/**
 * quoteService — orchestrates the lifecycle of `quotes`, their
 * `quote_line_items`, and the public `quote_action_tokens` used by the
 * accept/decline link in the customer email.
 *
 * Mirrors the layered shape of customerAccountsService: pure functions
 * doing one thing each, with a small set of transformation helpers at
 * the top. Routes (adminQuotes.js / publicQuotes.js) stay thin.
 *
 * Money is stored as INTEGER minor units (cents/Rappen). The service
 * re-computes line totals + net/vat/total on save, never trusting the
 * payload — the editor sends a hint for live UX, the server is the
 * source of truth.
 *
 * Statuses (`quotes.status`):
 *   draft     freshly created or edited after send; not visible publicly
 *   sent      emailed to customer; public token live
 *   accepted  customer accepted; ready to convert to event
 *   declined  customer declined; admin can resend after edits
 *   expired   valid_until passed without a response (set by the scheduler)
 *   converted accepted + event created from it
 *
 * Per-customer feature override: when `customer_accounts.feature_quotes`
 * is false (toggled by admin on the customer detail page) the service
 * refuses to create / send / convert quotes for that customer. Admins
 * can still view existing rows for audit.
 */

const crypto = require('crypto');
const { db, withRetry, logActivity } = require('../database/db');
const logger = require('../utils/logger');
const { getAppSetting } = require('../utils/appSettings');
const { cleanNetMinor } = require('../utils/invoiceRounding');
const { AppError } = require('../utils/errors');
const { validateLineItemHierarchy } = require('../utils/lineItemPositions');
const { formatBoolean } = require('../utils/dbCompat');
const { nextDocumentNumber } = require('../utils/documentSequences');
const { resolveDefaultEventType } = require('./eventTypeService');
const { formatShortDate } = require('../utils/dateFormatter');
const businessProfileService = require('./businessProfileService');
const pdfThemeService = require('./pdfThemeService');
const documentArtifactService = require('./documentArtifactService');
const { buildIssuerBlock, buildRecipientBlock } = require('./_renderContext');
const pdfService = require('./pdfService');
const emailProcessor = require('./emailProcessor');
const { getFrontendBaseUrl } = require('../utils/frontendUrl');
const { hasColumnCached } = require('../utils/schemaCache');
const { getVatRegisteredSetting } = require('../utils/vatRegistration');
const {
  normalizeLineItems, countedLineItems, resolveDiscountLines, extendedLineColumns, parsePromotionSnapshot,
  isTruthyFlag, isUnselectedOptional,
} = require('../utils/lineItemTotals');
const { prepareQuoteLineItems } = require('./quoteCatalogService');
const { readStoredDocumentPdf } = require('../utils/storedDocumentPdf');
const { resolveStoredPath, toStoredPath } = require('../utils/storedPath');
const { auditedInsert, auditedUpdate, auditedDelete } = require('./accountingHistory');

// Every write to `quotes.status` goes through assertQuoteTransition below.
//
// The table was written before the admin-side flows existed and did not match
// what the service actually performs; it has been reconciled against every
// call site rather than the other way round, since each of those flows is
// deliberate and covered by its own guard:
//   draft    → accepted   adminAcceptQuote ("customer accepted on the phone")
//   declined → sent       sendQuote (revise + resend after a decline)
//   expired  → sent/accepted/declined  sendQuote / adminAccept / adminDecline
//                         all accept `expired` — a lapsed quote is revivable
//   accepted → accepted   recordResponse re-affirm inside the toggle window
//   declined → declined   recordResponse re-decline inside the toggle window
//
// `sent → expired` is retained as documented intent: no scheduler sets
// `expired` today, so nothing reaches that state on its own.
const VALID_QUOTE_TRANSITIONS = {
  draft: new Set(['sent', 'accepted', 'declined']),
  sent: new Set(['draft', 'accepted', 'declined', 'expired']),
  accepted: new Set(['accepted', 'converted', 'declined']),
  declined: new Set(['draft', 'sent', 'accepted', 'declined']),
  expired: new Set(['draft', 'sent', 'accepted', 'declined']),
  converted: new Set([]),
};

/**
 * Backstop for the state machine above. The call sites keep their own, more
 * specific guards (they produce better-worded 409s naming the exact reason);
 * this catches anything they miss — including a status the table has never
 * heard of — as a 409 rather than letting it through or 500ing downstream.
 */
