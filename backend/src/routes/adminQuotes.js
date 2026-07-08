/**
 * Admin → Quotes Routes
 *
 * Endpoint mounted at /api/admin/quotes. Surface:
 *   GET    /                            list (filter + sort + paginate)
 *   POST   /                            create (status=draft)
 *   GET    /:id                         detail
 *   PUT    /:id                         update (line items + scalars)
 *   POST   /:id/send                    render PDF + queue email
 *   POST   /:id/duplicate               clone as new draft
 *   POST   /:id/convert                 convert accepted quote → event
 *   GET    /:id/pdf                     preview / download persisted PDF
 *   POST   /preview                     render PDF from unsaved payload
 *   GET    /presets/line-items
 *   POST   /presets/line-items
 *   PUT    /presets/line-items/:id
 *   DELETE /presets/line-items/:id
 *   GET    /presets/payment-terms
 *   POST   /presets/payment-terms
 *   PUT    /presets/payment-terms/:id
 *   DELETE /presets/payment-terms/:id
 *
 * Permissions: `quotes.view` for reads, `quotes.manage` for writes.
 * The global `quotes` feature flag is checked at the route layer so a
 * disabled installation returns 403 cleanly without the route bodies
 * ever running.
 */

const express = require('express');
const { body, param, query } = require('express-validator');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const quoteService = require('../services/quoteService');
const { db } = require('../database/db');

const router = express.Router();

// ----- feature flag gate (admin global) -------------------------------
async function requireQuotesFlag(req, res, next) {
  try {
    const row = await db('feature_flags').where({ key: 'quotes' }).first();
    const enabled = row && (row.value === true || row.value === 1 || row.value === '1');
    if (!enabled) {
      return res.status(403).json({ error: 'Quotes feature is disabled', code: 'QUOTES_DISABLED' });
    }
    next();
  } catch (err) {
    next(err);
  }
}

router.use(adminAuth);
router.use(requireQuotesFlag);

// ---------------------------------------------------------------------
// Transforms (snake_case DB → camelCase API)
// ---------------------------------------------------------------------

function transformQuote(q) {
  if (!q) return null;
  return {
    id: q.id,
    quoteNumber: q.quote_number,
    customerAccountId: q.customer_account_id,
    // Migration 121 — Project Overview link (undefined on pre-121 DBs).
    projectId: q.project_id ?? null,
    customer: {
      email: q.customer_email,
      displayName: q.customer_display_name,
      firstName: q.customer_first_name,
      lastName: q.customer_last_name,
      companyName: q.customer_company_name,
      // Passive customers (admin-only, no portal access) flagged
      // by null password_hash. Hash itself is dropped here.
      isPassive: q.customer_password_hash == null,
    },
    status: q.status,
    // Migration 140 — cross-document lineage UUID. Lets the frontend
    // call /api/admin/deals/:uuid/documents in one shot to render the
    // full lineage (quote + contract + N invoices + Storni).
    dealUuid: q.deal_uuid || null,
    language: q.language,
    currency: q.currency,
    issueDate: q.issue_date,
    validUntil: q.valid_until,
    eventName: q.event_name,
    eventDate: q.event_date,
    eventType: q.event_type ?? null,
    bookingWorkflowId: q.booking_workflow_id ?? null,
    eventTimeStart: q.event_time_start,
    eventTimeEnd: q.event_time_end,
    expectedDurationHours: q.expected_duration_hours == null ? null : Number(q.expected_duration_hours),
    paymentTermTemplateId: q.payment_term_template_id,
    // Split payment-term picker (migration 124).
    paymentNetDaysTemplateId: q.payment_net_days_template_id || null,
    paymentTimingTemplateId: q.payment_timing_template_id || null,
    netAmountMinor: q.net_amount_minor,
    vatRate: q.vat_rate == null ? null : Number(q.vat_rate),
    vatAmountMinor: q.vat_amount_minor,
    shippingAmountMinor: q.shipping_amount_minor,
    totalAmountMinor: q.total_amount_minor,
    introText: q.intro_text,
    outroText: q.outro_text,
    internalNotes: q.internal_notes,
    ccPdfEmail: q.cc_pdf_email,
    sentAt: q.sent_at,
    respondedAt: q.responded_at,
    responseLockedAt: q.response_locked_at,
    acceptedAt: q.accepted_at,
    declinedAt: q.declined_at,
    declineReason: q.decline_reason ?? null,
    convertedEventId: q.converted_event_id,
    // Migration 130 lineage. Null until quoteService.createFromQuote
    // sets it. Surfaced so QuoteDetailPage can render a "Linked
    // contract" badge alongside the existing resulting-invoices list.
    // contract_number comes from the conv_contract JOIN — falls back
    // to null when the converted contract has been deleted (FK is
    // ON DELETE SET NULL).
    convertedContractId: q.converted_contract_id || null,
    convertedContractNumber: q.converted_contract_number || null,
    pdfPath: q.pdf_path,
    businessBankAccountId: q.business_bank_account_id,
    createdAt: q.created_at,
    updatedAt: q.updated_at,
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
    // Hierarchy (migration 119). `parentPosition` is what the editor
    // uses to thread sub-items in unsaved drafts; on existing rows
    // we hydrate it from the actual parent's position via a join in
    // getQuoteById (see service). NULL = top-level item.
    parentLineItemId: li.parent_line_item_id || null,
    parentPosition: li.parent_position == null ? null : Number(li.parent_position),
    detailsText: li.details_text || null,
  };
}

