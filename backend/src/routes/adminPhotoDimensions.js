const express = require('express');
const router = express.Router();
const { db } = require('../database/db');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const fs = require('fs').promises;
const logger = require('../utils/logger');

const { resolvePhotoFilePath } = require('../services/photoResolver');
const maintenanceJobs = require('../services/maintenanceJobState');

// Run state for both sweeps lives in the database, not in this process
// (#1181). It used to be a module-level object per job, which is correct on a
// single replica and wrong behind a load balancer: the status poll answers
// from whichever process it reaches, so an idle replica reports isRunning
// false while another is mid-run, the UI re-enables the button, and the next
// POST starts a duplicate pass over the entire library.
//
// Two separate rows, for the same reason the two objects were separate: the
// jobs walk the same photos but read different things out of them, and one
// running must not block or report for the other.
const { JOB_DIMENSION_REPAIR, JOB_CAPTURE_DATE_BACKFILL } = maintenanceJobs;

const { HEARTBEAT_INTERVAL_MS } = maintenanceJobs;

/**
 * Renew the lease on a timer for as long as the run holds it.
 *
 * On a timer, not between photos: a single hung read on a stalled NAS mount or
 * a slow S3 object can outlast the whole stale window inside one iteration, and
 * a renewal that only fires between photos never gets to run. The lease would
 * expire while the job was demonstrably alive, another replica would take it
 * over, and the two would walk the same rows — precisely the case the lease
 * exists to prevent. The timer also covers the candidate query, which on a
 * large library is itself slow.
 *
 * `lost()` reports whether the claim has since been taken over. The loops check
 * it between photos and stop: mid-photo interruption is not possible, so the
 * worst case is one extra row written by the old runner, and its release is
 * fenced on the token anyway.
 */
function startLeaseKeeper(jobName, token) {
  let lost = false;
  const timer = setInterval(async () => {
    try {
      if (!(await maintenanceJobs.heartbeat(jobName, token))) {
        lost = true;
        clearInterval(timer);
      }
    } catch (err) {
      // heartbeat() already swallows query errors and reports the claim as
      // held; this is belt-and-braces so an unexpected throw cannot kill the
      // timer callback and silently stop all renewals.
      logger.warn(`Lease renewal error for ${jobName}: ${err.message}`);
    }
  }, HEARTBEAT_INTERVAL_MS);
  // Do not hold the event loop open on account of a maintenance sweep.
  if (typeof timer.unref === 'function') timer.unref();

  return {
    lost: () => lost,
    stop: () => clearInterval(timer),
  };
}

