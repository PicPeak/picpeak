'use strict';
const { db } = require('../database/db');
const { scheduledTask } = require('./scheduledTask');
const lease = require('./maintenanceJobState');
const { stripeClient, stripeConfiguration } = require('../modules/photoSales/stripeClient');
const { checkoutSession, reconcileSession, quoteOf, OPEN } = require('../modules/photoSales/stripeCheckout');
const { sendPurchaseEmail } = require('../modules/photoSales/fulfilment');
const logger = require('../utils/logger');
const JOB = 'photo_checkout_recovery';

async function recoveryFailure(order, error) {
  // Successful bounded scans are progress, not a provider outage. Check again
  // at the release boundary rather than extending a short promo hold via backoff.
  if (error.retryAt) {
    await db('photo_purchase_orders').where({ id: order.id }).update({ recovery_next_at: error.retryAt });
    return;
  }
  const attempts = Number(order.recovery_attempts || 0) + 1;
  const malformed = error instanceof SyntaxError || error instanceof TypeError;
  await db('photo_purchase_orders').where({ id: order.id }).update({
    recovery_attempts: attempts, recovery_error: malformed ? 'QUOTE_UNREADABLE' : 'PROVIDER_UNCONFIRMED',
    recovery_needs_attention: malformed || attempts >= 6 || order.status === 'refund_failed',
    recovery_next_at: new Date(Date.now() + Math.min(86400, 60 * 2 ** Math.min(attempts, 11)) * 1000).toISOString(),
  });
  logger.warn('Photo checkout recovery will retry', { order_id: order.order_id, type: error.type || error.name });
}
async function reconcilePhotoCheckouts() {
  await lease.ensure(JOB);
  const token = await lease.claim(JOB);
  if (!token) return;
  const keeper = lease.startLeaseKeeper(JOB, token);
  try {
    await require('../modules/photoSales/promoIdentity').prune();
    const config = await stripeConfiguration();
    const orders = await db('photo_purchase_orders')
      .where((q) => q.whereIn('status', [...OPEN, 'refund_pending', 'refund_failed'])
        .orWhere((q) => q.where({ status: 'completed', email_sent: false })))
      .whereNotNull('checkout_quote')
      .where((q) => q.whereNull('recovery_next_at').orWhere('recovery_next_at', '<=', new Date().toISOString()))
      .orderByRaw('COALESCE(recovery_next_at, purchased_at)').orderBy('id').limit(20);
    let client;
    for (const order of orders) {
      if (keeper.lost() || !(await lease.heartbeat(JOB, token))) break;
      // Give the live request time to create its provider session.
      if (Date.now() - Date.parse(order.purchased_at) < 120000) continue;
      try {
        const quote = quoteOf(order); // isolate corrupt rows, too
        if (order.payment_provider === 'snipcart') {
          if (order.provider_order_id) {
            const snipcart = require('../modules/photoSales/snipcartOrders');
            const remote = await snipcart.fetchSnipcartOrder(order.provider_order_id);
            if (!remote) throw new Error('Snipcart order unavailable');
            await snipcart.reconcileOrder(remote);
            const fresh = await db('photo_purchase_orders').where({ id: order.id }).first('status', 'email_sent');
            if (['refunded', 'charged_back', 'cancelled', 'failed', 'expired'].includes(fresh.status) || (fresh.status === 'completed' && fresh.email_sent)) continue;
          }
          if (order.status === 'completed') {
            await sendPurchaseEmail(order, quote.galleryName, quote.lines.length);
            continue;
          }
          if (['refund_pending', 'refund_failed'].includes(order.status)) {
            await db('photo_purchase_orders').where({ id: order.id }).update({ recovery_needs_attention: true, recovery_error: 'REFUND_UNCONFIRMED', recovery_next_at: new Date(Date.now() + 86400000).toISOString() });
            continue;
          }
          if (!order.provider_order_id && OPEN.includes(order.status) && Date.now() >= (quote.sessionExpiresAt + 300) * 1000) {
            // Snipcart cannot cancel an unpaid cart through its Orders API.
            // Reject/refund a later paid delivery against this expired quote.
            await db('photo_purchase_orders').where({ id: order.id }).whereIn('status', OPEN)
              .whereNull('provider_order_id').update({ status: 'expired', promo_gallery_id: null });
          } else {
            await db('photo_purchase_orders').where({ id: order.id }).update({
              recovery_next_at: new Date(Math.max(Date.now() + 60000, (quote.sessionExpiresAt + 300) * 1000)).toISOString(),
            });
          }
          continue;
        }
        if (!config.checkout_configured || !config.webhook_configured || quote.testMode !== config.test_mode) {
          throw Object.assign(new Error('Payment credentials unavailable'), { code: 'PAYMENT_CONFIGURATION' });
        }
        client ||= await stripeClient();
        const session = order.checkout_session_id
          ? await client.checkout.sessions.retrieve(order.checkout_session_id, { expand: ['payment_intent.latest_charge'] })
          : await checkoutSession(order, client);
        await reconcileSession(order, session, { client });
        const fresh = await db('photo_purchase_orders').where({ id: order.id }).first('status');
        if (fresh.status === 'refund_failed') throw new Error('Refund remains unconfirmed');
        await db('photo_purchase_orders').where({ id: order.id }).update({ recovery_attempts: 0, recovery_error: null,
          recovery_needs_attention: false, recovery_next_at: new Date(Date.now() + 60000).toISOString() });
      } catch (error) {
        if (error.code !== 'CHECKOUT_ENDED') await recoveryFailure(order, error);
      }
    }
  } finally {
    keeper.stop();
    await lease.release(JOB, token);
  }
}
const task = scheduledTask(reconcilePhotoCheckouts, { interval: 60000, initialDelay: 15000 });
module.exports = { reconcilePhotoCheckouts, start: task.start, stop: task.stop };