function transformPaymentTermTemplate(t) {
  if (!t) return null;
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    netDays: t.net_days,
    skontoPercent: t.skonto_percent == null ? null : Number(t.skonto_percent),
    skontoWithinDays: t.skonto_within_days,
    installments: typeof t.installments === 'string' ? JSON.parse(t.installments) : t.installments,
    isSystem: t.is_system === 1 || t.is_system === true,
    isActive: t.is_active === 1 || t.is_active === true,
    displayOrder: t.display_order,
  };
}

// Split payment-term templates (migration 124). Two transforms because
// the rows have different shapes — net-days carries Skonto, timing
// carries the installments array.
function transformPaymentNetDaysTemplate(t) {
  if (!t) return null;
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    netDays: t.net_days,
    skontoPercent: t.skonto_percent == null ? null : Number(t.skonto_percent),
    skontoWithinDays: t.skonto_within_days,
    isSystem: t.is_system === 1 || t.is_system === true,
    isActive: t.is_active === 1 || t.is_active === true,
    displayOrder: t.display_order,
  };
}

function transformPaymentTimingTemplate(t) {
  if (!t) return null;
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    installments: typeof t.installments === 'string' ? JSON.parse(t.installments) : t.installments,
    isSystem: t.is_system === 1 || t.is_system === true,
    isActive: t.is_active === 1 || t.is_active === true,
    displayOrder: t.display_order,
  };
}

function transformLineItemPreset(p) {
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    unitPriceMinor: p.unit_price_minor,
    currency: p.currency,
    quantityDefault: Number(p.quantity_default),
    displayOrder: p.display_order,
    isActive: p.is_active === 1 || p.is_active === true,
  };
}

// ----- payload conversion helpers ------------------------------------

