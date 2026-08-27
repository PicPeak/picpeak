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
const { JOB_DIMENSION_REPAIR, JOB_CAPTURE_DATE_BACKFILL, JOB_ORIENTATION_BACKFILL } = maintenanceJobs;

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
              await db('photos')
                .where({ id: photo.id })
                .update({
                  width: dims.width,
                  height: dims.height
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

        if (lostClaim) {
          // Another replica declared this run stale and took it over. It owns
          // the row now, so releasing would clear ITS flag — release() refuses
          // on the token, but there is nothing to report either way.
          logger.warn(`Dimension repair stopped: claim taken over after ${successCount} updated, ${errorCount} errors`);
          return;
        }
        await maintenanceJobs.release(JOB_DIMENSION_REPAIR, token, { success: successCount, failed: errorCount });
        logger.info(`Dimension repair complete: ${successCount} success, ${errorCount} errors`);
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
      let skippedCount = 0;
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
            //
            // Fenced on path and filename as well as the id, for the same reason
            // the orientation backfill below is (#1199): replacePhoto — reachable
            // from the replace_by_name upload path (adminPhotos.js) — swaps a NEW
            // file under an existing row and rewrites path/filename. That
            // replacement carries no date of its own, so captured_at is still
            // NULL and whereNull alone would let the previous file's EXIF date
            // land on it. Matching the identity that was actually read means the
            // update affects no rows and the row is simply skipped.
            const updated = await db('photos')
              .where({ id: photo.id, path: photo.path, filename: photo.filename })
              .whereNull('captured_at')
              .update({ captured_at: captured.toISOString() });
            // Counted, not dropped: without this a candidate that was read but
            // not written falls out of the run's arithmetic entirely, and
            // success + noExif + failed silently stops adding up to the count
            // the operator was shown when they started it. Two ways to land
            // here, both "another writer got there first" — the row was dated
            // meanwhile (whereNull), or its file changed under us (the fence).
            // Neither is an error and neither needs a retry: captured_at is
            // still NULL for the fenced case, so the status endpoint keeps
            // reporting it as backlog and the next run picks it up.
            if (updated) successCount++; else skippedCount++;

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
        await maintenanceJobs.release(JOB_CAPTURE_DATE_BACKFILL, token, { success: successCount, noExif: missingCount, failed: errorCount, skipped: skippedCount });
        logger.info(
          `Capture date backfill complete: ${successCount} updated, ${missingCount} without EXIF, `
          + `${errorCount} errors, ${skippedCount} skipped (dated or replaced mid-run)`
        );
      } catch (err) {
        logger.error('Capture date backfill aborted:', err);
        await maintenanceJobs
          .release(JOB_CAPTURE_DATE_BACKFILL, token, { success: successCount, noExif: missingCount, failed: errorCount, skipped: skippedCount, error: err.message })
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

/**
 * Backfill orientation for a library that predates #1185 (#1198).
 *
 * The orientation fix corrected the generators and every ingest path, but did
 * nothing for photos already in the database. Those rows are worse off than
 * untouched ones in one specific way: before the fix a rotated photo was
 * CONSISTENTLY wrong — a sideways image in a tile shaped to match. Afterwards
 * the regenerated thumbnail is correct while photos.width/height still
 * describe the raw sensor order, so masonry and justified size a portrait
 * photo with a landscape ratio.
 *
 * The dimension repair above cannot reach them: it only selects rows with a
 * NULL dimension, and an affected row has both — just transposed.
 *
 * Its own job rather than a mode of that one, because it does strictly more:
 * where the EXIF transform means the pixels have moved, the derived images and
 * face data generated against the old orientation are no longer valid and have
 * to be invalidated with the write.
 */
router.post('/repair-orientation', adminAuth, requirePermission('system.manage'), async (req, res) => {
  try {
    // The trigger is the EXIF tag on the original, and correcting a photo does
    // not untag it — so without a marker every re-run would throw away the
    // renditions it just regenerated and requeue every completed face scan.
    // `force` is the escape hatch for an interrupted run, or for a future fix
    // that needs to revisit rows this one already cleared.
    const force = req.body?.force === true || req.query?.force === 'true';

    const token = await maintenanceJobs.claim(JOB_ORIENTATION_BACKFILL);
    if (!token) {
      return res.status(409).json({ error: 'Orientation backfill is already running' });
    }
    const lease = startLeaseKeeper(JOB_ORIENTATION_BACKFILL, token);

    let photos;
    try {
      photos = await db('photos')
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
        // Archiving deletes the originals and keeps the rows, so every archived
        // photo would fail its read and add nothing but noise to a run that
        // already walks the whole library.
        .where(function () {
          this.where('events.is_archived', false).orWhereNull('events.is_archived');
        })
        .modify((q) => {
          if (!force) q.whereNull('photos.orientation_checked_at');
        })
        .select(
          'photos.id', 'photos.path', 'photos.filename',
          'photos.source_origin', 'photos.external_relpath', 'photos.event_id',
          'photos.width', 'photos.height', 'photos.face_status',
          // Every rendition the invalidation below deletes. Selecting only
          // preview_path left thumbnail_path and hero_path undefined, so their
          // database pointers were cleared while the objects stayed in storage.
          'photos.preview_path', 'photos.thumbnail_path', 'photos.hero_path',
          'photos.watermark_path',
          'events.source_mode', 'events.external_path', 'events.slug'
        );
    } catch (err) {
      lease.stop();
      await maintenanceJobs.release(JOB_ORIENTATION_BACKFILL, token);
      throw err;
    }

    if (photos.length === 0) {
      lease.stop();
      await maintenanceJobs.release(JOB_ORIENTATION_BACKFILL, token);
      return res.json({ message: 'No photos to check', count: 0 });
    }

    res.json({ message: `Checking orientation for ${photos.length} photos`, count: photos.length });

    setImmediate(async () => {
      const sharp = require('sharp');
      const {
        orientedDimensions, hasOrientationTransform, withLocalCopy, withProcessableImage,
        deletePreviewTiers, deleteThumbnailTiers, previewTierKeys, thumbnailTierKeys,
      } = require('../services/imageProcessor');
      const { getStorage } = require('../services/storage');
      const { resolvePhotoStorageKey } = require('../services/photoResolver');

      // Fenced on the identity that was measured, not just the id: replacePhoto
      // — reachable from the replace_by_name upload path (adminPhotos.js) —
      // swaps a new file under an existing row and rewrites path/filename, so a
      // replacement landing mid-run would otherwise be given the previous
      // file's dimensions and have its fresh renditions cleared.
      const fenceOf = (photo) => ({ id: photo.id, path: photo.path, filename: photo.filename });
      const nowIso = () => new Date().toISOString();

      let checked = 0;
      let corrected = 0;
      let requeuedFaces = 0;
      let staleTiers = 0;
      let errorCount = 0;
      let lostClaim = false;

      try {
        for (const photo of photos) {
          if (lease.lost()) { lostClaim = true; break; }

          try {
            const event = {
              source_mode: photo.source_mode,
              external_path: photo.external_path,
              slug: photo.slug,
            };
            const isExternal = photo.source_origin === 'external' || photo.source_origin === 'reference';

            // Read the metadata the same way every other maintenance path
            // does. The dimension repair reads with resolvePhotoFilePath and
            // plain sharp, which means it does nothing at all on an S3 install
            // and rejects RAW/DNG — this job walks the WHOLE library, so both
            // of those stop being edge cases.
            let metadata;
            if (isExternal) {
              const fullPath = resolvePhotoFilePath(event, photo);
              await fs.access(fullPath);
              const proc = await withProcessableImage(fullPath, photo.filename);
              try {
                metadata = await sharp(proc.path).metadata();
              } finally {
                await proc.cleanup();
              }
            } else {
              const sourceKey = resolvePhotoStorageKey(event, photo);
              metadata = await withLocalCopy(sourceKey, async (localPath) => {
                await fs.access(localPath);
                const proc = await withProcessableImage(localPath, photo.filename);
                try {
                  return await sharp(proc.path).metadata();
                } finally {
                  await proc.cleanup();
                }
              });
            }

            checked++;

            const dims = orientedDimensions(metadata);
            if (!dims.width || !dims.height) continue;

            const dimsWrong = photo.width !== dims.width || photo.height !== dims.height;
            // Face boxes live in ORIGINAL pixel space and are scaled by
            // photo.width at read time, so ANY change to the stored dimensions
            // invalidates them — not only one caused by rotation.
            // A 5-8 rotation changes the dimensions, so a tagged photo whose
            // stored dimensions are ALREADY oriented must have been ingested
            // after #1185 — its renditions are correct and re-clearing them
            // would delete valid files and rescan faces for nothing. 2, 3 and
            // 4 leave dimensions untouched, so they carry no such evidence and
            // are invalidated once; the marker stops it happening twice.
            // A square image is the exception within 5-8: the rotation is real
            // but the dimensions come out identical, so it carries no evidence
            // either and has to be treated like 2/3/4.
            const swapsDimensions = metadata.orientation >= 5 && metadata.orientation <= 8
              && metadata.width !== metadata.height;
            const cannotTell = hasOrientationTransform(metadata) && !swapsDimensions;
            const facesStale = dimsWrong || cannotTell;
            // NOT the same question as "did the dimensions change". Orientation

            if (!dimsWrong && !facesStale) {
              // Nothing to change, but record that it was looked at so a
              // re-run does not pay for reading it again.
              await db('photos').where(fenceOf(photo)).update({ orientation_checked_at: nowIso() });
              continue;
            }

            // Every write is fenced on the identity we measured, not just the
            // id. replacePhoto — reachable from the replace_by_name upload path
            // (adminPhotos.js) — swaps a new file under an existing row and
            // rewrites path/filename, so a replacement landing while this job
            // read the old original would otherwise get the previous file's
            // dimensions written over it and its fresh renditions cleared.
            // Matching path and filename too means the update affects no rows
            // instead.
            const fence = fenceOf(photo);

            // One transaction. If the dimension write commits and the
            // invalidation does not, the row keeps stale face boxes AND a
            // retry computes "already correct" — so nothing would ever fix it.
            let dimsWritten = 0;
            let invalidated = 0;
            let markerPending = false;
            await db.transaction(async (trx) => {
              if (dimsWrong) {
                dimsWritten = await trx('photos').where(fence)
                  .update({ width: dims.width, height: dims.height });
              }

              if (facesStale) {
                // Every cached rendition, not just the preview. All three are
                // regenerated lazily and all three short-circuit on a file
                // that is merely VALID — and a pre-fix sideways thumbnail is
                // perfectly valid. Clearing only the preview fixed the face
                // data while leaving the gallery showing the old sideways
                // image inside a newly-corrected portrait tile, which is worse
                // than not having run at all.
                //
                // The preview specifically must go before faces are requeued:
                // ensurePreviewImage would otherwise hand the rescan the old
                // unrotated pixels, whose boxes then get scaled by the
                // corrected dimensions.
                invalidated = await trx('photos').where(fence).update({
                  preview_path: null,
                  thumbnail_path: null,
                  hero_path: null,
                  // gallery.js serves watermark_path ahead of the original when
                  // branding watermarking is on, so a stale one is the single
                  // most visible rendition of all.
                  watermark_path: null,
                });

                // whereNotNull: face_status NULL means this photo was never
                // scanned, and an install that never enabled the feature must
                // not start scanning because of a dimension repair.
                requeuedFaces += await trx('photos')
                  .where(fence)
                  .whereNotNull('face_status')
                  .whereNot('face_status', 'pending')
                  .update({ face_status: 'pending' });
              }

              // Same transaction as the work it records: a marker written
              // separately could survive a rolled-back correction and hide the
              // row from every future run. Withheld below if the storage
              // cleanup then fails, so the row stays eligible for a retry.
              markerPending = true;
            });

            // Outside the transaction on purpose: these delete files, and a
            // storage error must not roll back a correct database write. A
            // rolled-back write is silent corruption; a leftover object is not.
            //
            // For the canonical renditions a failed delete is harmless — their
            // keys are deterministic, so regeneration overwrites in place. The
            // responsive TIERS are the exception: ensurePreviewImageAtWidth
            // treats storage.stat(key) as a cache hit, so a tier that survived
            // deletion keeps being served unrotated and never regenerates. The
            // tier helpers swallow their own errors, so the keys are re-checked
            // and anything still standing is counted — a run that could not
            // clear them should not report itself as clean.
            // Only when a fenced write actually landed. If the file was
            // replaced mid-run every update matched zero rows, and deleting
            // now would destroy renditions belonging to the REPLACEMENT —
            // watermarks especially, which are keyed by photo id and so alias
            // straight onto the new file.
            if (facesStale && invalidated > 0) {
              const storage = getStorage();
              for (const key of [photo.preview_path, photo.thumbnail_path, photo.hero_path, photo.watermark_path]) {
                if (key) await storage.delete(key).catch(() => {});
              }
              await deletePreviewTiers(photo).catch(() => {});
              await deleteThumbnailTiers(photo).catch(() => {});

              // stat() RESOLVES with null for a missing key rather than
              // rejecting, so testing only that the promise settled counted
              // every deleted — and every never-created — tier as a survivor,
              // and told the operator to re-run after a perfectly clean pass.
              // A rejection is a real storage error, which is also not proof
              // the object is gone, so it counts as stuck.
              const survivors = await Promise.all(
                [...previewTierKeys(photo), ...thumbnailTierKeys(photo)]
                  .map((k) => storage.stat(k).then((st) => (st ? k : null)).catch(() => k))
              );
              const stuck = survivors.filter(Boolean).length;
              if (stuck) {
                staleTiers += stuck;
                // Leave the row unmarked so the ordinary (non-force) re-run
                // the UI recommends actually finds it again. Marking it here
                // would make that advice impossible to follow.
                markerPending = false;
                logger.warn(
                  `Orientation backfill: ${stuck} tier(s) survived deletion for photo ${photo.id} — `
                  + 'they will keep serving unrotated until storage is writable and this is re-run'
                );
              }
            }

            if (markerPending) {
              await db('photos').where(fence).update({ orientation_checked_at: nowIso() });
            }

            // From the affected-row count, not the intent: if the fence
            // rejected the write because the file was replaced mid-run, the
            // photo was not corrected and must not be reported as such.
            if (dimsWritten > 0) corrected++;

            if ((corrected + requeuedFaces) % 50 === 0 && (corrected + requeuedFaces) > 0) {
              logger.info(`Orientation backfill progress: ${corrected} corrected...`);
            }
          } catch (error) {
            logger.error(`Error backfilling orientation for photo ${photo.id}:`, error);
            errorCount++;
          }
        }

        if (lostClaim) {
          logger.warn(`Orientation backfill stopped: claim taken over after ${corrected} corrected`);
          return;
        }
        await maintenanceJobs.release(JOB_ORIENTATION_BACKFILL, token, {
          checked, corrected, requeuedFaces, staleTiers, failed: errorCount,
        });
        logger.info(
          `Orientation backfill complete: ${checked} checked, ${corrected} corrected, `
          + `${requeuedFaces} requeued for face scanning, ${errorCount} errors`
        );
      } catch (err) {
        logger.error('Orientation backfill aborted:', err);
        await maintenanceJobs
          .release(JOB_ORIENTATION_BACKFILL, token, {
            checked, corrected, requeuedFaces, staleTiers, failed: errorCount, error: err.message,
          })
          .catch(() => {});
      } finally {
        lease.stop();
      }
    });
  } catch (error) {
    logger.error('Error starting orientation backfill:', error);
    res.status(500).json({ error: 'Failed to start orientation backfill' });
  }
});

router.get('/repair-orientation/status', adminAuth, requirePermission('system.manage'), async (req, res) => {
  try {
    const state = await maintenanceJobs.read(JOB_ORIENTATION_BACKFILL);
    res.json({ isRunning: state.isRunning, lastResult: state.lastResult });
  } catch (error) {
    logger.error('Error fetching orientation backfill status:', error);
    res.status(500).json({ error: 'Failed to fetch orientation backfill status' });
  }
});

module.exports = router;
