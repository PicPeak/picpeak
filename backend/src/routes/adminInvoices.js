/**
 * Admin → Invoices Routes
 *
 * Endpoint mounted at /api/admin/invoices. Surface:
 *   GET    /                            list (filter + sort + paginate)
 *   POST   /                            create (status=scheduled or sent)
 *   GET    /:id                         detail incl. line items + payments
 *   PUT    /:id                         update (only when not paid/cancelled)
 *   POST   /:id/send                    render PDF + queue email now
 *   POST   /:id/mark-paid               record a payment
 *   POST   /:id/send-reminder           manually trigger reminder ladder
 *   POST   /:id/cancel                  cancel a non-paid invoice
 *   GET    /:id/pdf                     preview / download PDF
 *   GET    /:id/payment-log             list payment log entries
 *   POST   /preview                     render PDF from unsaved payload
 *
 * Permissions: `bills.view` for reads, `bills.manage` for writes.
 * Global `bills` feature flag enforced at the route layer.
 */

const express = require('express');
const { body, param, query } = require('express-validator');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const { getStoragePath } = require('../config/storage');
const invoiceService = require('../services/invoiceService');
const { db } = require('../database/db');

const router = express.Router();

// PR #603 review follow-up #2 — bound payment dates. `isISO8601()` alone
// accepts year 1900/9999; cash-basis revenue keys on paid_at, so a typo
// (2026→2226) would silently push a payment out of every dashboard window
// forever. Reject anything before 2000-01-01 or more than 30 days in the
// future (small future window covers value-date lag without allowing fat-
// finger years). Use as `.custom(isReasonablePaidAt)` after `.isISO8601()`.
function isReasonablePaidAt(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error('Invalid payment date');
  const min = new Date('2000-01-01T00:00:00Z');
  const max = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  if (d < min || d > max) {
    throw new Error('Payment date must be between 2000-01-01 and 30 days from now');
  }
  return true;
}

// Multer config for "import historical invoice" PDF uploads. Stored
// under storage/business-docs/invoice-imports/<year>/<filename> so
// imported files don't collide with the renderer's own output under
// storage/business-docs/invoice/<year>/. PDF-only, 10MB cap.
const importedInvoiceStorage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    const year = new Date().getFullYear();
    const dir = path.join(getStoragePath(), 'business-docs', 'invoice-imports', String(year));
    await fs.mkdir(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.pdf';
    cb(null, `imported-${Date.now()}${ext}`);
  },
});
const importedInvoiceUpload = multer({
  storage: importedInvoiceStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are allowed for imported invoices'));
  },
});

async function requireBillsFlag(req, res, next) {
  try {
    const row = await db('feature_flags').where({ key: 'bills' }).first();
    const enabled = row && (row.value === true || row.value === 1 || row.value === '1');
    if (!enabled) return res.status(403).json({ error: 'Bills feature is disabled', code: 'BILLS_DISABLED' });
    next();
  } catch (err) { next(err); }
}

router.use(adminAuth);
router.use(requireBillsFlag);