// Repair photo dimensions (background job)
//
// system.manage, not photos.edit: the query below is unscoped, so this walks
// every event in the install, reads every original off S3 or the NAS mount, and
// rewrites their metadata. photos.edit is held by the team_photographer preset
// (175_granular_permissions_and_presets.js:106), which exists for a contributing
// second shooter — someone who should be able to edit the photos they work on,
// not start a whole-library scan or touch another owner's events.
router.post('/repair-dimensions', adminAuth, requirePermission('system.manage'), async (req, res) => {
  try {
    // Normally this job only fills rows that have no dimensions at all.
    // `recompute` widens it to every image row (#1185): a library that
    // predates the orientation fix has BOTH dimensions stored, just in the
    // raw order, so the NULL filter never reaches them — and once their
    // thumbnails regenerate rotated, the grid sizes a portrait photo with a
    // landscape ratio. Opt-in because it re-reads every original.
    const recompute = req.body?.recompute === true || req.query?.recompute === 'true';
    // Claimed before the candidate query, not after: that query is an await,
    // and two requests arriving inside it would both read "not running" and
    // both start a pass. The claim is a conditional UPDATE, so it settles the
    // race across replicas as well as within one.
    const token = await maintenanceJobs.claim(JOB_DIMENSION_REPAIR);
    if (!token) {
      return res.status(409).json({ error: 'Repair is already running' });
    }
    // Started at the claim, not at the loop: on a large or loaded install the
    // candidate SELECT below (plus the setImmediate hop) can itself outlast the
    // stale window, and an unrenewed claim would be taken over before the sweep
    // had read its first photo. Handed to the background section, which stops
    // it; every early exit here stops it too.
    const lease = startLeaseKeeper(JOB_DIMENSION_REPAIR, token);

    let photos;
    try {
      photos = await db('photos')
        .join('events', 'photos.event_id', 'events.id')
        .modify((q) => {
          if (!recompute) q.where(function () {
            this.whereNull('photos.width').orWhereNull('photos.height');
          });
        })
        .where(function () {
          this.where('photos.media_type', '!=', 'video').orWhereNull('photos.media_type');
        })
        .select(
          'photos.id', 'photos.path', 'photos.filename',
          'photos.source_origin', 'photos.external_relpath', 'photos.event_id',
          // Needed to tell a row that actually changed from one merely re-read:
          // only a real change invalidates that photo's face data.
          'photos.width', 'photos.height',
          'events.source_mode', 'events.external_path', 'events.slug'
        );
    } catch (err) {
      lease.stop();
      await maintenanceJobs.release(JOB_DIMENSION_REPAIR, token);
      throw err;
    }

    if (photos.length === 0) {
      // Released with no result: nothing ran, so the numbers from the last
      // real run stay on screen rather than being blanked by a no-op.
      lease.stop();
      await maintenanceJobs.release(JOB_DIMENSION_REPAIR, token);
      return res.json({ message: 'No photos need dimension repair', count: 0 });
    }

    // Return immediately
    res.json({
      message: `Started repairing dimensions for ${photos.length} photos`,
      count: photos.length
    });

    // Process in background
    setImmediate(async () => {
      let sharp;
      try {
        sharp = require('sharp');
      } catch (err) {
        logger.error('Sharp not available for dimension repair:', err.message);
        lease.stop();
        await maintenanceJobs.release(JOB_DIMENSION_REPAIR, token, { success: 0, failed: 0, error: 'Sharp not available' });
        return;
      }

      let successCount = 0;
      let errorCount = 0;
      let requeuedFaces = 0;
      let lostClaim = false;

      // Everything below runs detached from the request, so an unexpected
      // throw has nobody to report to. Without this the claim would sit held
      // until it aged out of the staleness window, disabling the button for
      // that whole time on every replica.
      try {
        for (const photo of photos) {
          // The timer does the renewing; this only notices that it has
          // already failed, so the loop stops instead of running on beside the
          // replica that took the claim over.
          if (lease.lost()) { lostClaim = true; break; }

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
            // Oriented, not raw — see orientedDimensions (#1185).
            const dims = require('../services/imageProcessor').orientedDimensions(metadata);

            if (dims.width && dims.height) {
              // Only the rows that actually change matter for the face
              // requeue below, so notice before writing.
              const changed = photo.width !== dims.width || photo.height !== dims.height;

              await db('photos')
                .where({ id: photo.id })
                .update({
                  width: dims.width,
                  height: dims.height
                });
              successCount++;

              // A changed orientation invalidates any face data this photo
              // already has (#1185). Detection runs against the preview and
              // stores boxes in ORIGINAL pixel space, scaled by
              // `photo.width / previewMeta.width` (faceProcessor.js:220-224) —
              // so boxes recorded before the fix are in the raw coordinate
              // system while the preview now regenerates rotated, and the
              // overlays crop the wrong region.
              //
              // Queued rather than deleted: the row keeps its identity and the
              // face queue re-detects it. whereNotNull so installs that never
              // enabled the feature are left alone, and so a photo already
              // waiting in the queue is not disturbed.
              if (changed) {
                requeuedFaces += await db('photos')
                  .where({ id: photo.id })
                  .whereNotNull('face_status')
                  .whereNot('face_status', 'pending')
                  .update({ face_status: 'pending' });
              }

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

        if (lostClaim) {
          // Another replica declared this run stale and took it over. It owns
          // the row now, so releasing would clear ITS flag — release() refuses
          // on the token, but there is nothing to report either way.
          logger.warn(`Dimension repair stopped: claim taken over after ${successCount} updated, ${errorCount} errors`);
          return;
        }
        await maintenanceJobs.release(JOB_DIMENSION_REPAIR, token, {
          success: successCount, failed: errorCount, requeuedFaces,
        });
        logger.info(
          `Dimension repair complete: ${successCount} success, ${errorCount} errors`
          + (requeuedFaces ? `, ${requeuedFaces} photo(s) requeued for face scanning` : '')
        );
      } catch (err) {
        logger.error('Dimension repair aborted:', err);
        await maintenanceJobs
          .release(JOB_DIMENSION_REPAIR, token, { success: successCount, failed: errorCount, error: err.message })
          .catch(() => {});
      } finally {
        lease.stop();
      }
    });
  } catch (error) {
    logger.error('Error starting dimension repair:', error);
    res.status(500).json({ error: 'Failed to start dimension repair' });
  }
});

// Get dimension repair status
//
// The same permission as the POST, not the read-only system.view. The two are
// independent grants, and StatusTab has no permission gate of its own — a
// successful status payload is what renders the card and its enabled button
// (StatusTab.tsx:558). system.view alone would therefore show a live Repair
// button whose every click 403s with no error surfaced.
router.get('/repair-dimensions/status', adminAuth, requirePermission('system.manage'), async (req, res) => {
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
    // Read from the shared row, so this answers the same on every replica.
    const state = await maintenanceJobs.read(JOB_DIMENSION_REPAIR);

    res.json({
      total,
      withDimensions: withDims,
      withoutDimensions: total - withDims,
      isRunning: state.isRunning,
      lastResult: state.lastResult
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
    // Claimed here, not after the candidate query: that query is an await, and
    // two POSTs arriving inside it would both read "not running" and both start
    // a pass over the same rows. Being a conditional UPDATE, the claim settles
    // that between replicas too. Every early exit below has to release it
    // again, hence the try/catch around the query.
    const token = await maintenanceJobs.claim(JOB_CAPTURE_DATE_BACKFILL);
    if (!token) {
      return res.status(409).json({ error: 'Capture date backfill is already running' });
    }
    // Started at the claim so the candidate SELECT below is covered too — see
    // the dimension repair above.
    const lease = startLeaseKeeper(JOB_CAPTURE_DATE_BACKFILL, token);

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
      lease.stop();
      await maintenanceJobs.release(JOB_CAPTURE_DATE_BACKFILL, token);
      throw err;
    }

    if (photos.length === 0) {
      // No result passed: nothing ran, so the last real run's numbers survive.
      lease.stop();
      await maintenanceJobs.release(JOB_CAPTURE_DATE_BACKFILL, token);
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
      let lostClaim = false;

      // Same reasoning as the dimension repair: detached from the request, so
      // an unexpected throw must not leave the claim held.
      try {
        for (const photo of photos) {
          // The timer renews; this only notices it has already failed.
          if (lease.lost()) { lostClaim = true; break; }

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

        if (lostClaim) {
          logger.warn(`Capture date backfill stopped: claim taken over after ${successCount} updated, ${errorCount} errors`);
          return;
        }
        await maintenanceJobs.release(JOB_CAPTURE_DATE_BACKFILL, token, { success: successCount, noExif: missingCount, failed: errorCount });
        logger.info(`Capture date backfill complete: ${successCount} updated, ${missingCount} without EXIF, ${errorCount} errors`);
      } catch (err) {
        logger.error('Capture date backfill aborted:', err);
        await maintenanceJobs
          .release(JOB_CAPTURE_DATE_BACKFILL, token, { success: successCount, noExif: missingCount, failed: errorCount, error: err.message })
          .catch(() => {});
      } finally {
        lease.stop();
      }
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
    // Read from the shared row, so this answers the same on every replica.
    const state = await maintenanceJobs.read(JOB_CAPTURE_DATE_BACKFILL);

    res.json({
      total,
      withCaptureDate,
      withoutCaptureDate: total - withCaptureDate,
      isRunning: state.isRunning,
      lastResult: state.lastResult
    });
  } catch (error) {
    logger.error('Error fetching capture date backfill status:', error);
    res.status(500).json({ error: 'Failed to fetch capture date backfill status' });
  }
});

module.exports = router;
