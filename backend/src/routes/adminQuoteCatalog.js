/**
 * Admin → Quote catalogue routes (#1451)
 *
 * Mounted at /api/admin/quote-catalog — its own prefix, so these collection
 * paths never collide with /api/admin/quotes/:id. Surface:
 *
 *   GET|POST        /packages          PUT|DELETE /packages/:id
 *   GET|POST        /promotions        PUT|DELETE /promotions/:id
 *   GET|POST        /text-blocks       PUT|DELETE /text-blocks/:id
 *   GET|POST        /templates         GET|PUT|DELETE /templates/:id
 *   POST /templates/:id/publish        freeze the working copy as a new version
 *   POST /templates/:id/quotes         create a quote from the latest version
 *   POST /templates/from-quote/:quoteId  save an existing quote as a template
 *
 * The service items themselves keep their existing home under
 * /api/admin/quotes/presets/line-items.
 *
 * Permissions: `quotes.view` for reads, `quotes.manage` for writes. The
 * `quotes` feature flag gates the whole router. DELETE archives: nothing a
 * quote or a published template was built from is ever removed.
 */

const express = require('express');
const { body, param, query } = require('express-validator');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { requireFeatureFlag } = require('../middleware/requireFeatureFlag');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const { isTruthyFlag, BOUND_TO } = require('../utils/lineItemTotals');
const catalog = require('../services/quoteCatalogService');
const templates = require('../services/quoteTemplateService');

const router = express.Router();

router.use(adminAuth);
router.use(requireFeatureFlag('quotes', 'QUOTES_DISABLED'));
// The example entries (archived, editable) are added the first time the
// catalogue is opened; once per install.
router.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  return require('../services/quoteCatalogExamples').ensureCatalogExamples().then(() => next(), next);
});

// ---------------------------------------------------------------------
// Transforms (snake_case DB → camelCase API)
// ---------------------------------------------------------------------

function transformPackage(p) {
  return {
    id: p.id,
    name: p.name,
    description: p.description || null,
    currency: p.currency,
    displayOrder: p.display_order,
    isActive: isTruthyFlag(p.is_active),
    items: (p.items || []).map((it) => ({
      id: it.id,
      presetId: it.preset_id,
      presetName: it.preset_name,
      detailsText: it.details_text || null,
      quantity: it.quantity == null ? null : Number(it.quantity),
      boundTo: it.bound_to || null,
      position: it.position,
      unitPriceMinor: it.unit_price_minor == null ? 0 : Number(it.unit_price_minor),
      unit: it.unit || null,
      priceMode: it.price_mode || 'fixed',
      pinnedRateMinor: it.pinned_rate_minor == null ? null : Number(it.pinned_rate_minor),
      quantityDefault: it.quantity_default == null ? 1 : Number(it.quantity_default),
      presetIsActive: isTruthyFlag(it.preset_is_active),
    })),
  };
}

function transformPromotion(p) {
  return {
    id: p.id,
    name: p.name,
    description: p.description || null,
    type: p.type,
    valueMinor: p.value_minor == null ? null : Number(p.value_minor),
    currency: p.currency || null,
    percent: p.percent == null ? null : Number(p.percent),
    validFrom: catalog.dateOnly(p.valid_from),
    validUntil: catalog.dateOnly(p.valid_until),
    displayOrder: p.display_order,
    isActive: isTruthyFlag(p.is_active),
  };
}

function transformTextBlock(b) {
  return {
    id: b.id,
    kind: b.kind,
    language: b.language,
    name: b.name,
    body: b.body,
    displayOrder: b.display_order,
    isActive: isTruthyFlag(b.is_active),
  };
}