function assertQuoteTransition(from, to) {
  const allowed = VALID_QUOTE_TRANSITIONS[from];
  if (!allowed || !allowed.has(to)) {
    throw new AppError(
      `Cannot change quote status from '${from}' to '${to}'`,
      409,
      'QUOTE_INVALID_TRANSITION',
    );
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

// `ensureInt` + `ensureNumber` moved to utils/numericHelpers (D.2 cleanup).
const { ensureInt, ensureNumber } = require('../utils/numericHelpers');
// Reading a stored timestamp back whatever shape the engine kept it in, and
// `null` when it can't be read at all — the difference between "the window is
// open" and "nobody can tell" (see utils/queueTimestamps).
const { toMillis } = require('../utils/queueTimestamps');

/**
 * Compute line totals + document totals authoritatively from the
 * supplied line items + VAT rate. Returns BigInt-safe integers (minor
 * units). Discount is applied before VAT.
 *
 * Hierarchy rules (migration 119):
 *   - Items with `parent_position` are SUB-ITEMS of the referenced
 *     top-level item.
 *   - Each sub-item's `line_total_minor` is computed (qty × unit ×
 *     (1 − discount)) so the renderer can show its individual price
 *     in parentheses for transparency.
 *   - **Parent total auto-resolves from sub-items when any are
 *     priced.** If at least one sub-item under a given parent has
 *     `unit_price_minor > 0`, the parent's effective line_total is
 *     the SUM of those sub-items' line_totals — the parent's own
 *     stored unit_price is ignored. Mental model: when you list
 *     itemised equipment with individual prices, the parent line
 *     becomes a header that auto-totals what's under it.
 *   - If all sub-items are priceless (transparency-only bullets), the
 *     parent's own qty × unit × discount math stands as today.
 *   - Sub-items NEVER contribute to the document net directly —
 *     only the parent's effective line_total does. So sub-items
 *     don't double-count, and the parent's "sum-of-sub-items" total
 *     is what lands in net + VAT.
 *
 * The empty-payload check upstream ensures `lineItems` is always an
 * array; we treat anything truthy on `parent_position` (number or
 * string that parses to int) as "I'm a sub-item".
 */
function computeTotals(lineItems, vatRate, shippingAmountMinor = 0, options = {}) {
  // Phase 1: compute raw line_total_minor for every row from its own
  // qty × unit × discount. Sub-item lines are computed here too so
  // the renderer can display their individual amounts.
  // normalizeLineItems applies the migration-215 rules (line kind, add-on
  // flags inherited by sub-items, discount lines stay top-level).
  const computed = normalizeLineItems(lineItems).map((li) => {
    const qty = ensureNumber(li.quantity, 1);
    const unit = ensureInt(li.unit_price_minor);
    const discount = Math.max(0, Math.min(100, ensureNumber(li.discount_percent, 0)));
    const rawLineMinor = Math.round(qty * unit);
    const discountedMinor = Math.round(rawLineMinor * (1 - discount / 100));
    const parentPosition = li.parent_position == null || li.parent_position === ''
      ? null : ensureInt(li.parent_position);
    return { ...li, line_total_minor: discountedMinor, parent_position: parentPosition };
  });

  // Phase 2: resolve parents. For each top-level item, sum its priced
  // sub-items; if the sum > 0, override the parent's line_total_minor.
  // Index by position for O(n) lookup.
  const childrenByParent = new Map();
  for (const li of computed) {
    if (li.parent_position == null) continue;
    if (!childrenByParent.has(li.parent_position)) childrenByParent.set(li.parent_position, []);
    childrenByParent.get(li.parent_position).push(li);
  }
  for (const li of computed) {
    if (li.parent_position != null) continue; // skip sub-items
    const children = childrenByParent.get(ensureInt(li.position)) || [];
    const pricedChildrenSum = children.reduce(
      (s, c) => s + (ensureInt(c.unit_price_minor) > 0 ? ensureInt(c.line_total_minor) : 0),
      0,
    );
    if (pricedChildrenSum > 0) {
      // Override the parent's effective line total with the sum of
      // its priced sub-items. The parent's own stored unit_price is
      // intentionally ignored here (the editor disables the parent
      // input when sub-items become priced — but the backend is the
      // source of truth either way).
      li.line_total_minor = pricedChildrenSum;
    }
  }

  // Phase 2b (#1451): discount lines take their amount from the regular
  // subtotal — percentage promotions first, then fixed, capped at the
  // subtotal. Unselected optional add-ons don't count toward anything.
  resolveDiscountLines(computed);
  const counted = countedLineItems(computed);

  // Phase 3: net = sum of top-level line totals (resolved).
  let netMinor = 0;
  for (const li of counted) {
    if (li.parent_position == null) netMinor += ensureInt(li.line_total_minor);
  }

  // Optional sub-cent reconciliation (crm_invoice_round_total). When on,
  // the stored net becomes the full-precision sum rounded ONCE so the
  // total matches qty × unit arithmetic; the few-Rappen drift from the
  // per-line rounding is surfaced as a "Rundung" row at render time
  // (derived as storedNet − Σ line totals). Off by default ⇒ net stays
  // the sum of rounded lines and roundingAdjustmentMinor is 0.
  const roundedNet = netMinor;
  let roundingAdjustmentMinor = 0;
  if (options.roundTotal) {
    const clean = cleanNetMinor(counted, { parentKey: 'parent_position', positionKey: 'position' });
    roundingAdjustmentMinor = clean - roundedNet;
    netMinor = clean;
  }

  const vatPercent = ensureNumber(vatRate, 0);
  const vatMinor = Math.round(netMinor * vatPercent / 100);
  const shipping = ensureInt(shippingAmountMinor);
  const totalMinor = netMinor + vatMinor + shipping;
  return {
    netAmountMinor: netMinor,
    vatAmountMinor: vatMinor,
    shippingAmountMinor: shipping,
    totalAmountMinor: totalMinor,
    roundingAdjustmentMinor,
    lineItems: computed,
  };
}

/**
 * Resolve parent line_total_minor from priced sub-items, in place.
 * Mirrors the phase-2 step of computeTotals so non-quote callers
 * (invoiceService.createInvoice, the PUT-invoice route) can apply
 * the same hierarchy math without going through full totals.
 *
 * Each item must already have line_total_minor pre-computed (the
 * raw qty × unit × discount product). After this call, top-level
 * items whose sub-items include at least one priced row will have
 * their line_total_minor overwritten with the sum of priced
 * sub-items' line_totals.
 */
function resolveParentTotalsFromSubItems(items) {
  if (!Array.isArray(items) || items.length === 0) return;
  const childrenByParent = new Map();
  for (const li of items) {
    const pp = li.parent_position == null || li.parent_position === '' ? null : ensureInt(li.parent_position);
    if (pp == null) continue;
    if (!childrenByParent.has(pp)) childrenByParent.set(pp, []);
    childrenByParent.get(pp).push(li);
  }
  for (const li of items) {
    const pp = li.parent_position == null || li.parent_position === '' ? null : ensureInt(li.parent_position);
    if (pp != null) continue;
    const children = childrenByParent.get(ensureInt(li.position)) || [];
    const pricedSum = children.reduce(
      (s, c) => s + (ensureInt(c.unit_price_minor) > 0 ? ensureInt(c.line_total_minor) : 0),
      0,
    );
    if (pricedSum > 0) li.line_total_minor = pricedSum;
  }
}

/**
 * Two-phase insert into a *_line_items table to resolve the
 * parent_position → parent_line_item_id remap. The payload uses
 * position numbers to express parent/child relationships because the
 * DB ids don't exist until rows are inserted; this helper handles
 * the round-trip.
 *
 *   trx          — db or transaction handle
 *   tableName    — 'quote_line_items' | 'invoice_line_items'
 *   ownerColumn  — 'quote_id' | 'invoice_id'
 *   ownerId      — the parent quote/invoice id
 *   items        — array of line-item rows with `position` +
 *                  optional `parent_position`. All other columns
 *                  passed through verbatim (except parent_position
 *                  which is stripped — it's a wire-only field, not a
 *                  DB column).
 *
 * Caller must have already run `validateLineItemHierarchy` on the
 * items, so this function trusts the hierarchy is sound.
 *
 *   context      — { actor, source } recorded in the accounting change
 *                  history for every inserted row
 */
async function insertLineItemsHierarchical(trx, tableName, ownerColumn, ownerId, items, context = {}) {
  if (!Array.isArray(items) || items.length === 0) return;
  // Phase 1: top-level items, captured into a position→id map for
  // phase 2.
  const topLevel = items.filter((li) => li.parent_position == null || li.parent_position === '');
  const subItems = items.filter((li) => li.parent_position != null && li.parent_position !== '');
  const stripWireOnly = ({ parent_position: _pp, parent_line_item_id: _pid, ...rest }) => rest;

  const positionToId = new Map();
  for (const li of topLevel) {
    const row = {
      ...stripWireOnly(li),
      [ownerColumn]: ownerId,
      parent_line_item_id: null,
      details_text: li.details_text == null ? null : String(li.details_text),
      created_at: new Date(),
      updated_at: new Date(),
    };
    const inserted = await auditedInsert(trx, tableName, row, context);
    const newId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
    positionToId.set(ensureInt(li.position), newId);
  }
  for (const li of subItems) {
    const parentId = positionToId.get(ensureInt(li.parent_position));
    if (!parentId) {
      // Defensive — validateLineItemHierarchy should have caught
      // this. Rethrow as a 500 so we don't silently swallow.
      throw new AppError(`Sub-item position ${li.position} references unknown parent ${li.parent_position}`, 500);
    }
    const row = {
      ...stripWireOnly(li),
      [ownerColumn]: ownerId,
      parent_line_item_id: parentId,
      details_text: li.details_text == null ? null : String(li.details_text),
      created_at: new Date(),
      updated_at: new Date(),
    };
    await auditedInsert(trx, tableName, row, context);
  }
}

// Atomic gap-free quote number generator. See utils/documentSequences.js
// for the locking story; migration 132 created the underlying table.
// The previous SELECT-MAX-then-INSERT path raced under concurrent
// admin creates and could emit `Q-2026-AB12C3` after 5 retries.
async function nextQuoteNumber(trx) {
  return nextDocumentNumber('quote', 'crm_quotes_number_format', 'Q-{YEAR}-{SEQ:04d}', trx);
}

function ensureCustomerFeatureEnabled(customer, feature) {
  // Global toggle (`customer_feature_quotes_enabled` / `..._bills_enabled`)
  // is checked at the route layer (feature flag); here we only enforce
  // the per-customer override.
  if (!customer) {
    throw new AppError('Customer not found', 404);
  }
  if (customer.is_active === false || customer.is_active === 0) {
    throw new AppError('Customer is deactivated', 409);
  }
  const flagField = feature === 'quotes' ? 'feature_quotes' : 'feature_bills';
  const flagValue = customer[flagField];
  if (flagValue === false || flagValue === 0 || flagValue === '0') {
    throw new AppError(`This customer has ${feature} disabled`, 409, 'CUSTOMER_FEATURE_DISABLED');
  }
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

/**
 * List quotes with filter + sort + pagination support. Returns a flat
 * list (transformed by the route layer); pagination metadata is in the
 * wrapper.
 *
 * Filters: { status[], customerAccountId, from, to, q }
 * Sort:    'newest' | 'oldest' | 'customer_asc' | 'value_asc' | 'value_desc'
 */
async function listQuotes({ filters = {}, sort = 'issue_desc', page = 1, pageSize = 25 } = {}) {
  return await withRetry(async () => {
    let query = db('quotes')
      .leftJoin('customer_accounts', 'quotes.customer_account_id', 'customer_accounts.id')
      .select(
        'quotes.*',
        'customer_accounts.email as customer_email',
        'customer_accounts.display_name as customer_display_name',
        'customer_accounts.first_name as customer_first_name',
        'customer_accounts.last_name as customer_last_name',
        'customer_accounts.company_name as customer_company_name',
        // Surfaced so the route's transformQuote can compute the
        // customer.isPassive flag. Hash itself never leaves the API.
        'customer_accounts.password_hash as customer_password_hash',
      );

    if (Array.isArray(filters.status) && filters.status.length > 0) {
      query = query.whereIn('quotes.status', filters.status);
    }
    if (filters.customerAccountId) {
      query = query.where('quotes.customer_account_id', filters.customerAccountId);
    }
    if (filters.from) {
      query = query.where('quotes.issue_date', '>=', filters.from);
    }
    if (filters.to) {
      query = query.where('quotes.issue_date', '<=', filters.to);
    }
    if (filters.q && String(filters.q).trim()) {
      const term = `%${String(filters.q).trim()}%`;
      query = query.andWhere(function() {
        this.where('quotes.quote_number', 'like', term)
          .orWhere('quotes.event_name', 'like', term)
          .orWhere('customer_accounts.email', 'like', term)
          .orWhere('customer_accounts.company_name', 'like', term);
      });
    }

    // Total before pagination.
    const countQuery = query.clone().clearSelect().clearOrder().count('quotes.id as total').first();
    const totalRow = await countQuery;
    const total = ensureInt(totalRow?.total || 0);

    switch (sort) {
    // "Newest" / "Oldest" sort by CREATION time, not issue_date —
    // the latter is admin-controlled (retro-dated quotes, future-
    // dated quotes for accruals) and drifts from actual chronology.
    // Sorting by created_at always puts a just-saved quote at the
    // top of the "Newest first" list.
    case 'oldest':
      query = query.orderBy('quotes.created_at', 'asc').orderBy('quotes.id', 'asc');
      break;
    case 'issue_asc':
      query = query.orderBy('quotes.issue_date', 'asc').orderBy('quotes.id', 'asc');
      break;
    case 'issue_desc':
      query = query.orderBy('quotes.issue_date', 'desc').orderBy('quotes.id', 'desc');
      break;
    case 'customer_asc':
      query = query
        .orderByRaw('COALESCE(customer_accounts.company_name, customer_accounts.last_name, customer_accounts.email) asc')
        .orderBy('quotes.id', 'desc');
      break;
    case 'customer_desc':
      query = query
        .orderByRaw('COALESCE(customer_accounts.company_name, customer_accounts.last_name, customer_accounts.email) desc')
        .orderBy('quotes.id', 'desc');
      break;
    case 'value_asc':
      query = query.orderBy('quotes.total_amount_minor', 'asc');
      break;
    case 'value_desc':
      query = query.orderBy('quotes.total_amount_minor', 'desc');
      break;
    case 'newest':
    default:
      query = query.orderBy('quotes.created_at', 'desc').orderBy('quotes.id', 'desc');
      break;
    }

    const offset = Math.max(0, (page - 1) * pageSize);
    query = query.offset(offset).limit(pageSize);
    const rows = await query;
    return { rows, total, page, pageSize };
  });
}

async function getQuoteById(id) {
  return await withRetry(async () => {
    // LEFT JOIN customer_accounts so transformQuote (which reads
    // q.customer_email / q.customer_display_name etc.) has populated
    // fields. Without this the API returns nulls for the recipient
    // block and the editor shows "undefined undefined" in its summary.
    const quote = await db('quotes')
      .leftJoin('customer_accounts', 'quotes.customer_account_id', 'customer_accounts.id')
      // Migration 130 lineage: the human contract_number of the
      // contract this quote was converted into, so the detail view
      // shows "Linked contract LBM-C-2026-0010" instead of just "#10".
      // LEFT join — most quotes never get converted to a contract.
      .leftJoin('contracts as conv_contract', 'quotes.converted_contract_id', 'conv_contract.id')
      // A reissue (#1451): the number and date of the quote it replaces.
      .leftJoin('quotes as replaced', 'quotes.replaces_quote_id', 'replaced.id')
      .where('quotes.id', id)
      .select(
        'quotes.*',
        'customer_accounts.email as customer_email',
        'customer_accounts.display_name as customer_display_name',
        'customer_accounts.first_name as customer_first_name',
        'customer_accounts.last_name as customer_last_name',
        'customer_accounts.company_name as customer_company_name',
        // For transformQuote.customer.isPassive — never leaves the API.
        'customer_accounts.password_hash as customer_password_hash',
        'conv_contract.contract_number as converted_contract_number',
        'replaced.quote_number as replaces_quote_number',
        'replaced.issue_date as replaces_issue_date',
      )
      .first();
    if (!quote) return null;
    // …and the quote that reissued this one, if there is one.
    const next = await db('quotes').where({ replaces_quote_id: id }).orderBy('id', 'desc').first('id', 'quote_number');
    quote.replaced_by_quote_id = next ? next.id : null;
    quote.replaced_by_quote_number = next ? next.quote_number : null;
    // Whether anything was invoiced from this quote — part of the same
    // conversion lock the write paths use (assertQuoteNotConverted), so the
    // detail view doesn't offer an add-on change the service will refuse.
    quote.has_source_invoice = !!(await db('invoices').where({ source_quote_id: id }).first('id'));
    // Self-join so the response carries parent_position alongside
    // parent_line_item_id. The editor uses position (1-based, stable
    // within the payload) to thread sub-items; the DB id is just for
    // unrelated callers.
    const lineItems = await db('quote_line_items as li')
      .leftJoin('quote_line_items as parent', 'parent.id', 'li.parent_line_item_id')
      .where('li.quote_id', id)
      .orderBy('li.position', 'asc')
      .select('li.*', 'parent.position as parent_position');
    return { quote, lineItems };
  });
}

/**
 * Create a quote. Validates the customer + recomputes totals.
 * Returns the new quote id.
 */
async function createQuote(payload, adminId) {
  const customer = await db('customer_accounts').where({ id: payload.customerAccountId }).first();
  ensureCustomerFeatureEnabled(customer, 'quotes');

  const profile = (await businessProfileService.getProfile()).profile;
  const currency = (payload.currency || profile?.default_currency || 'CHF').toUpperCase();
  const language = payload.language || customer.preferred_language || profile?.default_locale || 'de';

  // Default validity = 7 days. Admin can override via Settings →
  // CRM → "Quote default validity (days)" (key
  // `crm_quotes_default_valid_days`).
  const validDays = ensureInt(await getAppSetting('crm_quotes_default_valid_days')) || 7;
  const issueDate = payload.issueDate || new Date().toISOString().slice(0, 10);
  const validUntil = payload.validUntil || new Date(Date.now() + validDays * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);

  // Authoritative totals. Rates, hours/days and promotions are resolved
  // server-side first (#1451).
  const roundTotal = (await getAppSetting('crm_invoice_round_total', false)) === true;
  const preparedLineItems = await prepareQuoteLineItems(payload.lineItems, {
    customerId: payload.customerAccountId, currency, hours: payload.hours, days: payload.days,
  });
  const totals = computeTotals(
    preparedLineItems,
    payload.vatRate,
    payload.shippingAmountMinor,
    { roundTotal }
  );

  // Negative line items (Rabatt) are allowed, but the resulting
  // quote total must not go below zero — a quote represents an
  // offer of value, not a credit note.
  if (totals.totalAmountMinor < 0) {
    throw new AppError(
      'Quote total cannot be negative. Reduce the discount amount.',
      400,
      'QUOTE_TOTAL_NEGATIVE',
    );
  }

  // Resolve bank account for the chosen currency.
  const bank = await businessProfileService.resolveBankAccountForCurrency(currency, payload.businessBankAccountId);

  // Resolve schema-drift column checks BEFORE the transaction — a cold
  // hasColumnCached lookup hits the global db, which deadlocks the single-
  // connection SQLite pool if issued inside the trx (prepare_quote runs this
  // unattended from a workflow).
  const hasProjectId = await hasColumnCached('quotes', 'project_id');
  const hasVatCode = await hasColumnCached('quotes', 'vat_code');
  const hasEventType = await hasColumnCached('quotes', 'event_type');
  const hasBookingWorkflowId = await hasColumnCached('quotes', 'booking_workflow_id');

  return await db.transaction(async (trx) => {
    // SQLite's 1-connection default deadlocks when claimNextSequence
    // opens its own micro-transaction inside this outer one — thread
    // trx so both run on the same connection. Postgres tolerates
    // either form but the consistency is worth it.
    const quoteNumber = await nextQuoteNumber(trx);
    const row = {
      quote_number: quoteNumber,
      customer_account_id: payload.customerAccountId,
      status: 'draft',
      language,
      currency,
      issue_date: issueDate,
      valid_until: validUntil,
      event_name: payload.eventName || null,
      event_date: payload.eventDate || null,
      event_time_start: payload.eventTimeStart || null,
      event_time_end: payload.eventTimeEnd || null,
      expected_duration_hours: payload.expectedDurationHours == null ? null : ensureNumber(payload.expectedDurationHours),
      // Migration 220 — quote-wide hours / days that bound lines follow,
      // and the template this quote was created from (reporting only).
      hours: payload.hours == null || payload.hours === '' ? null : ensureNumber(payload.hours),
      days: payload.days == null || payload.days === '' ? null : ensureNumber(payload.days),
      source_template_id: payload.sourceTemplateId || null,
      source_template_version: payload.sourceTemplateVersion || null,
      payment_term_template_id: payload.paymentTermTemplateId || null,
      // Migration 124 — split payment-term picker. Editor stops writing
      // to the legacy single FK once both new ones are present; the
      // legacy column stays nullable for backward compatibility.
      payment_net_days_template_id: payload.paymentNetDaysTemplateId || null,
      payment_timing_template_id: payload.paymentTimingTemplateId || null,
      // Migration 142 — ad-hoc installments override (commit #6). When
      // the editor's InstallmentsPanel is set the array lands here;
      // composeSnapshotFromSplitFks then substitutes it for the
      // template's installments field at every snapshot-read site
      // (send, convertToEvent, convertToInvoiceOnly).
      payment_term_installments_override: Array.isArray(payload.installments) && payload.installments.length > 0
        ? JSON.stringify(payload.installments)
        : null,
      net_amount_minor: totals.netAmountMinor,
      vat_rate: ensureNumber(payload.vatRate, 0),
      vat_amount_minor: totals.vatAmountMinor,
      shipping_amount_minor: totals.shippingAmountMinor,
      total_amount_minor: totals.totalAmountMinor,
      intro_text: payload.introText || null,
      outro_text: payload.outroText || null,
      internal_notes: payload.internalNotes || null,
      cc_pdf_email: payload.ccPdfEmail || null,
      business_bank_account_id: bank?.id || null,
      // Migration 140 — cross-document lineage UUID. A freshly-created
      // quote is the root of its deal chain; mint a new one here and let
      // convertQuoteToContract / convertQuoteToInvoices propagate it down.
      // A reissued quote (#1451) stays in the deal of the quote it replaces.
      deal_uuid: payload.dealUuid || crypto.randomUUID(),
      replaces_quote_id: payload.replacesQuoteId || null,
      created_by_admin_id: adminId,
      created_at: new Date(),
      updated_at: new Date(),
    };
    // Migration 121 — optional link to a Project Overview project.
    if (payload.projectId !== undefined && hasProjectId) {
      row.project_id = payload.projectId || null;
    }
    // Migration 130 — snapshot the chosen output VAT code (immutable; the export
    // emits exactly this rather than re-deriving from the mutable rate→code map).
    if (payload.vatCode !== undefined && hasVatCode) {
      row.vat_code = payload.vatCode ? String(payload.vatCode).slice(0, 16) : null;
    }
    // Migration 146 — event type (event_types.slug_prefix). Drives the type of
    // the event the quote converts into, instead of the old hardcoded 'wedding'.
    if (payload.eventType !== undefined && hasEventType) {
      row.event_type = payload.eventType ? String(payload.eventType).slice(0, 64) : null;
    }
    // Migration 147 — the booking workflow this quote runs on acceptance.
    if (payload.bookingWorkflowId !== undefined && hasBookingWorkflowId) {
      row.booking_workflow_id = payload.bookingWorkflowId || null;
    }
    const history = { actor: adminId, source: 'quote.create' };
    const inserted = await auditedInsert(trx, 'quotes', row, history);
    const quoteId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

    // Cascade the project link across the deal lineage (no-op for a brand-new
    // quote with no contract/event yet — just adopts the customer onto an
    // empty project).
    if (row.project_id) {
      await require('./projectService').linkDealToProject(row.deal_uuid, row.project_id, trx, { id: adminId });
    }

    if (totals.lineItems.length > 0) {
      // Normalise rows for the hierarchical-insert helper. We preserve
      // the wire-only `parent_position` field here so the helper can
      // resolve it; the helper strips it before the actual DB insert.
      const rows = totals.lineItems.map((li, idx) => ({
        position: ensureInt(li.position) || (idx + 1),
        quantity: ensureNumber(li.quantity, 1),
        description: String(li.description || ''),
        unit_price_minor: ensureInt(li.unit_price_minor),
        discount_percent: ensureNumber(li.discount_percent, 0),
        line_total_minor: li.line_total_minor,
        details_text: li.details_text || null,
        parent_position: li.parent_position || null,
        ...extendedLineColumns(li),
      }));
      validateLineItemHierarchy(rows);
      await insertLineItemsHierarchical(trx, 'quote_line_items', 'quote_id', quoteId, rows, history);
    }

    try {
      // Pass `trx` so the audit insert rides the transaction's connection —
      // the global db here deadlocks the single-connection SQLite pool.
      await logActivity('quote_created', { quoteId, quoteNumber, customerAccountId: payload.customerAccountId }, null, `admin:${adminId}`, trx);
    } catch (_) { /* non-fatal */ }

    logger.info('Quote created', { adminId, quoteId, quoteNumber });
    return quoteId;
  });
}

/**
 * Update a quote (line items + scalar fields). Editing a `sent` quote
 * reverts it to draft so a fresh send is required to push the change.
 */
async function updateQuote(id, payload, adminId) {
  const existing = await db('quotes').where({ id }).first();
  if (!existing) {
    throw new AppError('Quote not found', 404);
  }
  // Once a customer has responded (accept / decline) or the quote has
  // been converted to an event/invoice, edits would invalidate the
  // record the customer agreed to. Lock these states the same way
  // sent invoices are locked. `draft` and `sent` remain editable;
  // `sent` reverts to `draft` further down so the admin must resend.
  // `expired` is left editable — quote can be revised and re-sent.
  if (['accepted', 'declined', 'converted'].includes(existing.status)) {
    throw new AppError(
      existing.status === 'accepted'
        ? 'This quote was accepted and can\'t be edited. Reissue it to make changes.'
        : `Cannot edit quote with status '${existing.status}'. Duplicate the quote and start fresh if changes are needed.`,
      409,
      'QUOTE_LOCKED',
    );
  }

  const roundTotal = (await getAppSetting('crm_invoice_round_total', false)) === true;
  const preparedLineItems = await prepareQuoteLineItems(payload.lineItems, {
    customerId: existing.customer_account_id,
    currency: existing.currency,
    hours: Object.prototype.hasOwnProperty.call(payload, 'hours') ? payload.hours : existing.hours,
    days: Object.prototype.hasOwnProperty.call(payload, 'days') ? payload.days : existing.days,
  });
  const totals = computeTotals(
    preparedLineItems,
    payload.vatRate ?? existing.vat_rate,
    payload.shippingAmountMinor ?? existing.shipping_amount_minor,
    { roundTotal }
  );

  // Negative line items (Rabatt) are allowed, but the resulting
  // quote total must not go below zero. See createQuote.
  if (totals.totalAmountMinor < 0) {
    throw new AppError(
      'Quote total cannot be negative. Reduce the discount amount.',
      400,
      'QUOTE_TOTAL_NEGATIVE',
    );
  }

  // Resolve schema-drift column checks BEFORE the transaction, as createQuote
  // does: a cold hasColumnCached lookup goes through the global db, and inside
  // the trx it waits on the single-connection SQLite pool for the connection
  // the trx holds. The quote editor sends projectId, so the save stalled for
  // the 60s acquire timeout and failed.
  const has = (field, column) => Object.prototype.hasOwnProperty.call(payload, field)
    && hasColumnCached('quotes', column);
  const hasProjectId = await has('projectId', 'project_id');
  const hasVatCode = await has('vatCode', 'vat_code');
  const hasEventType = await has('eventType', 'event_type');
  const hasBookingWorkflowId = await has('bookingWorkflowId', 'booking_workflow_id');

  return await db.transaction(async (trx) => {
    const updates = {
      updated_at: new Date(),
      net_amount_minor: totals.netAmountMinor,
      vat_amount_minor: totals.vatAmountMinor,
      shipping_amount_minor: totals.shippingAmountMinor,
      total_amount_minor: totals.totalAmountMinor,
      vat_rate: ensureNumber(payload.vatRate ?? existing.vat_rate, 0),
    };
    // Revert sent → draft on edit so the admin must explicitly resend.
    if (existing.status === 'sent') {
      assertQuoteTransition(existing.status, 'draft');
      updates.status = 'draft';
    }
    // An edited expired quote no longer matches the file it was sent as;
    // drop the pointer so it renders live until it is sent again (#1451).
    if (existing.status === 'expired') {
      updates.pdf_path = null;
    }
    const map = {
      eventName: 'event_name',
      eventDate: 'event_date',
      eventTimeStart: 'event_time_start',
      eventTimeEnd: 'event_time_end',
      expectedDurationHours: 'expected_duration_hours',
      paymentTermTemplateId: 'payment_term_template_id',
      // Migration 124 — split picker. Both legacy + new FKs accepted
      // on the update path so the editor can transition without breaking.
      paymentNetDaysTemplateId: 'payment_net_days_template_id',
      paymentTimingTemplateId: 'payment_timing_template_id',
      introText: 'intro_text',
      outroText: 'outro_text',
      internalNotes: 'internal_notes',
      ccPdfEmail: 'cc_pdf_email',
      businessBankAccountId: 'business_bank_account_id',
      validUntil: 'valid_until',
      language: 'language',
      // Migration 220 — quote-wide hours / days.
      hours: 'hours',
      days: 'days',
    };
    for (const [api, col] of Object.entries(map)) {
      if (Object.prototype.hasOwnProperty.call(payload, api)) {
        updates[col] = payload[api];
      }
    }
    // Migration 142 — ad-hoc installments override (commit #6). Treated
    // separately because it needs JSON encoding + "empty array means
    // clear the override" semantics.
    if (Object.prototype.hasOwnProperty.call(payload, 'installments')) {
      updates.payment_term_installments_override =
        Array.isArray(payload.installments) && payload.installments.length > 0
          ? JSON.stringify(payload.installments)
          : null;
    }
    // Migration 121 — optional Project Overview link.
    if (hasProjectId) {
      updates.project_id = payload.projectId || null;
    }
    // Migration 130 — VAT code snapshot.
    if (hasVatCode) {
      updates.vat_code = payload.vatCode ? String(payload.vatCode).slice(0, 16) : null;
    }
    // Migration 146 — event type.
    if (hasEventType) {
      updates.event_type = payload.eventType ? String(payload.eventType).slice(0, 64) : null;
    }
    // Migration 147 — selected booking workflow.
    if (hasBookingWorkflowId) {
      updates.booking_workflow_id = payload.bookingWorkflowId || null;
    }
    const history = { actor: adminId, source: 'quote.update' };
    await auditedUpdate(trx, 'quotes', { id }, updates, history);

    // When linked to a project, cascade across the deal lineage so the linked
    // contract / event / invoices roll up into the same project automatically.
    if (updates.project_id) {
      const dealRow = await trx('quotes').where({ id }).select('deal_uuid').first();
      await require('./projectService').linkDealToProject(dealRow && dealRow.deal_uuid, updates.project_id, trx, { id: adminId });
    }

    // Delete + reinsert keeps the editor flow simple: the frontend
    // sends the canonical line-item set on every save, we drop the
    // old rows and rebuild from scratch. CASCADE on parent_line_item_id
    // means deleting parents sweeps their sub-items too, so there's
    // no orphan risk here.
    await auditedDelete(trx, 'quote_line_items', { quote_id: id }, history);
    if (totals.lineItems.length > 0) {
      const rows = totals.lineItems.map((li, idx) => ({
        position: ensureInt(li.position) || (idx + 1),
        quantity: ensureNumber(li.quantity, 1),
        description: String(li.description || ''),
        unit_price_minor: ensureInt(li.unit_price_minor),
        discount_percent: ensureNumber(li.discount_percent, 0),
        line_total_minor: li.line_total_minor,
        details_text: li.details_text || null,
        parent_position: li.parent_position || null,
        ...extendedLineColumns(li),
      }));
      validateLineItemHierarchy(rows);
      await insertLineItemsHierarchical(trx, 'quote_line_items', 'quote_id', id, rows, history);
    }

    try {
      // Pass trx: through the global db this insert waits on the single-
      // connection SQLite pool for the connection this transaction holds,
      // stalling every save for the 60s acquire timeout and losing the row.
      await logActivity('quote_updated', { quoteId: id }, null, `admin:${adminId}`, trx);
    } catch (_) { /* non-fatal */ }
  });
}

/**
 * Build the renderer context object from the quote + DB lookups. Shared
 * by sendQuote (where we persist the PDF) and previewQuote* (where we
 * just return the buffer to the admin).
 */
async function buildRenderContext(quote, lineItems) {
  const { profile } = await businessProfileService.getProfile();
  const customer = await db('customer_accounts').where({ id: quote.customer_account_id }).first();
  // The row keeps the raw intro / outro; {{placeholders}} resolve here (#1451).
  const texts = await require('./quoteTemplateService').resolveQuoteTexts(quote, { customer: customer || null, profile });
  const bank = quote.business_bank_account_id
    ? await db('business_bank_accounts').where({ id: quote.business_bank_account_id }).first()
    : await businessProfileService.resolveBankAccountForCurrency(quote.currency);
  const paymentTerm = quote.payment_term_template_id
    ? await db('payment_term_templates').where({ id: quote.payment_term_template_id }).first()
    : null;

  // Resolve the PDF logo to a verified absolute disk path. The
  // helper exhaustively tries:
  //   1. business_profile.logo_path
  //   2. app_settings.branding_logo_path  (absolute multer path)
  //   3. app_settings.branding_logo_url   (URL path)
  // …and for each, generates ~7 candidate disk locations before
  // giving up. Returns null + logs a detailed warning when nothing
  // resolves. Already-verified path means the renderer never has
  // to second-guess.
  const { resolveLogoFile } = require('../utils/resolveLogoFile');
  const resolvedLogoPath = await resolveLogoFile(profile);

  // Resolve Skonto values for the PDF payment block:
  //   - if the chosen template defines its own skonto_percent +
  //     skonto_within_days, use those (per-template wins);
  //   - otherwise fall back to the global CRM defaults
  //     (crm_invoices_skonto_percent_default + _business_days);
  //   - the whole row is suppressed when the global
  //     `crm_quotes_skonto_enabled` toggle is off.
  const skontoEnabled = (await getAppSetting('crm_quotes_skonto_enabled')) !== false;
  let skontoPercent = paymentTerm?.skonto_percent;
  let skontoWithinDays = paymentTerm?.skonto_within_days;
  if (skontoEnabled && (skontoPercent == null || skontoWithinDays == null)) {
    const defaultPct = Number(await getAppSetting('crm_invoices_skonto_percent_default'));
    const defaultDays = parseInt(await getAppSetting('crm_invoices_skonto_business_days'), 10);
    if (skontoPercent == null && Number.isFinite(defaultPct) && defaultPct > 0) skontoPercent = defaultPct;
    if (skontoWithinDays == null && Number.isFinite(defaultDays) && defaultDays > 0) skontoWithinDays = defaultDays;
  }
  if (!skontoEnabled) {
    skontoPercent = null;
    skontoWithinDays = null;
  }

  // Global date format from Settings → General (general_date_format).
  // Stored as JSON `{ format, locale }`; missing or malformed entries
  // fall back to DD.MM.YYYY in the renderer.
  let dateFormat = null;
  try {
    const raw = await getAppSetting('general_date_format');
    if (raw && typeof raw === 'object' && raw.format) dateFormat = raw;
    else if (typeof raw === 'string' && raw.trim()) dateFormat = { format: raw.trim() };
  } catch (_) { /* fall back to default */ }

  // Sub-cent reconciliation (crm_invoice_round_total). The displayed
  // "Betrag Netto" is always the sum of the visible line totals so it
  // foots with the items; the stored net may be the clean (rounded-once)
  // value, in which case the gap is shown as a "Rundung" row. For
  // legacy/unrounded quotes the two are equal ⇒ adjustment 0, no row.
  // Unselected optional add-ons (and their sub-items) are left off the PDF
  // body and out of the displayed net (#1451).
  const visibleLineItems = countedLineItems(lineItems);
  // By object, not by id: a preview of unsaved lines has no ids yet.
  const visibleLines = new Set(visibleLineItems);
  const displayedNetMinor = visibleLineItems.reduce(
    (s, li) => (li.parent_line_item_id == null && (li.parent_position == null || li.parent_position === '')
      ? s + ensureInt(li.line_total_minor) : s),
    0,
  );
  const roundingAdjustmentMinor = ensureInt(quote.net_amount_minor) - displayedNetMinor;

  // Not VAT-registered (Settings → Accounting): a quote without VAT shows no
  // MwSt. row, and nothing stands in its place. The note that fills that gap on
  // an invoice is an invoice's statement — the setting is
  // `crm_invoices_vat_note_text`, and MWSTG Art. 10 Abs. 2 is something a bill
  // declares, not an offer. A quote that repeated it read as though the offer
  // itself were the tax document.
  const vatRegistered = await getVatRegisteredSetting();

  return {
    locale: quote.language || profile?.default_locale || 'de',
    currency: quote.currency,
    qrFormat: 'none', // quotes never carry a Swiss QR-bill
    vatRegistered,
    dateFormat,
    // PDF theme (#1445): font family, colours, footer, page numbers.
    theme: await pdfThemeService.resolveTheme('quote'),
    // Issuer + recipient blocks are shared across all three doc services.
    // The quote variant opts into the two extra payment-block toggles.
    // See backend/src/services/_renderContext.js for the spec + drift
    // history.
    issuer: buildIssuerBlock(profile, resolvedLogoPath, { quoteToggles: true }),
    recipient: buildRecipientBlock(profile, customer),
    bank: bank ? {
      accountHolder: bank.account_holder || profile?.company_name,
      iban: bank.iban,
      bic: bank.bic,
      currency: bank.currency,
    } : null,
    // Resolved above so Skonto honours the global enable toggle + the
    // default-rate fallback. If no template is selected at all we
    // still pass the Skonto defaults through so the PDF can show a
    // sensible "X% discount if paid within Y days" line.
    paymentTerm: paymentTerm || skontoPercent || skontoWithinDays ? {
      description: paymentTerm?.description,
      netDays: paymentTerm?.net_days,
      skontoPercent,
      skontoWithinDays,
    } : null,
    // Every line, add-ons included (#1451): a booked add-on is marked and
    // counted; one that isn't booked is marked "not in total", shown muted
    // and left out of the net above.
    lineItems: lineItems.map((li) => ({
      quantity: li.quantity,
      description: li.description,
      unitPriceMinor: li.unit_price_minor,
      discountPercent: li.discount_percent,
      lineTotalMinor: li.line_total_minor,
      // Migration 220 — discount lines render as a labelled minus row;
      // `unit` fills the unit column.
      lineKind: li.line_kind || 'item',
      unit: li.unit || null,
      promotion: parsePromotionSnapshot(li.promotion_snapshot),
      // Migration 119 hierarchy + details — surfaced to the PDF
      // renderer so drawLineItems can indent sub-items + render
      // details_text below.
      parentLineItemId: li.parent_line_item_id || null,
      parentPosition: li.parent_position == null ? null : Number(li.parent_position),
      detailsText: li.details_text || null,
      addOn: li.line_kind !== 'discount' && isTruthyFlag(li.is_optional)
        && li.parent_line_item_id == null && (li.parent_position == null || li.parent_position === '')
        ? (visibleLines.has(li) ? 'booked' : 'not_booked')
        : null,
      excluded: !visibleLines.has(li),
    })),
    totals: {
      netAmountMinor: displayedNetMinor,
      roundingAdjustmentMinor,
      vatRate: quote.vat_rate,
      vatAmountMinor: quote.vat_amount_minor,
      shippingAmountMinor: quote.shipping_amount_minor,
      totalAmountMinor: quote.total_amount_minor,
    },
    doc: {
      quoteNumber: quote.quote_number,
      issueDate: quote.issue_date,
      validUntil: quote.valid_until,
      // A reissued quote names the quote it replaces, like a reissued invoice.
      replacesQuote: quote.replaces_quote_number
        ? { number: quote.replaces_quote_number, issueDate: quote.replaces_issue_date || null }
        : null,
      introText: texts.introText,
      outroText: texts.outroText,
      totalAmountMinor: quote.total_amount_minor,
    },
  };
}

async function renderQuotePdfBuffer(quoteId) {
  const data = await getQuoteById(quoteId);
  if (!data) throw new AppError('Quote not found', 404);
  const ctx = await buildRenderContext(data.quote, data.lineItems);
  return await pdfService.renderQuoteToBuffer(ctx);
}

/**
 * The quote PDF to show an admin or the customer. Once a quote has been
 * sent, that is the file that went out — later template, branding or
 * setting changes never alter it. A draft renders live.
 */
async function getQuotePdfBuffer(quoteId) {
  const quote = await db('quotes').where({ id: quoteId }).first('status', 'pdf_path');
  if (!quote) throw new AppError('Quote not found', 404);
  if (quote.status !== 'draft') {
    const stored = readStoredDocumentPdf(quote.pdf_path, 'quote');
    if (stored) return stored;
  }
  return renderQuotePdfBuffer(quoteId);
}

/**
 * Preview a quote PDF from an unsaved payload — never touches the DB.
 * The frontend "Preview" button on the editor calls this with the
 * current form state so the admin can validate before saving.
 */
async function renderQuotePdfFromPayload(payload) {
  const customer = await db('customer_accounts').where({ id: payload.customerAccountId }).first();
  const roundTotal = (await getAppSetting('crm_invoice_round_total', false)) === true;
  const preparedLineItems = await prepareQuoteLineItems(payload.lineItems, {
    customerId: payload.customerAccountId,
    currency: (payload.currency || 'CHF').toUpperCase(),
    hours: payload.hours,
    days: payload.days,
  });
  const totals = computeTotals(
    preparedLineItems,
    payload.vatRate,
    payload.shippingAmountMinor,
    { roundTotal }
  );
  const fakeQuote = {
    quote_number: 'PREVIEW',
    customer_account_id: payload.customerAccountId,
    language: payload.language || customer?.preferred_language || 'de',
    currency: (payload.currency || 'CHF').toUpperCase(),
    issue_date: payload.issueDate || new Date().toISOString().slice(0, 10),
    valid_until: payload.validUntil,
    intro_text: payload.introText,
    outro_text: payload.outroText,
    // What the intro / outro {{placeholders}} read.
    event_name: payload.eventName,
    event_date: payload.eventDate,
    hours: payload.hours,
    days: payload.days,
    payment_term_template_id: payload.paymentTermTemplateId,
    business_bank_account_id: payload.businessBankAccountId,
    net_amount_minor: totals.netAmountMinor,
    vat_rate: ensureNumber(payload.vatRate, 0),
    vat_amount_minor: totals.vatAmountMinor,
    shipping_amount_minor: totals.shippingAmountMinor,
    total_amount_minor: totals.totalAmountMinor,
  };
  // Carry position + parent_position + details_text through to the
  // renderer so the preview matches the saved-quote PDF: sub-items
  // render indented with parenthesised totals, parent shows its
  // resolved total (sum of priced sub-items), and details_text rows
  // appear under their parent. Without these fields the renderer
  // treats every row as a top-level item and shows the parent at 0.
  const ctx = await buildRenderContext(fakeQuote, totals.lineItems.map((li, idx) => ({
    position: li.position == null ? idx + 1 : Number(li.position),
    quantity: li.quantity,
    description: li.description,
    unit_price_minor: li.unit_price_minor,
    discount_percent: li.discount_percent,
    line_total_minor: li.line_total_minor,
    parent_position: li.parent_position == null || li.parent_position === '' ? null : Number(li.parent_position),
    details_text: li.details_text || null,
    line_kind: li.line_kind,
    unit: li.unit || null,
    is_optional: li.is_optional,
    selected: li.selected,
    promotion_snapshot: li.promotion_snapshot || null,
  })));
  return await pdfService.renderQuoteToBuffer(ctx);
}

/**
 * Send a quote: render PDF, persist snapshot, generate accept/decline
 * tokens, queue email. Transitions status draft|declined → sent.
 */
async function sendQuote(id, adminId) {
  const data = await getQuoteById(id);
  if (!data) throw new AppError('Quote not found', 404);
  const { quote, lineItems } = data;

  if (!['draft', 'declined', 'expired'].includes(quote.status)) {
    throw new AppError(`Cannot send a quote with status '${quote.status}'`, 409);
  }
  // A reissued quote (#1451) is never sent again: the quote that replaced it is.
  if (await db('quotes').where({ replaces_quote_id: quote.id }).first('id')) {
    throw new AppError('This quote was reissued; send the new quote instead', 409, 'QUOTE_REPLACED');
  }
  assertQuoteTransition(quote.status, 'sent');

  const customer = await db('customer_accounts').where({ id: quote.customer_account_id }).first();
  ensureCustomerFeatureEnabled(customer, 'quotes');
  // Read before the transaction opens — a schema lookup inside it waits on
  // the one SQLite connection the transaction holds.
  const hasNotifiedColumn = await hasColumnCached('quotes', 'acceptance_notified_at');
  const hasEmittedColumn = await hasColumnCached('quotes', 'workflow_response_emitted_at');

  // Render PDF + persist snapshot.
  const ctx = await buildRenderContext(quote, lineItems);
  const buffer = await pdfService.renderQuoteToBuffer(ctx);
  const pdfPath = await persistDocPdf('quote', quote, buffer, '', { kind: 'sent', theme: ctx.theme, issuer: ctx.issuer });

  // Snapshot payment term so future template edits don't mutate the doc.
  // Migration 124 — prefer the two new split FKs; fall back to the legacy
  // single FK when the quote was authored before the split was deployed.
  // Output shape is unchanged: { description, net_days, skonto_percent,
  // skonto_within_days, installments } — that's what pdfService and the
  // scheduler already read.
  const paymentTermSnapshot = await composeSnapshotFromSplitFks(quote)
    || (quote.payment_term_template_id
      ? await db('payment_term_templates').where({ id: quote.payment_term_template_id }).first()
      : null);

  // Mint a single shared token; accept and decline are differentiated
  // by the request body. This makes the email link survive a customer
  // changing their mind inside the 15-min window without sending two
  // links.
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = quote.valid_until
    ? new Date(new Date(quote.valid_until).getTime() + 14 * 24 * 60 * 60 * 1000)
    : new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);

  await db.transaction(async (trx) => {
    await trx('quote_action_tokens').insert({
      quote_id: id,
      token,
      // ISO, like every other value a later check reads back: a bare Date
      // from another realm is stored as "[object Object]", and an expiry
      // nobody can read is one no check can enforce.
      expires_at: stamp(expiresAt),
      created_at: stamp(new Date()),
    });
    await auditedUpdate(trx, 'quotes', { id }, {
      status: 'sent',
      sent_at: new Date(),
      pdf_path: toStoredPath(pdfPath),
      payment_term_snapshot: paymentTermSnapshot ? JSON.stringify(paymentTermSnapshot) : null,
      // A (re)sent quote is a new offer, so nothing of the previous answer
      // carries over: the add-on choice, the answer itself, the response
      // window, the consent to the terms that were shown then, and both
      // "already dealt with" markers. Each one left behind broke the new
      // offer in its own way — the window made the acceptance 423
      // RESPONSE_LOCKED for good, the workflow marker stopped
      // `quote.accepted` from ever firing again, and the consent stamp made
      // the record say the customer had agreed to terms they were not shown
      // this time.
      optional_selection_snapshot: null,
      selection_accepted_at: null,
      selection_changes: null,
      customer_message: null,
      responded_at: null,
      response_locked_at: null,
      accepted_at: null,
      declined_at: null,
      tos_accepted_at: null,
      tos_text_snapshot: null,
      ...(hasNotifiedColumn ? { acceptance_notified_at: null } : {}),
      ...(hasEmittedColumn ? { workflow_response_emitted_at: null } : {}),
      updated_at: new Date(),
    }, { actor: adminId, source: 'quote.send' });
  });

  // Queue customer email (with PDF + cc) — honour the global
  // crm_quotes_pdf_attachment_enabled toggle.
  const attachPdf = await getAppSetting('crm_quotes_pdf_attachment_enabled');
  const frontendUrl = await getFrontendBaseUrl() || 'http://localhost:3000';
  const responseUrl = `${frontendUrl}/quote/${token}`;
  // Add-ons are chosen on the online page; the email says so (#1451).
  const hasAddOns = offeredOptionalPositions(await loadQuoteLinesWithParentPosition(id)).length > 0;
  await emailProcessor.queueEmail(null, customer.email, 'quote_sent', {
    quote_number: quote.quote_number,
    customer_name: customer.display_name || customer.first_name || customer.email.split('@')[0],
    response_url: responseUrl,
    accept_url: `${responseUrl}?action=accept`,
    decline_url: `${responseUrl}?action=decline`,
    valid_until: formatShortDate(quote.valid_until),
    event_name: quote.event_name || '',
    total_amount: formatMajor(quote.total_amount_minor, quote.currency, ctx.locale, ctx.issuer?.countryCode),
    has_add_ons: hasAddOns,
    cc: quote.cc_pdf_email || undefined,
    attachments: (attachPdf !== false && pdfPath) ? [{
      filename: `${quote.quote_number}.pdf`,
      contentPath: pdfPath,
      contentType: 'application/pdf',
    }] : undefined,
  });

  try {
    // Do NOT log the raw bearer token — it grants quote actions and the
    // activity log is readable later (GHSA-prch). The quoteId is the audit key.
    await logActivity('quote_sent', { quoteId: id }, null, `admin:${adminId}`);
  } catch (_) { /* non-fatal */ }

  // Fire the quote.sent workflow trigger (best-effort; emit is fail-closed when
  // the workflows flag is off). The accepted/declined emits already exist; this
  // closes the gap so flows can react to a quote going out.
  await emitQuoteEvent(quote, 'sent');

  logger.info('Quote sent', { adminId, quoteId: id });
  return { token, pdfPath };
}

function formatMajor(minor, currency, locale, issuerCountryCode) {
  // Per maintainer: every DACH-region issuer (FL/CH/DE/AT) writes
  // 1'000.00 with an apostrophe separator regardless of document
  // language. de-CH is the only Intl locale that produces that
  // format, so we force it whenever the issuer sits in that region.
  // Outside DACH we still honour the document locale.
  const cc = (issuerCountryCode || '').toUpperCase();
  const intlLocale = ['CH', 'LI', 'DE', 'AT'].includes(cc)
    ? 'de-CH'
    : (locale === 'de' ? 'de-CH' : 'en-GB');
  return new Intl.NumberFormat(intlLocale, {
    style: 'currency', currency: (currency || 'CHF').toUpperCase(),
  }).format(Number(minor || 0) / 100);
}

/**
 * Persist a rendered PDF under storage/business-docs/quote/<YEAR>/<NUMBER><suffix>.pdf
 * and record it in generated_documents (#1445). `suffix` keeps a later
 * version (e.g. '-accepted') next to the sent file; `meta` carries the kind
 * and the theme / issuer it was rendered with.
 */
async function persistDocPdf(type, doc, buffer, suffix = '', meta = {}) {
  const number = doc.quote_number || doc.invoice_number;
  if (!number) return null;
  const year = (doc.issue_date ? new Date(doc.issue_date) : new Date()).getFullYear();
  const stored = await documentArtifactService.persist({
    docType: type,
    docId: doc.id,
    kind: meta.kind || (suffix ? 'accepted' : 'sent'),
    buffer,
    fileName: `${number}${suffix}.pdf`,
    year,
    theme: meta.theme,
    issuer: meta.issuer,
  });
  return stored.path;
}

// ---------------------------------------------------------------------
// Optional add-ons chosen when a quote is accepted (#1451 phase 2)
// ---------------------------------------------------------------------

/** A quote's lines with `parent_position`, the shape getQuoteById returns. */
async function loadQuoteLinesWithParentPosition(quoteId) {
  return db('quote_line_items as li')
    .leftJoin('quote_line_items as parent', 'parent.id', 'li.parent_line_item_id')
    .where('li.quote_id', quoteId)
    .orderBy('li.position', 'asc')
    .select('li.*', 'parent.position as parent_position');
}

/**
 * Timestamps that are compared again later — the response window, the
 * acceptance — are written as ISO strings. A bare Date from another realm
 * (which is what Jest hands a service) is stored by node-sqlite3 as
 * "[object Object]", and a window that can't be read is a window no check can
 * enforce: the lock silently stopped working under test, and hid a re-sent
 * quote that could never be accepted.
 */
const stamp = (date) => (date instanceof Date ? date.toISOString() : date);

const isTopLevelRow = (li) => li.parent_position == null || li.parent_position === '';
const topPositionOf = (li) => ensureInt(isTopLevelRow(li) ? li.position : li.parent_position);

/** Positions of the top-level optional add-ons a quote offers. */
function offeredOptionalPositions(lineItems) {
  return lineItems
    .filter((li) => isTopLevelRow(li) && li.line_kind !== 'discount' && isTruthyFlag(li.is_optional))
    .map((li) => ensureInt(li.position));
}

/** The offered add-ons that are currently selected, in position order. */
function currentOptionalSelection(lineItems) {
  const offered = new Set(offeredOptionalPositions(lineItems));
  return lineItems
    .filter((li) => isTopLevelRow(li) && offered.has(ensureInt(li.position)) && !isUnselectedOptional(li))
    .map((li) => ensureInt(li.position))
    .sort((a, b) => a - b);
}

/**
 * The lines with `selected` set from a choice of add-on positions; sub-items
 * follow their parent. Anything that isn't an offered add-on is refused, so
 * a choice can only switch optional lines on or off.
 */
function applyOptionalSelection(lineItems, selectedPositions) {
  const offered = new Set(offeredOptionalPositions(lineItems));
  const chosen = new Set();
  for (const value of selectedPositions || []) {
    const position = ensureInt(value);
    if (!offered.has(position)) {
      throw new AppError('Only optional add-ons can be chosen', 400, 'INVALID_SELECTION');
    }
    chosen.add(position);
  }
  return {
    chosen: [...chosen].sort((a, b) => a - b),
    lines: lineItems.map((li) => (offered.has(topPositionOf(li))
      ? { ...li, selected: chosen.has(topPositionOf(li)) }
      : li)),
  };
}

/** Totals for an add-on choice — the same computeTotals a save runs. */
async function totalsForSelection(quote, lineItems, selectedPositions) {
  const { chosen, lines } = applyOptionalSelection(lineItems, selectedPositions);
  const roundTotal = (await getAppSetting('crm_invoice_round_total', false)) === true;
  const totals = computeTotals(lines, quote.vat_rate, quote.shipping_amount_minor, { roundTotal });
  // Same rule as create and update: a quote is an offer, never a credit
  // note. Removing an add-on shrinks the subtotal a manual negative line is
  // taken from, so a choice the customer is free to make could otherwise
  // store an accepted quote with a total below zero.
  if (totals.totalAmountMinor < 0) {
    throw new AppError(
      'That choice would make the quote total negative. Please contact us instead.',
      409, 'QUOTE_TOTAL_NEGATIVE',
    );
  }
  return { chosen, totals };
}

/**
 * Live totals for the public quote page while the customer ticks add-ons.
 * Read-only: the same calculation runs again, authoritatively, on accept.
 */
async function previewOptionalSelection(quoteId, selectedPositions) {
  const quote = await db('quotes').where({ id: quoteId }).first();
  if (!quote) throw new AppError('Quote not found', 404);
  const lineItems = await loadQuoteLinesWithParentPosition(quoteId);
  const { chosen, totals } = await totalsForSelection(quote, lineItems, selectedPositions);
  return {
    selectedOptional: chosen,
    netAmountMinor: totals.netAmountMinor,
    vatAmountMinor: totals.vatAmountMinor,
    shippingAmountMinor: totals.shippingAmountMinor,
    totalAmountMinor: totals.totalAmountMinor,
    // Discount lines follow the subtotal, so their amounts move with the choice.
    lines: totals.lineItems.map((li) => ({
      position: ensureInt(li.position),
      lineTotalMinor: ensureInt(li.line_total_minor),
    })),
  };
}

const storedJson = (raw, fallback) => {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) {
    return fallback;
  }
};

/** One entry of a quote's add-on change history (#1451). */
function selectionChange(lineItems, before, after, totalBeforeMinor, totals, by, adminId, at) {
  const had = new Set(before);
  const has = new Set(after);
  const describe = (positions) => lineItems
    .filter((li) => isTopLevelRow(li) && positions.includes(ensureInt(li.position)))
    .map((li) => li.description);
  return {
    at: at.toISOString(),
    by,
    adminId: adminId || null,
    booked: describe(after.filter((p) => !had.has(p))),
    removed: describe(before.filter((p) => !has.has(p))),
    totalBeforeMinor: ensureInt(totalBeforeMinor),
    totalAfterMinor: totals.totalAmountMinor,
  };
}

function selectionSnapshot(lineItems, chosen, totals, by) {
  const offered = new Set(offeredOptionalPositions(lineItems));
  const chosenSet = new Set(chosen);
  return {
    by,
    selectedOptional: chosen,
    addOns: lineItems
      .filter((li) => isTopLevelRow(li) && offered.has(ensureInt(li.position)))
      .map((li) => ({
        position: ensureInt(li.position),
        description: li.description,
        selected: chosenSet.has(ensureInt(li.position)),
      })),
    netAmountMinor: totals.netAmountMinor,
    vatAmountMinor: totals.vatAmountMinor,
    totalAmountMinor: totals.totalAmountMinor,
  };
}

/**
 * Store an accepted add-on choice: the line flags, the recomputed discount
 * amounts and quote totals, and a snapshot of what was chosen. The stored
 * PDF pointer is cleared — the sent file shows the offer, not the choice —
 * until storeAcceptedQuotePdf writes the accepted version.
 */
async function writeAcceptedSelection(
  trx, quote, lineItems, { chosen, totals }, by, at,
  { previousChosen = null, adminId = null, history = null } = {},
) {
  const record = history || { actor: adminId, source: `quote.addons.${by}` };
  // The history, the first-chosen snapshot and what the choice was BEFORE
  // this change are read inside the transaction: two changes landing together
  // both read the row before either wrote, so one entry replaced the other
  // and both recorded the same stale "before".
  const current = (await trx('quotes').where({ id: quote.id }).forUpdate().first()) || quote;
  const locked = await trx('quote_line_items as li')
    .leftJoin('quote_line_items as parent', 'parent.id', 'li.parent_line_item_id')
    .where('li.quote_id', quote.id)
    .orderBy('li.position', 'asc')
    .select('li.*', 'parent.position as parent_position');
  const offered = new Set(offeredOptionalPositions(lineItems));
  const chosenSet = new Set(chosen);
  const on = [];
  const off = [];
  for (const li of lineItems) {
    const top = topPositionOf(li);
    if (!offered.has(top)) continue;
    (chosenSet.has(top) ? on : off).push(li.id);
  }
  if (on.length) {
    await auditedUpdate(trx, 'quote_line_items', (q) => q.whereIn('id', on),
      { selected: formatBoolean(true) }, record);
  }
  if (off.length) {
    await auditedUpdate(trx, 'quote_line_items', (q) => q.whereIn('id', off),
      { selected: formatBoolean(false) }, record);
  }
  for (const li of totals.lineItems) {
    if (li.line_kind !== 'discount' || li.id == null) continue;
    await auditedUpdate(trx, 'quote_line_items', { id: li.id }, {
      unit_price_minor: ensureInt(li.unit_price_minor),
      line_total_minor: ensureInt(li.line_total_minor),
    }, record);
  }
  // A change after the first acceptance (#1451) keeps when and by whom the
  // add-ons were first chosen, and adds an entry to the change history.
  // `previousChosen` says only *that* this is a change; what it changed from
  // is read here, under the lock.
  const isChange = Array.isArray(previousChosen);
  const before = isChange ? currentOptionalSelection(locked) : null;
  const firstBy = isChange ? (storedJson(current.optional_selection_snapshot, {}).by || by) : by;
  await auditedUpdate(trx, 'quotes', { id: quote.id }, {
    net_amount_minor: totals.netAmountMinor,
    vat_amount_minor: totals.vatAmountMinor,
    total_amount_minor: totals.totalAmountMinor,
    optional_selection_snapshot: JSON.stringify(selectionSnapshot(lineItems, chosen, totals, firstBy)),
    selection_accepted_at: isChange ? current.selection_accepted_at : at,
    ...(isChange ? {
      selection_changes: JSON.stringify([
        ...storedJson(current.selection_changes, []),
        selectionChange(lineItems, before, chosen, current.total_amount_minor, totals, by, adminId, at),
      ]),
    } : {}),
    pdf_path: null,
  }, record);
}

// Each version of the accepted quote keeps its own file (#1451): the first
// acceptance is "-accepted", every later one "-accepted-2", "-accepted-3", …
// Counted from the documents already stored, not from the change history: a
// decline and a re-send clear the history, and two changes at once read the
// same array, so both pointed at one name. persist() also refuses to
// overwrite, so an earlier version's recorded sha256 stays true either way.
async function acceptedSuffix(quoteId) {
  const stored = await db('generated_documents')
    .where({ doc_type: 'quote', doc_id: quoteId, kind: 'accepted' })
    .count({ count: '*' })
    .first();
  const version = ensureInt(stored && stored.count) + 1;
  return version > 1 ? `-accepted-${version}` : '-accepted';
}

/** Render and keep the accepted version of a quote; the sent file stays as it was. */
async function storeAcceptedQuotePdf(quoteId) {
  try {
    const data = await getQuoteById(quoteId);
    const ctx = await buildRenderContext(data.quote, data.lineItems);
    const buffer = await pdfService.renderQuoteToBuffer(ctx);
    const pdfPath = await persistDocPdf('quote', data.quote, buffer, await acceptedSuffix(quoteId),
      { kind: 'accepted', theme: ctx.theme, issuer: ctx.issuer });
    await auditedUpdate(db, 'quotes', { id: quoteId }, { pdf_path: toStoredPath(pdfPath) },
      { source: 'quote.accepted.pdf' });
  } catch (err) {
    // pdf_path is already cleared, so the quote renders live — with the
    // chosen add-ons — until a file is stored.
    logger.warn('Could not store the accepted quote PDF', { quoteId, error: err.message });
  }
}

const customerDisplayName = (customer) => customer.display_name
  || [customer.first_name, customer.last_name].filter(Boolean).join(' ')
  || String(customer.email || '').split('@')[0];

/**
 * Tell the business that the customer accepted (#1451): the total, the
 * booked add-ons and the customer's message. Sent to the business profile's
 * email; never fails the acceptance.
 */
async function notifyBusinessOfAcceptance(quoteId, { onlyOnce = false } = {}) {
  try {
    // Claimed before the mail is built, so two acceptances arriving together
    // send one notice.
    if (await hasColumnCached('quotes', 'acceptance_notified_at')) {
      const claim = db('quotes').where({ id: quoteId });
      if (onlyOnce) claim.whereNull('acceptance_notified_at');
      const claimed = await claim.update({ acceptance_notified_at: new Date().toISOString() });
      if (!claimed) return;
    }
    const { profile } = await businessProfileService.getProfile();
    if (!profile || !profile.email) return;
    const quote = await db('quotes').where({ id: quoteId }).first();
    const customer = await db('customer_accounts').where({ id: quote.customer_account_id }).first();
    const frontendUrl = (await getFrontendBaseUrl()) || 'http://localhost:3000';
    const snapshot = storedJson(quote.optional_selection_snapshot, null);
    await emailProcessor.queueEmail(null, profile.email, 'quote_accepted_admin', {
      quote_number: quote.quote_number,
      customer_email: (customer && customer.email) || '',
      event_name: quote.event_name || '',
      total_amount: formatMajor(quote.total_amount_minor, quote.currency, quote.language || 'de', profile.country_code || null),
      admin_dashboard_url: `${frontendUrl}/admin/clients/quotes/${quote.id}`,
      booked_add_ons: snapshot && Array.isArray(snapshot.addOns)
        ? snapshot.addOns.filter((a) => a.selected).map((a) => a.description).join(', ')
        : '',
      customer_message: quote.customer_message || '',
    });
  } catch (err) {
    logger.warn('Could not queue the quote-accepted notice', { quoteId, error: err.message });
  }
}

/** Email the customer the quote after their add-ons were changed (#1451). */
async function emailAddOnChange(quoteId, change) {
  try {
    const quote = await db('quotes').where({ id: quoteId }).first();
    const customer = await db('customer_accounts').where({ id: quote.customer_account_id }).first();
    if (!customer || !customer.email) return;
    const { profile } = await businessProfileService.getProfile();
    await emailProcessor.queueEmail(null, customer.email, 'quote_addons_updated', {
      quote_number: quote.quote_number,
      customer_name: customerDisplayName(customer),
      event_name: quote.event_name || '',
      total_amount: formatMajor(quote.total_amount_minor, quote.currency, quote.language || 'de', (profile && profile.country_code) || null),
      booked_list: change.booked.join(', '),
      removed_list: change.removed.join(', '),
      // Storing the PDF is best effort; only claim it when it is there.
      has_pdf: Boolean(quote.pdf_path),
      cc: quote.cc_pdf_email || undefined,
      attachments: quote.pdf_path ? [{
        filename: `${quote.quote_number}.pdf`,
        contentPath: resolveStoredPath(quote.pdf_path) || quote.pdf_path,
        contentType: 'application/pdf',
      }] : undefined,
    });
  } catch (err) {
    logger.warn('Could not email the add-on change', { quoteId, error: err.message });
  }
}

/**
 * The add-on choice a customer's acceptance carries, checked against the
 * total their page showed. Returns null when the quote offers no add-ons, or
 * when an accepted quote is accepted again with the same choice. Accepting
 * again with another choice changes it (#1451): recordResponse has already
 * refused a closed response window, so only the window allows it.
 */
async function resolveCustomerSelection(quote, { selectedOptional, expectedTotalMinor }) {
  const lineItems = await loadQuoteLinesWithParentPosition(quote.id);
  if (offeredOptionalPositions(lineItems).length === 0) return null;
  const current = currentOptionalSelection(lineItems);
  const asked = Array.isArray(selectedOptional)
    ? [...new Set(selectedOptional.map(ensureInt))].sort((a, b) => a - b)
    : null;
  if (quote.selection_accepted_at && (!asked || asked.join(',') === current.join(','))) return null;
  const selection = await totalsForSelection(quote, lineItems, asked || current);
  if (expectedTotalMinor == null) {
    throw new AppError('Confirm the total before accepting', 400, 'TOTAL_REQUIRED');
  }
  if (ensureInt(expectedTotalMinor) !== selection.totals.totalAmountMinor) {
    const err = new AppError('The total has changed. Check it and accept again.', 409, 'TOTAL_MISMATCH');
    err.totalAmountMinor = selection.totals.totalAmountMinor;
    throw err;
  }
  return { lineItems, ...selection, previousChosen: quote.selection_accepted_at ? current : null };
}

/**
 * Record a customer response from the public accept/decline link.
 *
 * 15-min toggle rule: the first response opens a window equal to
 * crm_quotes_accept_window_minutes (default 15). Within that window
 * the same token may flip accept↔decline. After the window expires the
 * response is locked.
 */
/**
 * Fire a quote lifecycle event for the workflow engine. Best-effort: resolves
 * the customer email (so send_email actions have a recipient) and never throws
 * into the caller. No-op when the workflows flag is off (emit fails closed).
 */
async function emitQuoteEvent(quote, status) {
  try {
    let customerEmail = null;
    if (quote.customer_account_id) {
      const c = await db('customer_accounts').where({ id: quote.customer_account_id }).first();
      customerEmail = c?.email || null;
    }
    // On acceptance, if the admin picked a booking workflow on the quote, run
    // ONLY that flow (instead of fanning out to every enabled quote.accepted
    // flow). Other statuses keep the normal fan-out.
    const targetWorkflowId = (status === 'accepted' && quote.booking_workflow_id)
      ? quote.booking_workflow_id
      : null;
    await require('./workflows').emitWorkflowEvent(`quote.${status}`, {
      entityType: 'quote',
      entityId: quote.id,
      targetWorkflowId,
      payload: {
        quoteId: quote.id,
        quoteNumber: quote.quote_number,
        customerAccountId: quote.customer_account_id || null,
        customerEmail,
        eventName: quote.event_name || null,
        eventDate: quote.event_date || null,
        eventType: quote.event_type || null,
        totalMinor: quote.total_amount_minor ?? null,
        bookingWorkflowId: quote.booking_workflow_id || null,
      },
    });
  } catch (_) { /* best-effort */ }
}

/**
 * Emit a quote accept/decline to the workflow engine — but only once the
 * customer's response window has LOCKED. While the window is open (the public
 * page lets them flip accept↔decline for crm_quotes_accept_window_minutes), an
 * immediate emit would let the booking flow convert the quote right away,
 * defeating the grace period (the quote went straight to 'converted' and could
 * no longer be declined). So:
 *   - window already closed (0-minute window, or admin decline) → emit now and
 *     stamp `workflow_response_emitted_at` (idempotent claim).
 *   - window still open → defer; `finalizeQuoteResponses` (scheduler) fires the
 *     FINAL status once it locks, so toggling inside the window never converts.
 * Returns true if it emitted, false if deferred / already emitted.
 * `history` is the { actor, source } of the response being emitted.
 */
async function maybeEmitQuoteResponse(quote, status, responseLockedAt, history = {}) {
  const lockedAtMs = toMillis(responseLockedAt);
  const locked = !responseLockedAt || lockedAtMs == null || lockedAtMs <= Date.now();
  if (!locked) return false; // deferred to the finalize sweep
  const hasCol = await hasColumnCached('quotes', 'workflow_response_emitted_at');
  if (hasCol) {
    // Atomically claim the emit so a concurrent finalize sweep can't double-fire.
    const claimed = await auditedUpdate(db, 'quotes',
      (q) => q.where({ id: quote.id }).whereNull('workflow_response_emitted_at'),
      { workflow_response_emitted_at: stamp(new Date()) }, history);
    if (!claimed) return false; // already emitted elsewhere
  }
  await emitQuoteEvent(quote, status);
  return true;
}

/**
 * Scheduler sweep: fire the workflow event for quote responses whose toggle
 * window has now locked but which were deferred at response time. Idempotent via
 * `workflow_response_emitted_at` (atomic claim). Called from the CRM scheduler
 * tick. Returns the number emitted.
 */
async function finalizeQuoteResponses(limit = 200) {
  const hasCol = await hasColumnCached('quotes', 'workflow_response_emitted_at');
  if (!hasCol) return 0; // pre-migration install — nothing to finalise
  // The unemitted accept/decline set is naturally small (a row leaves it the
  // moment it's emitted), so fetch the candidates and compare the lock time in
  // JS — avoids SQLite/Postgres date-string comparison pitfalls.
  const now = Date.now();
  const candidates = await db('quotes')
    .whereIn('status', ['accepted', 'declined'])
    .whereNull('workflow_response_emitted_at')
    .whereNotNull('response_locked_at')
    .limit(limit);
  // An unreadable lock time counts as past: the alternative is a row this
  // sweep skips on every run, so the workflow event never fires at all.
  const rows = candidates.filter((q) => {
    const at = toMillis(q.response_locked_at);
    return at == null || at <= now;
  });
  let emitted = 0;
  for (const q of rows) {
    const claimed = await auditedUpdate(db, 'quotes',
      (query) => query.where({ id: q.id }).whereNull('workflow_response_emitted_at'),
      { workflow_response_emitted_at: stamp(new Date()) },
      { actor: 'scheduler', source: 'quote.response.finalize' });
    if (!claimed) continue; // raced with another tick / the inline emit
    await emitQuoteEvent(q, q.status);
    emitted += 1;
  }
  return emitted;
}

// The change history's actor for a response through the emailed link. The
// token row names only the quote, not who holds the link.
const QUOTE_LINK_ACTOR = { type: 'public', id: null, name: 'quote-link' };

/**
 * `actor` names the responder in the accounting change history: the customer
 * portal passes the signed-in customer; the public link leaves the default.
 */
async function recordResponse({
  token, action, ip, tosAccepted, selectedOptional, expectedTotalMinor, customerMessage,
  actor = QUOTE_LINK_ACTOR,
}) {
  if (!['accept', 'decline'].includes(action)) {
    throw new AppError('Invalid action', 400);
  }
  const tokenRow = await db('quote_action_tokens').where({ token }).first();
  if (!tokenRow) {
    throw new AppError('Token not found', 404);
  }
  // A token without an expiry is refused, not treated as permanent: the
  // column is NOT NULL and the route guard already refuses one, so this only
  // matters for a caller that reaches the service another way.
  const tokenExpires = toMillis(tokenRow.expires_at);
  if (tokenExpires == null || tokenExpires < Date.now()) {
    throw new AppError('Token expired', 410);
  }

  const quote = await db('quotes').where({ id: tokenRow.quote_id }).first();
  if (!quote) {
    throw new AppError('Quote not found', 404);
  }
  if (!['sent', 'accepted', 'declined'].includes(quote.status)) {
    throw new AppError(`Quote cannot be responded to in status '${quote.status}'`, 409);
  }
  // A reissued quote (#1451) is closed for good, whatever its response
  // window says: the customer answers the quote that replaced it.
  if (await db('quotes').where({ replaces_quote_id: quote.id }).first('id')) {
    throw new AppError('This quote was reissued; the new quote replaces it', 410, 'QUOTE_REPLACED');
  }
  // Converting leaves the quote `accepted`, so without this an accepted
  // quote could still be re-accepted with other add-ons inside the response
  // window — changing the lines the contract's own line table reads. Only a
  // second response is locked: a quote can carry a manual invoice before the
  // customer has answered it at all.
  if (quote.status === 'accepted') {
    await assertQuoteNotConverted(quote, 'This quote already has a contract, event or invoice, so it can no longer be changed here.');
  }

  // Terms of Service handling on accept:
  //   - Setting OFF: ignored.
  //   - Setting ON + box ticked: normal acceptance; ToS snapshot
  //     stored on the quote for audit.
  //   - Setting ON + box NOT ticked: server returns TOS_REQUIRED;
  //     the frontend keeps Accept disabled until ticked. To refuse
  //     the engagement the customer clicks Decline explicitly, which
  //     records `declined` like any other decline (no ToS needed for
  //     decline since the customer is rejecting the terms anyway).
  const tosRequired = await getAppSetting('crm_quotes_tos_required', false) === true;
  const tosText = await getAppSetting('crm_quotes_tos_text', '');
  if (action === 'accept' && tosRequired && !tosAccepted) {
    throw new AppError('Terms of Service must be accepted before the quote can be accepted.',
      400, 'TOS_REQUIRED');
  }
  const effectiveAction = action;

  const now = new Date();
  const windowMinutes = ensureInt(await getAppSetting('crm_quotes_accept_window_minutes')) || 15;
  // If there's already a response, check if we're inside the toggle window.
  // A lock time this process can't read counts as closed: `NaN > now` is
  // false, so an unreadable value used to wave every answer through — the
  // same fail-open shape as an unreadable expiry, and it hid the bug above
  // from the SQLite test run.
  if (quote.responded_at && quote.response_locked_at) {
    const lockedAt = toMillis(quote.response_locked_at);
    if (lockedAt == null || now.getTime() > lockedAt) {
      const err = new AppError('Response window has closed', 423, 'RESPONSE_LOCKED');
      err.lockedAt = quote.response_locked_at;
      err.currentStatus = quote.status;
      throw err;
    }
  }

  const isAccept = effectiveAction === 'accept';
  const newStatus = isAccept ? 'accepted' : 'declined';
  const respondedAt = quote.responded_at || now;
  const responseLockedAt = new Date(new Date(respondedAt).getTime() + windowMinutes * 60 * 1000);
  assertQuoteTransition(quote.status, newStatus);
  const history = { actor, source: 'quote.respond' };
  // Optional add-ons (#1451 phase 2), checked before anything is written.
  const selection = isAccept
    ? await resolveCustomerSelection(quote, { selectedOptional, expectedTotalMinor })
    : null;

  await db.transaction(async (trx) => {
    const updates = {
      status: newStatus,
      responded_at: stamp(respondedAt),
      response_locked_at: stamp(responseLockedAt),
      accepted_at: isAccept ? stamp(now) : null,
      declined_at: !isAccept ? stamp(now) : null,
      updated_at: now,
    };
    // Snapshot the ToS text the customer agreed to. Only set on the
    // FIRST acceptance — subsequent toggles inside the 15-min window
    // don't overwrite, so the audit trail captures the original
    // agreement moment.
    if (isAccept && tosAccepted && !quote.tos_accepted_at) {
      updates.tos_accepted_at = stamp(now);
      updates.tos_text_snapshot = tosText || null;
    }
    // What the customer wrote with the acceptance (#1451); accepting again
    // without a message keeps the earlier one.
    const message = isAccept && customerMessage ? String(customerMessage).trim().slice(0, 2000) : '';
    if (message) updates.customer_message = message;
    // Conditional on the status this request read: a conversion committing
    // between the checks above and here would otherwise be flipped back to
    // accepted or declined by an answer that never saw it.
    const applied = await auditedUpdate(trx, 'quotes', { id: quote.id, status: quote.status }, updates, history);
    if (!applied) {
      throw new AppError('This quote changed while you were answering it. Reload the page.', 409, 'QUOTE_CHANGED');
    }
    if (selection) {
      await writeAcceptedSelection(trx, quote, selection.lineItems, selection, 'customer', now,
        { previousChosen: selection.previousChosen, history });
    }
    await trx('quote_action_tokens').where({ id: tokenRow.id }).update({
      used_at: now,
      used_action: newStatus,
      used_ip: ip || null,
    });
  });

  if (selection) await storeAcceptedQuotePdf(quote.id);
  // The business hears about an acceptance once, and again only when the
  // add-on choice actually changed. Inside the response window the customer
  // can accept, decline and accept again, and each of those used to send
  // another "quote accepted" mail saying the same thing.
  if (isAccept) {
    await notifyBusinessOfAcceptance(quote.id, { onlyOnce: !(selection && Array.isArray(selection.previousChosen)) });
  }

  try {
    // Raw bearer token must not reach the activity log (GHSA-prch).
    await logActivity(`quote_${newStatus}`, { quoteId: quote.id }, null, 'customer:public');
  } catch (_) { /* non-fatal */ }

  // Defer the workflow emit until the 15-min toggle window locks — so accepting
  // (then converting) can't strip the customer's ability to decline. The
  // scheduler's finalize sweep fires the final status once it locks.
  await maybeEmitQuoteResponse(quote, newStatus, responseLockedAt, history);

  return { status: newStatus, lockedAt: responseLockedAt };
}

/**
 * Admin "accept on behalf of customer" — records the quote as
 * accepted directly, bypassing the public token + response window.
 * Used when the admin is on the phone with the customer and they
 * verbally accept; the admin wants the quote flipped to `accepted`
 * immediately so they can convert it to an event/invoice.
 *
 * Unlike recordResponse:
 *   - No token required
 *   - No response-window lockout (admin can accept stale / expired
 *     quotes too — useful for retroactive bookkeeping)
 *   - Skips the ToS-required guard (admin is responsible for
 *     confirming verbally; ToS_snapshot stays null)
 *
 * Refuses to act on quotes that are already terminal: `accepted`,
 * `declined`, or `converted` rows would silently overwrite history.
 * Admins use the cancel/duplicate flow for those cases.
 */
async function adminAcceptQuote(id, adminId) {
  const quote = await db('quotes').where({ id }).first();
  if (!quote) throw new AppError('Quote not found', 404);
  if (quote.status === 'accepted') {
    throw new AppError('Quote already accepted', 409, 'QUOTE_ALREADY_ACCEPTED');
  }
  if (quote.status === 'declined') {
    throw new AppError('Quote was declined; duplicate it to start a fresh round.', 409, 'QUOTE_DECLINED');
  }
  if (quote.status === 'converted') {
    throw new AppError('Quote already converted to an event/invoice', 409, 'QUOTE_CONVERTED');
  }
  assertQuoteTransition(quote.status, 'accepted');

  const now = new Date();
  const windowMinutes = ensureInt(await getAppSetting('crm_quotes_accept_window_minutes')) || 15;
  const responseLockedAt = new Date(now.getTime() + windowMinutes * 60 * 1000);

  const history = { actor: adminId, source: 'quote.accept.admin' };
  await auditedUpdate(db, 'quotes', { id }, {
    status: 'accepted',
    responded_at: stamp(now),
    response_locked_at: stamp(responseLockedAt),
    accepted_at: stamp(now),
    // accept_on_behalf flag intentionally NOT stored as a separate
    // column — the audit log entry below captures who accepted and
    // when, which is the legally relevant breadcrumb.
    updated_at: now,
  }, history);

  // Record which add-ons the acceptance covers (#1451 phase 2): the choice
  // as the admin set it in the editor.
  const acceptedLines = await loadQuoteLinesWithParentPosition(id);
  if (offeredOptionalPositions(acceptedLines).length > 0) {
    const selection = await totalsForSelection(quote, acceptedLines, currentOptionalSelection(acceptedLines));
    await db.transaction((trx) => writeAcceptedSelection(trx, quote, acceptedLines, selection, 'admin', now));
  }

  try {
    await logActivity('quote_accepted_by_admin', { quoteId: id }, null, `admin:${adminId}`);
  } catch (_) { /* non-fatal */ }

  // ---- customer confirmation email -------------------------------
  // Renders the quote PDF + queues a "quote accepted — on your
  // behalf" email so the customer has a paper trail of what they
  // just verbally agreed to on the phone. Failures here don't roll
  // back the acceptance — the DB row is already updated and the
  // admin can re-send via the resend flow if SMTP is down.
  try {
    const customer = await db('customer_accounts').where({ id: quote.customer_account_id }).first();
    if (customer?.email) {
      const fresh = await db('quotes').where({ id }).first();
      const lineItems = await db('quote_line_items').where({ quote_id: id }).orderBy('position', 'asc');
      const ctx = await buildRenderContext(fresh, lineItems);
      const buffer = await pdfService.renderQuoteToBuffer(ctx);
      // Persist PDF snapshot under the same convention sendQuote uses
      // — keeps every issued PDF on disk for the audit trail.
      // Kept next to the sent file rather than over it (#1451).
      const pdfPath = await persistDocPdf('quote', fresh, buffer, '-accepted',
        { kind: 'accepted', theme: ctx.theme, issuer: ctx.issuer });
      // Record it like sendQuote does: the accepted quote opens as this
      // file from now on instead of re-rendering (#1451).
      await auditedUpdate(db, 'quotes', { id }, { pdf_path: toStoredPath(pdfPath) },
        { actor: adminId, source: 'quote.accept.admin' });

      const formatMoney = (minor, currency, locale) =>
        new Intl.NumberFormat(locale === 'de' ? 'de-CH' : 'en-GB', {
          style: 'currency', currency: (currency || 'CHF').toUpperCase(),
        }).format(Number(minor || 0) / 100);

      const lang = customer.preferred_language || ctx.locale || 'de';
      await emailProcessor.queueEmail(null, customer.email, 'quote_accepted_customer', {
        quote_number: fresh.quote_number,
        customer_name: customer.display_name
          || [customer.first_name, customer.last_name].filter(Boolean).join(' ')
          || customer.email.split('@')[0],
        event_name: fresh.event_name || '',
        total_amount: formatMoney(fresh.total_amount_minor, fresh.currency, lang),
        accepted_on_behalf: true,
        attachments: [{
          filename: `${fresh.quote_number}.pdf`,
          contentPath: pdfPath,
          contentType: 'application/pdf',
        }],
      });
    }
  } catch (err) {
    // Email failure is not fatal — log + move on. The acceptance
    // itself is recorded; the admin can use Resend later.
    logger.warn('quote_accepted_customer email queue failed', { quoteId: id, err: err.message });
  }

  // Same deferral as the public path — an admin "accept on behalf" also opens
  // the toggle window, so don't convert until it locks.
  await maybeEmitQuoteResponse(quote, 'accepted', responseLockedAt, history);

  return { status: 'accepted', lockedAt: responseLockedAt };
}

/**
 * Refuse a change to a quote that something was already made from. The
 * contract's line table, the event and the invoices all read the quote's
 * lines live, so a later change to its content would silently change theirs.
 *
 * One helper for every caller that changes a quote after acceptance — the
 * admin's add-on change, the reissue, the admin decline and the customer's
 * re-accept inside the response window — so the four can't drift apart. A
 * manual invoice can carry `source_quote_id` without the quote ever reaching
 * `converted`, which is why the invoice lookup is part of the rule.
 *
 * @param {object} quote the quotes row
 * @param {string} [message] what the caller should say instead
 */
async function assertQuoteNotConverted(quote, message) {
  const invoice = await db('invoices').where({ source_quote_id: quote.id }).first('id');
  if (quote.status === 'converted' || quote.converted_contract_id || quote.converted_event_id || invoice) {
    throw new AppError(
      message || 'This quote already has a contract, event or invoice. Change the add-ons there.',
      409, 'QUOTE_CONVERTED',
    );
  }
}

/**
 * Change the add-ons of an accepted quote (#1451) — e.g. after the customer
 * called — until a contract, event or invoice exists; from then on the change
 * belongs on that document. Recorded in the change history and the activity
 * log, re-rendered, and the customer is always emailed the updated quote.
 */
async function adminChangeAddOns(id, { selectedOptional }, adminId) {
  const quote = await db('quotes').where({ id }).first();
  if (!quote) throw new AppError('Quote not found', 404);
  await assertQuoteNotConverted(quote);
  if (quote.status !== 'accepted') {
    throw new AppError('Add-ons can be changed here once the quote is accepted. Before that, edit the quote.', 409, 'QUOTE_NOT_ACCEPTED');
  }
  const lineItems = await loadQuoteLinesWithParentPosition(id);
  if (offeredOptionalPositions(lineItems).length === 0) {
    throw new AppError('This quote has no add-ons', 400, 'NO_ADD_ONS');
  }
  const current = currentOptionalSelection(lineItems);
  const selection = await totalsForSelection(quote, lineItems, selectedOptional || []);
  if (selection.chosen.join(',') === current.join(',')) {
    return { changed: false, totalAmountMinor: ensureInt(quote.total_amount_minor) };
  }
  const now = new Date();
  await db.transaction((trx) => writeAcceptedSelection(trx, quote, lineItems, selection, 'admin', now,
    { previousChosen: current, adminId }));
  await storeAcceptedQuotePdf(id);
  const change = selectionChange(lineItems, current, selection.chosen, quote.total_amount_minor, selection.totals, 'admin', adminId, now);
  try {
    await logActivity('quote_add_ons_changed', { quoteId: id, booked: change.booked, removed: change.removed }, null, `admin:${adminId}`);
  } catch (_) { /* non-fatal */ }
  await emailAddOnChange(id, change);
  return { changed: true, totalAmountMinor: selection.totals.totalAmountMinor };
}

/**
 * Admin "decline on behalf of customer" — records the quote as
 * `declined` directly, bypassing the public token + response window.
 * Used when the customer says no by phone/email and the admin wants the
 * pipeline reflected without asking them to click the decline link.
 *
 * Allowed from `draft` / `sent` / `expired`, and from `accepted` while no
 * contract, event or invoice exists (#1451) — the customer withdrew, or
 * the quote no longer applies; its acceptance stays on record. Refuses
 * `declined` and `converted`, which would overwrite history.
 *
 * `reason` is optional free text persisted to `quotes.decline_reason`
 * (migration 115) and surfaced on the quote detail page.
 *
 * Any outstanding accept/decline tokens are invalidated so the customer
 * can't flip the quote back to accepted via a still-live emailed link.
 */
async function adminDeclineQuote(id, adminId, reason = null) {
  const quote = await db('quotes').where({ id }).first();
  if (!quote) throw new AppError('Quote not found', 404);
  if (quote.status === 'declined') {
    throw new AppError('Quote already declined', 409, 'QUOTE_ALREADY_DECLINED');
  }
  // An accepted quote can be declined while nothing was made from it yet
  // (#1451): the customer withdrew, or it no longer applies.
  await assertQuoteNotConverted(quote, 'Quote already converted to an event/invoice');
  assertQuoteTransition(quote.status, 'declined');

  const now = new Date();
  const cleanReason = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 5000) : null;
  const hasReasonColumn = await hasColumnCached('quotes', 'decline_reason');
  const history = { actor: adminId, source: 'quote.decline.admin' };

  await db.transaction(async (trx) => {
    const updates = {
      status: 'declined',
      responded_at: quote.responded_at || stamp(now),
      // Close the public response window immediately so a customer link
      // can't toggle the quote afterwards (recordResponse rejects once
      // now > response_locked_at).
      response_locked_at: stamp(now),
      declined_at: stamp(now),
      updated_at: now,
    };
    // A declined acceptance stays on record; anything else never had one.
    if (quote.status !== 'accepted') updates.accepted_at = null;
    if (hasReasonColumn) updates.decline_reason = cleanReason;
    // Conditional on the status this call read, like the reissue: two
    // requests that both passed the checks above must not both write.
    const declined = await auditedUpdate(trx, 'quotes', { id, status: quote.status }, updates, history);
    if (!declined) {
      throw new AppError('This quote changed while it was being declined. Reload and try again.', 409, 'QUOTE_CONFLICT');
    }

    // Burn any unused tokens for this quote — defense in depth alongside
    // the closed response window above.
    await trx('quote_action_tokens')
      .where({ quote_id: id })
      .whereNull('used_at')
      .update({ used_at: now, used_action: 'declined' });
  });

  try {
    await logActivity('quote_declined_by_admin', { quoteId: id, reason: cleanReason }, null, `admin:${adminId}`);
  } catch (_) { /* non-fatal */ }

  // Admin decline locks the window immediately (response_locked_at = now), so
  // this emits straight away (and stamps emitted) rather than deferring.
  await maybeEmitQuoteResponse(quote, 'declined', now, history);

  return { status: 'declined', declinedAt: now };
}

