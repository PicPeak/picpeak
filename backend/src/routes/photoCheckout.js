'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { db } = require('../database/db');
const { noStoreCache } = require('../middleware/noStoreCache');
const { rateLimitKey } = require('../utils/rateLimitKey');
const { checkoutSession, reconcileSession, OPEN, quoteOf, verifyCheckoutBrowser } = require('../modules/photoSales/stripeCheckout');
const { stripeClient } = require('../modules/photoSales/stripeClient');
const logger = require('../utils/logger');

const router = express.Router();
const tokenLimiter = rateLimit({ windowMs: 60000, max: 120, keyGenerator: rateLimitKey, standardHeaders: true, legacyHeaders: false });
router.use(noStoreCache, tokenLimiter);

async function findCheckout(req) {
  if (!/^[0-9a-f]{48}$/.test(req.params.token || '')) return null;
  const order = await db('photo_purchase_orders').where({ payment_provider: 'stripe', checkout_token: req.params.token }).first();
  return verifyCheckoutBrowser(order, req.get('X-Photo-Checkout-Key')) ? order : null;
}

// The provider receives the return URL, so its token alone grants nothing.
// The browser proof stays in session storage and never travels to Stripe.
router.get('/:token', async (req, res) => {
  try {
    const order = await findCheckout(req);
    if (!order) return res.status(404).json({ error: 'Checkout not found' });
    const quote = quoteOf(order);
    return res.json({
      status: order.status,
      gallery_url: `/gallery/${encodeURIComponent(quote.gallerySlug)}`,
      gallery_slug: quote.gallerySlug,
      purchased_photo_ids: order.status === 'completed' ? quote.lines.map((line) => line.photoId) : [],
      download_url: order.status === 'completed' ? `/purchased-downloads/${order.access_token}` : null,
    });
  } catch {
    return res.status(500).json({ error: 'Checkout status is temporarily unavailable' });
  }
});

// Returning through cancel_url is only navigation. Release a promo after
// Stripe confirms expiration, since another tab could still pay otherwise.
router.post('/:token/cancel', async (req, res) => {
  try {
    const order = await findCheckout(req);
    if (!order) return res.status(404).json({ error: 'Checkout not found' });
    if (OPEN.includes(order.status)) {
      const client = stripeClient();
      let session = await checkoutSession(order, client);
      if (session.status === 'open') {
        try { session = await client.checkout.sessions.expire(session.id); }
        catch { session = await client.checkout.sessions.retrieve(session.id, { expand: ['payment_intent.latest_charge'] }); }
      }
      await reconcileSession(order, session, { client });
    }
    return res.json({ ok: true });
  } catch (error) {
    logger.warn('Stripe checkout cancellation could not be confirmed', { type: error.type || error.name });
    return res.status(503).json({ error: 'Cancellation could not be confirmed. Please try again.' });
  }
});

module.exports = router;
