// Extracted verbatim from invoiceService.js — see ../invoiceService.js for the
// module-level overview. Do not add behavior here without updating the entry re-exports.

const crypto = require('crypto');
const { db, logActivity } = require('../../database/db');
const businessProfileService = require('../businessProfileService');
const { ensureInt, ensureNumber } = require('../../utils/numericHelpers');
const { renumberLineItemPositions } = require('../../utils/lineItemPositions');
const { computeMonthlyCadenceDate, getHierarchyHelpers, nextInvoiceNumber } = require('./helpers');
const { auditedInsert, auditedUpdate } = require('../accountingHistory');
const { frozenPaymentTerm } = require('./paymentTerm');
const { getAppSetting } = require('../../utils/appSettings');
const { cleanNetMinor } = require('../../utils/invoiceRounding');
// Called through the module, so tests can stand in a concurrent writer.
const crmAccess = require('../../database/crmAccess');
const { AppError } = require('../../utils/errors');

/** A VAT rate as the draft key compares it (2 decimals, like the column). */
function draftVatRate(value) {
  return Math.round(ensureNumber(value, 0) * 100) / 100;
}

/** Whether a payload states a VAT rate of its own. */
function statesVatRate(value) {
  return value !== undefined && value !== null && value !== '';
}


/** The currency and VAT rate of a draft key (see getOrCreateMonthlyDraft). */
async function resolveDraftKey(trx, customer, key = {}) {
  const profile = (await businessProfileService.getProfile(trx)).profile;
  return {
    profile,
    currency: String(key.currency || customer.preferred_currency || profile?.default_currency || 'CHF').toUpperCase(),
    vatRate: statesVatRate(key.vatRate) ? draftVatRate(key.vatRate) : null,
  };
}

/**
 * The customer's open drafts of a key, newest first. Not filtered by
 * monthly_period_end: if the scheduler hasn't yet promoted an expired draft,
 * it's still the landing spot for new items; promoting it is the
 * scheduler's job, not ours. A null rate matches the draft of any rate.
 */
function openDraftQuery(trx, customerId, { currency, vatRate }) {
  const q = trx('invoices')
    .where({ customer_account_id: customerId, is_monthly_draft: true, currency });
  if (vatRate != null) q.where('vat_rate', vatRate);
  return q.orderBy('id', 'desc');
}

/**
 * Run `work(dealUuid)` for a booking flow converting a quote of its own deal
 * into the customer's running bill. The running bill is a deal of its own,
 * outside the flow's deal fence; widen the fence to that one deal (the open
 * draft's, or a fresh one the new draft takes). The flow's actor still needs
 * bills.manage and must own the draft (crmAccess.withCapabilityDeals).
 */
async function withAccumulatorDraftDeal(trx, customer, key, work) {
  const resolved = await resolveDraftKey(trx, customer, key);
  const open = await crmAccess.withTrustedCrmAccess('accumulator draft: deal of the open draft of the key',
    () => openDraftQuery(trx, customer.id, resolved).first('deal_uuid'));
  const dealUuid = open?.deal_uuid || crypto.randomUUID();
  return crmAccess.withCapabilityDeals([dealUuid], () => work(dealUuid));
}

/**
 * The net of an unissued invoice whose lines changed in place, by the same
 * rule as createInvoice and the accumulator append: the top-level (parent-
 * resolved) lines, or with crm_invoice_round_total the full-precision net
 * rounded once.
 */
async function unissuedNetMinor(trx, invoiceId) {
  const allItems = await trx('invoice_line_items').where({ invoice_id: invoiceId });
  let netMinor = 0;
  for (const li of allItems) {
    if (li.parent_line_item_id == null) netMinor += ensureInt(li.line_total_minor);
  }
  if ((await getAppSetting('crm_invoice_round_total', false, trx)) === true) {
    netMinor = cleanNetMinor(allItems, { parentKey: 'parent_line_item_id', positionKey: 'id' });
  }
  return { netMinor, allItems };
}

/**
 * Re-total an unissued invoice after its lines changed in place (an hours
 * entry edited or removed, a re-bill unwound): unissuedNetMinor, then VAT at
 * the invoice's stored rate and its stored shipping.
 */