/**
 * Reissue an accepted quote (#1451), like reissueInvoice with its Storno:
 * the admin declines the accepted quote — its customer link stops working,
 * the reason is kept, its acceptance stays on record — and a draft copy
 * that replaces it ("Ersetzt Angebot …") is created in the same deal. Only
 * until a contract, event or invoice exists. The customer isn't emailed and
 * no "declined" workflow event fires: the reissued quote's email tells them
 * what changed.
 *
 * The copy is made after the decline commits (createQuote runs its own
 * transaction). Should it fail, the quote stays declined and "Duplicate"
 * still makes the copy.
 *
 * @returns {Promise<{ quoteId: number }>} the new draft
 */
async function reissueQuote(id, adminId, reason = null) {
  const quote = await db('quotes').where({ id }).first();
  if (!quote) throw new AppError('Quote not found', 404);
  if (quote.status !== 'accepted') {
    throw new AppError('Only an accepted quote can be reissued', 409, 'QUOTE_NOT_ACCEPTED');
  }
  await assertQuoteNotConverted(quote, 'A contract, event or invoice already exists for this quote');
  assertQuoteTransition(quote.status, 'declined');

  const now = new Date();
  const cleanReason = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 5000) : null;
  const hasReasonColumn = await hasColumnCached('quotes', 'decline_reason');

  await db.transaction(async (trx) => {
    const updates = {
      status: 'declined', response_locked_at: stamp(now), declined_at: stamp(now), updated_at: now,
    };
    if (hasReasonColumn) updates.decline_reason = cleanReason;
    // Only the request that takes the quote out of `accepted` reissues it.
    // The status check above runs outside the transaction, so two clicks
    // both passed it and each made a replacement draft; the unique index on
    // replaces_quote_id (migration 220) is the second line of defence.
    const claimed = await auditedUpdate(trx, 'quotes', { id, status: 'accepted' }, updates,
      { actor: adminId, source: 'quote.reissue' });
    if (!claimed) {
      throw new AppError('This quote is no longer accepted, so it can\'t be reissued', 409, 'QUOTE_NOT_ACCEPTED');
    }
    await trx('quote_action_tokens')
      .where({ quote_id: id })
      .whereNull('used_at')
      .update({ used_at: stamp(now), used_action: 'declined' });
  });

  const newId = await duplicateQuote(id, adminId, { replacesQuoteId: id, dealUuid: quote.deal_uuid });

  try {
    await logActivity('quote_reissued', { quoteId: id, newQuoteId: newId, reason: cleanReason }, null, `admin:${adminId}`);
  } catch (_) { /* non-fatal */ }

  return { quoteId: newId };
}

