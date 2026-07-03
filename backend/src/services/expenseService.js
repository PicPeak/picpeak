/**
 * Accounting service — two separate concepts (split in migration 126):
 *
 *   INCOMING INVOICES (external)  → the `inbound_documents` row IS the payable.
 *     It carries its own disposition, supplier-payment, booking (event_id, NULL
 *     = company) and re-bill linkage. A supplier invoice never creates an
 *     `expenses` row, so it appears ONLY in the incoming-invoices surface.
 *
 *   EXPENSES (internal)           → `expenses` rows are own costs entered by
 *     staff: kind = amount | mileage(km) | per_diem, amount = quantity x rate
 *     (rate from accounting settings, per-entry override), optional proof file,
 *     booked to an event or the company. No supplier payment (you incur these).
 *
 * Money is integer minor units. VAT/tax handling is v1 (capture only) — verify
 * with a Treuhaender.
 */
const crypto = require('crypto');
const fsp = require('fs').promises;
const { PDFDocument } = require('pdf-lib');
const { db, logActivity } = require('../database/db');
const { AppError } = require('../utils/errors');
const logger = require('../utils/logger');
const invoiceService = require('./invoiceService');

const DISPOSITIONS = ['rebill', 'durchlaufend', 'eigener_aufwand', 'duplikat', 'abgelehnt'];
const TAX_TREATMENTS = ['domestic', 'reverse_charge_service', 'foreign_vat_non_reclaimable', 'import_goods'];
const MARKUP_TYPES = ['none', 'percent', 'flat'];
const PAYMENT_METHODS = ['bank_transfer', 'cash', 'twint', 'paypal', 'card', 'other'];
const EXPENSE_KINDS = ['amount', 'mileage', 'per_diem'];

const DISPOSITION_DOC_STATUS = {
  rebill: 'categorized',
  durchlaufend: 'categorized',
  eigener_aufwand: 'categorized',
  duplikat: 'duplicate',
  abgelehnt: 'declined',
};

function toIsoDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

// ── Accounting settings (app_settings, type 'accounting') ───────────────────
async function getAccountingSettings() {
  const keys = ['accounting_km_rate_minor', 'accounting_per_diem_rate_minor', 'accounting_require_proof',
    'accounting_vat_reclaim_countries'];
  let rows = [];
  try {
    rows = await db('app_settings').whereIn('setting_key', keys).select('setting_key', 'setting_value');
  } catch (_e) { /* table may not exist in some test harnesses */ }
  const map = {};
  for (const r of rows) {
    let v = r.setting_value;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_e) { /* keep raw */ } }
    map[r.setting_key] = v;
  }
  return {
    kmRateMinor: Number.isFinite(Number(map.accounting_km_rate_minor)) ? Number(map.accounting_km_rate_minor) : 0,
    perDiemRateMinor: Number.isFinite(Number(map.accounting_per_diem_rate_minor)) ? Number(map.accounting_per_diem_rate_minor) : 0,
    requireProof: map.accounting_require_proof === true || map.accounting_require_proof === 1 || map.accounting_require_proof === '1',
    vatReclaimCountries: Array.isArray(map.accounting_vat_reclaim_countries)
      ? map.accounting_vat_reclaim_countries.map((c) => String(c || '').toUpperCase()) : [],
  };
}

/**
 * Default tax treatment from the supplier country: explicit payload wins; else
 * a country in the reclaim list (typically CH / LI) is `domestic` (input VAT
 * reclaimable), an out-of-list country is `foreign_vat_non_reclaimable`, and an
 * unknown country falls back to `domestic`. reverse_charge / import_goods stay
 * admin-set (can't be auto-detected).
 */
function resolveTaxTreatment(payloadTreatment, supplierCountry, reclaimCountries) {
  if (TAX_TREATMENTS.includes(payloadTreatment)) return payloadTreatment;
  const cc = String(supplierCountry || '').toUpperCase();
  if (!cc) return 'domestic';
  // Don't auto-classify until the admin has actually configured their reclaim
  // countries — an unset (empty) list must not make every supplier, including
  // the admin's own domestic one, "foreign". (PR #636 review #1.)
  if (!reclaimCountries || reclaimCountries.length === 0) return 'domestic';
  return reclaimCountries.includes(cc) ? 'domestic' : 'foreign_vat_non_reclaimable';
}

