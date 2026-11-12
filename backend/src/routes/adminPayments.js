'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const Stripe = require('stripe');
const { adminAuth } = require('../middleware/auth');
const { requireSuperAdmin } = require('../middleware/permissions');
const { noStoreCache } = require('../middleware/noStoreCache');
const { rateLimitKey } = require('../utils/rateLimitKey');
const { getFrontendBaseUrl, getApiBaseUrl, isLoopbackBase } = require('../utils/frontendUrl');
const { db } = require('../database/db');
const { summarisePurchaseOrder } = require('../modules/photoSales/adminOrders');
const { logActivity } = require('../database/db');
const payments = require('../modules/photoSales/paymentSettings');
const snipcart = require('../modules/photoSales/snipcartSettings');
const providers = require('../modules/photoSales/providers');
const router = express.Router();
const probeLimiter = rateLimit({ windowMs: 60000, max: 10, keyGenerator: rateLimitKey, standardHeaders: true, legacyHeaders: false });

router.use(adminAuth, requireSuperAdmin(), noStoreCache);

function failure(res, error) {
  return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Payment settings are temporarily unavailable.' });
}
async function payload() {
  const base = await getFrontendBaseUrl();
  const apiBase = await getApiBaseUrl();
  const webhookUrl = `${apiBase.replace(/\/+$/, '')}/photo-sales/stripe/webhook`;
  return {
    ...await payments.settings(), site_url: base, site_url_ready: publicHttpsUrl(base),
    webhook_url: publicHttpsUrl(webhookUrl) ? webhookUrl : '',
    api_version: Stripe.API_VERSION, webhook_events: payments.WEBHOOK_EVENTS,
    snipcart: { ...await snipcart.settings(), webhook_url: publicHttpsUrl(apiBase) ? `${apiBase.replace(/\/+$/, '')}/gallery/snipcart-webhook` : '' },
    providers: await providers.configuration(),
    checkout_enabled: await providers.preferences(),
  };
}

// Configuration check only: a received signed event proves Stripe delivery.
function publicHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      && !isLoopbackBase(value) && !url.hostname.endsWith('.localhost');
  } catch { return false; }
}

router.get('/', async (req, res) => {
  try { return res.json(await payload()); }
  catch (error) { return failure(res, error); }
});

router.put('/', probeLimiter, async (req, res) => {
  const input = req.body;
  if (input?.provider === 'availability') {
    if (typeof input.revision !== 'string' || typeof input.stripe !== 'boolean' || typeof input.snipcart !== 'boolean' || Object.keys(input).some((key) => !['provider', 'revision', 'stripe', 'snipcart'].includes(key))) return res.status(400).json({ error: 'Invalid provider availability.' });
    try {
      await providers.savePreferences(input);
      await logActivity('payment_checkout_availability_updated', { stripe: input.stripe, snipcart: input.snipcart }, null, { type: 'admin', id: req.admin.id, name: req.admin.username });
      return res.json(await payload());
    } catch (error) { return failure(res, error); }
  }
  if (!input || Array.isArray(input) || (input.provider !== undefined && !['stripe', 'snipcart'].includes(input.provider))
      || Object.keys(input).some((key) => !(input.provider === 'snipcart' ? ['provider', 'revision', 'public_key', 'secret_key'] : ['provider', 'revision', 'secret_key', 'webhook_secret']).includes(key))
      || typeof input.revision !== 'string'
      || ['public_key', 'secret_key', 'webhook_secret'].some((key) => input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > (input.provider === 'snipcart' ? 2048 : 512)))) {
    return res.status(400).json({ error: 'Invalid payment settings.' });
  }
  try {
    const saved = await (input.provider === 'snipcart' ? snipcart.save(input) : payments.save(input));
    await logActivity('payment_settings_updated', { provider: input.provider || 'stripe', test_mode: saved.test_mode }, null, { type: 'admin', id: req.admin.id, name: req.admin.username });
    return res.json(await payload());
  } catch (error) { return failure(res, error); }
});

router.get('/orders', async (req, res) => {
  const page = Number(req.query.page || 1);
  if (!Number.isSafeInteger(page) || page < 1) return res.status(400).json({ error: 'Invalid page.' });
  try {
    const rows = await db('photo_purchase_orders').where((q) => q.whereNull('gallery_id')
      .orWhere({ recovery_needs_attention: true }).orWhereIn('status', ['refund_pending', 'refund_failed']))
      .orderBy('id', 'desc').limit(51).offset((page - 1) * 50);
    return res.json({ orders: rows.slice(0, 50).map((order) => ({ ...summarisePurchaseOrder(order),
      id: order.id, gallery_id: order.gallery_id, orphaned: order.gallery_id == null })), has_more: rows.length > 50 });
  } catch (error) { return failure(res, error); }
});

router.post('/test', probeLimiter, async (req, res) => {
  if (req.body?.provider !== undefined && !['stripe', 'snipcart'].includes(req.body.provider)) return res.status(400).json({ error: 'Invalid payment provider.' });
  try {
    if (req.body?.provider === 'snipcart') {
      const value = await snipcart.credentials();
      return res.json(await snipcart.verifyApi(value.secretKey));
    }
    const value = await payments.credentials();
    if (!payments.configurationOf(value).checkout_configured) return res.status(409).json({ error: 'Save a Stripe API key first.' });
    return res.json({ ...await payments.verifyApi(value.secretKey), checked_at: new Date().toISOString() });
  } catch (error) { return failure(res, error); }
});

module.exports = router;
