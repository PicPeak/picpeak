/**
 * Photo sales — Snipcart order validation for priced galleries.
 *
 * Snipcart's SERVER crawls this URL once per cart line before payment
 * (no gallery session cookie — public by design) and compares the answer
 * with the item in the cart.
 *
 * The price of a line is cart-dependent (the first N lines of the order are
 * free), which the per-item crawl cannot know. The cart itself is kept
 * correctly priced client-side (cartAllocation in the photo-sales feature)
 * and re-verified against the database at order.completed — so this crawl
 * confirms the photo belongs to a priced gallery and accepts the line
 * as-is.
 */

const express = require('express');
const { db } = require('../../database/db');
const { livePhotos } = require('../../utils/photoVisibility');
const { errorResponse } = require('../../utils/routeHelpers');
const { isGalleryPriced } = require('../../modules/photoSales/priceRules');

const router = express.Router();

router.get('/:slug/price-check', async (req, res) => {
  try {
    const event = await db('events')
      .where({ slug: req.params.slug })
      .first('id', 'slug', 'is_priced');
    if (!event || !isGalleryPriced(event)) {
      return res.status(403).json({ error: 'Gallery is not priced' });
    }

    const photoId = Number(req.query?.photoId || req.query?.photo_id || 0);
    if (!Number.isFinite(photoId) || photoId <= 0) {
      return res.status(404).json({ error: 'Missing photoId' });
    }
    const photo = await livePhotos(db)
      .where({ id: photoId, event_id: event.id })
      .first('id');
    if (!photo) {
      return res.status(404).json({ error: 'Photo not found in gallery' });
    }

    // Snipcart JSON-crawler contract: `valid: true` skips the price/custom-
    // field comparison for this line. Pricing is enforced per order at
    // order.completed (DB-backed audit, refund on mismatch).
    return res.json({ valid: true });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to validate gallery item');
  }
});

module.exports = router;