function transformTemplate(t) {
  return {
    id: t.id,
    name: t.name,
    description: t.description || null,
    eventType: t.event_type || null,
    language: t.language || null,
    currency: t.currency || null,
    status: t.status,
    currentVersion: t.current_version == null ? null : Number(t.current_version),
    draft: templates.parseSnapshot(t.draft_snapshot) || templates.emptyDraft(),
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

function transformVersion(v) {
  return {
    id: v.id,
    version: Number(v.version),
    publishedAt: v.published_at,
    publishedByAdminId: v.published_by_admin_id || null,
    snapshot: templates.parseSnapshot(v.snapshot),
  };
}

const idParam = param('id').isInt({ min: 1 });
const activeOnlyQuery = query('activeOnly').optional().isIn(['true', 'false']);
const activeOnly = (req) => req.query.activeOnly === 'true';

// ---------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------

const PACKAGE_VALIDATORS = [
  body('description').optional({ nullable: true }).isString().isLength({ max: 5000 }),
  body('currency').optional({ values: 'falsy' }).isString().isLength({ min: 3, max: 3 }),
  body('displayOrder').optional({ values: 'falsy' }).isInt({ min: 0, max: 9999 }),
  body('items').optional().isArray({ max: 50 }),
  body('items.*.presetId').isInt({ min: 1 }),
  body('items.*.quantity').optional({ nullable: true }).isFloat({ min: 0 }),
  body('items.*.boundTo').optional({ nullable: true }).isIn(BOUND_TO),
];

function packagePayload(reqBody) {
  return {
    name: reqBody.name,
    description: reqBody.description,
    currency: reqBody.currency,
    display_order: reqBody.displayOrder,
    is_active: reqBody.isActive,
    items: Array.isArray(reqBody.items)
      ? reqBody.items.map((it) => ({ preset_id: it.presetId, quantity: it.quantity, bound_to: it.boundTo }))
      : undefined,
  };
}

router.get(
  '/packages',
  requirePermission('quotes.view'),
  [activeOnlyQuery],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const rows = await catalog.listPackages({ activeOnly: activeOnly(req) });
    return successResponse(res, { packages: rows.map(transformPackage) });
  })
);

router.post(
  '/packages',
  requirePermission('quotes.manage'),
  [body('name').isString().trim().isLength({ min: 1, max: 128 }), ...PACKAGE_VALIDATORS],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const pkg = await catalog.savePackage(null, packagePayload(req.body));
    return successResponse(res, { package: transformPackage(pkg) }, 201);
  })
);

router.put(
  '/packages/:id',
  requirePermission('quotes.manage'),
  [
    idParam,
    body('name').optional().isString().trim().isLength({ min: 1, max: 128 }),
    body('isActive').optional().isBoolean(),
    ...PACKAGE_VALIDATORS,
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const pkg = await catalog.savePackage(parseInt(req.params.id, 10), packagePayload(req.body));
    return successResponse(res, { package: transformPackage(pkg) });
  })
);

router.delete(
  '/packages/:id',
  requirePermission('quotes.manage'),
  [idParam],
  handleAsync(async (req, res) => {
    validateRequest(req);
    await catalog.archivePackage(parseInt(req.params.id, 10));
    return successResponse(res, { archived: true });
  })
);

// ---------------------------------------------------------------------
// Promotions
// ---------------------------------------------------------------------

const PROMOTION_VALIDATORS = [
  body('description').optional({ nullable: true }).isString().isLength({ max: 5000 }),
  body('type').optional().isIn(catalog.PROMOTION_TYPES),
  body('valueMinor').optional({ nullable: true }).isInt({ min: 0 })
    .withMessage('Enter the discount as a positive amount (300 for −300)'),
  body('currency').optional({ nullable: true }).isString().isLength({ min: 3, max: 3 }),
  body('percent').optional({ nullable: true }).isFloat({ min: 0, max: 100 })
    .withMessage('Enter a percentage between 0 and 100'),
  body('validFrom').optional({ nullable: true }).isISO8601().withMessage('Valid from is not a date'),
  body('validUntil').optional({ nullable: true }).isISO8601().withMessage('Valid until is not a date'),
  body('displayOrder').optional({ values: 'falsy' }).isInt({ min: 0, max: 9999 }),
];

function promotionPayload(reqBody) {
  return {
    name: reqBody.name,
    description: reqBody.description,
    type: reqBody.type,
    value_minor: reqBody.valueMinor,
    currency: reqBody.currency,
    percent: reqBody.percent,
    valid_from: reqBody.validFrom,
    valid_until: reqBody.validUntil,
    display_order: reqBody.displayOrder,
    is_active: reqBody.isActive,
  };
}

router.get(
  '/promotions',
  requirePermission('quotes.view'),
  [activeOnlyQuery],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const rows = await catalog.listPromotions({ activeOnly: activeOnly(req) });
    return successResponse(res, { promotions: rows.map(transformPromotion) });
  })
);

