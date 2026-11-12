/**
 * Admin → customer gifts and gift stock (migration 343).
 *
 * The whole mount sits behind the `customerGifts` flag. Reading needs
 * customers.gifts.view, every change needs customers.gifts.manage. A route that
 * returns customer data also needs customers.view, the right that covers it
 * everywhere else, and customers.gifts.view, because a change answers with the
 * customer's gift history.
 */

const express = require('express');
const { body, param } = require('express-validator');

const { adminAuth } = require('../middleware/auth');
const { requirePermission, userHasAnyPermission } = require('../middleware/permissions');
const { requireFeatureFlag } = require('../middleware/requireFeatureFlag');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const giftsService = require('../services/customerGiftsService');

const router = express.Router();

router.use(adminAuth, requireFeatureFlag('customerGifts', 'CUSTOMER_GIFTS_DISABLED'));

const canView = requirePermission('customers.gifts.view');
const canManage = requirePermission('customers.gifts.manage');
const canSeeCustomers = requirePermission('customers.view');
const canChangeCustomerGifts = [canSeeCustomers, canView, canManage];

const idParam = (name = 'id') => param(name).isInt({ min: 1 }).toInt();
const NOTE_MAX = 500;
const noteField = (name) => body(name).optional({ nullable: true }).isString().trim().isLength({ max: NOTE_MAX });
// Calendar days only: ISO 8601 also allows week dates, which the rules can't read.
const dateField = (name) => body(name).optional({ nullable: true, checkFalsy: true })
  .matches(/^\d{4}-\d{2}-\d{2}$/).isISO8601({ strict: true });
const yearsField = (chain) => chain.isInt({ min: 1, max: 100 }).toInt();

// ---- lists and rules -----------------------------------------------------

router.get('/suggestions', canSeeCustomers, canView, handleAsync(async (req, res) => {
  return successResponse(res, await giftsService.listSuggestions());
}));

router.get('/rules', canView, handleAsync(async (req, res) => {
  return successResponse(res, { rules: await giftsService.getRules() });
}));

router.put('/rules', [
  canManage,
  body('milestoneYears').optional().isArray({ min: 1, max: 20 }),
  yearsField(body('milestoneYears.*').optional()),
  body('minBookings').optional().isInt({ min: 0, max: 100 }).toInt(),
  body('activityMinInvoices').optional().isInt({ min: 0, max: 100 }).toInt(),
  body('activityPeriodYears').optional().isInt({ min: 1, max: 50 }).toInt(),
  body('rhythmMarginMonths').optional().isInt({ min: 0, max: 60 }).toInt(),
  body('graceDays').optional().isInt({ min: 0, max: 365 }).toInt(),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const {
    milestoneYears, minBookings, activityMinInvoices, activityPeriodYears, rhythmMarginMonths, graceDays,
  } = req.body;
  const input = Object.fromEntries(Object.entries({
    milestoneYears, minBookings, activityMinInvoices, activityPeriodYears, rhythmMarginMonths, graceDays,
  }).filter(([, value]) => value !== undefined));
  return successResponse(res, { rules: await giftsService.updateRules(input, req.admin) });
}));

// ---- items and stock -----------------------------------------------------

router.get('/items', canView, handleAsync(async (req, res) => {
  const includeArchived = req.query.includeArchived === 'true';
  return successResponse(res, { items: await giftsService.listItems({ includeArchived }) });
}));

router.post('/items', [
  canManage,
  body('name').isString().trim().isLength({ min: 1, max: 120 }),
  noteField('description'),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const { name, description } = req.body;
  return successResponse(res, { item: await giftsService.createItem({ name, description }, req.admin) }, 201);
}));

router.patch('/items/:id', [
  canManage,
  idParam(),
  body('name').optional().isString().trim().isLength({ min: 1, max: 120 }),
  noteField('description'),
  body('isArchived').optional().isBoolean().toBoolean(),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const { name, description, isArchived } = req.body;
  return successResponse(res, {
    item: await giftsService.updateItem(req.params.id, { name, description, isArchived }, req.admin),
  });
}));

