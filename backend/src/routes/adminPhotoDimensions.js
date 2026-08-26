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
// system.manage, not photos.edit: this walks every event in the install and
// rewrites their metadata. photos.edit is held by the team_photographer preset
// (175_granular_permissions_and_presets.js:106), which exists precisely for a
// contributing shooter who should not be able to start a whole-library S3/NAS
// scan or touch another owner's photos. The dimension repair above had the same
// exposure and predates this; it is brought in line separately in #1182.
router.post('/repair-capture-dates', adminAuth, requirePermission('system.manage'), async (req, res) => {
  try {
    if (captureDateProgress.isRunning) {
      return res.status(409).json({ error: 'Capture date backfill is already running' });
    }
    // Claimed here, not after the candidate query: that query is an await, and
    // two POSTs arriving inside it would both read isRunning === false and both
    // start a pass over the same rows. Every early exit below has to release it
    // again, hence the try/catch around the query.
    captureDateProgress.isRunning = true;
    captureDateProgress.lastResult = null;

    let photos;
    try {
      photos = await db('photos')
        .join('events', 'photos.event_id', 'events.id')
        .whereNull('photos.captured_at')
        // Three markers, because no single one is reliable. fileWatcher's
        // auto-import sets type='video' and a video/* mime but never
        // media_type (fileWatcher.js:128-130), so those rows keep the 'image'
        // default from migration 048 and a media_type-only filter queues them
        // forever: extractCaptureDate returns null for a video, captured_at
        // stays null, and every run picks it up again.
        .where(function () {
          this.where('photos.media_type', '!=', 'video').orWhereNull('photos.media_type');
        })
        .where(function () {
          this.where('photos.type', '!=', 'video').orWhereNull('photos.type');
        })
        .where(function () {
          this.whereNull('photos.mime_type').orWhere('photos.mime_type', 'not like', 'video/%');
        })
        // Archiving deletes the originals from storage but keeps the photos
        // rows (archiveService.js:166,199). Those files are inside the zip and
        // nothing here can read them, so including them would fail every row
        // on every run and leave the button permanently lit.
        .where(function () {
          this.where('events.is_archived', false).orWhereNull('events.is_archived');
        })
        .select(
          'photos.id', 'photos.path', 'photos.filename',
          'photos.source_origin', 'photos.external_relpath', 'photos.event_id',
          'events.source_mode', 'events.external_path', 'events.slug'
        );
    } catch (err) {
      captureDateProgress.isRunning = false;
      throw err;
    }

    if (photos.length === 0) {
      captureDateProgress.isRunning = false;
      return res.json({ message: 'No photos need a capture date', count: 0 });
    }

    res.json({
      message: `Started backfilling capture dates for ${photos.length} photos`,
      count: photos.length
    });

    setImmediate(async () => {
      const { extractCaptureDate, withLocalCopy } = require('../services/imageProcessor');
      const { resolvePhotoStorageKey } = require('../services/photoResolver');
      let successCount = 0;
      let missingCount = 0;
      let errorCount = 0;

      for (const photo of photos) {
        try {
          const event = { source_mode: photo.source_mode, external_path: photo.external_path, slug: photo.slug };
          const isExternal = photo.source_origin === 'external' || photo.source_origin === 'reference';

          // Two source shapes, same split the thumbnail regenerator uses
          // (imageProcessor.js:391-420). External rows live on a local mount
          // and are read directly; managed rows live behind the storage
          // backend, which on an S3 install is not a filesystem at all — going
          // through resolvePhotoFilePath there would build a STORAGE_PATH that
          // holds nothing and fail every managed photo.
          let captured;
          if (isExternal) {
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

            captured = await extractCaptureDate(fullPath);
          } else {
            let sourceKey;
            try {
              sourceKey = resolvePhotoStorageKey(event, photo);
            } catch (err) {
              logger.warn(`Photo ${photo.id} has no resolvable storage key, skipping capture date: ${err.message}`);
              errorCount++;
              continue;
            }

            // In local-fs mode withLocalCopy hands back the resolved path
            // without checking it exists, so the access probe stays. In S3
            // mode a missing object throws out of getToFile and lands in the
            // outer catch — both end up counted as failures, which is what a
            // missing original is.
            captured = await withLocalCopy(sourceKey, async (localPath) => {
              await fs.access(localPath);
              return extractCaptureDate(localPath);
            });
          }

          if (!captured) {
            // No date recovered. Usually genuine — plenty of sources carry no
            // EXIF — but extractCaptureDate also returns null when the file is
            // unreadable as an image, so this bucket is "nothing to write",
            // not "definitely has no EXIF". The failure counter above is the
            // one that means the storage is broken.
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

// The same permission as the POST, not the read-only system.view. system.view
// and system.manage are independent grants, and StatusTab has no permission
// gate of its own — a successful status payload is what renders the card and
// its enabled button (StatusTab.tsx:637). Gating this on system.view therefore
// handed a system.view-only role a live button whose every click 403s with no
// error surfaced. Requiring system.manage makes the card appear only for
// someone who can actually run it, which is what this comment always claimed.
router.get('/repair-capture-dates/status', adminAuth, requirePermission('system.manage'), async (req, res) => {
  try {
    // Same scope as the job itself — counting archived photos here would show
    // a permanent backlog the button can never clear.
    const scoped = () => db('photos')
      .join('events', 'photos.event_id', 'events.id')
      .where(function () {
        this.where('photos.media_type', '!=', 'video').orWhereNull('photos.media_type');
      })
      .where(function () {
        this.where('photos.type', '!=', 'video').orWhereNull('photos.type');
      })
      .where(function () {
        this.whereNull('photos.mime_type').orWhere('photos.mime_type', 'not like', 'video/%');
      })
      .where(function () {
        this.where('events.is_archived', false).orWhereNull('events.is_archived');
      });

    // One query, two aggregates. As two separate counts an import committing a
    // dated photo between them could be counted by the second and not the
    // first, so withCaptureDate came out larger than total and the card showed
    // a negative backlog — with the button enabled to "fix" it.
    const counts = await scoped()
      .count('photos.id as total')
      .count({ dated: db.raw('CASE WHEN photos.captured_at IS NOT NULL THEN 1 END') })
      .first();

    const total = Number(counts.total);
    const withCaptureDate = Number(counts.dated);

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
