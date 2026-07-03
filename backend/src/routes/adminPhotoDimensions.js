const express = require('express');
const router = express.Router();
const { db } = require('../database/db');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const fs = require('fs').promises;
const logger = require('../utils/logger');

const { resolvePhotoFilePath } = require('../services/photoResolver');

// Module-level progress state
let repairProgress = {
  isRunning: false,
  lastResult: null
};

// Repair photo dimensions (background job)
router.post('/repair-dimensions', adminAuth, requirePermission('photos.edit'), async (req, res) => {
  try {
    if (repairProgress.isRunning) {
      return res.status(409).json({ error: 'Repair is already running' });
    }

    const photos = await db('photos')
      .join('events', 'photos.event_id', 'events.id')
      .where(function () {
        this.whereNull('photos.width').orWhereNull('photos.height');
      })
      .where(function () {
        this.where('photos.media_type', '!=', 'video').orWhereNull('photos.media_type');
      })
      .select(
        'photos.id', 'photos.path', 'photos.filename',
        'photos.source_origin', 'photos.external_relpath', 'photos.event_id',
        'events.source_mode', 'events.external_path', 'events.slug'
      );

    if (photos.length === 0) {
      return res.json({ message: 'No photos need dimension repair', count: 0 });
    }

    // Return immediately
    res.json({
      message: `Started repairing dimensions for ${photos.length} photos`,
      count: photos.length
    });

    // Process in background
    repairProgress.isRunning = true;
    repairProgress.lastResult = null;

    setImmediate(async () => {
      let sharp;
      try {
        sharp = require('sharp');
      } catch (err) {
        logger.error('Sharp not available for dimension repair:', err.message);
        repairProgress.isRunning = false;
        repairProgress.lastResult = { success: 0, failed: 0, error: 'Sharp not available' };
        return;
      }

      let successCount = 0;
      let errorCount = 0;

      for (const photo of photos) {
        try {
          const event = { source_mode: photo.source_mode, external_path: photo.external_path, slug: photo.slug };
          let fullPath;
          try {
            fullPath = resolvePhotoFilePath(event, photo);
          } catch (err) {
            logger.warn(`Photo ${photo.id} has no resolvable path, skipping dimension repair: ${err.message}`);
            errorCount++;
            continue;
          }

          try {
            await fs.access(fullPath);
          } catch (err) {
            logger.warn(`File not found for photo ${photo.id}: ${fullPath}`);
            errorCount++;
            continue;
          }

          const metadata = await sharp(fullPath).metadata();

          if (metadata.width && metadata.height) {
            await db('photos')
              .where({ id: photo.id })
              .update({
                width: metadata.width,
                height: metadata.height
              });
            successCount++;

            if (successCount % 50 === 0) {
              logger.info(`Dimension repair progress: ${successCount} updated...`);
            }
          } else {
            logger.warn(`Could not extract dimensions for photo ${photo.id}`);
            errorCount++;
          }
        } catch (error) {
          logger.error(`Error repairing dimensions for photo ${photo.id}:`, error);
          errorCount++;
        }
      }

      repairProgress.isRunning = false;
      repairProgress.lastResult = { success: successCount, failed: errorCount };
      logger.info(`Dimension repair complete: ${successCount} success, ${errorCount} errors`);
    });
  } catch (error) {
    logger.error('Error starting dimension repair:', error);
    res.status(500).json({ error: 'Failed to start dimension repair' });
  }
});

// Get dimension repair status
router.get('/repair-dimensions/status', adminAuth, requirePermission('photos.view'), async (req, res) => {
  try {
    const totalPhotos = await db('photos')
      .where(function () {
        this.where('media_type', '!=', 'video').orWhereNull('media_type');
      })
      .count('id as count')
      .first();

    const withDimensions = await db('photos')
      .where(function () {
        this.where('media_type', '!=', 'video').orWhereNull('media_type');
      })
      .whereNotNull('width')
      .whereNotNull('height')
      .count('id as count')
      .first();

    const total = Number(totalPhotos.count);
    const withDims = Number(withDimensions.count);

    res.json({
      total,
      withDimensions: withDims,
      withoutDimensions: total - withDims,
      isRunning: repairProgress.isRunning,
      lastResult: repairProgress.lastResult
    });
  } catch (error) {
    logger.error('Error fetching dimension repair status:', error);
    res.status(500).json({ error: 'Failed to fetch dimension repair status' });
  }
});

module.exports = router;
