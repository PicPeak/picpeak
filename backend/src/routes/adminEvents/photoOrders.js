/**
 * Photo sales — per-gallery purchase orders (admin).
 *
 * Follows the adminEvents sub-router shape (see ./index.js for the
 * registration-order contract). Read-only overview + manual resend of the
 * purchase access email.
 */

const { db, logActivity } = require('../../database/db');
const { adminAuth } = require('../../middleware/auth');
const { requirePermission } = require('../../middleware/permissions');
const { errorResponse } = require('../../utils/routeHelpers');
const { requireEventOwner, scopeEventsListQuery } = require('../../middleware/ownership');
const { buildPurchasedDownloadUrl } = require('../../modules/photoSales/purchaseAccess');
const { summarisePurchaseOrder } = require('../../modules/photoSales/adminOrders');
const { queueEmail } = require('../../services/emailProcessor');
const { getFrontendBaseUrl } = require('../../utils/frontendUrl');

async function loadOwnedEvent(req) {
  // Defence in depth — requireEventOwner already ran on write routes.
  return scopeEventsListQuery(db('events').where('id', req.params.id), req.admin).first();
}

function emailVariables(order, galleryName, photoCount) {
  return {
    buyer_email: order.buyer_email,
    gallery_name: galleryName,
    access_link: null, // filled by the caller once the URL is known
    purchased_at: order.purchased_at,
    expires_at: order.expires_at,
    photo_count: photoCount,
    download_count: photoCount,
  };
}

module.exports = (router) => {
  // Read with the event details' visibility (GET /:id), so a role that sees
  // every event reads the orders of one it does not own; resending stays
  // with the owner.
  router.get('/:id/photo-orders', adminAuth, requirePermission('events.view'), async (req, res) => {
    try {
      const event = await scopeEventsListQuery(db('events').where('id', req.params.id), req.admin).first();
      if (!event) return res.status(404).json({ error: 'Event not found' });

      const orders = await db('photo_purchase_orders')
        .where({ gallery_id: event.id })
        .orderBy('purchased_at', 'desc');

      const summaries = [];
      for (const order of orders) {
        const rows = await db('photo_purchases')
          .where({ order_id: order.order_id })
          .select('*');
        summaries.push(summarisePurchaseOrder(order, rows));
      }

      res.json({
        orders: summaries,
        // Whether this install can sell at all: without the public key the
        // gallery shows no cart, without the secret key every webhook is
        // refused and no order is ever granted.
        store: {
          checkout_configured: !!(process.env.SNIPCART_API_KEY || '').trim(),
          webhook_configured: !!(process.env.SNIPCART_SECRET_API_KEY || '').trim(),
        },
      });
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to load photo orders');
    }
  });

  // The buyer's purchase link, for the owner only: neither a role that may
  // read every event's orders nor an assigned admin gets a buyer's download
  // link (credentials on a gallery are owner-only, see requireEventOwner).
  router.post('/:id/photo-orders/:orderId/access-link', adminAuth, requirePermission('events.edit'), requireEventOwner, async (req, res) => {
    try {
      const event = await loadOwnedEvent(req);
      if (!event) return res.status(404).json({ error: 'Event not found' });

      const order = await db('photo_purchase_orders')
        .where({ gallery_id: event.id, order_id: String(req.params.orderId), status: 'completed' })
        .first('access_token');
      if (!order) return res.status(404).json({ error: 'Order not found' });

      res.json({
        access_link: buildPurchasedDownloadUrl({ baseUrl: await getFrontendBaseUrl(), accessToken: order.access_token }),
      });
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to load the purchase link');
    }
  });

  // Manual resend of the purchase access email (admin requirement: the
  // buyer lost the mail and asks for the link again). Owner-only like the
  // link itself: the email carries it.
  router.post('/:id/photo-orders/:orderId/resend-email', adminAuth, requirePermission('events.edit'), requireEventOwner, async (req, res) => {
    try {
      const event = await loadOwnedEvent(req);
      if (!event) return res.status(404).json({ error: 'Event not found' });

      const order = await db('photo_purchase_orders')
        .where({ gallery_id: event.id, order_id: String(req.params.orderId), status: 'completed' })
        .first();
      if (!order) return res.status(404).json({ error: 'Order not found' });

      const photoCount = Number(
        (await db('photo_purchases').where({ order_id: order.order_id }).count('* as c').first())?.c || 0
      );

      const accessLink = buildPurchasedDownloadUrl({
        baseUrl: await getFrontendBaseUrl(),
        accessToken: order.access_token,
      });
      const variables = emailVariables(order, event.event_name || event.slug, photoCount);
      variables.access_link = accessLink;

      await queueEmail(event.id, order.buyer_email, 'photo_purchase_access', variables);
      await db('photo_purchase_orders')
        .where({ id: order.id })
        .update({ email_sent: true, updated_at: new Date().toISOString() });
      await logActivity('photo_purchase_email_resent', {
        order_id: order.order_id,
        buyer_email: order.buyer_email,
      }, event.id, { type: 'admin', id: req.admin.id, name: req.admin.username });

      res.json({ ok: true });
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to resend purchase email');
    }
  });
};