function transformInvoice(i) {
  if (!i) return null;
  return {
    id: i.id,
    invoiceNumber: i.invoice_number,
    customerAccountId: i.customer_account_id,
    customer: {
      email: i.customer_email,
      displayName: i.customer_display_name,
      firstName: i.customer_first_name,
      lastName: i.customer_last_name,
      companyName: i.customer_company_name,
      // Passive customers (admin-only, no portal access) are
      // identified by a null password_hash. We expose just the
      // boolean — the hash itself is dropped here.
      isPassive: i.customer_password_hash == null,
    },
    // Migration 140 — cross-document lineage UUID. See adminQuotes
    // transform for the rationale; lets the lineage card pull the
    // whole deal in one query.
    dealUuid: i.deal_uuid || null,
    sourceQuoteId: i.source_quote_id,
    sourceQuoteNumber: i.source_quote_number || null,
    // Migration 130 lineage: set by contractService.convertToInvoiceOnly
    // so BillDetailPage can render a "From contract" badge. The number
    // (e.g. LBM-C-2026-0010) comes from the src_contract JOIN; the id
    // is kept as a fallback for invoices generated before the JOIN
    // was wired in.
    sourceContractId: i.source_contract_id || null,
    sourceContractNumber: i.source_contract_number || null,
    eventId: i.event_id,
    language: i.language,
    currency: i.currency,
    issueDate: i.issue_date,
    dueDate: i.due_date,
    installmentIndex: i.installment_index,
    installmentTotal: i.installment_total,
    installmentLabel: i.installment_label,
    installmentTrigger: i.installment_trigger,
    status: i.status,
    scheduledSendAt: i.scheduled_send_at,
    sentAt: i.sent_at,
    netAmountMinor: i.net_amount_minor,
    vatRate: i.vat_rate == null ? null : Number(i.vat_rate),
    // Snapshotted VAT code (migration 130) — the editor needs it to repopulate
    // VatRateSelect on edit; without it the dropdown falls back to rate-matching
    // and a custom-rate code is silently lost.
    vatCode: i.vat_code || null,
    vatAmountMinor: i.vat_amount_minor,
    shippingAmountMinor: i.shipping_amount_minor,
    totalAmountMinor: i.total_amount_minor,
    paidAmountMinor: i.paid_amount_minor,
    paidAt: i.paid_at,
    paymentMethod: i.payment_method,
    paymentReference: i.payment_reference,
    reminderLevel: i.reminder_level,
    lastReminderSentAt: i.last_reminder_sent_at,
    lateFeeAmountMinor: i.late_fee_amount_minor,
    ccPdfEmail: i.cc_pdf_email,
    qrFormat: i.qr_format,
    pdfPath: i.pdf_path,
    businessBankAccountId: i.business_bank_account_id,
    paymentTermTemplateId: i.payment_term_template_id || null,
    // Split payment-term picker (migration 124). Two new FKs; the
    // editor prefers these. Both must be present for the new path to
    // engage server-side.
    paymentNetDaysTemplateId: i.payment_net_days_template_id || null,
    paymentTimingTemplateId: i.payment_timing_template_id || null,
    // Migration 126 — per-invoice Skonto opt-out. Editor surfaces
    // this as a checkbox so admin can suppress the discount for one
    // invoice without touching the template or global default.
    skontoDisabled: i.skonto_disabled === true || i.skonto_disabled === 1,
    // Monthly billing (migration 128). isMonthlyDraft=true marks the
    // accumulator the editor's banner + save-button-label react to.
    // monthlyPeriodStart/End drive the period banner on the customer
    // detail page and (later) the PDF header.
    isMonthlyDraft: i.is_monthly_draft === true || i.is_monthly_draft === 1,
    monthlyPeriodStart: i.monthly_period_start || null,
    monthlyPeriodEnd: i.monthly_period_end || null,
    // Storno wiring (migration 114). The four FK columns drive the
    // admin UI's banners + action gating:
    //  - kind: 'invoice' | 'storno' — defaults to 'invoice' for rows
    //    seeded before the column existed (legacy installs).
    //  - replacesInvoiceId: on a reissued invoice → original cancelled id.
    //  - cancelsInvoiceId: on a Storno row → invoice it reverses.
    //  - cancellationStornoId: on a cancelled original → Storno that
    //    cancelled it (so the detail view can link forward).
    kind: i.kind || 'invoice',
    replacesInvoiceId: i.replaces_invoice_id || null,
    cancelsInvoiceId: i.cancels_invoice_id || null,
    cancelsInvoiceNumber: i.cancels_invoice_number || null,
    cancellationStornoId: i.cancellation_storno_id || null,
    cancellationStornoNumber: i.cancellation_storno_number || null,
    // Inline event snapshot (migration 123). The editor binds to
    // these, the list page shows event_name as a column, and email
    // / tax-report rendering reads them in preference to the FK.
    eventName: i.event_name || null,
    eventDate: i.event_date || null,
    eventTimeStart: i.event_time_start || null,
    eventTimeEnd: i.event_time_end || null,
    // `isImported` surfaces the historical-PDF flag to the admin UI
    // so the list / detail page can hide line-item editing on rows
    // that originated from a different billing system (migration 111).
    isImported: !!i.imported_pdf_path,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
  };
}

function transformLineItem(li) {
  return {
    id: li.id,
    position: li.position,
    quantity: Number(li.quantity),
    description: li.description,
    unitPriceMinor: li.unit_price_minor,
    discountPercent: li.discount_percent == null ? 0 : Number(li.discount_percent),
    lineTotalMinor: li.line_total_minor,
    // Hierarchy (migration 119). parentPosition comes from the
    // self-join in getInvoiceById; parentLineItemId is the raw FK.
    // detailsText is the optional free-form notes block rendered
    // below the description on the PDF and customer view.
    parentLineItemId: li.parent_line_item_id || null,
    parentPosition: li.parent_position == null ? null : Number(li.parent_position),
    detailsText: li.details_text || null,
  };
}

function transformPaymentLog(p) {
  return {
    id: p.id,
    amountMinor: p.amount_minor,
    paidAt: p.paid_at,
    paymentMethod: p.payment_method,
    reference: p.reference,
    notes: p.notes,
    recordedByAdminId: p.recorded_by_admin_id,
    createdAt: p.created_at,
  };
}