/**
 * Convert an accepted quote to an event + scheduled invoices.
 * Wraps everything in a transaction so a half-finished conversion
 * doesn't litter the DB.
 *
 * Implementation note: invoice creation delegates to invoiceService —
 * required by Commit 7. We `require` lazily to dodge the circular
 * dependency between quoteService and invoiceService.
 */
/**
 * Convert an accepted quote directly into an invoice — no event, no
 * gallery, just the financial document. Used for engagements that
 * don't produce a photo deliverable (consulting, equipment hire, etc).
 *
 * Creates ONE invoice per installment in the payment-term snapshot —
 * same fan-out as convertToEvent, but without the events / event_
 * payment_plans rows. The first installment is scheduled to send
 * immediately; later ones use the same trigger-relative-to-event
 * date logic the schedule pass uses, anchored on the quote's event_
 * date if any, else the issue date.
 *
 * Leaves the quote `accepted` → `converted` state machine intact so
 * the same status badge logic works for both paths.
 */
async function convertToInvoiceOnly(quoteId, adminId, options = {}) {
  const { quote, lineItems } = (await getQuoteById(quoteId)) || {};
  if (!quote) throw new AppError('Quote not found', 404);
  if (quote.status !== 'accepted') {
    throw new AppError(`Cannot convert a quote with status '${quote.status}'`, 409);
  }
  assertQuoteTransition(quote.status, 'converted');
  if (quote.converted_event_id) {
    // Already has a linked event — nothing to do here; tell the
    // caller to use the event-detail page for new invoices.
    throw new AppError('This quote was already converted to an event; create the invoice from the event instead.', 409, 'ALREADY_CONVERTED_TO_EVENT');
  }
  // Guard against double-spending a quote that already has a contract
  // in flight. contractService.convertToInvoiceOnly re-enters this
  // path on the contract→invoice button — it passes
  // { fromContract: true } so the guard yields.
  if (quote.converted_contract_id && !options.fromContract) {
    throw new AppError(
      'This quote already has a pending contract. Convert the contract to invoices instead, or cancel the contract first.',
      409, 'CONTRACT_IN_FLIGHT',
    );
  }

  const customer = await db('customer_accounts').where({ id: quote.customer_account_id }).first();
  ensureCustomerFeatureEnabled(customer, 'quotes');
  // The customer must also have the bills feature enabled or the
  // generated invoice can't be sent.
  if (customer.feature_bills === false || customer.feature_bills === 0 || customer.feature_bills === '0') {
    throw new AppError('This customer has Bills disabled — enable it on the customer detail page first.',
      409, 'CUSTOMER_FEATURE_DISABLED');
  }

  const paymentTermSnapshot = quote.payment_term_snapshot
    ? (typeof quote.payment_term_snapshot === 'string'
      ? JSON.parse(quote.payment_term_snapshot)
      : quote.payment_term_snapshot)
    : null;

  const invoiceService = require('./invoiceService');

  const result = await db.transaction(async (trx) => {
    const installments = Array.isArray(paymentTermSnapshot?.installments)
      ? paymentTermSnapshot.installments
      : [{ percent: 100, trigger: 'after_delivery', offset_days: 0, label: 'Total' }];

    const spawnResult = await invoiceService.scheduleInvoicesForEvent({
      trx,
      // eventId omitted → invoices have source_quote_id but no event_id.
      eventId: null,
      quoteId: quote.id,
      customer,
      currency: quote.currency,
      language: quote.language,
      // Unselected optional add-ons never reach an invoice (#1451).
      lineItems: countedLineItems(lineItems),
      totals: {
        net: quote.net_amount_minor,
        vatRate: quote.vat_rate,
        vat: quote.vat_amount_minor,
        shipping: quote.shipping_amount_minor,
        total: quote.total_amount_minor,
      },
      installments,
      eventDate: quote.event_date,
      // Inline event snapshot — copied so the converted invoice
      // keeps the quote's event label / times for accounting + UI
      // even when there's no `events` row to fall back to (migration 123).
      eventName: quote.event_name,
      eventTimeStart: quote.event_time_start,
      eventTimeEnd: quote.event_time_end,
      // Migration 124 — pass the split payment-term FKs + the
      // composed snapshot through so the converted invoice carries
      // them on both the FK and snapshot paths.
      paymentNetDaysTemplateId: quote.payment_net_days_template_id,
      paymentTimingTemplateId: quote.payment_timing_template_id,
      paymentTermSnapshot,
      adminId,
      ccPdfEmail: quote.cc_pdf_email,
      // Net 14 / 30 / 60 / 90 carry through from the quote's
      // selected payment-term template so each scheduled invoice's
      // due_date reflects what the customer agreed to on the quote.
      netDays: paymentTermSnapshot?.net_days,
      // Migration 140 — every spawned invoice inherits the source
      // quote's deal_uuid so quote + N invoices group under one deal.
      dealUuid: quote.deal_uuid,
      // Workflow draft-seam: when called by the booking flow's prepare_invoice
      // action, create the invoices on HOLD (no scheduled_send_at) so they wait
      // for the explicit send_document after the review gate.
      hold: options.draft === true,
    });

    // Contract→invoice re-entry (contract/conversions.js): stamp the
    // contract lineage in this same transaction, so a crash can never
    // commit the invoices without the source_contract_id the contract
    // path looks them up by.
    if (options.sourceContractId) {
      await auditedUpdate(trx, 'invoices',
        (q) => q.where({ source_quote_id: quote.id }).whereNull('source_contract_id'),
        { source_contract_id: options.sourceContractId },
        { actor: adminId, source: 'contract.convert.invoices' });
    }

    // Mark quote `converted` without a converted_event_id so the
    // existing transition rules still apply (can't be edited / sent
    // again). The list view's status badge says "converted"; admin
    // sees the linked invoices in the customer detail panel.
    await auditedUpdate(trx, 'quotes', { id: quote.id }, {
      status: 'converted',
      updated_at: new Date(),
    }, { actor: adminId, source: 'quote.convert.invoices' });

    return { installmentsCreated: installments.length, invoiceIds: spawnResult?.invoiceIds || [] };
  });

  // Audit log AFTER commit — logActivity writes via the global `db`, which
  // deadlocks the single-connection SQLite pool if issued inside the trx
  // (the booking flow's prepare_invoice action runs this unattended, so a
  // hang here would wedge the workflow executor, not just a request).
  try {
    await logActivity('quote_converted_invoices_only', { quoteId: quote.id, installments: result.installmentsCreated },
      null, `admin:${adminId}`);
  } catch (_) { /* non-fatal */ }

  logger.info('Quote converted to invoices only (no event)', { adminId, quoteId: quote.id, installments: result.installmentsCreated });
  return result;
}

