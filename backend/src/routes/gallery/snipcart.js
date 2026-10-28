/**
 * Photo sales — Snipcart order validation for priced galleries.
 *
 * Snipcart's SERVER crawls this URL once per cart line before payment
 * (no gallery session cookie — public by design) and compares the answer
 * with the item in the cart. The answer is Snipcart's JSON-crawler item
 * ({ id, price, customFields, url }): the price comes from the saved quote,
 * so a cart line re-priced in the browser fails
 * validation before anything is charged. The one-time promo code is a
 * Snipcart discount, not an item price, and is audited at order.completed.
 *
 * Only a sellable photo of a gallery that is on sale validates, and only
 * with the sale signature the gallery handed its authenticated viewer (see
 * modules/photoSales/sellable.js).
 */

const express = require('express');
const { db } = require('../../database/db');
const { errorResponse } = require('../../utils/routeHelpers');
const {
  ON_SALE_COLUMNS, isGalleryOnSale, sellablePhotos, verifyPhotoSale,
} = require('../../modules/photoSales/sellable');

const { quoteOf, OPEN } = require('../../modules/photoSales/checkoutReservation');
const router = express.Router();

router.get('/:slug/price-check', async (req, res) => {
  try {
    const event = await db('events')
      .where({ slug: req.params.slug })
      .first(...ON_SALE_COLUMNS, 'photo_price');
    if (!event || !isGalleryOnSale(event)) {
      return res.status(403).json({ error: 'Gallery is not on sale' });
    }

    const photoId = Number(req.query?.photoId || req.query?.photo_id || 0);
    if (!Number.isInteger(photoId) || photoId <= 0) {
      return res.status(404).json({ error: 'Missing photoId' });
    }
    if (!verifyPhotoSale(photoId, req.query?.sig)) {
      return res.status(403).json({ error: 'Invalid sale signature' });
    }
    const photo = await sellablePhotos(db, event.id)
      .where('photos.id', photoId)
      .first('photos.id', 'photos.photo_price');
    if (!photo) {
      return res.status(404).json({ error: 'Photo not found in gallery' });
    }

    // Unsubmitted carts from before shared checkout must restart in PicPeak.
    // Otherwise omitting `checkout` bypasses promo email verification. Already
    // submitted provider payments still settle through the legacy webhook path.
    if (req.query.checkout === undefined) {
      return res.status(409).json({ code: 'CHECKOUT_REQUIRED', error: 'This older cart must be restarted in PicPeak. Close Snipcart and return to the gallery to start again.' });
    }
    const token = String(req.query.checkout);
    const reserved = /^[0-9a-f]{48}$/.test(token) ? await db('photo_purchase_orders')
      .where({ payment_provider: 'snipcart', checkout_token: token, gallery_id: event.id }).first() : null;
    const quote = reserved ? quoteOf(reserved) : null;
    const line = quote?.lines.find((candidate) => candidate.photoId === photoId);
    if (!reserved || !OPEN.includes(reserved.status) || !line || Date.now() >= quote.sessionExpiresAt * 1000) {
      return res.status(409).json({ error: 'Checkout has ended. Return to the gallery to start again.' });
    }
    return res.json({
      id: `${event.slug}-photo-${photo.id}`,
      price: line.originalAmountCents / 100,
      customFields: [],
      url: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to validate gallery item');
  }
});

module.exports = router;
