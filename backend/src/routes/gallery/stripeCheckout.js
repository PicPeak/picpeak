'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { verifyGalleryAccess, denySlideshowToken } = require('../../middleware/gallery');
const { noStoreCache } = require('../../middleware/noStoreCache');
const { rateLimitKey } = require('../../utils/rateLimitKey');
const { reserveCheckout, checkoutSession, reconcileSession } = require('../../modules/photoSales/stripeCheckout');
const logger = require('../../utils/logger');

const router = express.Router();
const checkoutLimiter = rateLimit({ windowMs: 60000, max: 20, keyGenerator: rateLimitKey, standardHeaders: true, legacyHeaders: false });

router.post('/:slug/checkout', noStoreCache, checkoutLimiter, verifyGalleryAccess, denySlideshowToken, async (req, res) => {
  try {
    // A preview session is an editing tool, never a buyer's payment flow.
    if (req.isAdminPreview) return res.status(403).json({ error: 'Purchases are unavailable in preview mode' });
    const order = await reserveCheckout(req.event, req.body);
    const session = await checkoutSession(order);
    if (session.status !== 'open') {
      await reconcileSession(order, session);
      return res.json({ return_url: `/photo-checkout/${order.checkout_token}` });
    }
    return res.json({ checkout_url: session.url });
  } catch (error) {
    if ((error.statusCode && error.code?.startsWith('CHECKOUT')) || ['PHOTOS_UNAVAILABLE', 'GALLERY_CLOSING', 'PROMO_UNAVAILABLE'].includes(error.code)) {
      return res.status(error.statusCode).json({ error: error.message, code: error.code });
    }
    // Provider errors can contain API keys or customer data. Log only their
    // classification; never forward the SDK message to the browser.
    logger.error('Stripe checkout could not be created', { type: error.type || error.name });
    return res.status(503).json({ error: 'Checkout is temporarily unavailable. Please try again.', code: 'CHECKOUT_RETRY' });
  }
});

module.exports = router;
