const crypto = require('crypto');
const { db, logActivity } = require('../../database/db');
const { adminActivityActor } = require('../../utils/activityActor');
const { AppError } = require('../../utils/errors');
const businessProfileService = require('../businessProfileService');
const { ensureInt, ensureNumber } = require('../../utils/numericHelpers');
const { renumberLineItemPositions } = require('../../utils/lineItemPositions');
const { extendedLineColumns, lineItemFieldsToApi, resolvedParentTotal, ownLineMinor } = require('../../utils/lineItemTotals');
const { cleanNetMinor } = require('../../utils/invoiceRounding');
const { toMillis } = require('../../utils/queueTimestamps');
const { getAppSetting } = require('../../utils/appSettings');
const { computeMonthlyCadenceDate, getHierarchyHelpers, nextInvoiceNumber } = require('./helpers');
const { loadInvoiceLines } = require('./queries');
const { auditedInsert, auditedUpdate } = require('../accountingHistory');
const { frozenPaymentTerm } = require('./paymentTerm');
const { toDateOnly } = require('../../utils/dateOnly');
const { vatMinorFor, roundsVatDown, normaliseVatGbpRate } = require('../../utils/vatAmount');


/** A VAT rate as the draft key compares it (2 decimals, like the column). */
function draftVatRate(value) {
  return Math.round(ensureNumber(value, 0) * 100) / 100;
}

