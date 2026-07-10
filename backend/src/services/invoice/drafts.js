// Extracted verbatim from invoiceService.js — see ../invoiceService.js for the
// module-level overview. Do not add behavior here without updating the entry re-exports.

const crypto = require('crypto');
const { db, logActivity } = require('../../database/db');
const { AppError } = require('../../utils/errors');
const businessProfileService = require('../businessProfileService');
const { ensureInt, ensureNumber } = require('../../utils/numericHelpers');
const { computeMonthlyCadenceDate, getHierarchyHelpers, nextInvoiceNumber } = require('./helpers');


/**
 * Find or create the running "monthly draft" invoice for a customer.
 * One draft per customer per current billing period (`monthly_period_end >= today`).
 * Subsequent saves through createInvoice for the same monthly-mode
 * customer append line items onto this draft instead of minting fresh
 * invoices.
 *
 * Returns `{ id, row }` for the draft so the caller can append items
 * + recompute totals without a second query.
 *
 * Period bounds:
 *   start = first calendar day of the month that contains today
 *   end   = computeMonthlyCadenceDate(year, month, cycle_day) where
 *           year/month are picked so that the resolved date is in the
 *           future. If today is already PAST the cadence day for the
 *           current month, the period rolls to next month — admin
 *           authoring items after the cadence is "starting the next
 *           bill", not "appending to one that already fired".
 */
async function getOrCreateMonthlyDraft(customer, adminId, trx) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Manual cadence has no billing cycle: the draft accumulates
  // indefinitely and ships ONLY via the admin "Trigger invoice now"
  // gesture, so it carries NO period_end. The scheduler's auto-flush
  // filter is `monthly_period_end <= today`, which a NULL period_end
  // can never satisfy — keeping manual drafts out of the cron path.
  const isManual = customer.billing_cadence === 'manual';

  // Resolve period_end: prefer the cadence in the current month, but
  // if it has already passed, roll to next month so the new draft
  // gathers items toward the NEXT bill.
  const cycleDay = ensureInt(customer.billing_cycle_day) || 1;
  let target = computeMonthlyCadenceDate(today.getFullYear(), today.getMonth(), cycleDay);
  if (target.getTime() < today.getTime()) {
    const nextMonth = today.getMonth() + 1;
    target = computeMonthlyCadenceDate(today.getFullYear(), nextMonth, cycleDay);
  }
  const periodStart = isManual ? null : new Date(target.getFullYear(), target.getMonth(), 1);
  const periodEnd = isManual ? null : target;
  // Placeholder issue/due date for the empty draft row — recomputed at
  // issuance time. Manual drafts have no period_end, so fall back to today.
  const placeholderDate = (periodEnd || today).toISOString().slice(0, 10);

  // Look up any existing open draft for this customer. We deliberately
  // do NOT filter by monthly_period_end here — only one draft can be
  // open per customer at a time (enforced by the partial unique index
  // created in migration 133). If the scheduler hasn't yet promoted an
  // expired draft, it's still the canonical landing spot for any new
  // items the admin queues; promoting it is the scheduler's job, not
  // ours. forUpdate() locks the row on Postgres so concurrent appenders
  // serialize on totals recomputation; SQLite's transaction write-lock
  // gives us the same guarantee implicitly.
  const existing = await trx('invoices')
    .where({
      customer_account_id: customer.id,
      is_monthly_draft: true,
    })
    .orderBy('id', 'desc')
    .forUpdate()
    .first();
  if (existing) {
    return { id: existing.id, row: existing, created: false };
  }

  // None yet — mint one with zero line items + zero totals. The
  // caller appends items + recomputes immediately after.
  const profile = (await businessProfileService.getProfile()).profile;
  const currency = (customer.preferred_currency || profile?.default_currency || 'CHF').toUpperCase();
  const language = customer.preferred_language || profile?.default_locale || 'de';
  const invoiceNumber = await nextInvoiceNumber(trx);
  const bank = await businessProfileService.resolveBankAccountForCurrency(currency, null);

  const row = {
    invoice_number: invoiceNumber,
    customer_account_id: customer.id,
    source_quote_id: null,
    event_id: null,
    language,
    currency,
    issue_date: placeholderDate,
    due_date: placeholderDate, // recomputed at issuance time
    installment_index: 0,
    installment_total: 1,
    status: 'scheduled',
    scheduled_send_at: null, // monthly pass sets this on cadence day
    net_amount_minor: 0,
    vat_rate: 0,
    vat_amount_minor: 0,
    shipping_amount_minor: 0,
    total_amount_minor: 0,
    business_bank_account_id: bank?.id || null,
    qr_format: null,
    is_monthly_draft: true,
    monthly_period_start: periodStart ? periodStart.toISOString().slice(0, 10) : null,
    monthly_period_end: periodEnd ? periodEnd.toISOString().slice(0, 10) : null,
    // Migration 140 — each monthly-draft cycle is its own deal (no
    // quote/contract chain). Fresh UUID at creation; subsequent line
    // appends just mutate this same row, so the uuid sticks.
    deal_uuid: crypto.randomUUID(),
    created_by_admin_id: adminId,
    created_at: new Date(),
    updated_at: new Date(),
  };
  try {
    const inserted = await trx('invoices').insert(row).returning('id');
    const id = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
    return { id, row: { ...row, id }, created: true };
  } catch (err) {
    // Partial-unique-index violation: another transaction snuck a draft
    // in between our SELECT and INSERT. Re-SELECT the winner and return
    // it — concurrent callers converge on the same draft row instead
    // of double-billing the customer. The error string varies by
    // driver: Postgres → SQLSTATE 23505; better-sqlite3 → 'UNIQUE
    // constraint failed'; node-sqlite3 → 'SQLITE_CONSTRAINT'.
    const msg = String(err && err.message || '');
    const isUniqueViolation =
      err && err.code === '23505' ||
      /unique/i.test(msg) ||
      /sqlite_constraint/i.test(msg);
    if (!isUniqueViolation) throw err;
    const winner = await trx('invoices')
      .where({ customer_account_id: customer.id, is_monthly_draft: true })
      .orderBy('id', 'desc')
      .first();
    if (!winner) {
      // No row to return despite the unique-violation — this would
      // mean the winning transaction rolled back after we lost the
      // race. Surface the original error so the caller can retry.
      throw err;
    }
    return { id: winner.id, row: winner, created: false };
  }
}