const INVOICE_BODY_VALIDATORS = [
  body('customerAccountId').optional({ values: 'falsy' }).isInt({ min: 1 }),
  body('language').optional({ values: 'falsy' }).isString().isLength({ max: 8 }),
  body('currency').optional({ values: 'falsy' }).isString().isLength({ min: 3, max: 3 }),
  body('issueDate').optional({ values: 'falsy' }).isISO8601(),
  body('dueDate').optional({ values: 'falsy' }).isISO8601(),
  body('scheduledSendAt').optional({ values: 'falsy' }).isISO8601(),
  body('installmentIndex').optional({ values: 'falsy' }).isInt({ min: 0 }),
  body('installmentTotal').optional({ values: 'falsy' }).isInt({ min: 1 }),
  body('installmentLabel').optional({ values: 'falsy' }).isString().isLength({ max: 128 }),
  body('installmentTrigger').optional({ values: 'falsy' }).isString().isLength({ max: 32 }),
  body('vatRate').optional({ values: 'falsy' }).isFloat({ min: 0, max: 100 }),
  body('shippingAmountMinor').optional({ values: 'falsy' }).isInt({ min: 0 }),
  body('ccPdfEmail').optional({ values: 'falsy' }).isString().isLength({ max: 255 }),
  body('businessBankAccountId').optional({ values: 'falsy' }).isInt({ min: 1 }),
  body('qrFormat').optional({ values: 'falsy' }).isIn(['swiss', 'epc', 'none']),
  body('paymentTermTemplateId').optional({ values: 'falsy' }).isInt({ min: 1 }),
  // Split payment-term picker (migration 124). Both optional at the
  // validator level so legacy clients still work; the editor will
  // require them once it's updated.
  body('paymentNetDaysTemplateId').optional({ values: 'falsy' }).isInt({ min: 1 }),
  body('paymentTimingTemplateId').optional({ values: 'falsy' }).isInt({ min: 1 }),
  // Ad-hoc installments override (commit #6 of the deal_uuid PR).
  // When the array has ≥2 rows with percent>0, createInvoice routes
  // through spawnInstallmentInvoices (commit #4) and returns
  // invoiceIds[].
  body('installments').optional().isArray(),
  body('installments.*.label').optional({ values: 'falsy' }).isString().isLength({ max: 128 }),
  body('installments.*.percent').optional({ values: 'falsy' }).isFloat({ min: 0, max: 100 }),
  body('installments.*.trigger').optional({ values: 'falsy' }).isIn(['quote_accepted', 'before_event', 'after_event', 'after_delivery', 'fixed_date']),
  body('installments.*.offset_days').optional({ values: 'falsy' }).isInt(),
  body('skontoDisabled').optional().isBoolean(),
  // Inline event snapshot (migration 123). Mirrors quotes — kept
  // optional because standalone invoices may not have an event yet.
  // eventId links the invoice to a gallery event (FK) when created from
  // the event detail page; persisted by createInvoice (event_id).
  body('eventId').optional({ values: 'falsy' }).isInt({ min: 1 }),
  body('eventName').optional({ values: 'falsy' }).isString().isLength({ max: 255 }),
  body('eventDate').optional({ values: 'falsy' }).isISO8601(),
  body('eventTimeStart').optional({ values: 'falsy' }).isString().isLength({ max: 8 }),
  body('eventTimeEnd').optional({ values: 'falsy' }).isString().isLength({ max: 8 }),
  body('lineItems').optional({ values: 'falsy' }).isArray(),
  body('lineItems.*.description').optional({ values: 'falsy' }).isString().isLength({ min: 1, max: 1000 }),
  body('lineItems.*.quantity').optional({ values: 'falsy' }).isFloat({ min: 0 }),
  // Negative unit prices are allowed so admins can add manual
  // discount / Rabatt lines (e.g. "Treuerabatt -50,00 €"). The
  // service-layer total guard rejects invoices whose net goes below
  // zero — for credit notes, use Storno instead.
  body('lineItems.*.unitPriceMinor').optional({ values: 'falsy' }).isInt(),
  body('lineItems.*.discountPercent').optional({ values: 'falsy' }).isFloat({ min: 0, max: 100 }),
  // Migration 119: sub-item + details support. Cross-row constraints
  // (parent must exist, max 1 level deep) are enforced by the service
  // (validateLineItemHierarchy).
  body('lineItems.*.parentPosition').optional({ values: 'falsy' }).isInt({ min: 1 }),
  body('lineItems.*.detailsText').optional({ values: 'falsy' }).isString().isLength({ max: 2000 }),
];

function mapPayloadToService(body) {
  const out = {};
  const map = {
    customerAccountId: 'customerAccountId',
    sourceQuoteId: 'sourceQuoteId',
    eventId: 'eventId',
    language: 'language', currency: 'currency',
    issueDate: 'issueDate', dueDate: 'dueDate',
    scheduledSendAt: 'scheduledSendAt',
    installmentIndex: 'installmentIndex',
    installmentTotal: 'installmentTotal',
    installmentLabel: 'installmentLabel',
    installmentTrigger: 'installmentTrigger',
    vatRate: 'vatRate', shippingAmountMinor: 'shippingAmountMinor',
    ccPdfEmail: 'ccPdfEmail', businessBankAccountId: 'businessBankAccountId',
    qrFormat: 'qrFormat',
    eventName: 'eventName',
    eventDate: 'eventDate',
    eventTimeStart: 'eventTimeStart',
    eventTimeEnd: 'eventTimeEnd',
    paymentTermTemplateId: 'paymentTermTemplateId',
    paymentNetDaysTemplateId: 'paymentNetDaysTemplateId',
    paymentTimingTemplateId: 'paymentTimingTemplateId',
    skontoDisabled: 'skontoDisabled',
    // Ad-hoc installment plan from the InstallmentsPanel. When the
    // array has ≥2 entries with percent > 0, createInvoice routes
    // through spawnInstallmentInvoices (commit #4).
    installments: 'installments',
  };
  for (const [api, svc] of Object.entries(map)) {
    if (Object.prototype.hasOwnProperty.call(body, api)) out[svc] = body[api];
  }
  if (Array.isArray(body.lineItems)) {
    out.lineItems = body.lineItems.map((li, idx) => ({
      position: li.position == null ? idx + 1 : li.position,
      quantity: li.quantity,
      description: li.description,
      unit_price_minor: li.unitPriceMinor,
      discount_percent: li.discountPercent,
      // Migration 119 sub-item + details support — same mapping as
      // quotes so the editor's payload shape is identical for both.
      parent_position: li.parentPosition == null || li.parentPosition === '' ? null : Number(li.parentPosition),
      details_text: li.detailsText == null ? null : String(li.detailsText),
    }));
  }
  return out;
}

