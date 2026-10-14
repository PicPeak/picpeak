/**
 * S3 prefix walker that mirrors the chokidar `fileWatcher` for S3 mode.
 *
 * Why: in S3 mode the local file watcher is disabled (no inotify on remote
 * objects). Without this, the only way to add photos is the upload API.
 * This walker polls every event's storage prefix on a slow cadence and
 * imports any new objects into the photos table.
 *
 * Eventual-consistency gate: an object is only imported after it has been
 * SEEN for two consecutive polls. This avoids flapping when a list returns
 * a freshly-uploaded object that disappears on the next list (a documented
 * S3 behavior on certain backends).
 *
 * Opt-in via STORAGE_AUTO_IMPORT=true (off by default — admins who don't
 * need it shouldn't pay the API call cost).
 */

const path = require('path');
const mime = require('mime-types');
const sharp = require('./isolatedSharp');
const { retryTransient } = require('./imageResourcePolicy');
const { resolveCredit } = require('./photoCredit');
const { exifColumn } = require('./photoExif');
const { db } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const { getStorage } = require('./storage');
const { withLocalCopy, extractCaptureDate, withProcessableImage } = require('./imageProcessor');
const { isRawFilename } = require('../utils/rawFormats');
const { normalizeUploadMimeType } = require('../utils/fileSecurityUtils');
const { getAllowedExtensions } = require('./uploadSettings');
const logger = require('../utils/logger');
const { promotionSettled } = require('./watchFolderClaims');
const { unfinishedKeys } = require('./publicUploadQuota');

const POLL_INTERVAL_MS = parseInt(process.env.STORAGE_AUTO_IMPORT_INTERVAL_MS || `${5 * 60 * 1000}`, 10);
const ENABLED = process.env.STORAGE_AUTO_IMPORT === 'true';

// Map<eventId, Set<storageKey>> — keys we saw on the previous poll.
// On the next poll, any key in BOTH the previous and current snapshots is
// eligible for import. This is the eventual-consistency gate.
const previousSnapshot = new Map();

let stopped = false;

async function runTick() {
  if (stopped) return;
  const storage = getStorage();
  if (storage.kind() !== 's3') return; // no-op for local fs

  try {
    const events = await db('events')
      .where({ is_active: formatBoolean(true), is_archived: formatBoolean(false) })
      .select('id', 'slug');

    for (const event of events) {
      await processEvent(event, storage);
    }
  } catch (err) {
    logger.error(`[s3AutoImporter] tick failed: ${err.message}`);
  }
}