/** Whether a payload states a VAT rate of its own. */
function statesVatRate(value) {
  return value !== undefined && value !== null && value !== '';
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
  const profile = (await businessProfileService.getProfile(trx)).profile;
  const currency = String(key.currency || customer.preferred_currency || profile?.default_currency || 'CHF').toUpperCase();
  const vatRate = statesVatRate(key.vatRate) ? draftVatRate(key.vatRate) : null;
  // The open drafts of this key. Not filtered by monthly_period_end: if the
  // scheduler hasn't yet promoted an expired draft, it's still the landing
  // spot for new items; promoting it is the scheduler's job, not ours. The
  // partial unique index (migration 375) allows one per customer, currency
  // and rate. forUpdate() locks the row on Postgres so concurrent appenders
  // serialize on totals recomputation; SQLite's transaction write-lock gives
  // us the same guarantee implicitly.
  //
  // Only a draft that is still `scheduled` takes items: a cancelled or paid
  // row is a closed document, whatever its draft flag says.
  const openDraftOfKey = () => {
    const q = trx('invoices')
      .where({ customer_account_id: customer.id, is_monthly_draft: true, status: 'scheduled', currency });
    if (vatRate != null) q.where('vat_rate', vatRate);
    return q.orderBy('id', 'desc');
  };
  const existing = await openDraftOfKey().forUpdate().first();
  if (existing) {
    return { id: existing.id, row: existing, created: false };
  }
  // Rows closed while still flagged as the draft (cancelled or paid before
  // cancelling and paying cleared the flag) would hold the one-draft-per-
  // customer index and keep a fresh draft from being opened.
  await auditedUpdate(trx, 'invoices',
    (q) => q.where({ customer_account_id: customer.id, is_monthly_draft: true }).whereNot('status', 'scheduled'),
    { is_monthly_draft: false, updated_at: new Date() },
    { actor: adminId, source: 'invoice.monthly.releaseClosedDraft' });

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
    deal_uuid: crypto.randomUUID(),
    created_by_admin_id: adminId,
    created_at: new Date(),
    updated_at: new Date(),
  };
  try {
    const inserted = await auditedInsert(trx, 'invoices', row, { actor: adminId, source: 'invoice.monthly.createDraft' });
    const id = inserted[0].id;
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
async function appendToMonthlyDraft(payload, customer, adminId, trx) {
  // The payload's currency and rate pick the draft (issue 2649): its amounts
  // stay in their currency and its lines keep their rate.
  const draft = await getOrCreateMonthlyDraft(customer, adminId, trx,
    { currency: payload.currency, vatRate: payload.vatRate });

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
      ...extendedLineColumns(li, { invoice: true }),
    };
  });

  if (newItems.length > 0) {
    const { validateLineItemHierarchy, insertLineItemsHierarchical } = getHierarchyHelpers();
    validateLineItemHierarchy(newItems);
    await insertLineItemsHierarchical(trx, 'invoice_line_items', 'invoice_id', draft.id, newItems,
      { actor: adminId, source: 'invoice.monthly.appendItems' });
  }

  // Recompute totals across the entire draft so the running figures
  // shown on the customer-detail "Monthly queue" card stay accurate
  // as items accumulate. Mirrors createInvoice's totals path. The rate is
  // the draft's own (its key); the payload's shipping adds to the draft's.
  const { netMinor } = await resolveUnissuedInvoiceNet(trx, draft.id,
    { actor: adminId, source: 'invoice.monthly.appendItems' });
  const vatRate = Number(draft.row.vat_rate || 0);
  // A UK business rounds its VAT total down (utils/vatAmount).
  const vatMinor = vatMinorFor(netMinor, vatRate, { roundDown: await roundsVatDown(trx) });
  const shippingMinor = ensureInt(draft.row.shipping_amount_minor) + ensureInt(payload.shippingAmountMinor);
  const totalMinor = netMinor + vatMinor + shippingMinor;

  // A GBP rate entered with the appended items (issue 2439) becomes the
  // draft's: the draft is the invoice that will be sent.
  const gbpRateUpdate = {};
  if (payload.vatGbpRate !== undefined && payload.vatGbpRate !== null && payload.vatGbpRate !== '') {
    const { profile } = await businessProfileService.getProfile(trx);
    const rate = normaliseVatGbpRate(payload.vatGbpRate, { countryCode: profile?.country_code, currency: draft.row.currency });
    if (rate != null) gbpRateUpdate.vat_gbp_rate = rate;
  }

  const updated = await auditedUpdate(trx, 'invoices', { id: draft.id, status: 'scheduled', is_monthly_draft: true }, {
    net_amount_minor: netMinor,
    vat_amount_minor: vatMinor,
    shipping_amount_minor: shippingMinor,
    total_amount_minor: totalMinor,
    ...gbpRateUpdate,
    updated_at: new Date(),
  }, { actor: adminId, source: 'invoice.monthly.appendItems' });
  if (!updated) {
    throw new AppError('The running monthly bill was closed in the meantime. Try again.', 409, 'MONTHLY_DRAFT_CLOSED');
  }

  // The quote (and later its contract) accumulated here (migration 375): the
  // draft has no source_quote_id, so conversion retries find it this way.
  if (payload.sourceQuoteId) {
    await trx('invoice_accumulated_sources').insert({
      invoice_id: draft.id, quote_id: payload.sourceQuoteId, created_at: new Date().toISOString(),
    });
  }

  try {
    await logActivity('monthly_billing_items_queued',
      { invoiceId: draft.id, customerId: customer.id, itemsAdded: newItems.length },
      null, adminActivityActor(adminId), trx);
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
  // draft it appended onto from its return value.
  // No rate stated: the line joins the open draft at the draft's rate (or
  // opens one at 0 %), and never retaxes the lines already on it.
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
 * Read the customer's running monthly drafts + their line items so the
 * customer-detail page can preview what will ship on the next cycle day.
 * One per currency and VAT rate (migration 375), oldest first; empty when
 * no draft is open (admin hasn't queued anything yet for the current
 * period). Used by GET /admin/customers/:id/monthly-draft.
 */
async function getMonthlyDrafts(customerId) {
  const drafts = await db('invoices')
    .where({ customer_account_id: customerId, is_monthly_draft: true, status: 'scheduled' })
    .orderBy('id', 'asc');
  const previews = [];
  for (const draft of drafts) {
    const lineItems = await loadInvoiceLines(db, draft.id);
    previews.push({
      id: draft.id,
      invoiceNumber: draft.invoice_number,
      currency: draft.currency,
      periodStart: toDateOnly(draft.monthly_period_start),
      periodEnd: toDateOnly(draft.monthly_period_end),
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
        ...lineItemFieldsToApi(li),
      })),
    });
  }
  return previews;
}

/**
 * The open accumulator drafts a quote or contract was accumulated into
 * (migration 375), so a conversion retry adopts them. Ids, oldest first.
 */
async function accumulatedDraftIds(conn, { quoteId = null, contractId = null }) {
  if (!quoteId && !contractId) return [];
  const q = conn('invoice_accumulated_sources');
  if (quoteId) q.where('quote_id', quoteId);
  else q.where('contract_id', contractId);
  const rows = await q.orderBy('invoice_id').distinct('invoice_id');
  return rows.map((r) => Number(r.invoice_id));
}

/**
 * Whether an invoice's scheduled send time has come (it is armed for sending,
 * so issued). No send time: not armed. A send time that can't be read counts
 * as armed, so an edit is refused rather than landing on an invoice that may
 * already be going out. Read through toMillis (a zone-less SQLite time is
 * UTC), shared by every check that decides whether an invoice can change.
 */