// ---- list + read -----------------------------------------------------

router.get(
  '/',
  requirePermission('bills.view'),
  [
    query('status').optional({ values: 'falsy' }).isString(),
    query('customerAccountId').optional({ values: 'falsy' }).isInt({ min: 1 }),
    query('sourceQuoteId').optional({ values: 'falsy' }).isInt({ min: 1 }),
    query('unpaidOnly').optional({ values: 'falsy' }).isBoolean(),
    query('includeDrafts').optional({ values: 'falsy' }).isBoolean(),
    query('q').optional({ values: 'falsy' }).isString().isLength({ max: 255 }),
    query('sort').optional({ values: 'falsy' }).isIn(['newest', 'oldest', 'issue_asc', 'issue_desc', 'due_asc', 'due_desc', 'value_asc', 'value_desc', 'customer_asc', 'customer_desc']),
    query('page').optional({ values: 'falsy' }).isInt({ min: 1 }),
    query('pageSize').optional({ values: 'falsy' }).isInt({ min: 1, max: 100 }),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const statusFilter = req.query.status
      ? String(req.query.status).split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const { rows, total, page, pageSize } = await invoiceService.listInvoices({
      filters: {
        status: statusFilter,
        customerAccountId: req.query.customerAccountId ? parseInt(req.query.customerAccountId, 10) : null,
        sourceQuoteId: req.query.sourceQuoteId ? parseInt(req.query.sourceQuoteId, 10) : null,
        unpaidOnly: req.query.unpaidOnly === 'true' || req.query.unpaidOnly === true,
        // Surface running monthly/manual accumulator drafts (hidden by
        // default per migration 128) when the Bills list explicitly asks.
        includeMonthlyDrafts: req.query.includeDrafts === 'true' || req.query.includeDrafts === true,
        q: req.query.q,
      },
      sort: req.query.sort || 'issue_desc',
      page: req.query.page ? parseInt(req.query.page, 10) : 1,
      pageSize: req.query.pageSize ? parseInt(req.query.pageSize, 10) : 25,
    });
    return successResponse(res, {
      invoices: rows.map(transformInvoice),
      pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 },
    });
  })
);

router.get(
  '/:id',
  requirePermission('bills.view'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const id = parseInt(req.params.id, 10);
    const data = await invoiceService.getInvoiceById(id);
    if (!data) return res.status(404).json({ error: 'Invoice not found' });
    // Resolve the effective Skonto percentage so the BillDetail
    // "Record payment" dialog can render the "Paid with Skonto"
    // checkbox + auto-fill the discounted amount (migration 126).
    // Reuses the same resolver the payment-check email path uses so
    // the two surfaces agree on whether the invoice qualifies.
    const skontoPercent = await invoiceService.resolveSkontoPercentForInvoice(data.invoice);
    const invoiceOut = transformInvoice(data.invoice);
    invoiceOut.skontoPercent = skontoPercent || null;
    return successResponse(res, {
      invoice: invoiceOut,
      lineItems: data.lineItems.map(transformLineItem),
      payments: data.payments.map(transformPaymentLog),
    });
  })
);

// ---- create + update -------------------------------------------------

router.post(
  '/',
  requirePermission('bills.manage'),
  [body('customerAccountId').isInt({ min: 1 }), ...INVOICE_BODY_VALIDATORS],
  handleAsync(async (req, res) => {
    validateRequest(req);
    // createInvoice always returns `{ invoiceIds: number[] }` —
    // single-installment / standalone case is a one-element array,
    // multi-installment is N (auto-routed through
    // spawnInstallmentInvoices). The response surfaces the first
    // invoice's payload (the one the editor redirects to) plus the
    // full id list so the editor can show "N invoices created".
    const { invoiceIds } = await invoiceService.createInvoice(mapPayloadToService(req.body), req.admin.id);
    const firstId = invoiceIds[0];
    const data = await invoiceService.getInvoiceById(firstId);
    return successResponse(res, {
      invoice: transformInvoice(data.invoice),
      lineItems: data.lineItems.map(transformLineItem),
      invoiceIds,
    }, 201, 'Invoice created');
  })
);