async function processEvent(event, storage) {
  const prefix = path.posix.join('events/active', event.slug);
  let entries = [];
  try {
    entries = await storage.list(prefix);
  } catch (err) {
    logger.warn(`[s3AutoImporter] list failed for event ${event.slug}: ${err.message}`);
    return;
  }

  const currentKeys = new Set(entries.map((e) => e.key));
  const lastSnapshot = previousSnapshot.get(event.id) || new Set();

  // Eventual-consistency gate: only consider keys present in BOTH the
  // previous tick's snapshot and the current one.
  const stableKeys = entries.filter((e) => lastSnapshot.has(e.key));

  if (stableKeys.length > 0) {
    // Find keys not yet in photos table.
    const stableKeyList = stableKeys.map((e) => e.key);
    const eventsActivePrefix = 'events/active/';
    const relativePaths = stableKeyList.map((k) =>
      k.startsWith(eventsActivePrefix) ? k.slice(eventsActivePrefix.length) : k
    );

    // Objects an upload stored but has not written a row for yet, or never
    // will (issue 1970): read BEFORE the photos, because commitObject writes
    // the row and settles the record in one transaction.
    const unfinished = await unfinishedKeys(stableKeyList);

    const existing = await db('photos')
      .where({ event_id: event.id })
      .whereIn('path', relativePaths)
      .select('path');
    const existingPaths = new Set(existing.map((r) => r.path));

    for (const entry of stableKeys) {
      const relativePath = entry.key.startsWith(eventsActivePrefix)
        ? entry.key.slice(eventsActivePrefix.length)
        : entry.key;
      if (existingPaths.has(relativePath)) continue;
      if (unfinished.has(entry.key) || promotionSettled(entry.key)) continue;

      // Skip generated artifacts (thumbnails get their own keys; we don't
      // want to re-register them as photos).
      const filename = path.basename(entry.key);
      if (filename.startsWith('thumb_') || filename.startsWith('hero_')) continue;
      if (filename.startsWith('.')) continue; // dotfiles like .download-cache

      // A camera RAW is typed from its extension, as the file watcher does:
      // mime-db knows few RAW types (only .dng as an image, .dcr as a
      // Director file), so the lookup alone skipped nearly all of them. RAW
      // is opt-in, the same switch the upload gate reads; a skip is only
      // logged at debug level because every poll would repeat it.
      const isRaw = isRawFilename(filename);
      if (isRaw && !(await getAllowedExtensions()).has(path.extname(filename).slice(1).toLowerCase())) {
        logger.debug(`[s3AutoImporter] skipping ${entry.key}: not in general_allowed_file_types`);
        continue;
      }
      const mimeType = isRaw
        ? (normalizeUploadMimeType(filename, '') || 'application/octet-stream')
        : (mime.lookup(filename) || 'application/octet-stream');
      const isImage = isRaw || mimeType.startsWith('image/');
      const isVideo = !isRaw && mimeType.startsWith('video/');
      if (!isImage && !isVideo) continue;

      // Capture image dimensions so aspect-aware layouts (masonry /
      // mosaic / justified) can size each card to the photo's real
      // proportions instead of the 800×600 fallback (#447). Materialize
      // a tmp local copy via withLocalCopy — withLocalCopy handles the
      // S3 download + cleanup. Skip videos (would need ffprobe).
      //
      // The EXIF credit (#1561) and the camera details (issue 1733, D1) are
      // read from the same local copy, so the object is only fetched once.
      let dimensions = null;
      let credit = {};
      let exif = {};
      let capturedAt = null;
      if (isImage) {
        try {
          dimensions = await withLocalCopy(entry.key, async (localPath) => {
            credit = await resolveCredit({ localPath });
            exif = await exifColumn(localPath);
            // The row is inserted complete, so the worker never reads it.
            capturedAt = await extractCaptureDate(localPath);
            // sharp cannot decode a RAW, so measure its embedded preview.
            const proc = await withProcessableImage(localPath, filename);
            try {
              const metadata = await retryTransient(() => sharp(proc.path).metadata());
              // Oriented, not raw — see imageProcessor.orientedDimensions (#1185).
              const dims = require('./imageProcessor').orientedDimensions(metadata);
              if (dims.width && dims.height) {
                return { width: dims.width, height: dims.height };
              }
              return null;
            } finally {
              await proc.cleanup();
            }
          });
        } catch (err) {
          logger.debug(`[s3AutoImporter] could not read dimensions for ${entry.key}: ${err.message}`);
        }
      }

      try {
        const insertResult = await db('photos').insert({
          event_id: event.id,
          filename,
          original_filename: filename,
          path: relativePath,
          type: 'individual',
          size_bytes: entry.size,
          media_type: isVideo ? 'video' : 'image',
          mime_type: mimeType,
          source_origin: 'managed',
          uploaded_at: new Date().toISOString(),
          captured_at: capturedAt ? capturedAt.toISOString() : null,
          ...(dimensions && { width: dimensions.width, height: dimensions.height }),
          ...credit,
          ...exif,
        }).returning('id');
        const photoId = insertResult[0]?.id || insertResult[0];

        logger.info(`[s3AutoImporter] imported s3://.../${entry.key} → photo #${photoId} for event ${event.slug}`);

        // Scene tagging (issue 1733): same as fileWatcher, a finished row
        // that never passes photoProcessor's enqueue.
        if (isImage) {
          try {
            await require('./tagSettings').enqueueFinishedPhotos(event.id, [photoId]);
          } catch (err) {
            logger.warn(`[s3AutoImporter] could not queue photo #${photoId} for tagging: ${err.message}`);
          }
        }

        // Webhook (#327): same shape as fileWatcher.
        try {
          const webhookService = require('./webhookService');
          await webhookService.fire('photo.uploaded', {
            event: { id: event.id, slug: event.slug },
            photo: { id: photoId, filename, size_bytes: entry.size, source: 's3-auto-import' },
          });
        } catch (e) { /* non-fatal */ }
      } catch (err) {
        logger.warn(`[s3AutoImporter] failed to insert ${entry.key}: ${err.message}`);
      }
    }
  }

  previousSnapshot.set(event.id, currentKeys);
}

const pollingTask = require('./scheduledTask').scheduledTask(runTick, {
  // Run once on start so admins see import activity without waiting a full poll.
  interval: POLL_INTERVAL_MS, initialDelay: 0,
});
const tick = () => runTick(); // Explicit test/manual tick does not start a timer.
function startS3AutoImporter() {
  if (!ENABLED) return;
  stopped = false;
  pollingTask.start();
}
async function stopS3AutoImporter() {
  stopped = true;
  await pollingTask.stop();
  previousSnapshot.clear();
}

module.exports = {
  startS3AutoImporter,
  stopS3AutoImporter,
  __test: { tick, processEvent, previousSnapshot, ENABLED, POLL_INTERVAL_MS },
};