// ── Incoming invoices (inbound_documents) ───────────────────────────────────
function transformInbound(row) {
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    status: row.status,
    parseStatus: row.parse_status,
    parseMethod: row.parse_method,
    pageCount: row.page_count,
    supplierName: row.supplier_name,
    invoiceNumber: row.invoice_number,
    invoiceDate: toIsoDate(row.invoice_date),
    dueDate: toIsoDate(row.due_date),
    currency: row.currency,
    netAmountMinor: row.net_amount_minor,
    vatAmountMinor: row.vat_amount_minor,
    totalAmountMinor: row.total_amount_minor,
    qrAmountMinor: row.qr_amount_minor,
    iban: row.iban,
    paymentReference: row.payment_reference,
    duplicateOfId: row.duplicate_of_id,
    // classification + booking (migration 126)
    disposition: row.disposition,
    taxTreatment: row.tax_treatment,
    eventId: row.event_id,
    categoryId: row.category_id,
    markupType: row.markup_type,
    markupPercent: row.markup_percent != null ? Number(row.markup_percent) : null,
    markupFlatMinor: row.markup_flat_minor,
    billedInvoiceId: row.billed_invoice_id,
    billedInvoiceLineItemId: row.billed_invoice_line_item_id,
    // re-bill customer linkage (migration 132) — the client a rebill/passthrough
    // is attached to. customerName/Email are denormalised from a LEFT JOIN in
    // list/get (null when the row came from a query without the join).
    customerAccountId: row.customer_account_id || null,
    customerName: row.customer_display_name || row.customer_company_name || null,
    customerEmail: row.customer_email || null,
    supplierCountry: row.supplier_country || null,
    note: row.note || null,
    // supplier payment (paid on the incoming invoice itself)
    supplierPaid: !!row.supplier_paid,
    supplierPaidAt: row.supplier_paid_at,
    supplierPaymentMethod: row.supplier_payment_method,
    supplierPaymentRef: row.supplier_payment_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function clampPage(page, pageSize) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const ps = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 25));
  return { p, ps };
}

async function inspectFile(filePath, mimeType) {
  const buf = await fsp.readFile(filePath);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  let pageCount = null;
  if ((mimeType || '').includes('pdf')) {
    try {
      const pdf = await PDFDocument.load(buf, { updateMetadata: false });
      pageCount = pdf.getPageCount();
    } catch (e) {
      logger.warn?.(`expenseService: PDF page count failed for ${filePath}: ${e.message}`);
    }
  }
  return { sha, pageCount };
}

async function recordInboundDocument({ source, filePath, originalFilename, mimeType }, adminId) {
  let fileSha256 = null;
  let pageCount = null;
  try {
    const info = await inspectFile(filePath, mimeType);
    fileSha256 = info.sha; pageCount = info.pageCount;
  } catch (e) {
    logger.warn?.(`expenseService: could not inspect ${filePath}: ${e.message}`);
  }

  let duplicateOfId = null;
  if (fileSha256) {
    const dup = await db('inbound_documents').where({ file_sha256: fileSha256 }).first('id');
    if (dup) duplicateOfId = dup.id;
  }

  const now = new Date();
  const row = {
    source: source || 'upload',
    original_filename: originalFilename || null,
    file_path: filePath,
    mime_type: mimeType || null,
    file_sha256: fileSha256,
    status: duplicateOfId ? 'duplicate' : 'unsorted',
    parse_status: 'pending',
    parse_method: 'none',
    // Cap stored page_count to the renderable max (rasterizeService
    // MAX_RENDERABLE_PAGES) so a hostile high-page PDF can't drive an
    // unbounded inbox pager (PR #622 concern 6).
    page_count: pageCount != null ? Math.min(pageCount, 200) : null,
    duplicate_of_id: duplicateOfId,
    created_by_admin_id: adminId || null,
    created_at: now,
    updated_at: now,
  };
  const inserted = await db('inbound_documents').insert(row).returning('id');
  const id = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
  await logActivity('incoming_invoice_captured', { inboundDocumentId: id, source: row.source, duplicate: !!duplicateOfId }, adminId);
  return getInbound(id);
}

// Denormalise the attached customer's name/email for the inbox UI (re-bill
// chip + pending-pool grouping). LEFT JOIN so docs without a customer still
// return. Selected explicitly to avoid colliding with inbound_documents.*.
const INBOUND_CUSTOMER_SELECT = [
  'inbound_documents.*',
  'c.display_name as customer_display_name',
  'c.company_name as customer_company_name',
  'c.email as customer_email',
];
function inboundWithCustomer() {
  return db('inbound_documents')
    .leftJoin('customer_accounts as c', 'inbound_documents.customer_account_id', 'c.id');
}

async function getInbound(id) {
  const row = await inboundWithCustomer().where('inbound_documents.id', id).first(INBOUND_CUSTOMER_SELECT);
  if (!row) throw new AppError('Incoming invoice not found', 404, 'INBOUND_NOT_FOUND');
  return transformInbound(row);
}

async function listInbound({ status, page, pageSize } = {}) {
  const { p, ps } = clampPage(page, pageSize);
  const base = inboundWithCustomer();
  if (status) base.where('inbound_documents.status', status);
  const countRow = await base.clone().clearSelect().count({ count: 'inbound_documents.id' }).first();
  const total = parseInt(countRow?.count || 0, 10);
  const rows = await base.clone().orderBy('inbound_documents.created_at', 'desc').limit(ps).offset((p - 1) * ps)
    .select(INBOUND_CUSTOMER_SELECT);
  return { items: rows.map(transformInbound), pagination: { page: p, pageSize: ps, total, totalPages: Math.ceil(total / ps) } };
}