// POST /import — attach a historical invoice PDF to a customer's
// account. Inserts a minimal invoice row whose `imported_pdf_path`
// points at the uploaded file. Every PDF endpoint (admin + customer)
// short-circuits the renderer when this column is populated, so the
// customer downloads the original document untouched.
//
// Use case: migrating from QuickBooks / Bexio / Xero — the admin
// keeps the legal records intact but the customer still sees a
// consolidated history in their portal.
//
// Form fields (multipart/form-data):
//   pdf                file (required, application/pdf, max 10MB)
//   customerAccountId  int (required)
//   invoiceNumber      string (required — admin types the original)
//   issueDate          ISO date (required)
//   dueDate            ISO date (optional, defaults to issueDate)
//   totalAmountMinor   int minor units (required)
//   currency           3-letter ISO (optional, default profile/CHF)
//   status             'sent' | 'paid' | 'overdue' (default 'sent')
//   paidAmountMinor    int (optional, for status='paid')
//   paidAt             ISO date (optional — the real historical payment
//                      date; defaults to issueDate, never import time)
//   language           string (optional, default 'de')
router.post(
  '/import',
  requirePermission('bills.manage'),
  importedInvoiceUpload.single('pdf'),
  [
    body('customerAccountId').isInt({ min: 1 }),
    body('invoiceNumber').isString().isLength({ min: 1, max: 64 }),
    body('eventName').optional({ values: 'falsy' }).isString().isLength({ max: 255 }),
    body('eventDate').optional({ values: 'falsy' }).isISO8601(),
    body('issueDate').isISO8601(),
    body('dueDate').optional({ values: 'falsy' }).isISO8601(),
    body('totalAmountMinor').isInt({ min: 0 }),
    body('currency').optional({ values: 'falsy' }).isString().isLength({ min: 3, max: 3 }),
    body('status').optional({ values: 'falsy' }).isIn(['sent', 'paid', 'overdue']),
    body('paidAmountMinor').optional({ values: 'falsy' }).isInt({ min: 0 }),
    body('paidAt').optional({ values: 'falsy' }).isISO8601().custom(isReasonablePaidAt),
    body('language').optional({ values: 'falsy' }).isString().isLength({ max: 8 }),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    if (!req.file) return res.status(400).json({ error: 'PDF file is required' });

    // Confirm the customer exists + has bills enabled (same gate as
    // the regular createInvoice).
    const customer = await db('customer_accounts').where({ id: req.body.customerAccountId }).first();
    if (!customer) {
      // Clean up the uploaded file so failed imports don't leave
      // orphans on disk.
      try { await fs.unlink(req.file.path); } catch (_) { /* ignore */ }
      return res.status(404).json({ error: 'Customer not found' });
    }
    if (customer.feature_bills === false || customer.feature_bills === 0 || customer.feature_bills === '0') {
      try { await fs.unlink(req.file.path); } catch (_) { /* ignore */ }
      return res.status(409).json({
        error: 'This customer has bills disabled',
        code: 'CUSTOMER_FEATURE_DISABLED',
      });
    }

    // Refuse duplicate invoice numbers — tax compliance requires
    // uniqueness within the issuer's books.
    const conflict = await db('invoices').where({ invoice_number: req.body.invoiceNumber }).first();
    if (conflict) {
      try { await fs.unlink(req.file.path); } catch (_) { /* ignore */ }
      return res.status(409).json({
        error: `Invoice number "${req.body.invoiceNumber}" already exists`,
        code: 'INVOICE_NUMBER_TAKEN',
      });
    }

    const totalMinor = parseInt(req.body.totalAmountMinor, 10);
    const status     = req.body.status || 'sent';
    // A paid import with no explicit paid amount means FULLY paid — default
    // paid_amount_minor to the total. The dashboard revenue windows sum
    // paid_amount_minor (not total), so a blank paid amount used to store 0
    // and the paid invoice contributed nothing to revenue.
    const explicitPaid = req.body.paidAmountMinor != null && String(req.body.paidAmountMinor) !== '';
    const paidMinor  = explicitPaid
      ? (parseInt(req.body.paidAmountMinor, 10) || 0)
      : (status === 'paid' ? totalMinor : 0);
    const issueDate  = req.body.issueDate;
    const dueDate    = req.body.dueDate || issueDate;
    // Imported docs are historical: their real send/payment dates are
    // the document's own dates, NOT the moment of import. Stamping
    // import-time here put year-old paid invoices inside the dashboard's
    // rolling "Revenue · last 30 days" window (which keys on paid_at).
    // Anchor to the historical date; let the admin override paid_at when
    // they know the exact payment date.
    const paidAt     = req.body.paidAt || issueDate;
    const currency   = (req.body.currency || customer.preferred_currency || 'CHF').toUpperCase();
    const language   = req.body.language || customer.preferred_language || 'de';

    const row = {
      invoice_number: req.body.invoiceNumber,
      customer_account_id: customer.id,
      source_quote_id: null,
      // No FK link on import — the event may predate picpeak. Store the
      // free-text snapshot only, mirroring createInvoice's event_name /
      // event_date columns (migration 107).
      event_id: null,
      event_name: req.body.eventName || null,
      event_date: req.body.eventDate || null,
      language,
      currency,
      issue_date: issueDate,
      due_date: dueDate,
      installment_index: 0,
      installment_total: 1,
      installment_label: null,
      installment_trigger: null,
      status,
      scheduled_send_at: null,
      sent_at: new Date(issueDate),
      net_amount_minor: totalMinor,         // imported docs lack a breakdown
      vat_rate: 0,                          // VAT info lives in the imported PDF
      vat_amount_minor: 0,
      shipping_amount_minor: 0,
      total_amount_minor: totalMinor,
      paid_amount_minor: paidMinor,
      paid_at: status === 'paid' ? new Date(paidAt) : null,
      // Store the path RELATIVE to STORAGE_PATH so the value survives
      // a host migration (Docker volume remount on a new host with a
      // different absolute path).
      imported_pdf_path: path.relative(getStoragePath(), req.file.path),
      created_by_admin_id: req.admin.id,
      created_at: new Date(),
      updated_at: new Date(),
    };

    const inserted = await db('invoices').insert(row).returning('id');
    const invoiceId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];

    return successResponse(res, {
      invoice: transformInvoice(await db('invoices').where({ id: invoiceId }).first()),
    }, 201, 'Invoice imported');
  })
);