function mapPayloadToService(body) {
  const out = {};
  const map = {
    customerAccountId: 'customerAccountId',
    language: 'language', currency: 'currency',
    issueDate: 'issueDate', validUntil: 'validUntil',
    eventName: 'eventName', eventDate: 'eventDate', eventType: 'eventType',
    bookingWorkflowId: 'bookingWorkflowId',
    eventTimeStart: 'eventTimeStart', eventTimeEnd: 'eventTimeEnd',
    expectedDurationHours: 'expectedDurationHours',
    paymentTermTemplateId: 'paymentTermTemplateId',
    paymentNetDaysTemplateId: 'paymentNetDaysTemplateId',
    paymentTimingTemplateId: 'paymentTimingTemplateId',
    // Ad-hoc installments override (commit #6). Stored on quotes
    // as payment_term_installments_override via migration 142.
    installments: 'installments',
    vatRate: 'vatRate', shippingAmountMinor: 'shippingAmountMinor',
    introText: 'introText', outroText: 'outroText',
    internalNotes: 'internalNotes', ccPdfEmail: 'ccPdfEmail',
    businessBankAccountId: 'businessBankAccountId',
    // Migration 121 — optional Project Overview link.
    projectId: 'projectId',
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
      // Migration 119 — sub-item + details support. parentPosition
      // refers to another item's position in the same payload; the
      // service resolves it to parent_line_item_id after inserting
      // the parents.
      parent_position: li.parentPosition == null || li.parentPosition === '' ? null : Number(li.parentPosition),
      details_text: li.detailsText == null ? null : String(li.detailsText),
    }));
  }
  return out;
}

// ---------------------------------------------------------------------
// List + read
// ---------------------------------------------------------------------

router.get(
  '/',
  requirePermission('quotes.view'),
  [
    query('status').optional({ values: 'falsy' }).isString(),
    query('customerAccountId').optional({ values: 'falsy' }).isInt({ min: 1 }),
    query('q').optional({ values: 'falsy' }).isString().isLength({ max: 255 }),
    query('from').optional({ values: 'falsy' }).isISO8601(),
    query('to').optional({ values: 'falsy' }).isISO8601(),
    query('sort').optional({ values: 'falsy' }).isIn(['newest', 'oldest', 'issue_asc', 'issue_desc', 'customer_asc', 'customer_desc', 'value_asc', 'value_desc']),
    query('page').optional({ values: 'falsy' }).isInt({ min: 1 }),
    query('pageSize').optional({ values: 'falsy' }).isInt({ min: 1, max: 100 }),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const statusFilter = req.query.status
      ? String(req.query.status).split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const { rows, total, page, pageSize } = await quoteService.listQuotes({
      filters: {
        status: statusFilter,
        customerAccountId: req.query.customerAccountId ? parseInt(req.query.customerAccountId, 10) : null,
        from: req.query.from, to: req.query.to, q: req.query.q,
      },
      sort: req.query.sort || 'issue_desc',
      page: req.query.page ? parseInt(req.query.page, 10) : 1,
      pageSize: req.query.pageSize ? parseInt(req.query.pageSize, 10) : 25,
    });
    return successResponse(res, {
      quotes: rows.map(transformQuote),
      pagination: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 },
    });
  })
);

router.get(
  '/:id',
  requirePermission('quotes.view'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const id = parseInt(req.params.id, 10);
    const data = await quoteService.getQuoteById(id);
    if (!data) return res.status(404).json({ error: 'Quote not found' });
    return successResponse(res, {
      quote: transformQuote(data.quote),
      lineItems: data.lineItems.map(transformLineItem),
    });
  })
);

// ---------------------------------------------------------------------
// Create + update
// ---------------------------------------------------------------------

