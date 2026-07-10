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
const { formatBoolean } = require('../utils/dbCompat');
const { nextDocumentNumber } = require('../utils/documentSequences');
const { formatShortDate } = require('../utils/dateFormatter');
const businessProfileService = require('./businessProfileService');
const { buildIssuerBlock, buildRecipientBlock } = require('./_renderContext');
const pdfService = require('./pdfService');
const emailProcessor = require('./emailProcessor');
const { getFrontendBaseUrl } = require('../utils/frontendUrl');
const { hasColumnCached } = require('../utils/schemaCache');
const fs = require('fs');
const path = require('path');

const VALID_QUOTE_TRANSITIONS = {
  draft: new Set(['sent', 'declined']),
  sent: new Set(['draft', 'accepted', 'declined', 'expired']),
  accepted: new Set(['converted', 'declined']),
  declined: new Set(['draft', 'accepted']),
  expired: new Set(['draft']),
  converted: new Set([]),
};

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

// `ensureInt` + `ensureNumber` moved to utils/numericHelpers (D.2 cleanup).
const { ensureInt, ensureNumber } = require('../utils/numericHelpers');

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
  const computed = lineItems.map((li) => {
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

  // Phase 3: net = sum of top-level line totals (resolved).
  let netMinor = 0;
  for (const li of computed) {
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
    const clean = cleanNetMinor(computed, { parentKey: 'parent_position', positionKey: 'position' });
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
 * Validate the hierarchy of a line-item payload BEFORE insert. Throws
 * AppError on:
 *   - duplicate positions
 *   - sub-item's parent_position not found in the payload
 *   - sub-item's parent is itself a sub-item (max 1 level deep)
 *   - circular reference (item references itself)
 *
 * Used by both quote + invoice services so the rules stay identical
 * across both flows (and so the quote→invoice cloner doesn't have to
 * re-validate).
 */
function validateLineItemHierarchy(lineItems) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) return;
  const positions = new Set();
  const parentPositions = new Map(); // position → parent_position (or null)
  for (const li of lineItems) {
    const pos = ensureInt(li.position);
    if (!pos) {
      throw new AppError('Every line item must have a positive position', 400, 'LINE_ITEM_POSITION_REQUIRED');
    }
    if (positions.has(pos)) {
      throw new AppError(`Duplicate line item position: ${pos}`, 400, 'LINE_ITEM_POSITION_DUPLICATE');
    }
    positions.add(pos);
    const pp = li.parent_position == null || li.parent_position === '' ? null : ensureInt(li.parent_position);
    parentPositions.set(pos, pp);
  }
  for (const [pos, pp] of parentPositions) {
    if (pp == null) continue;
    if (pp === pos) {
      throw new AppError(`Line item ${pos} cannot be its own parent`, 400, 'LINE_ITEM_SELF_PARENT');
    }
    if (!parentPositions.has(pp)) {
      throw new AppError(`Sub-item ${pos} references missing parent position ${pp}`, 400, 'LINE_ITEM_PARENT_NOT_FOUND');
    }
    if (parentPositions.get(pp) != null) {
      throw new AppError(`Sub-item ${pos} cannot nest under another sub-item (max one level deep)`, 400, 'LINE_ITEM_NESTING_TOO_DEEP');
    }
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
 */
async function insertLineItemsHierarchical(trx, tableName, ownerColumn, ownerId, items) {
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
    const inserted = await trx(tableName).insert(row).returning('id');
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
    await trx(tableName).insert(row);
  }
}

// Atomic gap-free quote number generator. See utils/documentSequences.js
// for the locking story; migration 132 created the underlying table.
// The previous SELECT-MAX-then-INSERT path raced under concurrent
// admin creates and could emit `Q-2026-AB12C3` after 5 retries.
async function nextQuoteNumber(trx) {
  return nextDocumentNumber('quote', 'crm_quotes_number_format', 'Q-{YEAR}-{SEQ:04d}', trx);
}

/**
 * Resolve the fallback event type for a quote→event conversion when the quote
 * itself carries none. Never hardcodes a specific slug (any of them, incl.
 * 'other', can be disabled by the admin): prefer the generic 'other' catch-all
 * when it's active, else the first active type by display order, and only fall
 * back to the literal 'other' if the catalog is somehow empty/unreadable.
 */
async function resolveDefaultEventType(conn) {
  const q = conn || db;
  try {
    const other = await q('event_types').where({ slug_prefix: 'other', is_active: true }).first('slug_prefix');
    if (other) return 'other';
    const firstActive = await q('event_types').where({ is_active: true }).orderBy('display_order', 'asc').first('slug_prefix');
    return firstActive?.slug_prefix || 'other';
  } catch (_) {
    return 'other';
  }
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
      )
      .first();
    if (!quote) return null;
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

  // Authoritative totals.
  const roundTotal = (await getAppSetting('crm_invoice_round_total', false)) === true;
  const totals = computeTotals(
    Array.isArray(payload.lineItems) ? payload.lineItems : [],
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
      // quote is always the root of its deal chain; mint a new one
      // here and let convertQuoteToContract / convertQuoteToInvoices
      // propagate it down.
      deal_uuid: crypto.randomUUID(),
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
    const inserted = await trx('quotes').insert(row).returning('id');
    const quoteId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

    // Cascade the project link across the deal lineage (no-op for a brand-new
    // quote with no contract/event yet — just adopts the customer onto an
    // empty project).
    if (row.project_id) {
      await require('./projectService').linkDealToProject(row.deal_uuid, row.project_id, trx);
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
      }));
      validateLineItemHierarchy(rows);
      await insertLineItemsHierarchical(trx, 'quote_line_items', 'quote_id', quoteId, rows);
    }

    try {
      // Pass `trx` so the audit insert rides the transaction's connection —
      // the global db here deadlocks the single-connection SQLite pool.
      await logActivity('quote_created', { quoteId, quoteNumber, customerAccountId: payload.customerAccountId }, null, `admin:${adminId}`, trx);
    } catch (_) {}

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
      `Cannot edit quote with status '${existing.status}'. Duplicate the quote and start fresh if changes are needed.`,
      409,
      'QUOTE_LOCKED',
    );
  }

  const roundTotal = (await getAppSetting('crm_invoice_round_total', false)) === true;
  const totals = computeTotals(
    Array.isArray(payload.lineItems) ? payload.lineItems : [],
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
    if (existing.status === 'sent') updates.status = 'draft';
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
    if (Object.prototype.hasOwnProperty.call(payload, 'projectId') && await hasColumnCached('quotes', 'project_id')) {
      updates.project_id = payload.projectId || null;
    }
    // Migration 130 — VAT code snapshot.
    if (Object.prototype.hasOwnProperty.call(payload, 'vatCode') && await hasColumnCached('quotes', 'vat_code')) {
      updates.vat_code = payload.vatCode ? String(payload.vatCode).slice(0, 16) : null;
    }
    // Migration 146 — event type.
    if (Object.prototype.hasOwnProperty.call(payload, 'eventType') && await hasColumnCached('quotes', 'event_type')) {
      updates.event_type = payload.eventType ? String(payload.eventType).slice(0, 64) : null;
    }
    // Migration 147 — selected booking workflow.
    if (Object.prototype.hasOwnProperty.call(payload, 'bookingWorkflowId') && await hasColumnCached('quotes', 'booking_workflow_id')) {
      updates.booking_workflow_id = payload.bookingWorkflowId || null;
    }
    await trx('quotes').where({ id }).update(updates);

    // When linked to a project, cascade across the deal lineage so the linked
    // contract / event / invoices roll up into the same project automatically.
    if (updates.project_id) {
      const dealRow = await trx('quotes').where({ id }).select('deal_uuid').first();
      await require('./projectService').linkDealToProject(dealRow && dealRow.deal_uuid, updates.project_id, trx);
    }

    // Delete + reinsert keeps the editor flow simple: the frontend
    // sends the canonical line-item set on every save, we drop the
    // old rows and rebuild from scratch. CASCADE on parent_line_item_id
    // means deleting parents sweeps their sub-items too, so there's
    // no orphan risk here.
    await trx('quote_line_items').where({ quote_id: id }).del();
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
      }));
      validateLineItemHierarchy(rows);
      await insertLineItemsHierarchical(trx, 'quote_line_items', 'quote_id', id, rows);
    }

    try {
      await logActivity('quote_updated', { quoteId: id }, null, `admin:${adminId}`);
    } catch (_) {}
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
  const displayedNetMinor = lineItems.reduce(
    (s, li) => (li.parent_line_item_id == null && (li.parent_position == null || li.parent_position === '')
      ? s + ensureInt(li.line_total_minor) : s),
    0,
  );
  const roundingAdjustmentMinor = ensureInt(quote.net_amount_minor) - displayedNetMinor;

  return {
    locale: quote.language || profile?.default_locale || 'de',
    currency: quote.currency,
    qrFormat: 'none', // quotes never carry a Swiss QR-bill
    dateFormat,
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
    lineItems: lineItems.map((li) => ({
      quantity: li.quantity,
      description: li.description,
      unitPriceMinor: li.unit_price_minor,
      discountPercent: li.discount_percent,
      lineTotalMinor: li.line_total_minor,
      // Migration 119 hierarchy + details — surfaced to the PDF
      // renderer so drawLineItems can indent sub-items + render
      // details_text below.
      parentLineItemId: li.parent_line_item_id || null,
      parentPosition: li.parent_position == null ? null : Number(li.parent_position),
      detailsText: li.details_text || null,
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
      introText: quote.intro_text,
      outroText: quote.outro_text,
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
 * Preview a quote PDF from an unsaved payload — never touches the DB.
 * The frontend "Preview" button on the editor calls this with the
 * current form state so the admin can validate before saving.
 */
async function renderQuotePdfFromPayload(payload) {
  const customer = await db('customer_accounts').where({ id: payload.customerAccountId }).first();
  const roundTotal = (await getAppSetting('crm_invoice_round_total', false)) === true;
  const totals = computeTotals(
    Array.isArray(payload.lineItems) ? payload.lineItems : [],
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

  const customer = await db('customer_accounts').where({ id: quote.customer_account_id }).first();
  ensureCustomerFeatureEnabled(customer, 'quotes');

  // Render PDF + persist snapshot.
  const ctx = await buildRenderContext(quote, lineItems);
  const buffer = await pdfService.renderQuoteToBuffer(ctx);
  const pdfPath = await persistDocPdf('quote', quote, buffer);

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
      expires_at: expiresAt,
      created_at: new Date(),
    });
    await trx('quotes').where({ id }).update({
      status: 'sent',
      sent_at: new Date(),
      pdf_path: pdfPath,
      payment_term_snapshot: paymentTermSnapshot ? JSON.stringify(paymentTermSnapshot) : null,
      updated_at: new Date(),
    });
  });

  // Queue customer email (with PDF + cc) — honour the global
  // crm_quotes_pdf_attachment_enabled toggle.
  const attachPdf = await getAppSetting('crm_quotes_pdf_attachment_enabled');
  const frontendUrl = await getFrontendBaseUrl() || 'http://localhost:3000';
  const responseUrl = `${frontendUrl}/quote/${token}`;
  await emailProcessor.queueEmail(null, customer.email, 'quote_sent', {
    quote_number: quote.quote_number,
    customer_name: customer.display_name || customer.first_name || customer.email.split('@')[0],
    response_url: responseUrl,
    accept_url: `${responseUrl}?action=accept`,
    decline_url: `${responseUrl}?action=decline`,
    valid_until: formatShortDate(quote.valid_until),
    event_name: quote.event_name || '',
    total_amount: formatMajor(quote.total_amount_minor, quote.currency, ctx.locale, ctx.issuer?.countryCode),
    cc: quote.cc_pdf_email || undefined,
    attachments: (attachPdf !== false && pdfPath) ? [{
      filename: `${quote.quote_number}.pdf`,
      contentPath: pdfPath,
      contentType: 'application/pdf',
    }] : undefined,
  });

  try {
    await logActivity('quote_sent', { quoteId: id, token }, null, `admin:${adminId}`);
  } catch (_) {}

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
 * Persist a rendered PDF under storage/business-docs/quote/<YEAR>/<NUMBER>.pdf
 */
async function persistDocPdf(type, doc, buffer) {
  const number = doc.quote_number || doc.invoice_number;
  if (!number) return null;
  const year = (doc.issue_date ? new Date(doc.issue_date) : new Date()).getFullYear();
  const root = path.join(process.cwd(), 'storage', 'business-docs', type, String(year));
  fs.mkdirSync(root, { recursive: true });
  const filePath = path.join(root, `${number}.pdf`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
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
 */
async function maybeEmitQuoteResponse(quote, status, responseLockedAt) {
  const locked = !responseLockedAt || new Date(responseLockedAt).getTime() <= Date.now();
  if (!locked) return false; // deferred to the finalize sweep
  const hasCol = await hasColumnCached('quotes', 'workflow_response_emitted_at');
  if (hasCol) {
    // Atomically claim the emit so a concurrent finalize sweep can't double-fire.
    const claimed = await db('quotes').where({ id: quote.id })
      .whereNull('workflow_response_emitted_at')
      .update({ workflow_response_emitted_at: new Date() });
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
  const rows = candidates.filter((q) => new Date(q.response_locked_at).getTime() <= now);
  let emitted = 0;
  for (const q of rows) {
    const claimed = await db('quotes').where({ id: q.id })
      .whereNull('workflow_response_emitted_at')
      .update({ workflow_response_emitted_at: new Date() });
    if (!claimed) continue; // raced with another tick / the inline emit
    await emitQuoteEvent(q, q.status);
    emitted += 1;
  }
  return emitted;
}

async function recordResponse({ token, action, ip, tosAccepted }) {
  if (!['accept', 'decline'].includes(action)) {
    throw new AppError('Invalid action', 400);
  }
  const tokenRow = await db('quote_action_tokens').where({ token }).first();
  if (!tokenRow) {
    throw new AppError('Token not found', 404);
  }
  if (tokenRow.expires_at && new Date(tokenRow.expires_at).getTime() < Date.now()) {
    throw new AppError('Token expired', 410);
  }

  const quote = await db('quotes').where({ id: tokenRow.quote_id }).first();
  if (!quote) {
    throw new AppError('Quote not found', 404);
  }
  if (!['sent', 'accepted', 'declined'].includes(quote.status)) {
    throw new AppError(`Quote cannot be responded to in status '${quote.status}'`, 409);
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
  if (quote.responded_at && quote.response_locked_at) {
    if (now.getTime() > new Date(quote.response_locked_at).getTime()) {
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

  await db.transaction(async (trx) => {
    const updates = {
      status: newStatus,
      responded_at: respondedAt,
      response_locked_at: responseLockedAt,
      accepted_at: isAccept ? now : null,
      declined_at: !isAccept ? now : null,
      updated_at: now,
    };
    // Snapshot the ToS text the customer agreed to. Only set on the
    // FIRST acceptance — subsequent toggles inside the 15-min window
    // don't overwrite, so the audit trail captures the original
    // agreement moment.
    if (isAccept && tosAccepted && !quote.tos_accepted_at) {
      updates.tos_accepted_at = now;
      updates.tos_text_snapshot = tosText || null;
    }
    await trx('quotes').where({ id: quote.id }).update(updates);
    await trx('quote_action_tokens').where({ id: tokenRow.id }).update({
      used_at: now,
      used_action: newStatus,
      used_ip: ip || null,
    });
  });

  try {
    await logActivity(`quote_${newStatus}`, { quoteId: quote.id, token: tokenRow.token }, null, 'customer:public');
  } catch (_) {}

  // Defer the workflow emit until the 15-min toggle window locks — so accepting
  // (then converting) can't strip the customer's ability to decline. The
  // scheduler's finalize sweep fires the final status once it locks.
  await maybeEmitQuoteResponse(quote, newStatus, responseLockedAt);

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

  const now = new Date();
  const windowMinutes = ensureInt(await getAppSetting('crm_quotes_accept_window_minutes')) || 15;
  const responseLockedAt = new Date(now.getTime() + windowMinutes * 60 * 1000);

  await db('quotes').where({ id }).update({
    status: 'accepted',
    responded_at: now,
    response_locked_at: responseLockedAt,
    accepted_at: now,
    // accept_on_behalf flag intentionally NOT stored as a separate
    // column — the audit log entry below captures who accepted and
    // when, which is the legally relevant breadcrumb.
    updated_at: now,
  });

  try {
    await logActivity('quote_accepted_by_admin', { quoteId: id }, null, `admin:${adminId}`);
  } catch (_) {}

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
      const pdfPath = await persistDocPdf('quote', fresh, buffer);

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
  await maybeEmitQuoteResponse(quote, 'accepted', responseLockedAt);

  return { status: 'accepted', lockedAt: responseLockedAt };
}

/**
 * Admin "decline on behalf of customer" — records the quote as
 * `declined` directly, bypassing the public token + response window.
 * Used when the customer says no by phone/email and the admin wants the
 * pipeline reflected without asking them to click the decline link.
 *
 * Mirrors adminAcceptQuote's guards: refuses quotes that are already
 * terminal (`accepted`, `declined`, `converted`) — those would overwrite
 * history. Allowed from `draft` / `sent` / `expired`.
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
  if (quote.status === 'accepted') {
    throw new AppError('Quote already accepted; duplicate it to start a fresh round.', 409, 'QUOTE_ALREADY_ACCEPTED');
  }
  if (quote.status === 'converted') {
    throw new AppError('Quote already converted to an event/invoice', 409, 'QUOTE_CONVERTED');
  }

  const now = new Date();
  const cleanReason = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 5000) : null;
  const hasReasonColumn = await hasColumnCached('quotes', 'decline_reason');

  await db.transaction(async (trx) => {
    const updates = {
      status: 'declined',
      responded_at: quote.responded_at || now,
      // Close the public response window immediately so a customer link
      // can't toggle the quote afterwards (recordResponse rejects once
      // now > response_locked_at).
      response_locked_at: now,
      declined_at: now,
      accepted_at: null,
      updated_at: now,
    };
    if (hasReasonColumn) updates.decline_reason = cleanReason;
    await trx('quotes').where({ id }).update(updates);

    // Burn any unused tokens for this quote — defense in depth alongside
    // the closed response window above.
    await trx('quote_action_tokens')
      .where({ quote_id: id })
      .whereNull('used_at')
      .update({ used_at: now, used_action: 'declined' });
  });

  try {
    await logActivity('quote_declined_by_admin', { quoteId: id, reason: cleanReason }, null, `admin:${adminId}`);
  } catch (_) {}

  // Admin decline locks the window immediately (response_locked_at = now), so
  // this emits straight away (and stamps emitted) rather than deferring.
  await maybeEmitQuoteResponse(quote, 'declined', now);

  return { status: 'declined', declinedAt: now };
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
      lineItems,
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

    // Mark quote `converted` without a converted_event_id so the
    // existing transition rules still apply (can't be edited / sent
    // again). The list view's status badge says "converted"; admin
    // sees the linked invoices in the customer detail panel.
    await trx('quotes').where({ id: quote.id }).update({
      status: 'converted',
      updated_at: new Date(),
    });

    return { installmentsCreated: installments.length, invoiceIds: spawnResult?.invoiceIds || [] };
  });

  // Audit log AFTER commit — logActivity writes via the global `db`, which
  // deadlocks the single-connection SQLite pool if issued inside the trx
  // (the booking flow's prepare_invoice action runs this unattended, so a
  // hang here would wedge the workflow executor, not just a request).
  try {
    await logActivity('quote_converted_invoices_only', { quoteId: quote.id, installments: result.installmentsCreated },
      null, `admin:${adminId}`);
  } catch (_) {}

  logger.info('Quote converted to invoices only (no event)', { adminId, quoteId: quote.id, installments: result.installmentsCreated });
  return result;
}

async function convertToEvent(quoteId, adminId, options = {}) {
  const { quote, lineItems } = (await getQuoteById(quoteId)) || {};
  if (!quote) throw new AppError('Quote not found', 404);
  if (quote.status !== 'accepted') {
    throw new AppError(`Cannot convert a quote with status '${quote.status}'`, 409);
  }
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
        lineItems,
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

    await trx('quotes').where({ id: quote.id }).update({
      status: 'converted',
      converted_event_id: eventId,
      updated_at: new Date(),
    });

    return { eventId, alreadyConverted: false, invoiceIds: spawnResult?.invoiceIds || [] };
  });

  // Audit log AFTER commit — logActivity writes via the global `db`, which
  // deadlocks the single-connection SQLite pool if issued inside the trx
  // (prepare_event runs this unattended from the booking flow).
  try {
    await logActivity('quote_converted', { quoteId: quote.id, eventId: result.eventId }, result.eventId, `admin:${adminId}`);
  } catch (_) {}

  logger.info('Quote converted to event', { adminId, quoteId: quote.id, eventId: result.eventId });
  return result;
}

async function duplicateQuote(id, adminId) {
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
    lineItems: lineItems.map((li) => ({
      position: li.position,
      quantity: li.quantity,
      description: li.description,
      unit_price_minor: li.unit_price_minor,
      discount_percent: li.discount_percent,
    })),
  }, adminId);
}

// ---------------------------------------------------------------------
// Presets (line items + payment terms)
// ---------------------------------------------------------------------

async function listLineItemPresets() {
  return await db('quote_line_item_presets')
    .where({ is_active: formatBoolean(true) })
    .orderBy('display_order', 'asc').orderBy('id', 'asc');
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
  for (const [api, col] of Object.entries(map)) {
    if (Object.prototype.hasOwnProperty.call(payload, api)) {
      updates[col] = col === 'is_active' ? formatBoolean(Boolean(payload[api])) : payload[api];
    }
  }
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
  recordResponse,
  adminAcceptQuote,
  adminDeclineQuote,
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
