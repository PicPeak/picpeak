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

// Same shape, separate state: the two jobs walk the same photos but read
// different things out of them, and one running must not block or report for
// the other.
let captureDateProgress = {
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

/**
 * Backfill captured_at from EXIF (#1172).
 *
 * External imports never read EXIF before this release, so every
 * externally-imported photo carries captured_at NULL — and the gallery's
 * "Date Taken" sort falls back to uploaded_at, which on a bulk import is the
 * import timestamp. A 5555-photo trip came back ordered by which folder was
 * imported first.
 *
 * Deliberately an endpoint rather than a migration: the originals live on a
 * mount that may be unavailable at upgrade time, reading 8000+ of them blocks
 * the boot, and a run that found nothing needs to be repeatable once the mount
 * is back. Same reasoning, and the same shape, as the dimension repair above —
 * including resolvePhotoFilePath, which is what makes it work for external
 * rows at all (the thumbnail regenerator resolves under
 * storage/events/active/<path>, which never exists for them).
 */
router.post('/repair-capture-dates', adminAuth, requirePermission('photos.edit'), async (req, res) => {
  try {
    if (captureDateProgress.isRunning) {
      return res.status(409).json({ error: 'Capture date backfill is already running' });
    }

    const photos = await db('photos')
      .join('events', 'photos.event_id', 'events.id')
      .whereNull('photos.captured_at')
      .where(function () {
        this.where('photos.media_type', '!=', 'video').orWhereNull('photos.media_type');
      })
      .select(
        'photos.id', 'photos.path', 'photos.filename',
        'photos.source_origin', 'photos.external_relpath', 'photos.event_id',
        'events.source_mode', 'events.external_path', 'events.slug'
      );

    if (photos.length === 0) {
      return res.json({ message: 'No photos need a capture date', count: 0 });
    }

    res.json({
      message: `Started backfilling capture dates for ${photos.length} photos`,
      count: photos.length
    });

    captureDateProgress.isRunning = true;
    captureDateProgress.lastResult = null;

    setImmediate(async () => {
      const { extractCaptureDate } = require('../services/imageProcessor');
      let successCount = 0;
      let missingCount = 0;
      let errorCount = 0;

      for (const photo of photos) {
        try {
          const event = { source_mode: photo.source_mode, external_path: photo.external_path, slug: photo.slug };
          let fullPath;
          try {
            fullPath = resolvePhotoFilePath(event, photo);
          } catch (err) {
            logger.warn(`Photo ${photo.id} has no resolvable path, skipping capture date: ${err.message}`);
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

          const captured = await extractCaptureDate(fullPath);
          if (!captured) {
            // A photo with no EXIF date is not a failure — plenty of sources
            // carry none. Counted separately so the operator can tell "the
            // mount is broken" from "these files simply have no date".
            missingCount++;
            continue;
          }

          // whereNull, not a blanket set: the job can run for a long time on a
          // large library, and an import or a replacement finishing meanwhile
          // has already written a date this pass would otherwise overwrite
          // with the same-or-worse value.
          const updated = await db('photos')
            .where({ id: photo.id })
            .whereNull('captured_at')
            .update({ captured_at: captured.toISOString() });
          if (updated) successCount++;

          if (successCount % 50 === 0 && successCount > 0) {
            logger.info(`Capture date backfill progress: ${successCount} updated...`);
          }
        } catch (error) {
          logger.error(`Error backfilling capture date for photo ${photo.id}:`, error);
          errorCount++;
        }
      }

      captureDateProgress.isRunning = false;
      captureDateProgress.lastResult = { success: successCount, noExif: missingCount, failed: errorCount };
      logger.info(`Capture date backfill complete: ${successCount} updated, ${missingCount} without EXIF, ${errorCount} errors`);
    });
  } catch (error) {
    logger.error('Error starting capture date backfill:', error);
    res.status(500).json({ error: 'Failed to start capture date backfill' });
  }
});

router.get('/repair-capture-dates/status', adminAuth, requirePermission('photos.view'), async (req, res) => {
  try {
    const notVideo = (q) => q.where(function () {
      this.where('media_type', '!=', 'video').orWhereNull('media_type');
    });

    const totalPhotos = await notVideo(db('photos')).count('id as count').first();
    const withDates = await notVideo(db('photos')).whereNotNull('captured_at').count('id as count').first();

    const total = Number(totalPhotos.count);
    const withCaptureDate = Number(withDates.count);

    res.json({
      total,
      withCaptureDate,
      withoutCaptureDate: total - withCaptureDate,
      isRunning: captureDateProgress.isRunning,
      lastResult: captureDateProgress.lastResult
    });
  } catch (error) {
    logger.error('Error fetching capture date backfill status:', error);
    res.status(500).json({ error: 'Failed to fetch capture date backfill status' });
  }
});

module.exports = router;