const QUOTE_BODY_VALIDATORS = [
  body('customerAccountId').isInt({ min: 1 }).withMessage('Customer is required'),
  body('language').optional({ values: 'falsy' }).isString().isLength({ max: 8 }),
  body('currency').optional({ values: 'falsy' }).isString().isLength({ min: 3, max: 3 }),
  body('issueDate').optional({ values: 'falsy' }).isISO8601(),
  body('validUntil').optional({ values: 'falsy' }).isISO8601(),
  body('eventName').optional({ values: 'falsy' }).isString().isLength({ max: 255 }),
  body('eventDate').optional({ values: 'falsy' }).isISO8601(),
  body('eventTimeStart').optional({ values: 'falsy' }).isString().isLength({ max: 8 }),
  body('eventTimeEnd').optional({ values: 'falsy' }).isString().isLength({ max: 8 }),
  body('expectedDurationHours').optional({ values: 'falsy' }).isFloat({ min: 0, max: 99.99 }),
  body('paymentTermTemplateId').optional({ values: 'falsy' }).isInt({ min: 1 }),
  body('paymentNetDaysTemplateId').optional({ values: 'falsy' }).isInt({ min: 1 }),
  body('paymentTimingTemplateId').optional({ values: 'falsy' }).isInt({ min: 1 }),
  // Ad-hoc installments override (commit #6 of the deal_uuid PR).
  // Each row carries { label, percent, trigger, offset_days }; the
  // service validates internal consistency (percents sum to 100).
  body('installments').optional().isArray(),
  body('installments.*.label').optional({ values: 'falsy' }).isString().isLength({ max: 128 }),
  body('installments.*.percent').optional({ values: 'falsy' }).isFloat({ min: 0, max: 100 }),
  body('installments.*.trigger').optional({ values: 'falsy' }).isIn(['quote_accepted', 'before_event', 'after_event', 'after_delivery', 'fixed_date']),
  body('installments.*.offset_days').optional({ values: 'falsy' }).isInt(),
  body('vatRate').optional({ values: 'falsy' }).isFloat({ min: 0, max: 100 }),
  body('shippingAmountMinor').optional({ values: 'falsy' }).isInt({ min: 0 }),
  body('introText').optional({ values: 'falsy' }).isString().isLength({ max: 5000 }),
  body('outroText').optional({ values: 'falsy' }).isString().isLength({ max: 5000 }),
  body('internalNotes').optional({ values: 'falsy' }).isString().isLength({ max: 5000 }),
  body('ccPdfEmail').optional({ values: 'falsy' }).isString().isLength({ max: 255 }),
  body('businessBankAccountId').optional({ values: 'falsy' }).isInt({ min: 1 }),
  body('lineItems').optional({ values: 'falsy' }).isArray(),
  body('lineItems.*.description').optional({ values: 'falsy' }).isString().isLength({ min: 1, max: 1000 }),
  body('lineItems.*.quantity').optional({ values: 'falsy' }).isFloat({ min: 0 }),
  // Negative unit prices are allowed so admins can add manual
  // discount / Rabatt lines (e.g. "Treuerabatt -50,00 €"). The
  // service-layer total guard rejects quotes whose net goes below
  // zero — see quoteService.
  body('lineItems.*.unitPriceMinor').optional({ values: 'falsy' }).isInt(),
  body('lineItems.*.discountPercent').optional({ values: 'falsy' }).isFloat({ min: 0, max: 100 }),
  // Migration 119: sub-item + details support. Cross-row constraints
  // (parent must exist, max 1 level deep) are enforced by the service
  // (validateLineItemHierarchy); these per-field validators just keep
  // bad data from reaching it.
  body('lineItems.*.parentPosition').optional({ values: 'falsy' }).isInt({ min: 1 }),
  body('lineItems.*.detailsText').optional({ values: 'falsy' }).isString().isLength({ max: 2000 }),
];

router.post(
  '/',
  requirePermission('quotes.manage'),
  QUOTE_BODY_VALIDATORS,
  handleAsync(async (req, res) => {
    validateRequest(req);
    const id = await quoteService.createQuote(mapPayloadToService(req.body), req.admin.id);
    const data = await quoteService.getQuoteById(id);
    return successResponse(res, {
      quote: transformQuote(data.quote),
      lineItems: data.lineItems.map(transformLineItem),
    }, 201, 'Quote created');
  })
);