const INBOUND_EDITABLE = {
  supplierName: 'supplier_name', invoiceNumber: 'invoice_number', invoiceDate: 'invoice_date',
  dueDate: 'due_date', currency: 'currency', netAmountMinor: 'net_amount_minor',
  vatAmountMinor: 'vat_amount_minor', totalAmountMinor: 'total_amount_minor', iban: 'iban',
  paymentReference: 'payment_reference', note: 'note', supplierCountry: 'supplier_country',
};

async function updateInbound(id, payload, adminId) {
  await getInbound(id);
  const patch = { updated_at: new Date(), parse_status: 'manual' };
  for (const [camel, snake] of Object.entries(INBOUND_EDITABLE)) {
    if (payload[camel] !== undefined) patch[snake] = payload[camel] === '' ? null : payload[camel];
  }
  await db('inbound_documents').where({ id }).update(patch);
  await logActivity('incoming_invoice_updated', { inboundDocumentId: id }, adminId);
  return getInbound(id);
}

// markup helpers (shared with re-bill)
async function resolveMarkup(source, override, contractId, trx) {
  const pick = (type, percent, flatMinor) => ({
    type: MARKUP_TYPES.includes(type) ? type : 'none',
    percent: percent != null ? Number(percent) : null,
    flatMinor: Number.isInteger(flatMinor) ? flatMinor : null,
  });
  if (override && override.markupType && override.markupType !== 'none') {
    return pick(override.markupType, override.markupPercent, override.markupFlatMinor);
  }
  if (source && source.markupType && source.markupType !== 'none') {
    return pick(source.markupType, source.markupPercent, source.markupFlatMinor);
  }
  const { hasColumnCached } = require('../utils/schemaCache');
  if (contractId && (await hasColumnCached('contracts', 'expense_markup_type'))) {
    const c = await (trx || db)('contracts').where({ id: contractId })
      .first('expense_markup_type', 'expense_markup_percent', 'expense_markup_flat_minor');
    if (c && c.expense_markup_type && c.expense_markup_type !== 'none') {
      return pick(c.expense_markup_type, c.expense_markup_percent, c.expense_markup_flat_minor);
    }
  }
  return pick('none', null, null);
}

function computeMarkupMinor(baseMinor, markup) {
  if (markup.type === 'percent' && markup.percent != null) return Math.round(baseMinor * Number(markup.percent) / 100);
  if (markup.type === 'flat' && Number.isInteger(markup.flatMinor)) return markup.flatMinor;
  return 0;
}

// Dispositions that can be billed to a client. 'rebill' always carries a
// customer; 'durchlaufend' (passthrough) may now ALSO attach to a customer
// (with optional markup) so it can be re-billed like a rebill.
const CUSTOMER_DISPOSITIONS = ['rebill', 'durchlaufend'];
const BOOKING_DISPOSITIONS = ['rebill', 'durchlaufend'];

/**
 * Can this invoice still be edited (line removed / appended)? Mirrors the
 * hour-entry lock rules (customerHoursService.isEntryLocked, inverted):
 * monthly drafts and not-yet-armed scheduled invoices are mutable; anything
 * sent/paid/overdue/cancelled or past its scheduled_send_at is locked.
 */
function isInvoiceMutable(invoice) {
  if (!invoice) return true; // referenced invoice gone — treat as not billed
  if (invoice.is_monthly_draft === true || invoice.is_monthly_draft === 1) return true;
  // NB: invoices have no 'draft' status (only quotes do). The editable,
  // not-yet-sent invoice state IS 'scheduled' with no scheduled_send_at (or a
  // future one), handled below — so there is no plain-'draft' case to slot in
  // here (PR #636 review #6).
  if (invoice.status !== 'scheduled') return false;
  if (!invoice.scheduled_send_at) return true;
  return new Date(invoice.scheduled_send_at).getTime() > Date.now();
}

/**
 * Re-categorisation unwind: remove this document's billed line item from its
 * invoice and recompute the invoice totals, so the disposition can change.
 * Refuses when the invoice is already issued (Storno required instead).
 */
async function unwindBilledLine(trx, doc) {
  const invoice = doc.billedInvoiceId
    ? await trx('invoices').where({ id: doc.billedInvoiceId }).first()
    : null;
  if (invoice && !isInvoiceMutable(invoice)) {
    throw new AppError(
      'This re-bill is on an invoice that has already been issued — Storno it before re-categorising.',
      409, 'INVOICE_LOCKED',
    );
  }
  if (doc.billedInvoiceLineItemId) {
    await trx('invoice_line_items').where({ id: doc.billedInvoiceLineItemId }).del();
  }
  if (invoice) {
    const allItems = await trx('invoice_line_items').where({ invoice_id: invoice.id });
    if (allItems.length === 0) {
      // The unwound re-bill was the only line — a net-zero invoice has no reason
      // to survive, and these would otherwise pile up over re-categorisations.
      // It's mutable (checked above) and never issued, so delete it outright
      // (PR #636 review #5). For a monthly draft this just means the next append
      // re-creates one.
      await trx('invoices').where({ id: invoice.id }).del();
      return;
    }
    let netMinor = 0;
    for (const li of allItems) {
      if (li.parent_line_item_id == null) netMinor += Number(li.line_total_minor || 0);
    }
    const vatRate = Number(invoice.vat_rate || 0);
    const vatMinor = Math.round(netMinor * vatRate / 100);
    const shippingMinor = Number(invoice.shipping_amount_minor || 0);
    await trx('invoices').where({ id: invoice.id }).update({
      net_amount_minor: netMinor,
      vat_amount_minor: vatMinor,
      total_amount_minor: netMinor + vatMinor + shippingMinor,
      updated_at: new Date(),
    });
  }
}