async function convertToEvent(quoteId, adminId, options = {}) {
  const { quote, lineItems } = (await getQuoteById(quoteId)) || {};
  if (!quote) throw new AppError('Quote not found', 404);
  if (quote.status !== 'accepted') {
    throw new AppError(`Cannot convert a quote with status '${quote.status}'`, 409);
  }
  assertQuoteTransition(quote.status, 'converted');
  if (quote.converted_event_id) {
    // Idempotent re-entry (e.g. workflow crash-recovery): hand back the
    // already-created event and its scheduled invoices so the caller can
    // adopt them instead of double-creating.
    const existingInvoices = await db('invoices')
      .where({ event_id: quote.converted_event_id }).select('id');
    return {
      eventId: quote.converted_event_id,
      alreadyConverted: true,
      invoiceIds: existingInvoices.map((r) => r.id),
    };
  }
  // Same guard as convertToInvoiceOnly — refuse if a contract is in
  // flight unless the contract→event button re-entered this path.
  if (quote.converted_contract_id && !options.fromContract) {
    throw new AppError(
      'This quote already has a pending contract. Convert the contract to an event instead, or cancel the contract first.',
      409, 'CONTRACT_IN_FLIGHT',
    );
  }

  const customer = await db('customer_accounts').where({ id: quote.customer_account_id }).first();
  ensureCustomerFeatureEnabled(customer, 'quotes');

  const paymentTermSnapshot = quote.payment_term_snapshot
    ? (typeof quote.payment_term_snapshot === 'string'
      ? JSON.parse(quote.payment_term_snapshot)
      : quote.payment_term_snapshot)
    : null;

  // Lazy import to avoid the circular dep.
  const invoiceService = require('./invoiceService');

  const result = await db.transaction(async (trx) => {
    // The events table schema has drifted across migrations:
    // installs that ran the original 060 series have
    // host_name/host_email; later ones renamed to customer_*; some
    // have both. Rather than hard-code one set and fail on the
    // other, introspect the columns at runtime and only insert
    // fields the table actually has.
    const adminRow = await trx('admin_users').where({ id: adminId }).first();
    const oneYearAfterEvent = new Date(quote.event_date || quote.issue_date);
    oneYearAfterEvent.setFullYear(oneYearAfterEvent.getFullYear() + 1);
    const placeholder = crypto.randomBytes(32).toString('hex');
    const shareLink = crypto.randomBytes(32).toString('hex');
    const fullName = [customer.first_name, customer.last_name].filter(Boolean).join(' ')
      || customer.display_name || customer.company_name || quote.quote_number;
    const customerEmail = customer.email || `${quote.quote_number.toLowerCase()}@picpeak.local`;
    const adminEmail = adminRow?.email || customer.email || 'admin@picpeak.local';

    // Event type for the new event: the type chosen on the quote (migration 146),
    // else a configurable org default, else the resolved catch-all (an ACTIVE
    // type — never a hardcoded slug the admin may have disabled).
    const eventType = (quote.event_type && String(quote.event_type).trim())
      || (await getAppSetting('crm_default_event_type', null, trx))
      || (await resolveDefaultEventType(trx));

    // Each candidate column is paired with the value we'd write. We
    // ask the DB which columns exist and only keep the matching pairs
    // — bullet-proof against schema drift in either direction.
    const eventCols = await trx('events').columnInfo();
    const { getImageSecurityDefaults, resolveImageSecurityColumns } = require('../routes/adminEvents/helpers');
    const imageSecurityColumns = resolveImageSecurityColumns({}, await getImageSecurityDefaults(trx));
    const candidate = {
      slug: `quote-${quote.quote_number.toLowerCase()}-${crypto.randomBytes(3).toString('hex')}`,
      event_name: quote.event_name || `Event ${quote.quote_number}`,
      event_date: quote.event_date || quote.issue_date,
      host_name: fullName,
      host_email: customerEmail,
      customer_name: fullName,
      customer_email: customerEmail,
      customer_phone: customer.phone,
      admin_email: adminEmail,
      event_type: eventType,
      password_hash: placeholder,
      share_link: shareLink,
      share_token: shareLink,
      expires_at: oneYearAfterEvent,
      is_active: true,
      is_archived: false,
      is_draft: true,
      created_by: adminId,
      quote_id: quote.id,
      created_at: new Date(),
      updated_at: new Date(),
      // #1296 — a converted quote produces a real gallery, so the global
      // Image Security defaults have to reach it too. Required lazily: this
      // is a service reaching into a route helper, and the lazy form keeps
      // the module graph acyclic the way the storage require below does.
      ...imageSecurityColumns,
    };
    const eventRow = {};
    for (const [k, v] of Object.entries(candidate)) {
      if (Object.prototype.hasOwnProperty.call(eventCols, k)) eventRow[k] = v;
    }
    const inserted = await trx('events').insert(eventRow).returning('id');
    const eventId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

    // Junction row so the customer can already see the event in their
    // dashboard once the admin activates it.
    await trx('event_customer_assignments').insert({
      event_id: eventId,
      customer_account_id: customer.id,
      assigned_by_admin_id: adminId,
      assigned_at: new Date(),
    });

    // Payment-plan glue.
    await trx('event_payment_plans').insert({
      event_id: eventId,
      quote_id: quote.id,
      payment_term_snapshot: JSON.stringify(paymentTermSnapshot || {}),
      created_at: new Date(),
      updated_at: new Date(),
    });

    // Build the invoice schedule from installments.
    const installments = Array.isArray(paymentTermSnapshot?.installments)
      ? paymentTermSnapshot.installments
      : [{ percent: 100, trigger: 'after_delivery', offset_days: 0, label: 'Total' }];

    // `skipInvoices` (workflow reserve_date): create the event as a pure date
    // hold — no invoices scheduled at all. The other booking actions handle
    // money documents separately.
    const spawnResult = options.skipInvoices === true
      ? { invoiceIds: [] }
      : await invoiceService.scheduleInvoicesForEvent({
        trx,
        eventId,
        quoteId: quote.id,
        customer,
        currency: quote.currency,
        language: quote.language,
        // Unselected optional add-ons never reach an invoice (#1451).
        lineItems: countedLineItems(lineItems),
        totals: {
          net: quote.net_amount_minor,
          vatRate: quote.vat_rate,
          vat: quote.vat_amount_minor,
          shipping: quote.shipping_amount_minor,
          total: quote.total_amount_minor,
        },
        installments,
        eventDate: quote.event_date,
        // Inline event snapshot — same rationale as convertToInvoiceOnly
        // above (migration 123).
        eventName: quote.event_name,
        eventTimeStart: quote.event_time_start,
        eventTimeEnd: quote.event_time_end,
        adminId,
        ccPdfEmail: quote.cc_pdf_email,
        // Net 14 / 30 / 60 / 90 carry through from the quote's
        // payment-term template (same as convertToInvoiceOnly).
        netDays: paymentTermSnapshot?.net_days,
        // Migration 140 — propagate the quote's deal_uuid down through
        // every spawned invoice (same as convertToInvoiceOnly above).
        dealUuid: quote.deal_uuid,
        // Workflow draft-seam: the booking flow's prepare_event creates the
        // event's invoices on HOLD (no scheduled_send_at) so they wait for the
        // review gate + explicit send_document after the event date.
        hold: options.hold === true,
      });

    await auditedUpdate(trx, 'quotes', { id: quote.id }, {
      status: 'converted',
      converted_event_id: eventId,
      updated_at: new Date(),
    }, { actor: adminId, source: 'quote.convert.event' });

    return { eventId, alreadyConverted: false, invoiceIds: spawnResult?.invoiceIds || [] };
  });

  // Audit log AFTER commit — logActivity writes via the global `db`, which
  // deadlocks the single-connection SQLite pool if issued inside the trx
  // (prepare_event runs this unattended from the booking flow).
  try {
    await logActivity('quote_converted', { quoteId: quote.id, eventId: result.eventId }, result.eventId, `admin:${adminId}`);
  } catch (_) { /* non-fatal */ }

  logger.info('Quote converted to event', { adminId, quoteId: quote.id, eventId: result.eventId });
  return result;
}