router.put(
  '/:id',
  requirePermission('quotes.manage'),
  // PUT accepts partial updates. We declare the same fields as POST but
  // every chain begins with `.optional({ values: 'falsy' })` so missing fields don't fail
  // validation. Doing `.map(v => v.optional)` (without invoking it) was
  // a bug that registered method references as middleware.
  [
    param('id').isInt({ min: 1 }),
    body('customerAccountId').optional({ values: 'falsy' }).isInt({ min: 1 }),
    body('language').optional({ values: 'falsy' }).isString().isLength({ max: 8 }),
    body('currency').optional({ values: 'falsy' }).isString().isLength({ min: 3, max: 3 }),
    body('issueDate').optional({ values: 'falsy' }).isISO8601(),
    body('validUntil').optional({ values: 'falsy' }).isISO8601(),
    body('eventName').optional({ values: 'falsy' }).isString().isLength({ max: 255 }),
    body('eventDate').optional({ values: 'falsy' }).isISO8601(),
    body('eventTimeStart').optional({ values: 'falsy' }).isString().isLength({ max: 8 }),
    body('eventTimeEnd').optional({ values: 'falsy' }).isString().isLength({ max: 8 }),
    body('expectedDurationHours').optional({ values: 'falsy' }).isFloat({ min: 0, max: 99.99 }),
    body('paymentTermTemplateId').optional({ values: 'falsy' }).isInt({ min: 1 }),
    body('paymentNetDaysTemplateId').optional({ values: 'falsy' }).isInt({ min: 1 }),
    body('paymentTimingTemplateId').optional({ values: 'falsy' }).isInt({ min: 1 }),
    body('vatRate').optional({ values: 'falsy' }).isFloat({ min: 0, max: 100 }),
    body('shippingAmountMinor').optional({ values: 'falsy' }).isInt({ min: 0 }),
    body('introText').optional({ values: 'falsy' }).isString().isLength({ max: 5000 }),
    body('outroText').optional({ values: 'falsy' }).isString().isLength({ max: 5000 }),
    body('internalNotes').optional({ values: 'falsy' }).isString().isLength({ max: 5000 }),
    body('ccPdfEmail').optional({ values: 'falsy' }).isString().isLength({ max: 255 }),
    body('businessBankAccountId').optional({ values: 'falsy' }).isInt({ min: 1 }),
    body('lineItems').optional({ values: 'falsy' }).isArray(),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const id = parseInt(req.params.id, 10);
    await quoteService.updateQuote(id, mapPayloadToService(req.body), req.admin.id);
    const data = await quoteService.getQuoteById(id);
    return successResponse(res, {
      quote: transformQuote(data.quote),
      lineItems: data.lineItems.map(transformLineItem),
    }, 200, 'Quote updated');
  })
);

// ---------------------------------------------------------------------
// Send / duplicate / convert
// ---------------------------------------------------------------------

router.post(
  '/:id/send',
  requirePermission('quotes.manage'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const id = parseInt(req.params.id, 10);
    const result = await quoteService.sendQuote(id, req.admin.id);
    return successResponse(res, { sent: true, token: result.token }, 200, 'Quote sent');
  })
);

router.post(
  '/:id/duplicate',
  requirePermission('quotes.manage'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const newId = await quoteService.duplicateQuote(parseInt(req.params.id, 10), req.admin.id);
    return successResponse(res, { id: newId }, 201, 'Quote duplicated');
  })
);

// Admin "accept on behalf of customer" — flips the quote straight
// to `accepted` without going through the public token + response
// window. For phone-call workflows where the customer verbally
// agrees and the admin wants to immediately convert.
router.post(
  '/:id/accept',
  requirePermission('quotes.manage'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const id = parseInt(req.params.id, 10);
    const result = await quoteService.adminAcceptQuote(id, req.admin.id);
    return successResponse(res, result, 200, 'Quote accepted');
  })
);

// Admin "decline on behalf" — flips a draft/sent/expired quote to
// `declined` without the customer's public link. For "they said no by
// phone" workflows. Optional free-text reason persisted on the row.
router.post(
  '/:id/decline',
  requirePermission('quotes.manage'),
  [
    param('id').isInt({ min: 1 }),
    body('reason').optional({ values: 'falsy' }).isString().isLength({ max: 5000 }),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const id = parseInt(req.params.id, 10);
    const result = await quoteService.adminDeclineQuote(id, req.admin.id, req.body.reason);
    return successResponse(res, result, 200, 'Quote declined');
  })
);

