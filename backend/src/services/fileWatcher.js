const chokidar = require('chokidar');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs').promises;
const sharp = require('./isolatedSharp');
const { retryTransient } = require('./imageResourcePolicy');
const { resolveCredit } = require('./photoCredit');
const { exifColumn } = require('./photoExif');
const pLimit = require('p-limit');
const { db } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const { generateThumbnail, generateVideoPlaceholder, withProcessableImage, extractCaptureDate, prefixedBasename } = require('./imageProcessor');
const logger = require('../utils/logger');
const { isVideoMimeType } = require('./videoProcessor');
const mime = require('mime-types');
const { isRawFilename } = require('../utils/rawFormats');
const { normalizeUploadMimeType } = require('../utils/fileSecurityUtils');
const { getAllowedExtensions } = require('./uploadSettings');
const downloadZipService = require('./downloadZipService');
const { promotionSettled } = require('./watchFolderClaims');
const { unfinishedKeys } = require('./publicUploadQuota');

const { getStoragePath } = require('../config/storage');
const WATCH_PATH = () => path.join(getStoragePath(), 'events/active');

// Bound concurrent watcher work. chokidar fires 'add' once per file — with no
// ignoreInitial option the boot scan fires it for EVERY existing file, and a
// bulk drop into the watch folder fires it for every new one at once. Each
// handler runs DB lookups and (for new files) a full sharp pipeline;
// sharp.concurrency(2) only caps libvips threads WITHIN one operation, not the
// number of parallel pipelines, so unbounded handlers can OOM small hosts.
// 'unlink' shares the limiter: mass deletes otherwise burst DB work and
// ZIP-cache invalidation the same way.
const configuredConcurrency = Number.parseInt(process.env.FILE_WATCHER_CONCURRENCY || '2', 10);
const watcherConcurrency = Number.isFinite(configuredConcurrency)
  ? Math.max(1, configuredConcurrency)
  : 2;
const processLimit = pLimit(watcherConcurrency);

// chokidar waits for a file to stop growing before it fires 'add'. The
// defaults suit a local disk; a slow NAS or a camera tether that flushes in
// bursts needs a longer quiet window, and a very fast SSD can use a shorter
// one. Same parsing rule as the concurrency bound: a positive integer, or the
// default with a warning.
function positiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  // Strict: "2s" must not become a 2 ms window.
  const parsed = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed < 1) {
    logger.warn(`[fileWatcher] ${name}=${JSON.stringify(raw)} is not a positive integer; using ${fallback}`);
    return fallback;
  }
  return parsed;
}
const writeFinishStabilityMs = positiveIntEnv('FILE_WATCHER_STABILITY_MS', 2000);
const writeFinishPollIntervalMs = positiveIntEnv('FILE_WATCHER_POLL_INTERVAL_MS', 100);

let watcher = null;
const pending = new Set();
const enqueue = (run) => {
  const task = processLimit(run); pending.add(task);
  task.finally(() => pending.delete(task)).catch(() => {});
  return task;
};
async function stopFileWatcher() {
  const closing = watcher; watcher = null;
  if (closing) await closing.close();
  await Promise.allSettled([...pending]);
}

function startFileWatcher() {
  if (watcher) return watcher;
  // Auto-import via filesystem watching only works with the local storage
  // backend. In S3 mode there is no local directory to watch — every photo
  // must enter through the admin upload API. Skip cleanly with a clear log
  // so operators aren't surprised by the missing feature.
  const backend = (process.env.STORAGE_BACKEND || 'local').toLowerCase();
  if (backend !== 'local') {
    logger.warn(`[fileWatcher] auto-import disabled — STORAGE_BACKEND=${backend}. Use the admin upload API instead.`);
    return null;
  }

  watcher = chokidar.watch(WATCH_PATH(), {
    ignored: /(^|[/\\])\../, // ignore dotfiles
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: writeFinishStabilityMs,
      pollInterval: writeFinishPollIntervalMs
    }
  });

  watcher
    .on('add', (filePath) => {
      // A busy image worker is asked again: nothing re-announces this file.
      enqueue(() => retryTransient(() => processNewPhoto(filePath))).catch((error) => {
        logger.error('Error processing new photo:', error);
      });
    })
    .on('unlink', (filePath) => {
      enqueue(() => removePhoto(filePath)).catch((error) => {
        logger.error('Error removing photo:', error);
      });
    });

  // Rows imported before thumbnails got a per-photo name may still share one.
  // Through the watcher's queue: same concurrency bound, and stopFileWatcher
  // waits for it.
  enqueue(() => repairSharedThumbnails()).catch((error) => {
    logger.warn('[fileWatcher] Shared thumbnail repair failed', { error: error.message });
  });

  logger.info('File watcher started');
  return watcher;
}

