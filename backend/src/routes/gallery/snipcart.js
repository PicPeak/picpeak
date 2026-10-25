/**
 * Photo sales — Snipcart order validation for priced galleries.
 *
 * Snipcart's SERVER crawls this URL once per cart line before payment
 * (no gallery session cookie — public by design) and compares the answer
 * with the item in the cart. The answer is Snipcart's JSON-crawler item
 * ({ id, price, customFields, url }): the price is the photo's effective
 * price from the database, so a cart line re-priced in the browser fails
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
const { effectivePhotoPrice } = require('../../modules/photoSales/priceRules');
const {
  ON_SALE_COLUMNS, isGalleryOnSale, sellablePhotos, verifyPhotoSale,
} = require('../../modules/photoSales/sellable');

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

    return res.json({
      id: `${event.slug}-photo-${photo.id}`,
      price: effectivePhotoPrice(event, photo),
      customFields: [],
      url: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to validate gallery item');
  }
});

module.exports = router;
