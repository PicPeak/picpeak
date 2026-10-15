const express = require('express');
const { db } = require('../../database/db');
const router = express.Router();
const { verifyGalleryAccess } = require('../../middleware/gallery');
const { noStoreCache } = require('../../middleware/noStoreCache');
const { blockHiddenGallery } = require('../../utils/revealMode');
const { applyPhotoVisibilityFilter, livePhotos, wherePhotoProcessed } = require('../../utils/photoVisibility');

// Guest-facing. The count is scoped to the photos this viewer may see, so a
// guest cannot infer the number of client-hidden photos; like the gallery
// list, it leaves out photos the worker has not finished. The event-wide view,
// download and unique-visitor totals this route used to return are audience
// analytics (admin dashboard, analytics.view); no gallery surface renders
// them, so they are no longer sent to a gallery viewer.
router.get('/:slug/stats', verifyGalleryAccess, blockHiddenGallery, noStoreCache, async (req, res) => {
  try {
    const totalPhotos = await applyPhotoVisibilityFilter(
      wherePhotoProcessed(livePhotos(db).where('photos.event_id', req.event.id)),
      req.accessLevel
    )
      .count('photos.id as count')
      .first();

    res.json({
      total_photos: totalPhotos.count
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// User photo upload endpoint

module.exports = router;