/**
 * Re-apply the current customer / business hour and day rates to the lines
 * whose price came from a rate (#1451). Drafts only: a sent quote keeps the
 * prices the customer saw. Lines with a pinned catalogue rate or a typed
 * price are left alone.
 */
async function recalculateRates(id, adminId) {
  const data = await getQuoteById(id);
  if (!data) throw new AppError('Quote not found', 404);
  if (data.quote.status !== 'draft') {
    throw new AppError('Only draft quotes can pick up new rates', 409, 'QUOTE_NOT_DRAFT');
  }
  const lineItems = data.lineItems.map((li) => ({
    position: li.position,
    quantity: li.quantity,
    description: li.description,
    unit_price_minor: li.unit_price_minor,
    discount_percent: li.discount_percent,
    parent_position: li.parent_position == null ? null : li.parent_position,
    details_text: li.details_text || null,
    line_kind: li.line_kind,
    unit: li.unit,
    is_optional: li.is_optional,
    selected: li.selected,
    price_mode: li.price_mode,
    rate_source: li.rate_source === 'customer' || li.rate_source === 'default' ? 'auto' : li.rate_source,
    bound_to: li.bound_to,
    promotion_snapshot: li.promotion_snapshot,
  }));
  await updateQuote(id, { lineItems }, adminId);
}