router.post(
  '/:id/convert',
  requirePermission('quotes.manage'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const id = parseInt(req.params.id, 10);
    const result = await quoteService.convertToEvent(id, req.admin.id);
    return successResponse(res, result, 200, result.alreadyConverted ? 'Already converted' : 'Quote converted');
  })
);

// Convert directly to invoice(s) — no event, no gallery. Used for
// engagements like consulting / equipment hire where there's no photo
// deliverable to ship.
router.post(
  '/:id/convert-to-invoice',
  requirePermission('quotes.manage'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const id = parseInt(req.params.id, 10);
    const result = await quoteService.convertToInvoiceOnly(id, req.admin.id);
    return successResponse(res, result, 200, 'Invoices created from quote');
  })
);

// Convert to a draft contract — the new middle step between accepted
// quote and event/invoice generation. The contracts feature flag is
// checked in contractService (it pulls the same db('feature_flags')
// row that the adminContracts router gates on); declining at the route
// layer here would force admins to flip TWO flags to use the workflow.
router.post(
  '/:id/convert-to-contract',
  requirePermission('quotes.manage'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    // Lazy require to keep the route file dep-light + avoid the
    // quoteService ↔ contractService cycle bleeding through.
    const contractService = require('../services/contractService');
    const id = parseInt(req.params.id, 10);
    const result = await contractService.createFromQuote(id, req.admin.id);
    return successResponse(res, result, 200,
      result.alreadyConverted ? 'Already linked to a contract' : 'Contract drafted from quote');
  })
);

// ---------------------------------------------------------------------
// PDF — preview (unsaved payload) + download (persisted)
// ---------------------------------------------------------------------

router.get(
  '/:id/pdf',
  requirePermission('quotes.view'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const id = parseInt(req.params.id, 10);
    const buf = await quoteService.renderQuotePdfBuffer(id);
    const { buildPdfFilename } = require('../utils/pdfFilename');
    const quote = await db('quotes').where({ id }).first();
    const customer = quote ? await db('customer_accounts').where({ id: quote.customer_account_id }).first() : null;
    const filename = buildPdfFilename({
      docNumber: quote?.quote_number,
      customer,
      fallback: `quote-${id}`,
    });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="${filename}"`);
    res.send(buf);
  })
);

router.post(
  '/preview',
  requirePermission('quotes.manage'),
  QUOTE_BODY_VALIDATORS,
  handleAsync(async (req, res) => {
    validateRequest(req);
    const payload = mapPayloadToService(req.body);
    const buf = await quoteService.renderQuotePdfFromPayload(payload);
    const { buildPdfFilename } = require('../utils/pdfFilename');
    const customer = payload.customerAccountId
      ? await db('customer_accounts').where({ id: payload.customerAccountId }).first()
      : null;
    const filename = buildPdfFilename({
      docNumber: null,
      customer,
      fallback: 'quote-preview',
    });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="${filename}"`);
    res.send(buf);
  })
);

// ---------------------------------------------------------------------
// Presets — line items
// ---------------------------------------------------------------------

router.get(
  '/presets/line-items',
  requirePermission('quotes.view'),
  handleAsync(async (req, res) => {
    const rows = await quoteService.listLineItemPresets();
    return successResponse(res, { presets: rows.map(transformLineItemPreset) });
  })
);

