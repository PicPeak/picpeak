'use strict';
const router = require('express').Router();
const { adminAuth } = require('../middleware/auth');
const { requirePermission, userHasAllPermissions } = require('../middleware/permissions');
const { requireFeatureFlag } = require('../middleware/requireFeatureFlag');
const { requireEventOwner, canLinkCrmToEvent } = require('../middleware/ownership');
const { handleAsync } = require('../utils/routeHelpers');
const { db } = require('../database/db');
const { AppError, ConflictError, ForbiddenError, NotFoundError } = require('../utils/errors');
const P = require('../services/printSales/profiles');
const O = require('../services/printSales/orders');
const G = require('../services/albumProducts/library');
const V = require('../services/albumProducts/validation');
const { pipeline } = require('stream/promises');
const { formatBoolean } = require('../utils/dbCompat');
const fulfilment = () => require('../services/printSales/fulfilment').createService({ db, storage: require('../services/storage').getStorage() });
const permissions = (...names) => requirePermission(names, { requireAll: true });
router.use(adminAuth, (req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
router.get('/settings', permissions('products.view'), handleAsync(async (_req, res) => {
  const cat = await P.catalogue(db);
  res.json({ ...await P.settings(db), products: cat.products.filter(p => p.typeId).map(p => G.resolve(p, cat)),
    presets: await db('quote_line_item_presets').where({ is_active: formatBoolean(true), price_mode: 'fixed' })
      .select('id', 'name', 'product_id', 'currency') });
}));
router.put('/settings', requireFeatureFlag('printSales'), requireFeatureFlag('albumProducts'), requireFeatureFlag('bills'),
  permissions('products.manage', 'bills.manage'), handleAsync(async (req, res) => {
    const result = await P.save(db, req.body);
    await require('../database/db').logActivity('print_settings_updated', { revision: result.revision }, null, { type: 'admin', id: req.admin.id });
    res.json(result);
  }));
router.get('/events/:eventId', requireEventOwner, permissions('products.view'), handleAsync(async (req, res) => {
  const e = Number.isSafeInteger(Number(req.params.eventId)) && await db('events').where({ id: Number(req.params.eventId) }).first();
  if (!e) throw new NotFoundError('Gallery');
  res.json({ enabled: require('../utils/galleryLifecycle').isTrue(e.print_sales_enabled) });
}));
router.put('/events/:eventId', requireEventOwner, requireFeatureFlag('printSales'), requireFeatureFlag('albumProducts'), requireFeatureFlag('bills'),
  permissions('products.configure', 'bills.manage', 'customers.edit'), handleAsync(async (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') throw new AppError('Choose whether gallery ordering is enabled', 400);
    const event = Number.isSafeInteger(Number(req.params.eventId)) && await db('events').where({ id: Number(req.params.eventId) }).first('id', 'created_by');
    if (!event) throw new NotFoundError('Gallery');
    // Orders invoice under the event, so the CRM rule applies, not event access.
    if (!canLinkCrmToEvent(req.admin, event)) throw new ForbiddenError('Only the gallery owner can run print ordering for this gallery');
    const update = { print_sales_enabled: formatBoolean(req.body.enabled) };
    if (req.body.enabled) {
      // Billing stays with the gallery's owner, whoever flips the switch.
      update.print_sales_admin_id = event.created_by ?? req.admin.id;
      if (!await userHasAllPermissions(update.print_sales_admin_id, ['bills.manage', 'customers.edit']))
        throw new ConflictError('The gallery owner needs billing and customer permissions to take print orders');
    }
    await db('events').where({ id: event.id }).update(update);
    res.json({ enabled: req.body.enabled });
  }));
router.get('/orders', permissions('products.view', 'bills.view', 'customers.view'), handleAsync(async (req, res) => {
  const query = db('print_sales_orders').orderBy('created_at', 'desc');
  if (req.admin.roleName !== 'super_admin') query.where({ created_by_admin_id: req.admin.id });
  const offset = Math.max(0, Math.min(100000, Number(req.query.offset) || 0));
  res.json({ orders: (await query.limit(50).offset(offset)).map(O.application().shape) });
}));
router.get('/orders/:id', permissions('products.view', 'bills.view', 'customers.view'), handleAsync(async (req, res) =>
  res.json(O.application().shape(await fulfilment().order(req.params.id, req.admin)))));
router.post('/orders/:id/actions', requireFeatureFlag('printSales'), permissions('products.configure', 'bills.manage', 'customers.edit'), handleAsync(async (req, res) => {
  await require('../services/activeApplicationWork').track('manual print fulfilment', () => fulfilment().action(req.params.id, req.admin, req.body));
  res.json(O.application().shape(await fulfilment().order(req.params.id, req.admin)));
}));
router.get('/orders/:id/files/:kind', requireFeatureFlag('printSales'), permissions('products.configure', 'bills.manage', 'customers.view'), handleAsync(async (req, res) => {
  V.uuid(req.params.id);
  const controller = new AbortController();
  const abort = () => { if (!res.writableFinished) controller.abort(); };
  res.once('close', abort);
  try {
    await require('../services/activeApplicationWork').track('print supplier file download', () =>
      fulfilment().download(req.params.id, req.admin, req.params.kind, async (stream, size) => {
        const pack = req.params.kind === 'pack';
        res.type(pack ? 'application/zip' : 'application/pdf').attachment(`print-${req.params.id}.${pack ? 'zip' : 'pdf'}`);
        res.set('Content-Length', String(size));
        if (req.method === 'HEAD') return res.end();
        await pipeline(stream, res, { signal: controller.signal });
      }, { signal: controller.signal }));
  } finally { res.removeListener('close', abort); }
}));
module.exports = router;