async function duplicateQuote(id, adminId, { replacesQuoteId = null, dealUuid = null } = {}) {
  const { quote, lineItems } = (await getQuoteById(id)) || {};
  if (!quote) throw new AppError('Quote not found', 404);

  return await createQuote({
    customerAccountId: quote.customer_account_id,
    language: quote.language,
    currency: quote.currency,
    eventName: quote.event_name,
    eventDate: quote.event_date,
    eventTimeStart: quote.event_time_start,
    eventTimeEnd: quote.event_time_end,
    expectedDurationHours: quote.expected_duration_hours,
    paymentTermTemplateId: quote.payment_term_template_id,
    vatRate: quote.vat_rate,
    // Migration 130 — VAT-code snapshot (so re-editing preserves it).
    vatCode: quote.vat_code ?? null,
    shippingAmountMinor: quote.shipping_amount_minor,
    introText: quote.intro_text,
    outroText: quote.outro_text,
    internalNotes: quote.internal_notes,
    ccPdfEmail: quote.cc_pdf_email,
    businessBankAccountId: quote.business_bank_account_id,
    hours: quote.hours,
    days: quote.days,
    // Full line shape: sub-items, notes and the migration-215 fields used to
    // be dropped here (and this is what the prepare_quote workflow action
    // copies). Stored rates stay as they are — nothing is re-resolved.
    lineItems: lineItems.map((li) => ({
      position: li.position,
      quantity: li.quantity,
      description: li.description,
      unit_price_minor: li.unit_price_minor,
      discount_percent: li.discount_percent,
      parent_position: li.parent_position == null ? null : li.parent_position,
      details_text: li.details_text || null,
      line_kind: li.line_kind,
      unit: li.unit,
      is_optional: li.is_optional,
      selected: li.selected,
      price_mode: li.price_mode,
      rate_source: li.rate_source,
      bound_to: li.bound_to,
      promotion_snapshot: li.promotion_snapshot,
    })),
    // Set only by reissueQuote: the reissued quote keeps the deal.
    replacesQuoteId,
    dealUuid,
  }, adminId);
}