router.post(
  '/presets/line-items',
  requirePermission('quotes.manage'),
  [
    body('name').isString().isLength({ min: 1, max: 128 }),
    body('description').optional({ values: 'falsy' }).isString().isLength({ max: 5000 }),
    body('unitPriceMinor').optional({ values: 'falsy' }).isInt({ min: 0 }),
    body('currency').optional({ values: 'falsy' }).isString().isLength({ min: 3, max: 3 }),
    body('quantityDefault').optional({ values: 'falsy' }).isFloat({ min: 0 }),
    body('displayOrder').optional({ values: 'falsy' }).isInt({ min: 0, max: 9999 }),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const row = await quoteService.createLineItemPreset({
      name: req.body.name,
      description: req.body.description,
      unit_price_minor: req.body.unitPriceMinor,
      currency: req.body.currency,
      quantity_default: req.body.quantityDefault,
      display_order: req.body.displayOrder,
    });
    return successResponse(res, { preset: transformLineItemPreset(row) }, 201);
  })
);

router.put(
  '/presets/line-items/:id',
  requirePermission('quotes.manage'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const id = parseInt(req.params.id, 10);
    const row = await quoteService.updateLineItemPreset(id, {
      name: req.body.name,
      description: req.body.description,
      unit_price_minor: req.body.unitPriceMinor,
      currency: req.body.currency,
      quantity_default: req.body.quantityDefault,
      display_order: req.body.displayOrder,
      is_active: req.body.isActive,
    });
    return successResponse(res, { preset: transformLineItemPreset(row) });
  })
);

router.delete(
  '/presets/line-items/:id',
  requirePermission('quotes.manage'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    await quoteService.deleteLineItemPreset(parseInt(req.params.id, 10));
    return successResponse(res, { deleted: true });
  })
);

// ---------------------------------------------------------------------
// Presets — payment terms
// ---------------------------------------------------------------------

router.get(
  '/presets/payment-terms',
  requirePermission('quotes.view'),
  handleAsync(async (req, res) => {
    const rows = await quoteService.listPaymentTermTemplates();
    return successResponse(res, { templates: rows.map(transformPaymentTermTemplate) });
  })
);

router.post(
  '/presets/payment-terms',
  requirePermission('quotes.manage'),
  [
    body('name').isString().isLength({ min: 1, max: 128 }),
    body('installments').isArray({ min: 1 }),
    body('netDays').optional({ values: 'falsy' }).isInt({ min: 1, max: 365 }),
    body('skontoPercent').optional({ values: 'falsy' }).isFloat({ min: 0, max: 100 }),
    body('skontoWithinDays').optional({ values: 'falsy' }).isInt({ min: 0, max: 365 }),
    body('description').optional({ values: 'falsy' }).isString().isLength({ max: 5000 }),
    body('displayOrder').optional({ values: 'falsy' }).isInt({ min: 0, max: 9999 }),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const row = await quoteService.createPaymentTermTemplate({
      name: req.body.name,
      description: req.body.description,
      net_days: req.body.netDays,
      skonto_percent: req.body.skontoPercent,
      skonto_within_days: req.body.skontoWithinDays,
      installments: req.body.installments,
      display_order: req.body.displayOrder,
    });
    return successResponse(res, { template: transformPaymentTermTemplate(row) }, 201);
  })
);

router.put(
  '/presets/payment-terms/:id',
  requirePermission('quotes.manage'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const id = parseInt(req.params.id, 10);
    const row = await quoteService.updatePaymentTermTemplate(id, {
      name: req.body.name,
      description: req.body.description,
      net_days: req.body.netDays,
      skonto_percent: req.body.skontoPercent,
      skonto_within_days: req.body.skontoWithinDays,
      installments: req.body.installments,
      display_order: req.body.displayOrder,
      is_active: req.body.isActive,
    });
    return successResponse(res, { template: transformPaymentTermTemplate(row) });
  })
);

router.delete(
  '/presets/payment-terms/:id',
  requirePermission('quotes.manage'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    await quoteService.deletePaymentTermTemplate(parseInt(req.params.id, 10));
    return successResponse(res, { deleted: true });
  })
);

// ---------------------------------------------------------------------
// Presets — payment net-days (migration 124, half of the split)
// ---------------------------------------------------------------------