/** The single invoice line that re-bills one incoming invoice (base + markup). */
function buildInboundLineItem(doc, disposition, markup) {
  const base = doc.totalAmountMinor != null ? doc.totalAmountMinor : doc.netAmountMinor;
  if (base == null) throw new AppError('Incoming invoice has no amount to re-bill', 400, 'AMOUNT_REQUIRED');
  const lineTotal = base + computeMarkupMinor(base, markup);
  const label = doc.supplierName || 'Weiterverrechnete Auslage';
  const suffix = disposition === 'durchlaufend' ? ' (Durchlaufende Position)' : ' (Weiterverrechnung)';
  return { description: `${label}${suffix}`, quantity: 1, unit_price_minor: lineTotal, discount_percent: 0, line_total_minor: lineTotal };
}

/**
 * Immediately bill ONE incoming invoice to its customer. createInvoice routes
 * monthly/manual customers onto the running draft (consolidated, like hours)
 * and mints a standalone invoice for per-event customers. Stamps the document
 * with the resulting invoice + line.
 */
async function billInboundNow(trx, id, customerAccountId, eventId, disposition, markup, adminId) {
  const row = await trx('inbound_documents').where({ id }).first();
  const doc = transformInbound(row);
  const lineItem = buildInboundLineItem(doc, disposition, markup);
  const { invoiceIds } = await invoiceService.createInvoice({
    customerAccountId,
    eventId: eventId || doc.eventId || null,
    lineItems: [lineItem],
  }, adminId, trx);
  const invoiceId = Array.isArray(invoiceIds) ? invoiceIds[0] : null;
  if (!invoiceId) throw new AppError('Failed to create the re-bill invoice', 500, 'REBILL_FAILED');
  const line = await trx('invoice_line_items').where({ invoice_id: invoiceId }).orderBy('id', 'desc').first('id');
  await trx('inbound_documents').where({ id }).update({
    billed_invoice_id: invoiceId,
    billed_invoice_line_item_id: line ? line.id : null,
    updated_at: new Date(),
  });
  // NOTE: no logActivity here — it writes via the GLOBAL db, which deadlocks
  // when called inside this transaction on a SQLite-backed install (a second
  // write connection blocks on the held write lock). Callers log AFTER commit.
  return invoiceId;
}

/**
 * Give an incoming invoice a disposition (updates the document, no expense
 * row). Re-runnable: re-categorising an already-billed document first unwinds
 * its prior re-bill line. For rebill/passthrough with a customer, monthly &
 * manual customers are billed immediately onto the running draft (like hours);
 * per-event customers stay PENDING in the customer's pool until "Bill these".
 */