// PUT — full re-save delegated through createInvoice's helper isn't
// straightforward (we keep the existing row). Implementing as a small
// inline shim that overrides scalars + replaces line items.
router.put(
  '/:id',
  requirePermission('bills.manage'),
  [param('id').isInt({ min: 1 }), ...INVOICE_BODY_VALIDATORS],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const id = parseInt(req.params.id, 10);
    const existing = await db('invoices').where({ id }).first();
    if (!existing) return res.status(404).json({ error: 'Invoice not found' });
    // Once an invoice has been sent to the customer it becomes a
    // legal record under CH/LI/DE/AT tax rules ("Rechnung ist
    // ausgestellt"). Modifying it in place would break the audit
    // trail — the correct workflow is to cancel the original +
    // issue a new one. Only `scheduled` (not yet sent) invoices
    // remain editable.
    if (existing.status !== 'scheduled') {
      return res.status(409).json({
        error: `Cannot edit invoice with status '${existing.status}'. Sent invoices are locked — cancel and reissue if changes are needed.`,
        code: 'INVOICE_LOCKED',
      });
    }
    const payload = mapPayloadToService(req.body);

    // Recompute totals if line items are present.
    let updates = { updated_at: new Date() };
    const map = {
      language: 'language', currency: 'currency',
      issueDate: 'issue_date', dueDate: 'due_date',
      scheduledSendAt: 'scheduled_send_at',
      installmentIndex: 'installment_index',
      installmentTotal: 'installment_total',
      installmentLabel: 'installment_label',
      installmentTrigger: 'installment_trigger',
      vatRate: 'vat_rate', shippingAmountMinor: 'shipping_amount_minor',
      ccPdfEmail: 'cc_pdf_email', businessBankAccountId: 'business_bank_account_id',
      qrFormat: 'qr_format',
      // Per-invoice Skonto opt-out (migration 126).
      skontoDisabled: 'skonto_disabled',
      // Inline event snapshot (migration 123) — editable as long as
      // the invoice is still in 'scheduled' status (this route already
      // gates on that above).
      eventName: 'event_name',
      eventDate: 'event_date',
      eventTimeStart: 'event_time_start',
      eventTimeEnd: 'event_time_end',
    };
    for (const [api, col] of Object.entries(map)) {
      if (Object.prototype.hasOwnProperty.call(payload, api)) updates[col] = payload[api];
    }
    // Payment-term selection: re-snapshot the template when the admin
    // changes it. Mirrors createInvoice — once the column is set the
    // PDF renderer prefers it over the source-quote fallback.
    if (Object.prototype.hasOwnProperty.call(payload, 'paymentTermTemplateId')) {
      const id = parseInt(payload.paymentTermTemplateId, 10);
      if (id) {
        const tpl = await db('payment_term_templates').where({ id }).first();
        if (tpl) {
          updates.payment_term_template_id = tpl.id;
          updates.payment_term_snapshot = JSON.stringify({
            description: tpl.description || null,
            net_days: tpl.net_days,
            skonto_percent: tpl.skonto_percent,
            skonto_within_days: tpl.skonto_within_days,
            installments: typeof tpl.installments === 'string'
              ? (() => { try { return JSON.parse(tpl.installments); } catch { return null; } })()
              : tpl.installments || null,
          });
        }
      } else {
        // Explicit clear — admin picked "no template".
        updates.payment_term_template_id = null;
        updates.payment_term_snapshot = null;
      }
    }

    // Migration 124 — split payment-term picker. When both new FKs are
    // present, prefer them and re-compose the snapshot from the pair.
    // The editor sends both together so we don't have to handle the
    // half-set case; it stays a noop here when only one is supplied.
    if (
      Object.prototype.hasOwnProperty.call(payload, 'paymentNetDaysTemplateId')
      && Object.prototype.hasOwnProperty.call(payload, 'paymentTimingTemplateId')
    ) {
      const netDaysId = parseInt(payload.paymentNetDaysTemplateId, 10);
      const timingId = parseInt(payload.paymentTimingTemplateId, 10);
      if (netDaysId && timingId) {
        const [netDays, timing] = await Promise.all([
          db('payment_net_days_templates').where({ id: netDaysId }).first(),
          db('payment_timing_templates').where({ id: timingId }).first(),
        ]);
        if (netDays && timing) {
          updates.payment_net_days_template_id = netDays.id;
          updates.payment_timing_template_id = timing.id;
          // Clear the legacy FK — the editor is moving off it.
          updates.payment_term_template_id = null;
          updates.payment_term_snapshot = JSON.stringify({
            description: timing.description || netDays.description || null,
            net_days: netDays.net_days,
            skonto_percent: netDays.skonto_percent,
            skonto_within_days: netDays.skonto_within_days,
            installments: typeof timing.installments === 'string'
              ? (() => { try { return JSON.parse(timing.installments); } catch { return null; } })()
              : timing.installments || null,
          });
        }
      } else {
        // Explicit clear — admin emptied both.
        updates.payment_net_days_template_id = null;
        updates.payment_timing_template_id = null;
        updates.payment_term_snapshot = null;
      }
    }

    if (Array.isArray(payload.lineItems)) {
      // Recompute everything authoritatively. Migration 119 — sub-
      // items don't roll into net directly; parent totals auto-
      // resolve from priced sub-items via resolveParentTotalsFromSubItems
      // (shared helper in quoteService._internal).
      const items = payload.lineItems.map((li, idx) => {
        const qty = Number(li.quantity || 1);
        const unit = parseInt(li.unit_price_minor, 10) || 0;
        const disc = Number(li.discount_percent || 0);
        const lineTotal = Math.round(Math.round(qty * unit) * (1 - disc / 100));
        const isSubItem = li.parent_position != null && li.parent_position !== '';
        return {
          position: parseInt(li.position, 10) || (idx + 1),
          quantity: qty,
          description: String(li.description || ''),
          unit_price_minor: unit,
          discount_percent: disc,
          line_total_minor: lineTotal,
          parent_position: isSubItem ? parseInt(li.parent_position, 10) : null,
          details_text: li.details_text || null,
        };
      });
      const { resolveParentTotalsFromSubItems } = require('../services/quoteService')._internal;
      resolveParentTotalsFromSubItems(items);
      let net = 0;
      for (const it of items) {
        if (it.parent_position == null) net += parseInt(it.line_total_minor, 10) || 0;
      }
      const vatRate = Number(payload.vatRate ?? existing.vat_rate ?? 0);
      const vatAmount = Math.round(net * vatRate / 100);
      const shipping = parseInt(payload.shippingAmountMinor ?? existing.shipping_amount_minor ?? 0, 10);
      updates.net_amount_minor = net;
      updates.vat_amount_minor = vatAmount;
      updates.vat_rate = vatRate;
      updates.shipping_amount_minor = shipping;
      updates.total_amount_minor = net + vatAmount + shipping;

      // Negative line items (Rabatt) are allowed, but the resulting
      // invoice total must not go below zero. Credit notes belong in
      // the Storno path, not in regular invoice edits.
      if (updates.total_amount_minor < 0) {
        return res.status(400).json({
          error: 'Invoice total cannot be negative. To issue a credit note, cancel the original invoice with Storno.',
          code: 'INVOICE_TOTAL_NEGATIVE',
        });
      }

      const quoteService = require('../services/quoteService');
      const { validateLineItemHierarchy, insertLineItemsHierarchical } = quoteService._internal;
      await db.transaction(async (trx) => {
        await trx('invoice_line_items').where({ invoice_id: id }).del();
        if (items.length > 0) {
          validateLineItemHierarchy(items);
          await insertLineItemsHierarchical(trx, 'invoice_line_items', 'invoice_id', id, items);
        }
        await trx('invoices').where({ id }).update(updates);
      });
    } else {
      await db('invoices').where({ id }).update(updates);
    }

    const data = await invoiceService.getInvoiceById(id);
    return successResponse(res, {
      invoice: transformInvoice(data.invoice),
      lineItems: data.lineItems.map(transformLineItem),
    }, 200, 'Invoice updated');
  })
);