router.get(
  '/presets/payment-net-days',
  requirePermission('quotes.view'),
  handleAsync(async (req, res) => {
    const rows = await quoteService.listPaymentNetDaysTemplates();
    return successResponse(res, { templates: rows.map(transformPaymentNetDaysTemplate) });
  })
);

router.post(
  '/presets/payment-net-days',
  requirePermission('quotes.manage'),
  [
    body('name').isString().isLength({ min: 1, max: 128 }),
    // net_days = 0 is "Sofort fällig" — valid.
    body('netDays').isInt({ min: 0, max: 365 }),
    body('skontoPercent').optional({ values: 'falsy' }).isFloat({ min: 0, max: 100 }),
    body('skontoWithinDays').optional({ values: 'falsy' }).isInt({ min: 0, max: 365 }),
    body('description').optional({ values: 'falsy' }).isString().isLength({ max: 255 }),
    body('displayOrder').optional({ values: 'falsy' }).isInt({ min: 0, max: 9999 }),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const row = await quoteService.createPaymentNetDaysTemplate({
      name: req.body.name,
      description: req.body.description,
      net_days: req.body.netDays,
      skonto_percent: req.body.skontoPercent,
      skonto_within_days: req.body.skontoWithinDays,
      display_order: req.body.displayOrder,
    });
    return successResponse(res, { template: transformPaymentNetDaysTemplate(row) }, 201);
  })
);

router.put(
  '/presets/payment-net-days/:id',
  requirePermission('quotes.manage'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const id = parseInt(req.params.id, 10);
    const row = await quoteService.updatePaymentNetDaysTemplate(id, {
      name: req.body.name,
      description: req.body.description,
      net_days: req.body.netDays,
      skonto_percent: req.body.skontoPercent,
      skonto_within_days: req.body.skontoWithinDays,
      display_order: req.body.displayOrder,
      is_active: req.body.isActive,
    });
    return successResponse(res, { template: transformPaymentNetDaysTemplate(row) });
  })
);

router.delete(
  '/presets/payment-net-days/:id',
  requirePermission('quotes.manage'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    await quoteService.deletePaymentNetDaysTemplate(parseInt(req.params.id, 10));
    return successResponse(res, { deleted: true });
  })
);

// ---------------------------------------------------------------------
// Presets — payment timing (migration 124, other half of the split)
// ---------------------------------------------------------------------

router.get(
  '/presets/payment-timing',
  requirePermission('quotes.view'),
  handleAsync(async (req, res) => {
    const rows = await quoteService.listPaymentTimingTemplates();
    return successResponse(res, { templates: rows.map(transformPaymentTimingTemplate) });
  })
);

router.post(
  '/presets/payment-timing',
  requirePermission('quotes.manage'),
  [
    body('name').isString().isLength({ min: 1, max: 128 }),
    body('installments').isArray({ min: 1 }),
    body('description').optional({ values: 'falsy' }).isString().isLength({ max: 255 }),
    body('displayOrder').optional({ values: 'falsy' }).isInt({ min: 0, max: 9999 }),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const row = await quoteService.createPaymentTimingTemplate({
      name: req.body.name,
      description: req.body.description,
      installments: req.body.installments,
      display_order: req.body.displayOrder,
    });
    return successResponse(res, { template: transformPaymentTimingTemplate(row) }, 201);
  })
);

router.put(
  '/presets/payment-timing/:id',
  requirePermission('quotes.manage'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const id = parseInt(req.params.id, 10);
    const row = await quoteService.updatePaymentTimingTemplate(id, {
      name: req.body.name,
      description: req.body.description,
      installments: req.body.installments,
      display_order: req.body.displayOrder,
      is_active: req.body.isActive,
    });
    return successResponse(res, { template: transformPaymentTimingTemplate(row) });
  })
);

router.delete(
  '/presets/payment-timing/:id',
  requirePermission('quotes.manage'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    await quoteService.deletePaymentTimingTemplate(parseInt(req.params.id, 10));
    return successResponse(res, { deleted: true });
  })
);

module.exports = router;