async function categorizeInbound(id, payload, adminId) {
  const disposition = payload.disposition;
  if (!DISPOSITIONS.includes(disposition)) {
    throw new AppError(`disposition must be one of ${DISPOSITIONS.join(', ')}`, 400, 'BAD_DISPOSITION');
  }
  const billsToCustomer = CUSTOMER_DISPOSITIONS.includes(disposition);
  const customerAccountId = billsToCustomer && payload.customerAccountId ? payload.customerAccountId : null;
  // rebill REQUIRES a customer; passthrough may omit one (then it's only booked
  // to an event/company and never re-billed).
  if (disposition === 'rebill' && !customerAccountId) {
    throw new AppError('customerAccountId is required to re-bill', 400, 'CUSTOMER_REQUIRED');
  }

  // Reclaim-country list for the tax-treatment auto-default (loaded before the
  // transaction — a global-db read).
  const { vatReclaimCountries } = await getAccountingSettings();

  let billedInvoiceId = null;
  await db.transaction(async (trx) => {
    const row = await trx('inbound_documents').where({ id }).first();
    if (!row) throw new AppError('Incoming invoice not found', 404, 'INBOUND_NOT_FOUND');
    const doc = transformInbound(row);

    // #1: unwind any prior re-bill so the disposition can change.
    if (doc.billedInvoiceId) await unwindBilledLine(trx, doc);

    // Markup is a re-bill concept only. A pass-through (durchlaufender Posten)
    // is invoiced at cost / VAT-neutral, so it never carries a markup.
    const appliesMarkup = disposition === 'rebill';
    const markup = appliesMarkup
      ? await resolveMarkup(
        { markupType: payload.markupType, markupPercent: payload.markupPercent, markupFlatMinor: payload.markupFlatMinor },
        payload, payload.contractId, trx,
      )
      : { type: 'none', percent: null, flatMinor: null };

    const patch = {
      disposition,
      // Explicit treatment wins; else auto-default from the supplier country.
      tax_treatment: resolveTaxTreatment(payload.taxTreatment, doc.supplierCountry, vatReclaimCountries),
      event_id: BOOKING_DISPOSITIONS.includes(disposition) ? (payload.eventId || null) : null,
      category_id: disposition === 'eigener_aufwand' ? (payload.categoryId || null) : null,
      customer_account_id: customerAccountId,
      markup_type: appliesMarkup ? markup.type : 'none',
      markup_percent: appliesMarkup && markup.type === 'percent' ? markup.percent : null,
      markup_flat_minor: appliesMarkup && markup.type === 'flat' ? markup.flatMinor : null,
      // Cleared here; re-set by billInboundNow when we bill immediately.
      billed_invoice_id: null,
      billed_invoice_line_item_id: null,
      status: DISPOSITION_DOC_STATUS[disposition] || 'categorized',
      updated_at: new Date(),
    };
    if (disposition === 'duplikat' && payload.duplicateOfId) patch.duplicate_of_id = payload.duplicateOfId;
    await trx('inbound_documents').where({ id }).update(patch);

    if (customerAccountId) {
      const customer = await trx('customer_accounts').where({ id: customerAccountId }).first();
      if (!customer) throw new AppError('Customer not found', 404, 'CUSTOMER_NOT_FOUND');
      // Monthly/manual = accumulator → bill now onto the running draft.
      // Per-event → leave PENDING for bundling via billPendingRebills.
      if (customer.billing_cadence === 'monthly' || customer.billing_cadence === 'manual') {
        billedInvoiceId = await billInboundNow(trx, id, customerAccountId, payload.eventId || null, disposition, markup, adminId);
      }
    }
  });
  // Audit logging AFTER commit — logActivity writes via the global db and would
  // deadlock if run inside the transaction above on a SQLite-backed install.
  await logActivity('incoming_invoice_categorized', { inboundDocumentId: id, disposition }, adminId);
  if (billedInvoiceId) await logActivity('incoming_invoice_rebilled', { inboundDocumentId: id, invoiceId: billedInvoiceId }, adminId);
  return getInbound(id);
}

/**
 * Explicit "re-bill this one now" endpoint (legacy /inbound/:id/rebill). Forces
 * an immediate single-document bill regardless of cadence. Re-runnable: unwinds
 * a prior re-bill first.
 */
async function rebillInbound(id, payload, adminId, trx0) {
  if (!payload.customerAccountId) throw new AppError('customerAccountId is required to re-bill', 400, 'CUSTOMER_REQUIRED');
  const run = async (trx) => {
    const row = await trx('inbound_documents').where({ id }).first();
    if (!row) throw new AppError('Incoming invoice not found', 404, 'INBOUND_NOT_FOUND');
    const doc = transformInbound(row);
    if (doc.billedInvoiceId) await unwindBilledLine(trx, doc);
    const markup = await resolveMarkup(
      { markupType: doc.markupType, markupPercent: doc.markupPercent, markupFlatMinor: doc.markupFlatMinor },
      payload, payload.contractId, trx,
    );
    await trx('inbound_documents').where({ id }).update({
      disposition: 'rebill',
      status: 'categorized',
      customer_account_id: payload.customerAccountId,
      event_id: payload.eventId || doc.eventId || null,
      markup_type: markup.type,
      markup_percent: markup.type === 'percent' ? markup.percent : null,
      markup_flat_minor: markup.type === 'flat' ? markup.flatMinor : null,
      updated_at: new Date(),
    });
    return billInboundNow(trx, id, payload.customerAccountId, payload.eventId || doc.eventId || null, 'rebill', markup, adminId);
  };
  const invoiceId = trx0 ? await run(trx0) : await db.transaction(run);
  // Log after commit (global-db write — see billInboundNow). When a caller
  // supplied trx0, that outer transaction owns the audit log instead.
  if (!trx0) await logActivity('incoming_invoice_rebilled', { inboundDocumentId: id, invoiceId }, adminId);
  return { document: await getInbound(id), invoiceId };
}

/**
 * Landing aggregate for the inbox "pending re-bills" card: one row per customer
 * that carries categorised-but-unbilled rebill/passthrough documents, with the
 * count + open amount (base + markup). In practice only per-event customers
 * surface here — monthly/manual cadences bill immediately on categorise.
 */