/**
 * Give every photo that shares a derived file with another photo its own.
 *
 * Watch-folder imports named the thumbnail after the camera's file name, and
 * regenerating a thumbnail, lightbox preview or hero did the same, so
 * same-named files in two galleries point at one file showing whichever was
 * written last. Each such row is regenerated from its own original, under a
 * per-photo name (imageProcessor's ownDerivativeName), and the old file is
 * removed once no row points at it. Shared keys are found across every row,
 * but archived galleries are not regenerated: their originals are in the
 * zip, not in storage, and their rows keep the key (and so the file). A live
 * row that cannot be regenerated loses the pointer instead, so it is rebuilt
 * on its next view rather than showing another gallery's picture, and it no
 * longer holds the key once the others have moved off. Idempotent: with no
 * shared keys left, this is three grouped queries.
 */
async function repairSharedThumbnails() {
  const { ensureThumbnail, ensurePreviewImage, ensureHeroImage } = require('./imageProcessor');
  const { getStorage } = require('./storage');
  const archived = () => db('events').where('is_archived', formatBoolean(true)).select('id');
  const kinds = {
    // Checked against a concurrent settings change (issue 2140); the row
    // keeps the shared key so a dropped render does not hand it back.
    thumbnail_path: (photo) => ensureThumbnail(photo, { force: true, checkSettings: true }),
    preview_path: (photo) => ensurePreviewImage({ ...photo, preview_path: null }, { force: true }),
    // The event's own focal point, as the gallery hero route asks for it.
    hero_path: (photo) => ensureHeroImage({ ...photo, hero_path: null }),
  };
  for (const [column, regenerate] of Object.entries(kinds)) {
    const keys = await db('photos').whereNotNull(column)
      .groupBy(column).havingRaw('count(*) > 1').pluck(column);
    if (keys.length === 0) continue;
    logger.info(`[fileWatcher] ${keys.length} ${column} file(s) shared by several photos; regenerating them per photo`);
    for (const key of keys) {
      const photos = await db('photos').where(column, key).whereNotIn('event_id', archived()).orderBy('id');
      for (const photo of photos) {
        let rebuilt = null;
        try {
          rebuilt = await regenerate(photo);
        } catch (error) {
          logger.warn(`[fileWatcher] Could not regenerate ${column} of photo ${photo.id}: ${error.message}`);
        }
        if (!rebuilt) {
          await db('photos').where({ id: photo.id, [column]: key }).update({ [column]: null });
        }
      }
      // Kept while any derived column of any row still names it, as the
      // gallery delete checks (routes/adminEvents/helpers.js).
      const stillReferenced = await db('photos').where((qb) => qb
        .where('thumbnail_path', key)
        .orWhere('hero_path', key)
        .orWhere('preview_path', key)
        .orWhere('watermark_path', key))
        .first('id');
      if (!stillReferenced) {
        await getStorage().delete(key).catch(() => {});
      }
    }
  }
}

/**
 * Has this watched file already been imported into this event?
 *
 * Exported so the regression test drives this query rather than a copy of it.
 * See the caller for why source_filename is one of the arms.
 *
 * @param {number} eventId
 * @param {string} basename    the file's basename on disk
 * @param {string} relativePath the path the import would store
 */
