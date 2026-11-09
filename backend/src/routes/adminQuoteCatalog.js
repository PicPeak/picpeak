/**
 * Admin → Quote catalogue routes (#1451)
 *
 * Mounted at /api/admin/quote-catalog — its own prefix, so these collection
 * paths never collide with /api/admin/quotes/:id. Surface:
 *
 *   GET|POST        /packages          PUT|DELETE /packages/:id
 *   GET|POST        /promotions        PUT|DELETE /promotions/:id
 *   GET|POST        /text-blocks       PUT|DELETE /text-blocks/:id
 *   GET|POST        /factors           PUT|DELETE /factors/:id   (#2440)
 *   POST /factors/price                price a catalogue item with its factors
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
const factors = require('../services/pricingFactorService');

const router = express.Router();

router.use(adminAuth);
router.use(requireFeatureFlag('quotes', 'QUOTES_DISABLED'));
// The example entries (archived, editable) are added the first time the
// catalogue is read; once per install. It runs after the permission check on
// each list route, so an admin who may not read the catalogue can't seed it.
const seedExamples = (req, res, next) => (
  require('../services/quoteCatalogExamples').ensureCatalogExamples().then(() => next(), next)
);

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
    // The contract template a contract from such a quote starts from (#1445).
    defaultContractTemplateId: t.default_contract_template_id == null ? null : Number(t.default_contract_template_id),
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
  seedExamples,
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
// Pricing factors (#2440)
// ---------------------------------------------------------------------

const optionalNumber = (v) => (v == null ? null : Number(v));

function transformFactor(f) {
  return {
    id: f.id,
    name: f.name,
    description: f.description || null,
    inputType: f.input_type,
    effect: f.effect || null,
    unitLabel: f.unit_label || null,
    currency: f.currency,
    amountMinor: f.amount_minor == null ? null : Number(f.amount_minor),
    percent: optionalNumber(f.percent),
    includedUnits: optionalNumber(f.included_units),
    stepSize: optionalNumber(f.step_size),
    minValue: optionalNumber(f.min_value),
    maxValue: optionalNumber(f.max_value),
    defaultValue: f.default_value ?? null,
    clientVisible: isTruthyFlag(f.client_visible),
    displayOrder: f.display_order,
    isActive: isTruthyFlag(f.is_active),
    options: (f.options || []).map((o) => ({
      id: o.id,
      label: o.label,
      effect: o.effect,
      amountMinor: o.amount_minor == null ? null : Number(o.amount_minor),
      percent: optionalNumber(o.percent),
      postcodes: o.postcodes || null,
      position: o.position,
    })),
  };
}

const FACTOR_VALIDATORS = [
  body('description').optional({ nullable: true }).isString().isLength({ max: 2000 }),
  body('inputType').optional().isIn(factors.INPUT_TYPES),
  body('effect').optional({ nullable: true }).isIn([...factors.NUMBER_EFFECTS, ...factors.TOGGLE_EFFECTS]),
  body('unitLabel').optional({ nullable: true }).isString().isLength({ max: 32 }),
  body('currency').optional({ values: 'falsy' }).isString().isLength({ min: 3, max: 3 }),
  body('amountMinor').optional({ nullable: true }).isInt({ min: -1e9, max: 1e9 }),
  body('percent').optional({ nullable: true }).isFloat({ min: -100, max: 1000 }),
  // decimal(10,2) columns: bounded so PostgreSQL never overflows, and a
  // step is at least what two decimals can hold.
  body('includedUnits').optional({ nullable: true }).isFloat({ min: 0, max: 99999999 }),
  body('stepSize').optional({ nullable: true }).isFloat({ min: 0.01, max: 99999999 }),
  body('minValue').optional({ nullable: true }).isFloat({ min: 0, max: 99999999 }),
  body('maxValue').optional({ nullable: true }).isFloat({ min: 0, max: 99999999 }),
  body('defaultValue').optional({ nullable: true }).isString().isLength({ max: 64 }),
  body('clientVisible').optional().isBoolean(),
  body('displayOrder').optional({ values: 'falsy' }).isInt({ min: 0, max: 9999 }),
  body('options').optional().isArray({ max: 100 }),
  body('options.*.id').optional({ nullable: true }).isInt({ min: 1 }),
  body('options.*.label').isString().trim().isLength({ min: 1, max: 128 }),
  body('options.*.effect').optional().isIn(factors.OPTION_EFFECTS),
  body('options.*.amountMinor').optional({ nullable: true }).isInt({ min: -1e9, max: 1e9 }),
  body('options.*.percent').optional({ nullable: true }).isFloat({ min: -100, max: 1000 }),
  body('options.*.postcodes').optional({ nullable: true }).isString().isLength({ max: 20000 }),
];

function factorPayload(b) {
  return {
    name: b.name,
    description: b.description,
    input_type: b.inputType,
    effect: b.effect,
    unit_label: b.unitLabel,
    currency: b.currency,
    amount_minor: b.amountMinor,
    percent: b.percent,
    included_units: b.includedUnits,
    step_size: b.stepSize,
    min_value: b.minValue,
    max_value: b.maxValue,
    default_value: b.defaultValue,
    client_visible: b.clientVisible,
    display_order: b.displayOrder,
    is_active: b.isActive,
    options: Array.isArray(b.options)
      ? b.options.map((o) => ({
        id: o.id, label: o.label, effect: o.effect, amount_minor: o.amountMinor, percent: o.percent, postcodes: o.postcodes,
      }))
      : undefined,
  };
}

router.get(
  '/factors',
  requirePermission('quotes.view'),
  [activeOnlyQuery],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const rows = await factors.listFactors({ activeOnly: activeOnly(req) });
    return successResponse(res, { factors: rows.map(transformFactor) });
  })
);

router.post(
  '/factors',
  requirePermission('quotes.manage'),
  [body('name').isString().trim().isLength({ min: 1, max: 128 }), body('inputType').isIn(factors.INPUT_TYPES), ...FACTOR_VALIDATORS],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const factor = await factors.saveFactor(null, factorPayload(req.body));
    return successResponse(res, { factor: transformFactor(factor) }, 201);
  })
);

// Before /factors/:id so "price" never reads as an id.
router.post(
  '/factors/price',
  requirePermission('quotes.view'),
  [
    body('presetId').isInt({ min: 1 }),
    body('values').optional({ nullable: true }).isObject(),
    body('customerId').optional({ nullable: true }).isInt({ min: 1 }),
    body('quantity').optional({ nullable: true }).isFloat({ min: 0, max: 99999 }),
    body('language').optional({ values: 'falsy' }).isString().isLength({ max: 8 }),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const result = await factors.priceWithFactors(parseInt(req.body.presetId, 10), {
      values: req.body.values || {},
      customerId: req.body.customerId ? parseInt(req.body.customerId, 10) : null,
      quantity: req.body.quantity,
      language: req.body.language || 'en',
    });
    return successResponse(res, {
      currency: result.currency,
      baseMinor: result.baseMinor,
      totalMinor: result.totalMinor,
      lines: result.lines,
      unmatched: result.unmatched,
      snapshot: result.snapshot,
    });
  })
);

router.put(
  '/factors/:id',
  requirePermission('quotes.manage'),
  [
    idParam,
    body('name').optional().isString().trim().isLength({ min: 1, max: 128 }),
    body('isActive').optional().isBoolean(),
    ...FACTOR_VALIDATORS,
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const factor = await factors.saveFactor(parseInt(req.params.id, 10), factorPayload(req.body));
    return successResponse(res, { factor: transformFactor(factor) });
  })
);

router.delete(
  '/factors/:id',
  requirePermission('quotes.manage'),
  [idParam],
  handleAsync(async (req, res) => {
    validateRequest(req);
    await factors.archiveFactor(parseInt(req.params.id, 10));
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
  seedExamples,
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
  seedExamples,
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
  body('defaultContractTemplateId').optional({ nullable: true }).isInt({ min: 1 }).toInt(),
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
    default_contract_template_id: reqBody.defaultContractTemplateId,
    draft: reqBody.draft,
  };
}

router.get(
  '/templates',
  requirePermission('quotes.view'),
  seedExamples,
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