router.post(
  '/promotions',
  requirePermission('quotes.manage'),
  [
    body('name').isString().trim().isLength({ min: 1, max: 128 }),
    body('type').isIn(catalog.PROMOTION_TYPES),
    ...PROMOTION_VALIDATORS,
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const row = await catalog.createPromotion(promotionPayload(req.body));
    return successResponse(res, { promotion: transformPromotion(row) }, 201);
  })
);

router.put(
  '/promotions/:id',
  requirePermission('quotes.manage'),
  [
    idParam,
    body('name').optional().isString().trim().isLength({ min: 1, max: 128 }),
    body('isActive').optional().isBoolean(),
    ...PROMOTION_VALIDATORS,
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const row = await catalog.updatePromotion(parseInt(req.params.id, 10), promotionPayload(req.body));
    return successResponse(res, { promotion: transformPromotion(row) });
  })
);

router.delete(
  '/promotions/:id',
  requirePermission('quotes.manage'),
  [idParam],
  handleAsync(async (req, res) => {
    validateRequest(req);
    await catalog.archivePromotion(parseInt(req.params.id, 10));
    return successResponse(res, { archived: true });
  })
);

// ---------------------------------------------------------------------
// Text blocks
// ---------------------------------------------------------------------

const TEXT_BLOCK_VALIDATORS = [
  body('language').optional({ values: 'falsy' }).isString().isLength({ max: 8 }),
  body('displayOrder').optional({ values: 'falsy' }).isInt({ min: 0, max: 9999 }),
];

function textBlockPayload(reqBody) {
  return {
    kind: reqBody.kind,
    language: reqBody.language,
    name: reqBody.name,
    body: reqBody.body,
    display_order: reqBody.displayOrder,
    is_active: reqBody.isActive,
  };
}

router.get(
  '/text-blocks',
  requirePermission('quotes.view'),
  [
    activeOnlyQuery,
    query('kind').optional().isIn(catalog.TEXT_BLOCK_KINDS),
    query('language').optional().isString().isLength({ max: 8 }),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const rows = await catalog.listTextBlocks({
      activeOnly: activeOnly(req), kind: req.query.kind || null, language: req.query.language || null,
    });
    return successResponse(res, { textBlocks: rows.map(transformTextBlock) });
  })
);

router.post(
  '/text-blocks',
  requirePermission('quotes.manage'),
  [
    body('kind').isIn(catalog.TEXT_BLOCK_KINDS),
    body('name').isString().trim().isLength({ min: 1, max: 128 }),
    body('body').isString().isLength({ min: 1, max: 5000 }),
    ...TEXT_BLOCK_VALIDATORS,
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const row = await catalog.createTextBlock(textBlockPayload(req.body));
    return successResponse(res, { textBlock: transformTextBlock(row) }, 201);
  })
);

router.put(
  '/text-blocks/:id',
  requirePermission('quotes.manage'),
  [
    idParam,
    body('kind').optional().isIn(catalog.TEXT_BLOCK_KINDS),
    body('name').optional().isString().trim().isLength({ min: 1, max: 128 }),
    body('body').optional().isString().isLength({ min: 1, max: 5000 }),
    body('isActive').optional().isBoolean(),
    ...TEXT_BLOCK_VALIDATORS,
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const row = await catalog.updateTextBlock(parseInt(req.params.id, 10), textBlockPayload(req.body));
    return successResponse(res, { textBlock: transformTextBlock(row) });
  })
);

router.delete(
  '/text-blocks/:id',
  requirePermission('quotes.manage'),
  [idParam],
  handleAsync(async (req, res) => {
    validateRequest(req);
    await catalog.archiveTextBlock(parseInt(req.params.id, 10));
    return successResponse(res, { archived: true });
  })
);

// ---------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------

const TEMPLATE_VALIDATORS = [
  body('description').optional({ nullable: true }).isString().isLength({ max: 5000 }),
  body('eventType').optional({ nullable: true }).isString().isLength({ max: 64 }),
  body('language').optional({ nullable: true }).isString().isLength({ max: 8 }),
  body('currency').optional({ nullable: true }).isString().isLength({ min: 3, max: 3 }),
  // The section structure is validated by quoteTemplateService.sanitizeDraft.
  body('draft').optional().isObject(),
];