async function listPendingRebillSummary() {
  const rows = await db('inbound_documents as d')
    .join('customer_accounts as c', 'd.customer_account_id', 'c.id')
    .whereNotNull('d.customer_account_id')
    .whereNull('d.billed_invoice_id')
    .whereIn('d.disposition', CUSTOMER_DISPOSITIONS)
    .where('d.status', 'categorized')
    .select(
      'd.customer_account_id', 'd.total_amount_minor', 'd.net_amount_minor',
      'd.markup_type', 'd.markup_percent', 'd.markup_flat_minor',
      'c.company_name', 'c.display_name', 'c.first_name', 'c.last_name',
      'c.email', 'c.password_hash', 'c.billing_cadence',
    );

  const byCustomer = new Map();
  for (const r of rows) {
    let agg = byCustomer.get(r.customer_account_id);
    if (!agg) {
      agg = {
        customerAccountId: r.customer_account_id,
        companyName: r.company_name || null,
        displayName: r.display_name || null,
        firstName: r.first_name || null,
        lastName: r.last_name || null,
        email: r.email || null,
        isPassive: r.password_hash == null,
        billingCadence: r.billing_cadence || null,
        itemCount: 0,
        openAmountMinor: 0,
      };
      byCustomer.set(r.customer_account_id, agg);
    }
    agg.itemCount += 1;
    const base = r.total_amount_minor != null ? Number(r.total_amount_minor)
      : (r.net_amount_minor != null ? Number(r.net_amount_minor) : 0);
    const markup = {
      type: MARKUP_TYPES.includes(r.markup_type) ? r.markup_type : 'none',
      percent: r.markup_percent != null ? Number(r.markup_percent) : null,
      flatMinor: Number.isInteger(r.markup_flat_minor) ? r.markup_flat_minor : null,
    };
    agg.openAmountMinor += base + computeMarkupMinor(base, markup);
  }

  return Array.from(byCustomer.values()).sort((a, b) => b.openAmountMinor - a.openAmountMinor);
}

/**
 * Per-event flow: bundle all pending rebill/passthrough documents for a
 * customer into ONE invoice, one line per document. Refuses for monthly/manual
 * customers (those bill immediately on categorise). Mirrors
 * customerHoursService.billUnbilledEntries.
 */
async function billPendingRebills(customerId, adminId) {
  const customer = await db('customer_accounts').where({ id: customerId }).first();
  if (!customer) throw new AppError('Customer not found', 404);
  if (customer.billing_cadence === 'monthly' || customer.billing_cadence === 'manual') {
    throw new AppError(
      'Monthly/manual customers consolidate automatically on categorise; bundling is for per-event customers.',
      409, 'CADENCE_MISMATCH',
    );
  }

  const result = await db.transaction(async (trx) => {
    const pending = await trx('inbound_documents')
      .where({ customer_account_id: customer.id })
      .whereNull('billed_invoice_id')
      .whereIn('disposition', CUSTOMER_DISPOSITIONS)
      .where('status', 'categorized')
      .orderBy('invoice_date', 'asc').orderBy('id', 'asc');
    if (pending.length === 0) throw new AppError('No pending re-bills to bill', 409, 'NO_PENDING');

    const lineItems = [];
    for (let i = 0; i < pending.length; i += 1) {
      const doc = transformInbound(pending[i]);
      // eslint-disable-next-line no-await-in-loop
      const markup = await resolveMarkup(
        { markupType: doc.markupType, markupPercent: doc.markupPercent, markupFlatMinor: doc.markupFlatMinor },
        null, null, trx,
      );
      lineItems.push({ ...buildInboundLineItem(doc, doc.disposition, markup), position: i + 1 });
    }

    const { invoiceIds } = await invoiceService.createInvoice({
      customerAccountId: customer.id,
      lineItems,
    }, adminId, trx);
    const invoiceId = invoiceIds[0];

    const insertedLines = await trx('invoice_line_items').where({ invoice_id: invoiceId }).orderBy('position', 'asc');
    const lineByPos = new Map(insertedLines.map((li) => [li.position, li.id]));
    const now = new Date();
    for (let i = 0; i < pending.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await trx('inbound_documents').where({ id: pending[i].id }).update({
        billed_invoice_id: invoiceId,
        billed_invoice_line_item_id: lineByPos.get(i + 1) || null,
        updated_at: now,
      });
    }

    return { invoiceId, count: pending.length };
  });
  // Audit log after commit (global-db write — see billInboundNow).
  await logActivity('incoming_invoices_rebilled_bundle', { customerId: customer.id, invoiceId: result.invoiceId, count: result.count }, adminId);
  return result;
}

/** Mark the supplier paid on the incoming invoice (the payable lives here). */
async function markInboundSupplierPayment(id, { paid, paidAt, paymentMethod, paymentReference }, adminId) {
  await getInbound(id);
  if (paymentMethod && !PAYMENT_METHODS.includes(paymentMethod)) {
    throw new AppError(`paymentMethod must be one of ${PAYMENT_METHODS.join(', ')}`, 400, 'BAD_PAYMENT_METHOD');
  }
  await db('inbound_documents').where({ id }).update({
    supplier_paid: !!paid,
    supplier_paid_at: paid ? (paidAt ? new Date(paidAt) : new Date()) : null,
    supplier_payment_method: paid ? (paymentMethod || null) : null,
    supplier_payment_ref: paid ? (paymentReference || null) : null,
    updated_at: new Date(),
  });
  await logActivity('incoming_invoice_supplier_payment', { inboundDocumentId: id, paid: !!paid }, adminId);
  return getInbound(id);
}