async function retotalUnissuedInvoice(trx, invoice, audit) {
  const { netMinor } = await unissuedNetMinor(trx, invoice.id);
  const vatMinor = Math.round(netMinor * Number(invoice.vat_rate || 0) / 100);
  const shippingMinor = Number(invoice.shipping_amount_minor || 0);
  await auditedUpdate(trx, 'invoices', { id: invoice.id }, {
    net_amount_minor: netMinor,
    vat_amount_minor: vatMinor,
    total_amount_minor: netMinor + vatMinor + shippingMinor,
    updated_at: new Date(),
  }, audit);
}

/**
 * Find or create the running "monthly draft" invoice for a customer.
 * One open draft per customer, currency and VAT rate (issue 2649): amounts
 * are never relabelled into another currency, and lines that came at one
 * rate are never retaxed at another. Subsequent saves through createInvoice
 * for the same monthly-mode customer append line items onto the draft of
 * their key instead of minting fresh invoices.
 *
 * `key.currency` defaults to the customer's preferred currency, then the
 * business default. `key.vatRate` null (the caller states no rate: hours,
 * re-bills) takes the newest open draft in that currency at whatever rate
 * it has, and opens one at 0 % when there is none.
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
async function getOrCreateMonthlyDraft(customer, adminId, trx, key = {}) {
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

  // Route reads through the caller's connection: conversions and re-bills
  // can already hold SQLite's only connection inside their transaction.
  const { profile, currency, vatRate } = await resolveDraftKey(trx, customer, key);
  // The partial unique index (migration 256) allows one open draft per
  // customer, currency and rate. forUpdate() locks the row on Postgres so
  // concurrent appenders serialize on totals recomputation; SQLite's
  // transaction write-lock gives us the same guarantee implicitly.
  const openDraftOfKey = () => openDraftQuery(trx, customer.id, { currency, vatRate });
  const existing = await openDraftOfKey().forUpdate().first();
  if (existing) {
    return { id: existing.id, row: existing, created: false };
  }

  // The key may be held by a draft this actor's lookup above did not find:
  // one a concurrent conversion committed since (adopt it, as the unique-
  // violation path below does), or one out of the actor's reach (another
  // admin's), which is refused rather than tripping the index. The trusted
  // read only says whether the key is taken and by which deal; the draft is
  // read again as the actor, with a booking flow's deal fence widened to
  // that deal (a concurrent draft has a deal of its own), so ownership and
  // permissions decide.
  const held = await crmAccess.withTrustedCrmAccess('accumulator draft: key held by a draft out of reach',
    () => openDraftOfKey().first('id', 'deal_uuid'));
  if (held) {
    const adopted = await crmAccess.withCapabilityDeals([held.deal_uuid],
      () => openDraftOfKey().forUpdate().first());
    if (adopted) return { id: adopted.id, row: adopted, created: false };
    throw new AppError('This customer\'s running bill in this currency and VAT rate belongs to another admin.',
      403, 'MONTHLY_DRAFT_NOT_ACCESSIBLE');
  }

  // None yet — mint one with zero line items + zero totals. The
  // caller appends items + recomputes immediately after.
  const language = customer.preferred_language || profile?.default_locale || 'de';
  const invoiceNumber = await nextInvoiceNumber(trx);
  const bank = await businessProfileService.resolveBankAccountForCurrency(currency, null, trx);

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
    // The key's rate, fixed for the draft's life (lines at another rate
    // open their own draft).
    vat_rate: vatRate ?? 0,
    vat_amount_minor: 0,
    shipping_amount_minor: 0,
    total_amount_minor: 0,
    business_bank_account_id: bank?.id || null,
    qr_format: null,
    is_monthly_draft: true,
    // The defaults as they stand when the draft opens (invoice/paymentTerm).
    payment_term_snapshot: await frozenPaymentTerm(trx),
    monthly_period_start: periodStart ? periodStart.toISOString().slice(0, 10) : null,
    monthly_period_end: periodEnd ? periodEnd.toISOString().slice(0, 10) : null,
    // Migration 140 — each monthly-draft cycle is its own deal (no
    // quote/contract chain). Fresh UUID at creation; subsequent line
    // appends just mutate this same row, so the uuid sticks.
    deal_uuid: key.dealUuid || crypto.randomUUID(),
    created_by_admin_id: adminId,
    created_at: new Date(),
    updated_at: new Date(),
  };
  try {
    const inserted = await auditedInsert(trx, 'invoices', row, { actor: adminId, source: 'invoice.monthly.createDraft' });
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
    const winner = await openDraftOfKey().first();
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
async function appendToMonthlyDraft(payload, customer, adminId, trx = db) {
  // The lines, the totals and the lineage row commit together.
  if (!trx.isTransaction) {
    return db.transaction((t) => appendToMonthlyDraft(payload, customer, adminId, t));
  }
  // A conversion that already accumulated this quote (a retry) appends
  // nothing and hands back the draft it went into.
  if (payload._accumulatedQuoteId) {
    const [already] = await accumulatedDraftIds(trx, { quoteId: payload._accumulatedQuoteId });
    if (already) return already;
  }
  // The payload's currency and rate pick the draft (issue 2649): its amounts
  // stay in their currency and its lines keep their rate.
  const draft = await getOrCreateMonthlyDraft(customer, adminId, trx,
    { currency: payload.currency, vatRate: payload.vatRate, dealUuid: payload._draftDealUuid });
  // The draft may be one a concurrent conversion opened under a deal other
  // than the one a booking flow's fence was widened to: append within its
  // own deal (a no-op outside a flow; permissions and ownership still apply).
  return crmAccess.withCapabilityDeals([draft.row.deal_uuid],
    () => appendLinesToDraft(payload, customer, adminId, trx, draft));
}

/** appendToMonthlyDraft past the draft lookup: lines, totals, lineage. */
async function appendLinesToDraft(payload, customer, adminId, trx, draft) {

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

  // Incoming positions are the caller's row ids, not slots in this draft.
  // Renumber them to 1..n (validating the parent references against the
  // original ids first), then shift the whole block past the draft's existing
  // lines, so every sub-item keeps pointing at its own parent (#1452).
  const incoming = renumberLineItemPositions(Array.isArray(payload.lineItems) ? payload.lineItems : []);
  const offset = nextPosition - 1;
  const newItems = incoming.map((li) => {
    const qty = ensureNumber(li.quantity, 1);
    const unit = ensureInt(li.unit_price_minor);
    const discount = ensureNumber(li.discount_percent, 0);
    const lineTotal = Math.round(Math.round(qty * unit) * (1 - discount / 100));
    return {
      position: li.position + offset,
      quantity: qty,
      description: String(li.description || ''),
      unit_price_minor: unit,
      discount_percent: discount,
      line_total_minor: lineTotal,
      parent_position: li.parent_position == null ? null : li.parent_position + offset,
      details_text: li.details_text || null,
    };
  });

  if (newItems.length > 0) {
    const { validateLineItemHierarchy, insertLineItemsHierarchical, resolveParentTotalsFromSubItems } = getHierarchyHelpers();
    validateLineItemHierarchy(newItems);
    // A parent's total follows its priced sub-items (migration 119), as
    // createInvoice stores it: a zero-priced parent with a priced child
    // counts the child's amount.
    resolveParentTotalsFromSubItems(newItems);
    await insertLineItemsHierarchical(trx, 'invoice_line_items', 'invoice_id', draft.id, newItems,
      { actor: adminId, source: 'invoice.monthly.appendItems' });
  }

  // Recompute totals across the entire draft so the running figures
  // shown on the customer-detail "Monthly queue" card stay accurate
  // as items accumulate. Mirrors createInvoice's totals path: top-level
  // (parent-resolved) lines, or with crm_invoice_round_total the
  // full-precision net rounded once. The rate is the draft's own (its
  // key); the payload's shipping adds to the draft's.
  const { netMinor } = await unissuedNetMinor(trx, draft.id);
  const vatRate = Number(draft.row.vat_rate || 0);
  const vatMinor = Math.round(netMinor * vatRate / 100);
  const shippingMinor = ensureInt(draft.row.shipping_amount_minor) + ensureInt(payload.shippingAmountMinor);
  const totalMinor = netMinor + vatMinor + shippingMinor;

  await auditedUpdate(trx, 'invoices', { id: draft.id }, {
    net_amount_minor: netMinor,
    vat_amount_minor: vatMinor,
    shipping_amount_minor: shippingMinor,
    total_amount_minor: totalMinor,
    updated_at: new Date(),
  }, { actor: adminId, source: 'invoice.monthly.appendItems' });

  // The quote (and the contract it was converted through) accumulated here
  // (migration 256): the draft has no source_quote_id, so conversion retries
  // find it this way. Set only by a conversion (spawnInstallmentInvoices),
  // whose quote the converting actor has already claimed.
  if (payload._accumulatedQuoteId) {
    await trx('invoice_accumulated_sources').insert({
      invoice_id: draft.id,
      quote_id: payload._accumulatedQuoteId,
      contract_id: payload._accumulatedContractId || null,
      created_at: new Date().toISOString(),
    });
  }

  try {
    await logActivity('monthly_billing_items_queued',
      { invoiceId: draft.id, customerId: customer.id, itemsAdded: newItems.length },
      null, `admin:${adminId}`, trx);
  } catch (_) { /* non-fatal */ }

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
  // recompute + activity log. We pass a single-item array, and take the
  // draft it appended onto from its return value. No rate stated: the line
  // joins the open draft at the draft's rate (or opens one at 0 %), and
  // never retaxes the lines already on it.
  const draftId = await appendToMonthlyDraft({
    customerAccountId: customer.id,
    lineItems: [lineItem],
  }, customer, adminId, trx);

  // The tail line item of that draft is the one just appended.
  const tail = await trx('invoice_line_items')
    .where({ invoice_id: draftId })
    .orderBy('position', 'desc')
    .first();
  return { invoiceId: draftId, lineItemId: tail?.id || null };
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
 * Read the customer's running monthly drafts + their line items so the
 * customer-detail page can preview what will ship on the next cycle day.
 * One per currency and VAT rate (migration 256), oldest first; empty when
 * no draft is open (admin hasn't queued anything yet for the current
 * period). Used by GET /admin/customers/:id/monthly-draft.
 */
async function getMonthlyDrafts(customerId) {
  const drafts = await db('invoices')
    .where({ customer_account_id: customerId, is_monthly_draft: true })
    .orderBy('id', 'asc');
  const previews = [];
  for (const draft of drafts) {
    const lineItems = await db('invoice_line_items as li')
      .leftJoin('invoice_line_items as parent', 'parent.id', 'li.parent_line_item_id')
      .where('li.invoice_id', draft.id)
      .orderBy('li.position', 'asc')
      .select('li.*', 'parent.position as parent_position');
    previews.push({
      id: draft.id,
      invoiceNumber: draft.invoice_number,
      currency: draft.currency,
      periodStart: draft.monthly_period_start,
      periodEnd: draft.monthly_period_end,
      netAmountMinor: draft.net_amount_minor,
      vatRate: draft.vat_rate == null ? null : Number(draft.vat_rate),
      vatAmountMinor: draft.vat_amount_minor,
      shippingAmountMinor: draft.shipping_amount_minor,
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
    });
  }
  return previews;
}

/**
 * The accumulator drafts a quote or contract was accumulated into
 * (migration 256), so a conversion retry adopts them. Ids, oldest first.
 * The drafts are deals of their own, outside a booking flow's deal fence:
 * the fence is widened to them (crmAccess.withCapabilityDeals), and the
 * actor's permissions and ownership still decide what it reads.
 */
async function accumulatedDraftIds(conn, { quoteId = null, contractId = null }) {
  if (!quoteId && !contractId) return [];
  const where = (q) => (quoteId ? q.where('invoice_accumulated_sources.quote_id', quoteId)
    : q.where('invoice_accumulated_sources.contract_id', contractId));
  const deals = await crmAccess.withTrustedCrmAccess('accumulator lineage: deals of the drafts',
    () => where(conn('invoice_accumulated_sources')
      .join('invoices', 'invoices.id', 'invoice_accumulated_sources.invoice_id'))
      .distinct('invoices.deal_uuid'));
  const rows = await crmAccess.withCapabilityDeals(deals.map((d) => d.deal_uuid),
    () => where(conn('invoice_accumulated_sources')).orderBy('invoice_id').distinct('invoice_id'));
  return rows.map((r) => Number(r.invoice_id));
}
module.exports = {
  getOrCreateMonthlyDraft,
  withAccumulatorDraftDeal,
  retotalUnissuedInvoice,
  appendToMonthlyDraft,
  appendOneLineItemToMonthlyDraft,
  getMonthlyDrafts,
  accumulatedDraftIds,
};