router.get('/items/:id/movements', [canView, idParam()], handleAsync(async (req, res) => {
  validateRequest(req);
  const showCosts = await userHasAnyPermission(req.admin.id, ['accounting.view']);
  return successResponse(res, { movements: await giftsService.listMovements(req.params.id, { showCosts }) });
}));

router.post('/items/:id/stock', [
  canManage,
  idParam(),
  body('quantity').isInt({ min: 1, max: 100000 }).toInt(),
  body('unitCostMinor').optional({ nullable: true }).isInt({ min: 0, max: 1000000000 }).toInt(),
  body('currency').optional({ nullable: true }).isString().isLength({ min: 3, max: 3 }).isAlpha(),
  dateField('occurredOn'),
  body('inboundDocumentId').optional({ nullable: true }).isInt({ min: 1 }).toInt(),
  noteField('note'),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const {
    quantity, unitCostMinor, currency, occurredOn, inboundDocumentId, note,
  } = req.body;
  const canReadInvoices = await userHasAnyPermission(req.admin.id, ['accounting.view']);
  const movement = await giftsService.addStock(req.params.id, {
    quantity, unitCostMinor, currency, occurredOn, inboundDocumentId, note,
  }, req.admin, { canReadInvoices });
  return successResponse(res, { movement }, 201);
}));

router.post('/items/:id/corrections', [
  canManage,
  idParam(),
  body('quantityDelta').isInt({ min: -100000, max: 100000 }).toInt()
    .custom((value) => value !== 0),
  body('reason').isString().trim().isLength({ min: 1, max: NOTE_MAX }),
  dateField('occurredOn'),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const { quantityDelta, reason, occurredOn } = req.body;
  const movement = await giftsService.correctStock(req.params.id, { quantityDelta, reason, occurredOn }, req.admin);
  return successResponse(res, { movement }, 201);
}));

// ---- a customer's gifts --------------------------------------------------

router.get('/customers/:id', [canSeeCustomers, canView, idParam()], handleAsync(async (req, res) => {
  validateRequest(req);
  return successResponse(res, await giftsService.getCustomerGifts(req.params.id));
}));

router.patch('/customers/:id', [
  ...canChangeCustomerGifts,
  idParam(),
  body('noGifts').optional().isBoolean().toBoolean(),
  dateField('startDateOverride'),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const { noGifts, startDateOverride } = req.body;
  return successResponse(res, await giftsService.updateCustomerPreferences(
    req.params.id, { noGifts, startDateOverride }, req.admin,
  ));
}));

router.post('/customers/:id/gifts', [
  ...canChangeCustomerGifts,
  idParam(),
  body('giftItemId').isInt({ min: 1 }).toInt(),
  dateField('giftDate'),
  noteField('note'),
  yearsField(body('milestoneYears').optional({ nullable: true })),
  body('isOverride').optional().isBoolean().toBoolean(),
  body('reduceStock').optional().isBoolean().toBoolean(),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const {
    giftItemId, giftDate, note, milestoneYears, isOverride, reduceStock,
  } = req.body;
  return successResponse(res, await giftsService.giveGift(req.params.id, {
    giftItemId, giftDate, note, milestoneYears, isOverride, reduceStock,
  }, req.admin), 201);
}));

router.post('/customers/:id/declines', [
  ...canChangeCustomerGifts,
  idParam(),
  yearsField(body('milestoneYears')),
  noteField('note'),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const { milestoneYears, note } = req.body;
  return successResponse(res, await giftsService.declineMilestone(req.params.id, { milestoneYears, note }, req.admin), 201);
}));

router.post('/:id/undo', [...canChangeCustomerGifts, idParam()], handleAsync(async (req, res) => {
  validateRequest(req);
  return successResponse(res, await giftsService.undo(req.params.id, req.admin));
}));

module.exports = router;