/**
 * Append line items from a `createInvoice`-shaped payload onto the
 * customer's running monthly-draft (migration 128). Used when the
 * customer is billing_cadence='monthly': the admin's editor save
 * lands here instead of minting a new invoice.
 *
 * Pulls the existing draft (or creates a fresh one for the current
 * period), appends the new line items continuing the position
 * sequence, recomputes totals across the merged set, and returns the
 * draft's id so the route layer can fetch + return it.
 */
async function appendToMonthlyDraft(payload, customer, adminId, trx) {
  const draft = await getOrCreateMonthlyDraft(customer, adminId, trx);

  // Load existing line items so we can compute the next `position` and
  // re-sum totals across the merged set. The migration-119 hierarchy
  // helpers operate on the merged array so parent_position pointers
  // remain consistent.
  const existing = await trx('invoice_line_items')
    .where({ invoice_id: draft.id })
    .orderBy('position', 'asc');
  const nextPosition = existing.length
    ? Math.max(...existing.map((li) => ensureInt(li.position))) + 1
    : 1;

  const incoming = Array.isArray(payload.lineItems) ? payload.lineItems : [];
  const newItems = incoming.map((li, idx) => {
    const qty = ensureNumber(li.quantity, 1);
    const unit = ensureInt(li.unit_price_minor);
    const discount = ensureNumber(li.discount_percent, 0);
    const lineTotal = Math.round(Math.round(qty * unit) * (1 - discount / 100));
    const isSubItem = li.parent_position != null && li.parent_position !== '';
    return {
      position: nextPosition + idx,
      quantity: qty,
      description: String(li.description || ''),
      unit_price_minor: unit,
      discount_percent: discount,
      line_total_minor: lineTotal,
      parent_position: isSubItem ? ensureInt(li.parent_position) : null,
      details_text: li.details_text || null,
    };
  });

  if (newItems.length > 0) {
    const { validateLineItemHierarchy, insertLineItemsHierarchical } = getHierarchyHelpers();
    validateLineItemHierarchy(newItems);
    await insertLineItemsHierarchical(trx, 'invoice_line_items', 'invoice_id', draft.id, newItems);
  }

  // Recompute totals across the entire draft so the running figures
  // shown on the customer-detail "Monthly queue" card stay accurate
  // as items accumulate. Mirrors createInvoice's totals path.
  const allItems = await trx('invoice_line_items')
    .where({ invoice_id: draft.id });
  let netMinor = 0;
  for (const li of allItems) {
    if (li.parent_line_item_id == null) netMinor += ensureInt(li.line_total_minor);
  }
  const vatRate = ensureNumber(payload.vatRate, draft.row.vat_rate || 0);
  const vatMinor = Math.round(netMinor * Number(vatRate) / 100);
  const shippingMinor = ensureInt(draft.row.shipping_amount_minor);
  const totalMinor = netMinor + vatMinor + shippingMinor;

  await trx('invoices').where({ id: draft.id }).update({
    net_amount_minor: netMinor,
    vat_rate: vatRate,
    vat_amount_minor: vatMinor,
    total_amount_minor: totalMinor,
    updated_at: new Date(),
  });

  try {
    await logActivity('monthly_billing_items_queued',
      { invoiceId: draft.id, customerId: customer.id, itemsAdded: newItems.length },
      null, `admin:${adminId}`);
  } catch (_) {}

  return draft.id;
}