async function findExistingPhoto(eventId, basename, relativePath) {
  return db('photos')
    .where({ event_id: eventId })
    .where(function() {
      this.where('filename', basename)
        .orWhere('source_filename', basename)
        .orWhere('path', relativePath);
    })
    .first();
}

// A database error is not a code retryTransient repeats, and nothing
// announces this file again, so the settings read is retried here.
const SETTINGS_READ_ATTEMPTS = 3;
const SETTINGS_READ_PAUSE_MS = 1000;
async function readAllowedExtensions() {
  for (let attempt = 1; ; attempt++) {
    try { return await getAllowedExtensions(); } catch (error) {
      if (attempt >= SETTINGS_READ_ATTEMPTS) throw error;
      await new Promise(resolve => setTimeout(resolve, SETTINGS_READ_PAUSE_MS));
    }
  }
}

async function processNewPhoto(filePath) {
  const relativePath = path.relative(WATCH_PATH(), filePath);
  const pathParts = relativePath.split(path.sep);
  
  if (pathParts.length < 2) return; // Not in correct folder structure
  
  const eventSlug = pathParts[0];
  const photoType = pathParts[1] === 'collages' ? 'collage' : 'individual';
  
  // Check if this is an image or video file
  const ext = path.extname(filePath).toLowerCase();
  const detectedMime = mime.lookup(filePath) || '';
  const isVideo = isVideoMimeType(detectedMime, filePath) || ['.mp4', '.mov', '.webm'].includes(ext);
  const isRaw = !isVideo && isRawFilename(filePath);
  if (!isVideo && !isRaw && !['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) return;
  
  // Skip temporary upload files
  const filename = path.basename(filePath);
  if (filename.startsWith('temp_')) {
    logger.debug(`Skipping temporary upload file: ${filename}`);
    return;
  }

  // RAW is opt-in, the same switch the upload gate reads. Checked by
  // extension, not through the MIME map: nothing here came from a browser, so
  // there is no client MIME to validate, and the map does not know every RAW
  // extension yet. A skip is logged because the file stays in the folder and
  // nothing else would say why it never showed up.
  if (isRaw && !(await readAllowedExtensions()).has(ext.slice(1))) {
    logger.warn(`[fileWatcher] Skipping ${relativePath}: ${ext.slice(1)} is not in general_allowed_file_types. `
      + 'Add it under Settings, then restart the backend or copy the file again.');
    return;
  }
  
  // Find the event
  const event = await db('events').where({ slug: eventSlug, is_active: formatBoolean(true) }).first();
  if (!event) return;

  // An upload storing this file has not written its row yet (issue 1970).
  // Wait for it, so the check below sees that row, or a hand-dropped file
  // is still imported; a failed upload may have removed the file meanwhile.
  const storageKey = path.posix.join('events/active', ...pathParts);
  const promotion = promotionSettled(storageKey);
  if (promotion) {
    await promotion;
    if (!(await fs.access(filePath).then(() => true, () => false))) return;
  }

  // Check if photo already exists.
  //
  // `source_filename` is in here, not just filename/path, because a REPLACEMENT
  // changes both of those (#1226). replacePhoto generates a fresh filename and
  // a fresh managed path, so a watched-folder photo that had its file replaced
  // — through the Lightroom round-trip (#745) or the admin replace — stopped
  // matching either arm, and the next sweep imported the untouched original a
  // second time. The gallery then held the edit AND the original: the same
  // duplicate shape external_relpath prevents for reference galleries.
  //
  // source_filename is the stable key: written once at ingest (below) and
  // preserved across a replace by design. Rows predating migration 193 are
  // covered too — its backfill sets source_filename from
  // COALESCE(original_filename, filename), and this path did not write
  // original_filename then, so for watcher rows that resolves to the basename
  // this compares against.
  //
  // Checked before any processing: chokidar re-announces every file on each
  // boot, and a RAW preview extraction reads the whole file.
  const existingPhoto = await findExistingPhoto(event.id, path.basename(filePath), relativePath);
  if (existingPhoto) {
    logger.debug(`Photo already exists: ${relativePath}`);
    return;
  }

  // An upload that died between storing this file and writing its row left
  // its promotion record behind (issue 1970). The in-process claim above did
  // not survive the restart; the record did, and every process sees it. The
  // file never became a photo, so it is not imported as one.
  if ((await unfinishedKeys([storageKey])).has(storageKey)) {
    logger.warn(`[fileWatcher] Skipping ${relativePath}: an upload stored it but never finished`);
    return;
  }
  // commitObject writes the row and settles the record in one transaction,
  // so an upload in another process may have finished between the photo
  // check above and the ledger read: look for its row once more.
  if (await findExistingPhoto(event.id, path.basename(filePath), relativePath)) {
    logger.debug(`Photo already exists: ${relativePath}`);
    return;
  }

  // Get file stats
  const stats = await fs.stat(filePath);
  
  // Generate thumbnail or placeholder
  let thumbnailPath = null;
  const thumbMeta = {};
  // The thumbnail key has no gallery in it, and cameras restart at
  // IMG_0001.JPG, so the camera's name alone made two galleries share one
  // thumbnail: the later import overwrote it, and deleting either photo
  // removed the other's. A random prefix, as the upload paths get from their
  // generated file names; the name is shortened to leave room for it.
  const thumbBasename = prefixedBasename(`w${crypto.randomBytes(6).toString('hex')}_`, filename);
  // Capture image dimensions so aspect-aware layouts (masonry / mosaic /
  // justified) can size each card to the photo's real proportions
  // instead of the 800×600 fallback in MasonryGalleryLayout (#447).
  // Skip videos — those would need ffprobe.
  let dimensions = null;
  if (isVideo) {
    thumbnailPath = await generateVideoPlaceholder(thumbBasename);
  } else {
    // sharp cannot decode a RAW, so thumbnail and measure its embedded
    // preview instead. Pass-through for ordinary images.
    const proc = await withProcessableImage(filePath, filename);
    try {
      thumbnailPath = await generateThumbnail(proc.path, { outputBasename: thumbBasename, meta: thumbMeta });
      try {
        const metadata = await sharp(proc.path).metadata();
        // Oriented, not raw — see imageProcessor.orientedDimensions (#1185).
        const dims = require('./imageProcessor').orientedDimensions(metadata);
        if (dims.width && dims.height) {
          dimensions = { width: dims.width, height: dims.height };
        }
      } catch (err) {
        if (require('./imageResourcePolicy').isResourceError(err)) throw err;
        logger.debug(`Could not read image dimensions for ${filename}: ${err.message}`);
      }
    } finally {
      await proc.cleanup();
    }
  }
  
  // Calculate relative thumbnail path
  const relativeThumbPath = thumbnailPath; // thumbnailPath is already relative to storage root
  // mime-db knows few RAW types and calls .dcr a Director file, so a RAW is
  // typed from its extension alone.
  const mimeType = isRaw
    ? (normalizeUploadMimeType(filename, '') || 'application/octet-stream')
    : (detectedMime || (isVideo ? 'video/mp4' : 'image/jpeg'));

  // Credit from the file's EXIF (#1561). Only for a row about to be created,
  // so a re-sweep of an imported folder reads nothing.
  const credit = await resolveCredit({ localPath: filePath, isVideo });
  // Camera details (issue 1733, D1), under the same condition.
  const exif = isVideo ? {} : await exifColumn(filePath);
  // Capture date, likewise: the row is complete, so the worker that reads it
  // for an upload never runs, and the timeline sorted it by import time.
  const capturedAt = isVideo ? null : await extractCaptureDate(filePath);
  // Browser-playable copy (issue 1430): a video the watcher picks up is
  // queued like an uploaded one while the setting is on; otherwise it would
  // wait for the next switch-on backfill. No transaction is open here.
  // Metadata stripping (issue 2102) queues it too.
  const webCopyEnabled = isVideo && await require('./videoRenditionService').queuesVideos();

  // Add to database
  const insertResult = await db('photos').insert({
    event_id: event.id,
    filename: path.basename(filePath),
    // The camera-original name, the key the Lightroom round-trip (#745)
    // matches a RAW against for auto-imported galleries.
    source_filename: path.basename(filePath),
    original_filename: path.basename(filePath),
    path: relativePath,
    thumbnail_path: relativeThumbPath,
    thumb_hash: thumbMeta.thumbHash || null,
    type: isVideo ? 'video' : photoType,
    // The column defaults to 'image', so a watched video was filed as a
    // photo. Migration 286 corrects the rows imported before this.
    media_type: isVideo ? 'video' : 'image',
    source_origin: 'managed',
    processing_status: 'complete',
    size_bytes: stats.size,
    mime_type: mimeType,
    captured_at: capturedAt ? capturedAt.toISOString() : null,
    ...(dimensions && { width: dimensions.width, height: dimensions.height }),
    ...(webCopyEnabled ? { web_status: 'pending' } : {}),
    ...credit,
    ...exif
  }).returning('id');
  const photoId = insertResult[0]?.id || insertResult[0];

  logger.info(`Added new photo: ${relativePath}`);
  downloadZipService.invalidate(event.id);

  // Scene tagging (issue 1733): this path writes a finished row itself and
  // never reaches photoProcessor's enqueue.
  if (!isVideo) {
    try {
      await require('./tagSettings').enqueueFinishedPhotos(event.id, [photoId]);
    } catch (err) {
      logger.warn(`Could not queue ${relativePath} for tagging: ${err.message}`);
    }
  }

  // Webhook (#327) — auto-import path. Only fires in local mode since
  // the watcher is disabled in S3 mode.
  try {
    const webhookService = require('./webhookService');
    await webhookService.fire('photo.uploaded', {
      event: { id: event.id, slug: event.slug, event_name: event.event_name },
      photo: { id: photoId, filename: path.basename(filePath), size_bytes: stats.size, source: 'auto-import' },
    });
  } catch (e) { /* non-fatal */ }
}

async function removePhoto(filePath) {
  const relativePath = path.relative(WATCH_PATH(), filePath);

  // Look up event before deleting to invalidate zip cache
  const photo = await db('photos').where({ path: relativePath }).first();

  // A purge under way (issue 1733) removed this file itself and still needs
  // the row to finish its cleanup, or to be found again after a crash.
  if (photo && photo.deleted_at && photo.purge_after == null) return;

  // Remove from database. Scene tags (issue 1733) go in the same
  // transaction: the FK cascade is inert on SQLite, and a tagging result in
  // flight then lands either before this (and is deleted here) or after it
  // (and finds no row to settle). The row first, the order tagProcessor
  // locks in.
  if (photo) {
    await db.transaction(async (trx) => {
      const ids = await trx('photos').where({ path: relativePath })
        .whereNot(function () { this.whereNotNull('deleted_at').whereNull('purge_after'); })
        .pluck('id');
      await require('./heroPhotoLock').lockHeroEvents(trx, ids);
      await trx('photos').whereIn('id', ids).delete();
      await trx('photo_tags').whereIn('photo_id', ids).del();
    });
  }

  if (photo) {
    await require('./videoHlsService').deleteLadder(photo);
    downloadZipService.invalidate(photo.event_id);

    // Webhook (#327) — fire only if the row actually existed. A photo in the
    // trash (issue 1733) announced its deletion when it was trashed.
    if (!photo.deleted_at) try {
      const event = await db('events').where({ id: photo.event_id }).first();
      const webhookService = require('./webhookService');
      await webhookService.fire('photo.deleted', {
        event: { id: photo.event_id, slug: event?.slug, event_name: event?.event_name },
        photo: { id: photo.id, filename: photo.filename, source: 'auto-import' },
      });
    } catch (e) { /* non-fatal */ }
  }

  logger.info(`Removed photo: ${relativePath}`);
}

module.exports = { stopFileWatcher, startFileWatcher, findExistingPhoto, processNewPhoto, removePhoto, repairSharedThumbnails };