function templatePayload(reqBody) {
  return {
    name: reqBody.name,
    description: reqBody.description,
    event_type: reqBody.eventType,
    language: reqBody.language,
    currency: reqBody.currency,
    draft: reqBody.draft,
  };
}

router.get(
  '/templates',
  requirePermission('quotes.view'),
  // Admin pages list drafts and archived templates too; the "new quote"
  // picker asks for published ones only.
  [query('publishedOnly').optional().isIn(['true', 'false'])],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const rows = await templates.listTemplates({ publishedOnly: req.query.publishedOnly === 'true' });
    return successResponse(res, { templates: rows.map(transformTemplate) });
  })
);

router.post(
  '/templates',
  requirePermission('quotes.manage'),
  [body('name').isString().trim().isLength({ min: 1, max: 128 }), ...TEMPLATE_VALIDATORS],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const id = await templates.createTemplate(templatePayload(req.body), req.admin.id);
    const { template, versions } = await templates.getTemplate(id);
    return successResponse(res, { template: transformTemplate(template), versions: versions.map(transformVersion) }, 201);
  })
);

router.get(
  '/templates/:id',
  requirePermission('quotes.view'),
  [idParam],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const data = await templates.getTemplate(parseInt(req.params.id, 10));
    if (!data) return res.status(404).json({ error: 'Template not found' });
    return successResponse(res, { template: transformTemplate(data.template), versions: data.versions.map(transformVersion) });
  })
);

router.put(
  '/templates/:id',
  requirePermission('quotes.manage'),
  [idParam, body('name').optional().isString().trim().isLength({ min: 1, max: 128 }), ...TEMPLATE_VALIDATORS],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const id = parseInt(req.params.id, 10);
    await templates.updateTemplate(id, templatePayload(req.body));
    const { template, versions } = await templates.getTemplate(id);
    return successResponse(res, { template: transformTemplate(template), versions: versions.map(transformVersion) });
  })
);

router.delete(
  '/templates/:id',
  requirePermission('quotes.manage'),
  [idParam],
  handleAsync(async (req, res) => {
    validateRequest(req);
    await templates.archiveTemplate(parseInt(req.params.id, 10));
    return successResponse(res, { archived: true });
  })
);

router.post(
  '/templates/:id/publish',
  requirePermission('quotes.manage'),
  [idParam],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const id = parseInt(req.params.id, 10);
    const version = await templates.publishTemplate(id, req.admin.id);
    const { template, versions } = await templates.getTemplate(id);
    return successResponse(res, {
      template: transformTemplate(template), versions: versions.map(transformVersion), version,
    });
  })
);

router.post(
  '/templates/:id/quotes',
  requirePermission('quotes.manage'),
  [
    idParam,
    body('customerAccountId').isInt({ min: 1 }).withMessage('Customer is required'),
    body('version').optional({ values: 'falsy' }).isInt({ min: 1 }),
    body('eventName').optional({ values: 'falsy' }).isString().isLength({ max: 255 }),
    body('eventDate').optional({ values: 'falsy' }).isISO8601(),
    body('hours').optional({ nullable: true, checkFalsy: true }).isFloat({ min: 0, max: 9999 }),
    body('days').optional({ nullable: true, checkFalsy: true }).isFloat({ min: 0, max: 999 }),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const result = await templates.createQuoteFromTemplate(parseInt(req.params.id, 10), {
      customerAccountId: parseInt(req.body.customerAccountId, 10),
      version: req.body.version ? parseInt(req.body.version, 10) : null,
      eventName: req.body.eventName,
      eventDate: req.body.eventDate,
      hours: req.body.hours,
      days: req.body.days,
    }, req.admin.id);
    return successResponse(res, result, 201, 'Quote created from template');
  })
);

router.post(
  '/templates/from-quote/:quoteId',
  requirePermission('quotes.manage'),
  [param('quoteId').isInt({ min: 1 }), body('name').isString().trim().isLength({ min: 1, max: 128 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const id = await templates.saveQuoteAsTemplate(parseInt(req.params.quoteId, 10), { name: req.body.name }, req.admin.id);
    const { template, versions } = await templates.getTemplate(id);
    return successResponse(res, { template: transformTemplate(template), versions: versions.map(transformVersion) }, 201);
  })
);

module.exports = router;