// ── Expenses (internal) ─────────────────────────────────────────────────────
function transformExpense(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind || 'amount',
    quantity: row.quantity != null ? Number(row.quantity) : null,
    rateMinor: row.rate_minor,
    eventId: row.event_id, // null = company
    supplierName: row.supplier_name,
    description: row.description,
    chfAmountMinor: row.chf_amount_minor,
    categoryId: row.category_id,
    receiptPath: row.receipt_path,
    hasProof: !!row.receipt_path,
    taxTreatment: row.tax_treatment,
    // invoiced = added to a real client invoice (locks editing); paid = settled.
    billedInvoiceId: row.billed_invoice_id,
    billedInvoiceLineItemId: row.billed_invoice_line_item_id,
    invoiced: !!row.billed_invoice_id,
    customerAccountId: row.customer_account_id,
    paid: !!row.supplier_paid,
    paidAt: row.supplier_paid_at,
    paymentMethod: row.payment_method,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Compute the booked amount (minor) for an internal expense. */
function computeExpenseAmount(kind, quantity, rateMinor, amountMinor) {
  if (kind === 'mileage' || kind === 'per_diem') {
    if (quantity != null && rateMinor != null) return Math.round(Number(quantity) * Number(rateMinor));
    return null;
  }
  return Number.isInteger(amountMinor) ? amountMinor : null;
}

function buildExpenseInsert(payload, adminId, opts = {}) {
  const now = new Date();
  const kind = EXPENSE_KINDS.includes(payload.kind) ? payload.kind : 'amount';
  let rateMinor = null;
  if (kind === 'mileage') rateMinor = Number.isInteger(payload.rateMinor) ? payload.rateMinor : (opts.kmRateMinor ?? null);
  else if (kind === 'per_diem') rateMinor = Number.isInteger(payload.rateMinor) ? payload.rateMinor : (opts.perDiemRateMinor ?? null);
  const quantity = (kind === 'mileage' || kind === 'per_diem') && payload.quantity != null ? Number(payload.quantity) : null;
  const chf = computeExpenseAmount(kind, quantity, rateMinor, payload.chfAmountMinor);
  return {
    inbound_document_id: null,
    disposition: 'eigener_aufwand', // internal expenses are always own-cost
    tax_treatment: TAX_TREATMENTS.includes(payload.taxTreatment) ? payload.taxTreatment : 'domestic',
    event_id: payload.eventId || null, // null = company
    supplier_name: payload.supplierName || null,
    description: payload.description || null,
    kind,
    quantity,
    rate_minor: rateMinor,
    chf_amount_minor: chf,
    gross_amount_minor: chf,
    category_id: payload.categoryId || null,
    receipt_path: opts.receiptPath || null,
    status: 'open',
    created_by_admin_id: adminId || null,
    created_at: now,
    updated_at: now,
  };
}

async function getExpense(id) {
  const row = await db('expenses').where({ id }).first();
  if (!row) throw new AppError('Expense not found', 404, 'EXPENSE_NOT_FOUND');
  return transformExpense(row);
}

async function createExpense(payload, adminId, { receiptPath } = {}) {
  const settings = await getAccountingSettings();
  if (settings.requireProof && !receiptPath) {
    throw new AppError('A proof file is required for expenses', 400, 'PROOF_REQUIRED');
  }
  const row = buildExpenseInsert(payload, adminId, {
    receiptPath,
    kmRateMinor: settings.kmRateMinor,
    perDiemRateMinor: settings.perDiemRateMinor,
  });
  const inserted = await db('expenses').insert(row).returning('id');
  const id = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
  await logActivity('expense_created', { expenseId: id, kind: row.kind }, adminId);
  return getExpense(id);
}

async function listExpenses({ kind, eventId, categoryId, page, pageSize } = {}) {
  const { p, ps } = clampPage(page, pageSize);
  const base = db('expenses').where({ inbound_document_id: null }); // internal only
  if (kind) base.where({ kind });
  if (categoryId) base.where({ category_id: categoryId });
  if (eventId === 'company') base.whereNull('event_id');
  else if (eventId) base.where({ event_id: eventId });
  const countRow = await base.clone().count({ count: '*' }).first();
  const total = parseInt(countRow?.count || 0, 10);
  const rows = await base.clone().orderBy('created_at', 'desc').limit(ps).offset((p - 1) * ps);
  return { items: rows.map(transformExpense), pagination: { page: p, pageSize: ps, total, totalPages: Math.ceil(total / ps) } };
}

const EXPENSE_EDITABLE = {
  supplierName: 'supplier_name', description: 'description', taxTreatment: 'tax_treatment',
  eventId: 'event_id', categoryId: 'category_id',
};

async function updateExpense(id, payload, adminId, { receiptPath } = {}) {
  const existing = await getExpense(id);
  if (existing.invoiced) {
    throw new AppError('Expense is invoiced — editing is locked', 409, 'EXPENSE_LOCKED');
  }
  const patch = { updated_at: new Date() };
  for (const [camel, snake] of Object.entries(EXPENSE_EDITABLE)) {
    if (payload[camel] !== undefined) patch[snake] = payload[camel] === '' ? null : payload[camel];
  }
  if (receiptPath) patch.receipt_path = receiptPath;
  await db('expenses').where({ id }).update(patch);
  await logActivity('expense_updated', { expenseId: id }, adminId);
  return getExpense(id);
}

/** Add an internal expense onto a client invoice (mints a line). Marks it
 *  invoiced (locks editing) + links the invoice. base = chf amount + markup. */
async function rebillExpense(id, payload, adminId, trx0) {
  const run = async (trx) => {
    const row = await trx('expenses').where({ id }).first();
    if (!row) throw new AppError('Expense not found', 404, 'EXPENSE_NOT_FOUND');
    const exp = transformExpense(row);
    if (exp.invoiced) throw new AppError('Expense already invoiced', 409, 'ALREADY_INVOICED');
    if (!payload.customerAccountId) throw new AppError('customerAccountId is required', 400, 'CUSTOMER_REQUIRED');
    const base = exp.chfAmountMinor;
    if (base == null) throw new AppError('Expense has no amount to invoice', 400, 'AMOUNT_REQUIRED');
    const markup = await resolveMarkup(
      { markupType: row.markup_type, markupPercent: row.markup_percent, markupFlatMinor: row.markup_flat_minor },
      payload, payload.contractId, trx,
    );
    const lineTotal = base + computeMarkupMinor(base, markup);
    const label = exp.description || exp.supplierName || 'Aufwand';
    const { invoiceIds } = await invoiceService.createInvoice({
      customerAccountId: payload.customerAccountId,
      eventId: payload.eventId || exp.eventId || null,
      lineItems: [{ description: `${label} (Weiterverrechnung)`, quantity: 1, unit_price_minor: lineTotal, discount_percent: 0, line_total_minor: lineTotal }],
    }, adminId, trx);
    const invoiceId = Array.isArray(invoiceIds) ? invoiceIds[0] : null;
    if (!invoiceId) throw new AppError('Failed to create invoice', 500, 'INVOICE_FAILED');
    const line = await trx('invoice_line_items').where({ invoice_id: invoiceId }).orderBy('id', 'desc').first('id');
    await trx('expenses').where({ id }).update({
      billed_invoice_id: invoiceId,
      billed_invoice_line_item_id: line ? line.id : null,
      billed_at: new Date(),
      customer_account_id: payload.customerAccountId,
      markup_type: markup.type,
      markup_percent: markup.type === 'percent' ? markup.percent : null,
      markup_flat_minor: markup.type === 'flat' ? markup.flatMinor : null,
      status: 'invoiced',
      updated_at: new Date(),
    });
    await logActivity('expense_invoiced', { expenseId: id, invoiceId }, adminId);
    return invoiceId;
  };
  const invoiceId = trx0 ? await run(trx0) : await db.transaction(run);
  return { expense: await getExpense(id), invoiceId };
}

/** Mark an expense paid/settled (manual). */
async function markExpensePaid(id, { paid, paidAt, paymentMethod, paymentReference }, adminId) {
  await getExpense(id);
  if (paymentMethod && !PAYMENT_METHODS.includes(paymentMethod)) {
    throw new AppError(`paymentMethod must be one of ${PAYMENT_METHODS.join(', ')}`, 400, 'BAD_PAYMENT_METHOD');
  }
  await db('expenses').where({ id }).update({
    supplier_paid: !!paid,
    supplier_paid_at: paid ? (paidAt ? new Date(paidAt) : new Date()) : null,
    payment_method: paid ? (paymentMethod || null) : null,
    payment_reference: paid ? (paymentReference || null) : null,
    updated_at: new Date(),
  });
  await logActivity('expense_paid', { expenseId: id, paid: !!paid }, adminId);
  return getExpense(id);
}

module.exports = {
  getAccountingSettings,
  rebillExpense,
  markExpensePaid,
  // incoming invoices
  recordInboundDocument,
  getInbound,
  listInbound,
  updateInbound,
  categorizeInbound,
  rebillInbound,
  listPendingRebillSummary,
  billPendingRebills,
  markInboundSupplierPayment,
  // expenses
  createExpense,
  getExpense,
  listExpenses,
  updateExpense,
  // constants
  DISPOSITIONS,
  TAX_TREATMENTS,
  MARKUP_TYPES,
  PAYMENT_METHODS,
  EXPENSE_KINDS,
  // unit-test surface
  _internal: { computeMarkupMinor, resolveMarkup, computeExpenseAmount, buildExpenseInsert, transformExpense, transformInbound, buildInboundLineItem, isInvoiceMutable, resolveTaxTreatment },
};
