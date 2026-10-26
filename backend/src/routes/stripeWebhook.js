'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { rateLimitKey } = require('../utils/rateLimitKey');
const { stripeClient } = require('../modules/photoSales/stripeClient');
const { reconcileWebhook } = require('../modules/photoSales/stripeCheckout');
const { credentials, configurationOf, recordWebhook, WEBHOOK_EVENTS } = require('../modules/photoSales/paymentSettings');
const logger = require('../utils/logger');

const router = express.Router();
const webhookLimiter = rateLimit({ windowMs: 60000, max: 300, keyGenerator: rateLimitKey, standardHeaders: true, legacyHeaders: false });
const EVENTS = new Set(WEBHOOK_EVENTS);

router.post('/', webhookLimiter, express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  try {
    const value = await credentials();
    const configuration = configurationOf(value);
    if (!configuration.checkout_configured || !configuration.webhook_configured) {
      return res.status(503).json({ error: 'Stripe webhooks are not configured' });
    }
    const client = await stripeClient(value);
    let event;
    try {
      // SDK verification includes a timestamp tolerance; parsed JSON and a
      // static HMAC fallback are deliberately never accepted here.
      event = client.webhooks.constructEvent(req.body, req.get('stripe-signature'), value.webhookSecret);
      if (event.livemode !== !configuration.test_mode) throw new Error('Payment mode mismatch');
    } catch {
      return res.status(400).json({ error: 'Invalid Stripe webhook signature or mode' });
    }
    await recordWebhook(value);
    if (!EVENTS.has(event.type)) return res.json({ ok: true });
    try {
      await reconcileWebhook(event, client);
      // Never return access tokens: providers retain webhook responses.
      return res.json({ ok: true });
    } catch (error) {
      logger.error('Stripe payment reconciliation failed', { type: error.type || error.name });
      return res.status(500).json({ error: 'Payment could not be reconciled' });
    }
  } catch (error) {
    logger.error('Stripe webhook configuration unavailable', { type: error.type || error.name });
    return res.status(503).json({ error: 'Stripe webhook is temporarily unavailable' });
  }
});

module.exports = router;