// ---------------------------------------------------------------------
// Presets (line items + payment terms)
// ---------------------------------------------------------------------

// The editor's preset picker wants active rows only; the catalogue admin
// page lists inactive (archived) ones too.
async function listLineItemPresets({ includeInactive = false } = {}) {
  const query = db('quote_line_item_presets');
  if (!includeInactive) query.where({ is_active: formatBoolean(true) });
  return await query.orderBy('display_order', 'asc').orderBy('id', 'asc');
}

const PRESET_PRICE_MODES = ['fixed', 'hour', 'day'];

// Migration 220 — service-catalogue columns on the presets table.
function presetCatalogueColumns(payload) {
  const out = {};
  if (payload.unit !== undefined) out.unit = payload.unit || null;
  if (payload.details_text !== undefined) out.details_text = payload.details_text || null;
  if (payload.category !== undefined) out.category = payload.category ? String(payload.category).slice(0, 64) : null;
  if (payload.vat_code !== undefined) out.vat_code = payload.vat_code ? String(payload.vat_code).slice(0, 16) : null;
  if (payload.price_mode !== undefined) {
    out.price_mode = PRESET_PRICE_MODES.includes(payload.price_mode) ? payload.price_mode : 'fixed';
  }
  if (payload.pinned_rate_minor !== undefined) {
    out.pinned_rate_minor = payload.pinned_rate_minor == null || payload.pinned_rate_minor === ''
      ? null
      : ensureInt(payload.pinned_rate_minor);
  }
  return out;
}

async function createLineItemPreset(payload) {
  const row = {
    name: payload.name,
    description: payload.description || '',
    unit_price_minor: ensureInt(payload.unit_price_minor),
    currency: (payload.currency || 'CHF').toUpperCase(),
    quantity_default: ensureNumber(payload.quantity_default, 1),
    display_order: ensureInt(payload.display_order),
    is_active: formatBoolean(true),
    ...presetCatalogueColumns(payload),
    created_at: new Date(),
    updated_at: new Date(),
  };
  const inserted = await db('quote_line_item_presets').insert(row).returning('id');
  const id = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
  return await db('quote_line_item_presets').where({ id }).first();
}

async function updateLineItemPreset(id, payload) {
  const map = {
    name: 'name', description: 'description', currency: 'currency',
    unit_price_minor: 'unit_price_minor', quantity_default: 'quantity_default',
    display_order: 'display_order', is_active: 'is_active',
  };
  const updates = { updated_at: new Date() };
  // Only fields the request actually sent: the route always passes every key,
  // and `Boolean(undefined)` used to archive the item on any partial edit.
  for (const [api, col] of Object.entries(map)) {
    if (payload[api] !== undefined) {
      updates[col] = col === 'is_active' ? formatBoolean(Boolean(payload[api])) : payload[api];
    }
  }
  Object.assign(updates, presetCatalogueColumns(payload));
  await db('quote_line_item_presets').where({ id }).update(updates);
  return await db('quote_line_item_presets').where({ id }).first();
}

async function deleteLineItemPreset(id) {
  // Soft delete via is_active = false to preserve historical references.
  await db('quote_line_item_presets').where({ id })
    .update({ is_active: formatBoolean(false), updated_at: new Date() });
  return { deleted: true };
}

async function listPaymentTermTemplates() {
  return await db('payment_term_templates')
    .where({ is_active: formatBoolean(true) })
    .orderBy('display_order', 'asc').orderBy('id', 'asc');
}

async function createPaymentTermTemplate(payload) {
  if (!Array.isArray(payload.installments) || payload.installments.length === 0) {
    throw new AppError('At least one installment is required', 400);
  }
  const sum = payload.installments.reduce((s, x) => s + ensureNumber(x.percent, 0), 0);
  if (Math.abs(sum - 100) > 0.01) {
    throw new AppError('Installment percentages must sum to 100', 400);
  }
  const row = {
    name: payload.name,
    description: payload.description || '',
    net_days: ensureInt(payload.net_days) || 30,
    skonto_percent: payload.skonto_percent == null ? null : ensureNumber(payload.skonto_percent),
    skonto_within_days: payload.skonto_within_days == null ? null : ensureInt(payload.skonto_within_days),
    installments: JSON.stringify(payload.installments),
    is_system: formatBoolean(false),
    is_active: formatBoolean(true),
    display_order: ensureInt(payload.display_order),
    created_at: new Date(),
    updated_at: new Date(),
  };
  const inserted = await db('payment_term_templates').insert(row).returning('id');
  const id = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
  return await db('payment_term_templates').where({ id }).first();
}

async function updatePaymentTermTemplate(id, payload) {
  const existing = await db('payment_term_templates').where({ id }).first();
  if (!existing) throw new AppError('Not found', 404);
  if (existing.is_system && Object.prototype.hasOwnProperty.call(payload, 'installments')) {
    // Allow renaming + description tweaks on system rows but never let
    // an admin reshape the installment array — keeps the "factory
    // presets" semantically stable for migrations & docs.
    delete payload.installments;
  }
  const updates = { updated_at: new Date() };
  for (const k of ['name', 'description', 'net_days', 'skonto_percent', 'skonto_within_days', 'display_order', 'is_active']) {
    if (Object.prototype.hasOwnProperty.call(payload, k)) {
      updates[k] = k === 'is_active' ? formatBoolean(Boolean(payload[k])) : payload[k];
    }
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'installments')) {
    updates.installments = JSON.stringify(payload.installments);
  }
  await db('payment_term_templates').where({ id }).update(updates);
  return await db('payment_term_templates').where({ id }).first();
}

async function deletePaymentTermTemplate(id) {
  const existing = await db('payment_term_templates').where({ id }).first();
  if (!existing) throw new AppError('Not found', 404);
  if (existing.is_system) {
    throw new AppError('Cannot delete a system payment-term template', 409);
  }
  // Soft-delete to keep snapshots referenced by sent quotes coherent.
  await db('payment_term_templates').where({ id })
    .update({ is_active: formatBoolean(false), updated_at: new Date() });
  return { deleted: true };
}

// ---------------------------------------------------------------------
// Split payment-term templates — net-days + timing (migration 124).
//
// The two new tables decouple the "Net X days" choice from the
// "payment timing / split" choice. CRUD shape mirrors the legacy
// payment_term_templates helpers above so adminQuotes routes can drop
// in matching endpoints without re-deriving validation rules.
// ---------------------------------------------------------------------

async function listPaymentNetDaysTemplates() {
  return await db('payment_net_days_templates')
    .where({ is_active: formatBoolean(true) })
    .orderBy('display_order', 'asc').orderBy('id', 'asc');
}

async function createPaymentNetDaysTemplate(payload) {
  if (payload.net_days == null) {
    throw new AppError('net_days is required', 400);
  }
  const row = {
    name: payload.name,
    description: payload.description || null,
    // Allow 0 ("Sofort fällig"). ensureInt would coerce non-numbers
    // to 0 which is fine for missing values but we already null-check
    // above to catch the genuinely-missing case.
    net_days: ensureInt(payload.net_days),
    skonto_percent: payload.skonto_percent == null ? null : ensureNumber(payload.skonto_percent),
    skonto_within_days: payload.skonto_within_days == null ? null : ensureInt(payload.skonto_within_days),
    is_system: formatBoolean(false),
    is_active: formatBoolean(true),
    display_order: ensureInt(payload.display_order),
    created_at: new Date(),
    updated_at: new Date(),
  };
  const inserted = await db('payment_net_days_templates').insert(row).returning('id');
  const id = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
  return await db('payment_net_days_templates').where({ id }).first();
}

async function updatePaymentNetDaysTemplate(id, payload) {
  const existing = await db('payment_net_days_templates').where({ id }).first();
  if (!existing) throw new AppError('Not found', 404);
  const updates = { updated_at: new Date() };
  for (const k of ['name', 'description', 'net_days', 'skonto_percent', 'skonto_within_days', 'display_order', 'is_active']) {
    if (Object.prototype.hasOwnProperty.call(payload, k)) {
      updates[k] = k === 'is_active' ? formatBoolean(Boolean(payload[k])) : payload[k];
    }
  }
  await db('payment_net_days_templates').where({ id }).update(updates);
  return await db('payment_net_days_templates').where({ id }).first();
}

async function deletePaymentNetDaysTemplate(id) {
  const existing = await db('payment_net_days_templates').where({ id }).first();
  if (!existing) throw new AppError('Not found', 404);
  if (existing.is_system) {
    throw new AppError('Cannot delete a system net-days template', 409);
  }
  // Soft-delete — sent quote/invoice snapshots survive independently.
  await db('payment_net_days_templates').where({ id })
    .update({ is_active: formatBoolean(false), updated_at: new Date() });
  return { deleted: true };
}

async function listPaymentTimingTemplates() {
  return await db('payment_timing_templates')
    .where({ is_active: formatBoolean(true) })
    .orderBy('display_order', 'asc').orderBy('id', 'asc');
}

async function createPaymentTimingTemplate(payload) {
  if (!Array.isArray(payload.installments) || payload.installments.length === 0) {
    throw new AppError('At least one installment is required', 400);
  }
  const sum = payload.installments.reduce((s, x) => s + ensureNumber(x.percent, 0), 0);
  if (Math.abs(sum - 100) > 0.01) {
    throw new AppError('Installment percentages must sum to 100', 400);
  }
  const row = {
    name: payload.name,
    description: payload.description || null,
    installments: JSON.stringify(payload.installments),
    is_system: formatBoolean(false),
    is_active: formatBoolean(true),
    display_order: ensureInt(payload.display_order),
    created_at: new Date(),
    updated_at: new Date(),
  };
  const inserted = await db('payment_timing_templates').insert(row).returning('id');
  const id = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
  return await db('payment_timing_templates').where({ id }).first();
}

async function updatePaymentTimingTemplate(id, payload) {
  const existing = await db('payment_timing_templates').where({ id }).first();
  if (!existing) throw new AppError('Not found', 404);
  // Same rule as the legacy helper — system rows can be renamed but
  // their installments array is locked so migrations + docs stay
  // semantically stable.
  if (existing.is_system && Object.prototype.hasOwnProperty.call(payload, 'installments')) {
    delete payload.installments;
  }
  const updates = { updated_at: new Date() };
  for (const k of ['name', 'description', 'display_order', 'is_active']) {
    if (Object.prototype.hasOwnProperty.call(payload, k)) {
      updates[k] = k === 'is_active' ? formatBoolean(Boolean(payload[k])) : payload[k];
    }
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'installments')) {
    updates.installments = JSON.stringify(payload.installments);
  }
  await db('payment_timing_templates').where({ id }).update(updates);
  return await db('payment_timing_templates').where({ id }).first();
}

/**
 * Compose a legacy-shape `payment_term_snapshot` JSON object from the
 * two new split FKs on a quote or invoice row (migration 124).
 *
 * Returns null when at least one of the two FKs is unset — the caller
 * then falls back to reading the legacy `payment_term_template_id`
 * column for backward compat. We deliberately don't blend partial
 * data with legacy data; either the split path applies cleanly or it
 * doesn't.
 *
 * Output shape is identical to the legacy template row so downstream
 * consumers (pdfService, scheduleInvoicesForEvent, dunning) work
 * without changes:
 *
 *   { description, net_days, skonto_percent, skonto_within_days,
 *     installments }
 */
async function composeSnapshotFromSplitFks(row) {
  if (!row.payment_net_days_template_id || !row.payment_timing_template_id) return null;
  const netDays = await db('payment_net_days_templates')
    .where({ id: row.payment_net_days_template_id }).first();
  const timing = await db('payment_timing_templates')
    .where({ id: row.payment_timing_template_id }).first();
  if (!netDays || !timing) return null;
  // Migration 142 — ad-hoc installments override. When the quote
  // carries a populated `payment_term_installments_override`, those
  // rows replace the template's installments in the snapshot. Keeps
  // every other snapshot field (net_days / skonto) coming from the
  // chosen templates so the override only touches what the admin
  // explicitly customised.
  let override = null;
  if (row.payment_term_installments_override) {
    try {
      override = typeof row.payment_term_installments_override === 'string'
        ? JSON.parse(row.payment_term_installments_override)
        : row.payment_term_installments_override;
      if (!Array.isArray(override) || override.length === 0) override = null;
    } catch (_) { override = null; }
  }
  const templateInstallments = typeof timing.installments === 'string'
    ? JSON.parse(timing.installments)
    : timing.installments;
  return {
    description: timing.description || netDays.description || null,
    net_days: netDays.net_days,
    skonto_percent: netDays.skonto_percent,
    skonto_within_days: netDays.skonto_within_days,
    installments: override || templateInstallments,
  };
}

async function deletePaymentTimingTemplate(id) {
  const existing = await db('payment_timing_templates').where({ id }).first();
  if (!existing) throw new AppError('Not found', 404);
  if (existing.is_system) {
    throw new AppError('Cannot delete a system timing template', 409);
  }
  await db('payment_timing_templates').where({ id })
    .update({ is_active: formatBoolean(false), updated_at: new Date() });
  return { deleted: true };
}

module.exports = {
  // Lifecycle
  listQuotes,
  getQuoteById,
  createQuote,
  updateQuote,
  sendQuote,
  duplicateQuote,
  recalculateRates,
  getQuotePdfBuffer,
  recordResponse,
  previewOptionalSelection,
  adminAcceptQuote,
  adminChangeAddOns,
  adminDeclineQuote,
  reissueQuote,
  finalizeQuoteResponses,
  convertToEvent,
  convertToInvoiceOnly,

  // Preview / PDF
  renderQuotePdfBuffer,
  renderQuotePdfFromPayload,

  // Presets
  listLineItemPresets,
  createLineItemPreset,
  updateLineItemPreset,
  deleteLineItemPreset,
  listPaymentTermTemplates,
  createPaymentTermTemplate,
  updatePaymentTermTemplate,
  deletePaymentTermTemplate,
  // Split payment-term templates (migration 124).
  listPaymentNetDaysTemplates,
  createPaymentNetDaysTemplate,
  updatePaymentNetDaysTemplate,
  deletePaymentNetDaysTemplate,
  listPaymentTimingTemplates,
  createPaymentTimingTemplate,
  updatePaymentTimingTemplate,
  deletePaymentTimingTemplate,

  // Internals exposed for tests + invoiceService re-use.
  _internal: {
    computeTotals,
    // Shared with quoteTemplateService so {{hourly_rate}} reads exactly like
    // the amounts in the quote email.
    formatMajor,
    ensureCustomerFeatureEnabled,
    nextQuoteNumber,
    persistDocPdf,
    buildRenderContext,
    // Migration 119: hierarchy helpers — shared with invoiceService
    // (commit 3) so the quote → invoice cloner stays consistent.
    validateLineItemHierarchy,
    insertLineItemsHierarchical,
    resolveParentTotalsFromSubItems,
  },
};