// ---- send / pay / remind / cancel ------------------------------------

router.post(
  '/:id/send',
  requirePermission('bills.manage'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    await invoiceService.sendInvoice(parseInt(req.params.id, 10), req.admin.id);
    return successResponse(res, { sent: true });
  })
);

router.post(
  '/:id/mark-paid',
  requirePermission('bills.manage'),
  [
    param('id').isInt({ min: 1 }),
    body('amountMinor').isInt({ min: 1 }),
    body('paidAt').optional({ values: 'falsy' }).isISO8601().custom(isReasonablePaidAt),
    body('paymentMethod').optional({ values: 'falsy' }).isString().isLength({ max: 64 }),
    body('reference').optional({ values: 'falsy' }).isString().isLength({ max: 128 }),
    body('notes').optional({ values: 'falsy' }).isString().isLength({ max: 5000 }),
    body('skontoApplied').optional().isBoolean(),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const result = await invoiceService.markPaid(parseInt(req.params.id, 10), {
      amountMinor: req.body.amountMinor,
      paidAt: req.body.paidAt,
      paymentMethod: req.body.paymentMethod,
      reference: req.body.reference,
      notes: req.body.notes,
      skontoApplied: req.body.skontoApplied,
    }, req.admin.id);
    return successResponse(res, result);
  })
);