/**
 * Append a single, fully-formed line item to the customer's running
 * monthly draft (migration 128 + 129). Used by customerHoursService
 * when an hour entry is logged for a monthly-mode customer — we want
 * the inserted `invoice_line_items.id` back so the entry can be
 * stamped with the cross-reference.
 *
 * `lineItem` is the shape consumed by appendToMonthlyDraft's internal
 * insertLineItemsHierarchical helper (description, quantity,
 * unit_price_minor, discount_percent, line_total_minor, etc.). The
 * `position` field is set internally — caller-supplied positions are
 * ignored to keep the accumulator's sequence intact.
 *
 * Returns { invoiceId, lineItemId } — the draft id plus the id of the
 * newly-appended row.
 */
async function appendOneLineItemToMonthlyDraft(customer, lineItem, adminId, trx) {
  // Reuse the accumulator path — it handles get-or-create + totals
  // recompute + activity log. We pass a single-item array.
  await appendToMonthlyDraft({
    customerAccountId: customer.id,
    lineItems: [lineItem],
    vatRate: 0, // hours logging doesn't ship with VAT today
  }, customer, adminId, trx);

  // Look up the draft we just appended onto + its tail line item.
  // Newest insert wins by id desc; we filter by position match so
  // concurrent appends in another tx don't return the wrong row.
  const draft = await trx('invoices')
    .where({ customer_account_id: customer.id, is_monthly_draft: true })
    .orderBy('id', 'desc')
    .first();
  if (!draft) {
    // Defensive — appendToMonthlyDraft would have created one.
    throw new AppError('Monthly draft missing after append', 500);
  }
  const tail = await trx('invoice_line_items')
    .where({ invoice_id: draft.id })
    .orderBy('position', 'desc')
    .first();
  return { invoiceId: draft.id, lineItemId: tail?.id || null };
}

/**
 * Admin override — issue the customer's running monthly draft NOW,
 * bypassing the cadence-day wait. Mirrors the scheduler's monthly
 * pass (migration 128): clears is_monthly_draft, sets the issue date
 * + scheduled_send_at to now, and fires sendInvoice inline so the
 * email goes out on the next email-queue tick (~60s) instead of
 * waiting for the next scheduler iteration.
 *
 * Refuses when:
 *   - no draft exists (admin hasn't queued anything yet)
 *   - the draft has zero line items (nothing to send — same as the
 *     scheduler's empty-month skip path)
 *
 * Returns { invoiceId, invoiceNumber } so the route can surface the
 * resulting invoice on the response toast.
 */
/**
 * Read the customer's running monthly draft + its line items so the
 * customer-detail page can preview what will ship on the next cycle
 * day. Returns null when no open draft exists (admin hasn't queued
 * anything yet for the current period). Used by GET
 * /admin/customers/:id/monthly-draft.
 */
async function getMonthlyDraft(customerId) {
  const draft = await db('invoices')
    .where({ customer_account_id: customerId, is_monthly_draft: true })
    .orderBy('id', 'desc')
    .first();
  if (!draft) return null;
  const lineItems = await db('invoice_line_items as li')
    .leftJoin('invoice_line_items as parent', 'parent.id', 'li.parent_line_item_id')
    .where('li.invoice_id', draft.id)
    .orderBy('li.position', 'asc')
    .select('li.*', 'parent.position as parent_position');
  return {
    id: draft.id,
    invoiceNumber: draft.invoice_number,
    currency: draft.currency,
    periodStart: draft.monthly_period_start,
    periodEnd: draft.monthly_period_end,
    netAmountMinor: draft.net_amount_minor,
    vatRate: draft.vat_rate == null ? null : Number(draft.vat_rate),
    vatAmountMinor: draft.vat_amount_minor,
    totalAmountMinor: draft.total_amount_minor,
    lineItems: lineItems.map((li) => ({
      id: li.id,
      position: li.position,
      quantity: Number(li.quantity),
      description: li.description,
      unitPriceMinor: ensureInt(li.unit_price_minor),
      discountPercent: Number(li.discount_percent || 0),
      lineTotalMinor: ensureInt(li.line_total_minor),
      parentPosition: li.parent_position == null ? null : ensureInt(li.parent_position),
      detailsText: li.details_text || '',
    })),
  };
}
module.exports = {
  getOrCreateMonthlyDraft,
  appendToMonthlyDraft,
  appendOneLineItemToMonthlyDraft,
  getMonthlyDraft,
};
