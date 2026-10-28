'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { verifyGalleryAccess, denySlideshowToken } = require('../../middleware/gallery');
const { noStoreCache } = require('../../middleware/noStoreCache');
const { rateLimitKey } = require('../../utils/rateLimitKey');
const { reserveCheckout } = require('../../modules/photoSales/checkoutReservation');
const { checkoutSession, reconcileSession } = require('../../modules/photoSales/stripeCheckout');
const snipcart = require('../../modules/photoSales/snipcartCheckout');
const promoIdentity = require('../../modules/photoSales/promoIdentity');
const { isGalleryOnSale } = require('../../modules/photoSales/sellable');
const { configuration: providerConfiguration } = require('../../modules/photoSales/providers');
const logger = require('../../utils/logger');

const router = express.Router();
const checkoutLimiter = rateLimit({ windowMs: 60000, max: 20, keyGenerator: rateLimitKey, standardHeaders: true, legacyHeaders: false });
const verificationLimiter = rateLimit({ windowMs: 60 * 60e3, max: 20, keyGenerator: rateLimitKey, standardHeaders: true, legacyHeaders: false });

function verificationHandler(action) {
  return async (req, res) => {
    if (req.isAdminPreview) return res.status(403).json({ error: 'Purchases are unavailable in preview mode' });
    const body = req.body || {};
    const promoCode = typeof body.promoCode === 'string' ? body.promoCode.trim().toUpperCase() : '';
    if (!isGalleryOnSale(req.event) || !req.event.promo_code || Number(req.event.free_photo_count) <= 0
        || promoCode !== req.event.promo_code) {
      return res.status(409).json({ error: 'This promo is not available.', code: 'PROMO_UNAVAILABLE' });
    }
    try {
      if (!(await providerConfiguration()).available.length) {
        return res.status(503).json({ error: 'Photo purchases are unavailable.', code: 'CHECKOUT_UNAVAILABLE' });
      }
      const result = await promoIdentity[action](req.event.id, body);
      return res.status(action === 'sendCode' ? 202 : 200).json(result);
    } catch (error) {
      if (error.code?.startsWith('CHECKOUT_PROMO_')) {
        if (error.retryAfterSeconds) res.set('Retry-After', String(error.retryAfterSeconds));
        return res.status(error.statusCode).json({ error: error.message, code: error.code, retryAfterSeconds: error.retryAfterSeconds });
      }
      logger.error('Photo promo verification failed', { type: error.name });
      return res.status(503).json({ error: 'Verification is temporarily unavailable.', code: 'CHECKOUT_PROMO_EMAIL_UNAVAILABLE' });
    }
  };
}
router.post('/:slug/checkout/promo-verification', noStoreCache, verificationLimiter, verifyGalleryAccess, denySlideshowToken, verificationHandler('sendCode'));
router.post('/:slug/checkout/promo-verification/confirm', noStoreCache, verificationLimiter, verifyGalleryAccess, denySlideshowToken, verificationHandler('confirmCode'));

router.post('/:slug/checkout', noStoreCache, checkoutLimiter, verifyGalleryAccess, denySlideshowToken, async (req, res) => {
  try {
    // A preview session is an editing tool, never a buyer's payment flow.
    if (req.isAdminPreview) return res.status(403).json({ error: 'Purchases are unavailable in preview mode' });
    const order = await reserveCheckout(req.event, req.body);
    if (order.payment_provider === 'snipcart') return res.json({ snipcart: snipcart.handoff(order) });
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
    logger.error('Photo checkout could not be created', { type: error.type || error.name });
    return res.status(503).json({ error: 'Checkout is temporarily unavailable. Please try again.', code: 'CHECKOUT_RETRY' });
  }
});

module.exports = router;
