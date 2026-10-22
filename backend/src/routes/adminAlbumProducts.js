'use strict';
const express = require('express');
const { body, param } = require('express-validator');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { requireFeatureFlag } = require('../middleware/requireFeatureFlag');
const {
  requireEventOwnership,
  requireEventOwner,
} = require('../middleware/ownership');
const { handleAsync, validateRequest } = require('../utils/routeHelpers');
const { db, logActivity } = require('../database/db');
const { NotFoundError } = require('../utils/errors');
const { pipeStreamToResponse } = require('../utils/streamResponse');
const service = () =>
  require('../services/albumProducts/service').application();
const router = express.Router();
const billing = require('../services/albumProducts/billing');
router.use(adminAuth, requireFeatureFlag('albumProducts'));
router.use((req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  next();
});
router.get(
  '/catalogue',
  requirePermission('products.view'),
  handleAsync(async (req, res) => res.json(await service().catalogue())),
);
router.get(
  '/customers/:customerId/billing',
  requireFeatureFlag('bills'),
  requirePermission(['customers.view', 'bills.manage'], { requireAll: true }),
  param('customerId').isInt({ min: 1 }),
  handleAsync(async (req, res) => {
    validateRequest(req);
    res.json({
      items: await billing
        .scoped(db('product_billable_items'))
        .where({ customer_account_id: Number(req.params.customerId) })
        .orderBy('created_at'),
    });
  }),
);
router.post(
  '/customers/:customerId/billing',
  requireFeatureFlag('bills'),
  requirePermission(['customers.edit', 'bills.manage'], { requireAll: true }),
  param('customerId').isInt({ min: 1 }),
  body('itemIds').isArray({ min: 1, max: 200 }),
  handleAsync(async (req, res) => {
    validateRequest(req);
    res
      .status(201)
      .json(
        await billing.billEvent(
          db,
          null,
          req.admin.id,
          null,
          Number(req.params.customerId),
          req.body.itemIds,
        ),
      );
  }),
);
router.put(
  '/catalogue',
  requirePermission('products.manage'),
  handleAsync(async (req, res) => {
    const result = await service().saveCatalogue(req.body);
    await logActivity(
      'album_catalogue_updated',
      { revision: result.revision },
      null,
      { type: 'admin', id: req.admin.id },
    );
    res.json(result);
  }),
);
router.post(
  '/images',
  requirePermission('products.manage'),
  express.raw({ type: 'application/octet-stream', limit: '6mb' }),
  handleAsync(async (req, res) =>
    res.status(201).json(await service().uploadImage(req.body, req.admin.id)),
  ),
);
router.get(
  '/images/:imageId',
  requirePermission('products.view'),
  param('imageId').isUUID(),
  handleAsync(async (req, res) => {
    validateRequest(req);
    const image = await service().image(req.params.imageId);
    res.type('png');
    pipeStreamToResponse(
      await require('../services/storage').getStorage().get(image.storage_key),
      res,
      { context: 'album option image' },
    );
  }),
);
const events = express.Router({ mergeParams: true });
router.use(
  '/events/:eventId',
  param('eventId').isInt({ min: 1 }),
  (req, res, next) => {
    validateRequest(req);
    next();
  },
  requireEventOwnership,
  events,
);
events.get(
  '/',
  requirePermission('products.view'),
  handleAsync(async (req, res) =>
    res.json({
      catalogue: await service().catalogue(),
      offers: await service().offers(Number(req.params.eventId)),
    }),
  ),
);
events.get(
  '/billing',
  requireEventOwner,
  requirePermission('bills.manage'),
  requireFeatureFlag('bills'),
  handleAsync(async (req, res) => {
    const eventId = Number(req.params.eventId);
    res.json({
      items: await billing
        .scoped(db('product_billable_items'))
        .where({ event_id: eventId })
        .orderBy('created_at'),
      presets: await db('quote_line_item_presets')
        .where({ is_active: require('../utils/dbCompat').formatBoolean(true) })
        .whereNotNull('product_id')
        .select('id', 'name', 'product_id', 'currency'),
      customers: await db('event_customer_assignments as a')
        .join('customer_accounts as c', 'c.id', 'a.customer_account_id')
        .where('a.event_id', eventId)
        .select('c.id', 'c.display_name', 'c.email'),
    });
  }),
);
events.post(
  '/billing',
  requireEventOwner,
  requirePermission(['customers.edit', 'bills.manage'], { requireAll: true }),
  requireFeatureFlag('bills'),
  body('invoiceId').optional({ nullable: true }).isInt({ min: 1 }),
  body('customerId').optional({ nullable: true }).isInt({ min: 1 }),
  handleAsync(async (req, res) => {
    validateRequest(req);
    res
      .status(201)
      .json(
        await billing.billEvent(
          db,
          Number(req.params.eventId),
          req.admin.id,
          req.body.invoiceId == null ? null : Number(req.body.invoiceId),
          req.body.customerId == null ? null : Number(req.body.customerId),
        ),
      );
  }),
);
events.post(
  '/offers',
  requirePermission('products.configure'),
  body('productId').isUUID(),
  handleAsync(async (req, res) => {
    validateRequest(req);
    if (
      !(await db('events')
        .where({ id: Number(req.params.eventId) })
        .first())
    )
      throw new NotFoundError('Event');
    res
      .status(201)
      .json(
        await service().assign(Number(req.params.eventId), req.body.productId),
      );
  }),
);
events.get(
  '/offers/:id/history',
  requirePermission('products.view'),
  param('id').isUUID(),
  handleAsync(async (req, res) => {
    validateRequest(req);
    res.json(
      await service().history(Number(req.params.eventId), req.params.id),
    );
  }),
);
events.put(
  '/offers/:id',
  requirePermission('products.configure'),
  param('id').isUUID(),
  body('revision').custom((value) => Number.isSafeInteger(value) && value >= 1),
  body('mutationId').isUUID(),
  (req, res, next) => {
    if (
      req.body.action === 'lock' ||
      req.body.action === 'unlock' ||
      req.body.cataloguePresetId !== undefined ||
      req.body.showPrices !== undefined ||
      req.body.customerId !== undefined
    ) {
      billing
        .enabled(db)
        .then((on) => {
          if (!on) return next();
          requireEventOwner(req, res, (err) =>
            err ? next(err) : requirePermission('bills.manage')(req, res, next),
          );
        })
        .catch(next);
    } else next();
  },
  handleAsync(async (req, res) => {
    validateRequest(req);
    const event = await db('events')
      .where({ id: Number(req.params.eventId) })
      .first();
    if (!event) throw new NotFoundError('Event');
    res.json(
      await service().mutate(
        event,
        {
          id: req.params.id,
          revision: req.body.revision,
          mutationId: req.body.mutationId,
          action: req.body.action,
          enabled: req.body.enabled,
          cataloguePresetId: req.body.cataloguePresetId,
          showPrices: req.body.showPrices,
          customerId: req.body.customerId,
        },
        { type: 'admin', id: req.admin.id, name: req.admin.username },
        { admin: true },
      ),
    );
  }),
);
module.exports = router;