router.post(
  '/:id/send-reminder',
  requirePermission('bills.manage'),
  [
    param('id').isInt({ min: 1 }),
    body('level').optional({ values: 'falsy' }).isInt({ min: 1, max: 2 }),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const result = await invoiceService.sendReminder(
      parseInt(req.params.id, 10),
      req.body.level || null,
      req.admin.id
    );
    return successResponse(res, result, 200, 'Reminder sent');
  })
);

// Test the admin payment-check email manually — bypasses the 24h
// throttle so the admin can verify the full flow (email → token
// page → action recorded) without waiting for the invoice to age
// past its reminder threshold. Only operates on sent/overdue
// invoices (same gate as the scheduled path).
router.post(
  '/:id/test-payment-check',
  requirePermission('bills.manage'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const result = await invoiceService.queuePaymentCheckEmail(
      parseInt(req.params.id, 10),
      { skipThrottle: true }
    );
    if (!result.sent) {
      return res.status(409).json({
        error: `Payment-check email not sent: ${result.reason}`,
        code: 'PAYMENT_CHECK_NOT_SENT',
        reason: result.reason,
      });
    }
    return successResponse(res, result, 200, 'Test payment-check email queued');
  })
);

// Cancel + reissue — atomically cancels the existing invoice and
// creates a fresh scheduled duplicate with a new sequential number,
// linked via replaces_invoice_id (migration 114). The PDF renderer
// stamps "Bezug: Ersetzt Rechnung R-XXXX vom DATE" on the new
// invoice so the customer + auditors can trace the chain.
router.post(
  '/:id/reissue',
  requirePermission('bills.manage'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const result = await invoiceService.reissueInvoice(parseInt(req.params.id, 10), req.admin.id);
    return successResponse(res, result, 201, 'Invoice reissued');
  })
);

// Release a pending_delivery invoice — photographer has confirmed
// delivery and wants the final installment to fire now.
router.post(
  '/:id/release-for-delivery',
  requirePermission('bills.manage'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const result = await invoiceService.releaseForDelivery(parseInt(req.params.id, 10), req.admin.id);
    return successResponse(res, result, 200, 'Delivery invoice released');
  })
);

router.post(
  '/:id/cancel',
  requirePermission('bills.manage'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    // Service returns { cancelled, stornoId } — pass through so the
    // frontend can show "Storno S-XXXX wurde erzeugt" feedback
    // when the invoice was already issued (vs. silent soft-cancel
    // on drafts).
    const result = await invoiceService.cancelInvoice(parseInt(req.params.id, 10), req.admin.id);
    return successResponse(res, result);
  })
);

// ---- PDF -------------------------------------------------------------

router.get(
  '/:id/pdf',
  requirePermission('bills.view'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const id = parseInt(req.params.id, 10);
    const buf = await invoiceService.renderInvoicePdfBuffer(id);
    // Build a useful filename: `<invoiceNumber>_<customerName>.pdf`.
    // The number + customer come from a small joined fetch; we
    // already loaded everything inside renderInvoicePdfBuffer, but
    // re-fetching here keeps the route a thin shim over the
    // service rather than reaching inside its internals.
    const { buildPdfFilename } = require('../utils/pdfFilename');
    const inv = await db('invoices').where({ id }).first();
    const customer = inv ? await db('customer_accounts').where({ id: inv.customer_account_id }).first() : null;
    const filename = buildPdfFilename({
      docNumber: inv?.invoice_number,
      customer,
      fallback: `invoice-${id}`,
    });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="${filename}"`);
    res.send(buf);
  })
);

router.post(
  '/preview',
  requirePermission('bills.manage'),
  INVOICE_BODY_VALIDATORS,
  handleAsync(async (req, res) => {
    validateRequest(req);
    const payload = mapPayloadToService(req.body);
    const buf = await invoiceService.renderInvoicePdfFromPayload(payload);
    // Preview is unsaved — there's no invoice_number yet. Look up
    // the customer so the filename still reflects who the invoice
    // is for; the number segment falls back to "invoice-preview".
    const { buildPdfFilename } = require('../utils/pdfFilename');
    const customer = payload.customerAccountId
      ? await db('customer_accounts').where({ id: payload.customerAccountId }).first()
      : null;
    const filename = buildPdfFilename({
      docNumber: null,
      customer,
      fallback: 'invoice-preview',
    });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="${filename}"`);
    res.send(buf);
  })
);

router.get(
  '/:id/payment-log',
  requirePermission('bills.view'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const data = await invoiceService.getInvoiceById(parseInt(req.params.id, 10));
    if (!data) return res.status(404).json({ error: 'Invoice not found' });
    return successResponse(res, { payments: data.payments.map(transformPaymentLog) });
  })
);

module.exports = router;
