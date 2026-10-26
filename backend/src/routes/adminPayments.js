'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const Stripe = require('stripe');
const { adminAuth } = require('../middleware/auth');
const { requireSuperAdmin } = require('../middleware/permissions');
const { noStoreCache } = require('../middleware/noStoreCache');
const { rateLimitKey } = require('../utils/rateLimitKey');
const { getFrontendBaseUrl } = require('../utils/frontendUrl');
const { logActivity } = require('../database/db');
const payments = require('../modules/photoSales/paymentSettings');
const router = express.Router();
const probeLimiter = rateLimit({ windowMs: 60000, max: 10, keyGenerator: rateLimitKey, standardHeaders: true, legacyHeaders: false });

router.use(adminAuth, requireSuperAdmin(), noStoreCache);

function failure(res, error) {
  return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Payment settings are temporarily unavailable.' });
}
async function payload() {
  const base = await getFrontendBaseUrl().catch(() => '');
  return { ...await payments.settings(), webhook_url: base ? `${base.replace(/\/+$/, '')}/api/photo-sales/stripe/webhook` : '', api_version: Stripe.API_VERSION, webhook_events: payments.WEBHOOK_EVENTS };
}

router.get('/', async (req, res) => {
  try { return res.json(await payload()); }
  catch (error) { return failure(res, error); }
});

router.put('/', probeLimiter, async (req, res) => {
  const input = req.body;
  if (!input || Array.isArray(input) || Object.keys(input).some((key) => !['revision', 'secret_key', 'webhook_secret'].includes(key))
      || typeof input.revision !== 'string'
      || ['secret_key', 'webhook_secret'].some((key) => input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 512))) {
    return res.status(400).json({ error: 'Invalid payment settings.' });
  }
  try {
    const saved = await payments.save(input);
    await logActivity('payment_settings_updated', { provider: 'stripe', test_mode: saved.test_mode }, null, { type: 'admin', id: req.admin.id, name: req.admin.username });
    return res.json(await payload());
  } catch (error) { return failure(res, error); }
});

router.post('/test', probeLimiter, async (req, res) => {
  try {
    const value = await payments.credentials();
    if (!payments.configurationOf(value).checkout_configured) return res.status(409).json({ error: 'Save a Stripe API key first.' });
    return res.json({ ...await payments.verifyApi(value.secretKey), checked_at: new Date().toISOString() });
  } catch (error) { return failure(res, error); }
});

module.exports = router;
