'use strict';
const router = require('express').Router();
const { verifyGalleryAccess, denySlideshowToken } = require('../../middleware/gallery');
const { blockHiddenGallery } = require('../../utils/revealMode');
const { handleAsync } = require('../../utils/routeHelpers');
const { ForbiddenError } = require('../../utils/errors');
const { requireFeatureFlag } = require('../../middleware/requireFeatureFlag');
const service = () => require('../../services/printSales/orders').application();
router.use('/:slug/print-sales', verifyGalleryAccess, denySlideshowToken, blockHiddenGallery,
  requireFeatureFlag('printSales'), requireFeatureFlag('albumProducts'), requireFeatureFlag('bills'),
  (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (req.isAdminPreview || !req.viaCustomer || !Number.isSafeInteger(req.galleryAccess?.session?.customerId))
      return next(new ForbiddenError('Open this gallery through your assigned customer account to order prints'));
    next();
  });
const customer = req => req.galleryAccess.session.customerId;
router.get('/:slug/print-sales', handleAsync(async (req, res) => res.json(await service().offers(req.event.id, customer(req)))));
router.get('/:slug/print-sales/orders', handleAsync(async (req, res) => {
  const s = service(); await s.buyer(require('../../database/db').db, req.event.id, customer(req));
  const rows = await require('../../database/db').db('print_sales_orders')
    .where({ event_id: req.event.id, customer_account_id: customer(req) }).orderBy('created_at', 'desc').limit(50);
  res.json({ orders: rows.map(s.shape) });
}));
router.post('/:slug/print-sales/quotes', require('express-rate-limit')({ windowMs: 10 * 60e3, max: 20, standardHeaders: true, legacyHeaders: false }),
  handleAsync(async (req, res) => res.status(201).json(await service().quote(req.event.id, customer(req), req.accessLevel, req.body))));
router.post('/:slug/print-sales/orders/:id/accept', handleAsync(async (req, res) =>
  res.json(await service().accept(req.event.id, customer(req), req.accessLevel, req.params.id, req.body))));
module.exports = router;