function isArmed(scheduledSendAt) {
  if (scheduledSendAt == null || scheduledSendAt === '') return false;
  const at = toMillis(scheduledSendAt);
  return at == null || at <= Date.now();
}

/**
 * Can an invoice's lines still change in place? Only while it is
 * 'scheduled' and either the running monthly draft or not yet due to be
 * sent. The status comes first: a draft that was paid or cancelled keeps
 * its monthly flag until the scheduler's next pass, and is closed.
 * (Invoices have no 'draft' status; that state IS 'scheduled'.)
 */
function isOpenForLineChanges(invoice) {
  if (invoice.status !== 'scheduled') return false;
  if (invoice.is_monthly_draft === true || invoice.is_monthly_draft === 1) return true;
  return !isArmed(invoice.scheduled_send_at);
}

/**
 * The net of an unissued invoice whose lines changed in place (a monthly
 * draft taking an append, an hours entry edited or removed, a re-bill
 * unwound), by the same rule as createInvoice:
 *   - a parent's stored total follows its priced sub-items (migration 119)
 *     and adds its options (migration 371); parents that disagree are
 *     rewritten, audited, so the net matches the lines the PDF prints;
 *   - with crm_invoice_round_total on, the net is the full-precision sum
 *     rounded once (utils/invoiceRounding).
 * Callers keep their own VAT step. Returns the net and the lines read.
 */
async function resolveUnissuedInvoiceNet(trx, invoiceId, audit = {}) {
  // Every caller checks first; this holds the line for a future one. Open
  // means: still 'scheduled', not a Storno, and either the running monthly
  // draft or not yet due to be sent. Anything else is issued or closed, and
  // its lines are never rewritten.
  const invoice = await trx('invoices').where({ id: invoiceId })
    .first('status', 'kind', 'is_monthly_draft', 'scheduled_send_at');
  if (!invoice || invoice.kind === 'storno' || !isOpenForLineChanges(invoice)) {
    throw new AppError('This invoice has already been issued — Storno it to change it.', 409, 'INVOICE_LOCKED');
  }
  const allItems = await trx('invoice_line_items').where({ invoice_id: invoiceId });
  const childrenOf = new Map();
  for (const li of allItems) {
    if (li.parent_line_item_id == null) continue;
    if (!childrenOf.has(li.parent_line_item_id)) childrenOf.set(li.parent_line_item_id, []);
    childrenOf.get(li.parent_line_item_id).push(li);
  }
  for (const li of allItems) {
    if (li.parent_line_item_id != null) continue;
    const children = childrenOf.get(li.id) || [];
    // No priced sub-line (left): a parent is back at its own amount, which a
    // removed sub-line may have replaced before.
    const resolved = resolvedParentTotal(li, children) ?? (children.length ? ownLineMinor(li) : null);
    if (resolved == null || resolved === ensureInt(li.line_total_minor)) continue;
    await auditedUpdate(trx, 'invoice_line_items', { id: li.id }, { line_total_minor: resolved }, audit);
    li.line_total_minor = resolved;
  }
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
 * entry edited or removed, a re-bill unwound): resolveUnissuedInvoiceNet,
 * then VAT at the invoice's stored rate and its stored shipping.
 * appendToMonthlyDraft keeps its own step (its VAT rate can come from the
 * payload).
 */
async function retotalUnissuedInvoice(trx, invoice, audit) {
  const { netMinor } = await resolveUnissuedInvoiceNet(trx, invoice.id, audit);
  const vatRate = Number(invoice.vat_rate || 0);
  // A UK business rounds its VAT total down (utils/vatAmount).
  const vatMinor = vatMinorFor(netMinor, vatRate, { roundDown: await roundsVatDown(trx) });
  const shippingMinor = Number(invoice.shipping_amount_minor || 0);
  await auditedUpdate(trx, 'invoices', { id: invoice.id }, {
    net_amount_minor: netMinor,
    vat_amount_minor: vatMinor,
    total_amount_minor: netMinor + vatMinor + shippingMinor,
    updated_at: new Date(),
  }, audit);
}

module.exports = {
  isArmed,
  isOpenForLineChanges,
  resolveUnissuedInvoiceNet,
  retotalUnissuedInvoice,
  getOrCreateMonthlyDraft,
  appendToMonthlyDraft,
  appendOneLineItemToMonthlyDraft,
  getMonthlyDrafts,
  accumulatedDraftIds,
};
