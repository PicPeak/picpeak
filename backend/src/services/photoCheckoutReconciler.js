'use strict';

const { db } = require('../database/db');
const { scheduledTask } = require('./scheduledTask');
const { stripeClient, stripeConfiguration } = require('../modules/photoSales/stripeClient');
const { checkoutSession, reconcileSession, quoteOf, OPEN } = require('../modules/photoSales/stripeCheckout');
const logger = require('../utils/logger');

// Webhooks remain required. This backstop recovers a crash after session
// creation, missed expiry notifications and an email queue failure. A cursor
// prevents long-running asynchronous payments from starving newer orders.
let afterId = 0;
async function reconcilePhotoCheckouts() {
  const config = stripeConfiguration();
  if (!config.checkout_configured || !config.webhook_configured) return;
  const candidates = () => db('photo_purchase_orders').where({ payment_provider: 'stripe' })
    .where((q) => q.whereIn('status', [...OPEN, 'refund_pending', 'refund_failed'])
      .orWhere((q) => q.where({ status: 'completed', email_sent: false })));
  let orders = await candidates().where('id', '>', afterId).orderBy('id').limit(20);
  if (!orders.length) { afterId = 0; orders = await candidates().orderBy('id').limit(20); }
  const client = stripeClient();
  for (const order of orders) {
    afterId = order.id;
    const quote = quoteOf(order);
    if (quote.testMode !== config.test_mode) continue;
    // While a checkout is being created, the request handler owns it.
    if (Date.now() - Date.parse(order.purchased_at) < 120000) continue;
    try {
      const session = order.checkout_session_id
        ? await client.checkout.sessions.retrieve(order.checkout_session_id, { expand: ['payment_intent.latest_charge'] })
        : await checkoutSession(order, client);
      await reconcileSession(order, session, { client });
    } catch (error) {
      if (error.code !== 'CHECKOUT_ENDED') logger.warn('Photo checkout recovery will retry', { type: error.type || error.name });
    }
  }
}

const task = scheduledTask(reconcilePhotoCheckouts, { interval: 60000, initialDelay: 15000 });
module.exports = { reconcilePhotoCheckouts, start: task.start, stop: task.stop };
