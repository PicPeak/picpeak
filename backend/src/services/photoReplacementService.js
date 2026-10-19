/**
 * PhotoReplacementService
 *
 * Handles replacing existing photos by matching original_filename.
 * Preserves the photo's ID, position, feedback, category, and visibility
 * while updating the physical file and metadata.
 */

const path = require('path');
const fsp = require('fs/promises');
const sharp = require('./isolatedSharp');
const { isResourceError } = require('./imageResourcePolicy');
const { db } = require('../database/db');
const { livePhotos } = require('../utils/photoVisibility');
const {
  generateThumbnail, extractCaptureDate, withProcessableImage,
  deleteThumbnailTiers, deletePreviewTiers,
} = require('./imageProcessor');
const { processUploadedVideo, extractVideoMetadata, posterFrameError } = require('./videoProcessor');
const { generatePhotoFilename } = require('../utils/filenameSanitizer');
const watermarkService = require('./watermarkService');
const { getStorage } = require('./storage');
const { resolvePhotoStorageKey } = require('./photoResolver');
const { resolveCredit } = require('./photoCredit');
const { exifColumn } = require('./photoExif');
const logger = require('../utils/logger');
const uploadQuota = require('./publicUploadQuota');
const { claimPromotion } = require('./watchFolderClaims');

/**
 * The trailing digit run of a filename stem, e.g. `Smith_Wedding_11234.jpg`
 * -> `11234`. Used by the `number_token` match mode below.
 *
 * Deliberately the LONGEST trailing run and never a fixed last-N slice.
 * Multi-camera shoots disambiguate by prefixing the camera index into the
 * number (`cam11234.jpg`, `cam21234.jpg`); a last-4 slice reads `1234` from
 * both bodies and reintroduces exactly the collision the prefix removes.
 *
 * @param {string} filename
 * @returns {string|null} the digit run, or null when there is none
 */
function trailingDigitRun(filename) {
  if (!filename) return null;
  const stem = String(filename).replace(/\.[^.]+$/, '');
  const match = stem.match(/(\d+)$/);
  return match ? match[1] : null;
}

/**
 * Find a replacement candidate.
 *
 * Two modes:
 *
 * - `exact` (default, unchanged behaviour): case-insensitive match on the
 *   name the photo was uploaded under.
 * - `number_token` (#745): match on the trailing digit run instead, so an
 *   editor who renamed `IMG_1234.JPG` to `Smith_Wedding_1234.jpg` in
 *   Lightroom still lands on the right photo. Opt-in, because a digit run is
 *   a much weaker key than a filename.
 *
 * Both modes prefer `source_filename` (the camera-original name, preserved
 * across replaces by migration 193) and fall back to `original_filename` for
 * rows that predate it.
 *
 * Returns the photo row on exactly one match, `{ ambiguous: true, count }`
 * when several match, or null. Ambiguity is never resolved by guessing — the
 * caller uploads the file as new rather than overwriting the wrong photo.
 *
 * @param {number} eventId
 * @param {string} originalFilename
 * @param {Object} [opts]
 * @param {'exact'|'number_token'} [opts.matchMode='exact']
 */
async function findReplacementCandidate(eventId, originalFilename, opts = {}) {
  if (!originalFilename) return null;
  const { matchMode = 'exact' } = opts;

  if (matchMode === 'number_token') {
    const token = trailingDigitRun(originalFilename);
    if (!token) return null;

    // The token has to be compared against the STEM of the stored name, not
    // the whole string, so `IMG_1234.JPG` yields `1234` on both sides. That
    // comparison stays in JS — expressing it in SQL across two engines is
    // more trouble than it is worth — but the CANDIDATE SET is narrowed in
    // SQL first.
    //
    // Without the LIKE this read every photo row in the event, once per
    // uploaded file, and twice per file when a photo cap is configured. At
    // the 2000-file upload limit against a 5000-photo event that is up to 20M
    // rows before any image processing starts. The token is a digit run
    // extracted by regex, so it is safe to interpolate and cannot carry a
    // LIKE wildcard.
    //
    // The LIKE over-matches on purpose (it ignores position and extension);
    // the exact trailing-run check below is still what decides, so semantics
    // are unchanged and only the row count drops.
    const pattern = '%' + token + '%';
    const rows = await livePhotos(db)
      .where({ event_id: eventId })
      .where(function () {
        this.where('source_filename', 'like', pattern)
          .orWhere('original_filename', 'like', pattern);
      })
      .select('id', 'source_filename', 'original_filename');

    const matches = rows.filter((row) => {
      const stored = row.source_filename || row.original_filename;
      return stored && trailingDigitRun(stored) === token;
    });

    if (matches.length > 1) return { ambiguous: true, count: matches.length };
    if (matches.length === 1) {
      // Re-read the full row: replacePhoto() needs the columns the narrowed
      // select above deliberately skipped (type, filename, source_filename).
      return livePhotos(db).where({ id: matches[0].id }).first();
    }
    return null;
  }

  const exactMatches = (name) => livePhotos(db)
    .where({ event_id: eventId })
    .where(function () {
      this.whereRaw('LOWER(original_filename) = LOWER(?)', [name])
        .orWhereRaw('LOWER(source_filename) = LOWER(?)', [name]);
    });

  let matches = await exactMatches(originalFilename);
  // Uploads before issue 2072 stored non-ASCII names latin1-decoded
  // (`ümläut.jpg` as `Ã¼mlÃ¤ut.jpg`). A re-upload now arrives correctly
  // decoded, so without this it would land as a new photo. Only that exact
  // legacy form, and only when nothing matches the real name.
  let legacyName = null;
  if (matches.length === 0) {
    const decoded = Buffer.from(originalFilename, 'utf8').toString('latin1');
    if (decoded !== originalFilename) {
      matches = await exactMatches(decoded);
      legacyName = decoded;
    }
  }

  if (matches.length === 1) {
    // Tells replacePhoto the row was found through its legacy name, so it can
    // repair source_filename. Non-enumerable: never spread into a write.
    if (legacyName) Object.defineProperty(matches[0], 'legacyNameMatch', { value: legacyName });
    return matches[0];
  }
  if (matches.length > 1) return { ambiguous: true, count: matches.length };
  return null;
}

/** True when a fallback match left source_filename mangled (or empty). */
function repairsLegacySource(photo) {
  if (!photo.legacyNameMatch) return false;
  return !photo.source_filename
    || photo.source_filename.toLowerCase() === photo.legacyNameMatch.toLowerCase();
}

/**
 * Delete what described the replaced file, once the row no longer names it.
 *
 * Afterwards rather than before the switch: until the row points at the new
 * original, a failure must leave the old photo whole. Every step is
 * best-effort; the replacement itself has already succeeded.
 */
async function removeReplacedAssets(oldPhoto, { event, finalKey, thumbnailPath, storage, videoRendition }) {
  try {
    const oldOriginalKey = resolvePhotoStorageKey(event, oldPhoto);
    if (oldOriginalKey && oldOriginalKey !== finalKey) {
      await storage.delete(oldOriginalKey).catch(() => {});
    }
    if (oldPhoto.thumbnail_path && oldPhoto.thumbnail_path !== thumbnailPath) {
      await storage.delete(oldPhoto.thumbnail_path).catch(() => {});
    }
    // Managed preview and hero names derive from the source basename, which
    // another row can share (see dropSupersededHero); such a file stays.
    for (const column of ['preview_path', 'hero_path']) {
      const key = oldPhoto[column];
      if (!key) continue;
      const shared = await db('photos').whereNot({ id: oldPhoto.id })
        .where((q) => q.where('preview_path', key).orWhere('hero_path', key)).first('id');
      if (!shared) await storage.delete(key).catch(() => {});
    }
    // The browser-playable copy (issue 1430) describes the old bytes.
    await videoRendition.deleteWebCopy(oldPhoto);
    // Responsive tiers, keyed off the OLD row (#1095 / #492). Their key embeds
    // the basename the update replaced, so the old row is the only thing they
    // can still be derived from.
    await deleteThumbnailTiers(oldPhoto);
    await deletePreviewTiers(oldPhoto);
    // The recorded watermark, and the one a job still cutting the old file
    // writes under its name (it then finds the row moved on and records
    // nothing).
    await watermarkService.deleteWatermarkFile(oldPhoto.watermark_path);
    await watermarkService.deleteWatermarkFile(watermarkService.watermarkKey(oldPhoto));
  } catch (err) {
    logger.warn('replacePhoto: old asset cleanup failed', { photoId: oldPhoto.id, error: err.message });
  }
}

/**
 * Poster frame and metadata for a replacement video, the way photoProcessor
 * makes them on ingest. processUploadedVideo already falls back to the static
 * placeholder when ffmpeg yields no frame, so the row never ends up with no
 * thumbnail at all.
 */
async function replacementVideoPoster(tempPath, newFilename, thumbMeta) {
  const thumbnailKey = path.posix.join('thumbnails', `thumb_${newFilename.replace(/\.[^.]+$/, '.jpg')}`);
  let metadata = null;
  let thumbnailPath = null;
  // A placeholder tile carries its note, as on ingest, so the admin grid
  // offers the poster retry; a real frame clears the old video's note.
  let posterError = null;
  try {
    const result = await processUploadedVideo(tempPath, thumbnailKey);
    metadata = result.metadata;
    thumbnailPath = result.thumbnailKey;
    thumbMeta.thumbHash = result.thumbHash;
    if (result.placeholder) posterError = posterFrameError(result.thumbnailError);
  } catch (error) {
    if (isResourceError(error)) throw error;
    logger.warn('Video processing failed for a replacement, using the placeholder', { error: error.message });
    posterError = posterFrameError(error.message);
    metadata = await extractVideoMetadata(tempPath).catch(() => null);
    thumbnailPath = await require('./imageProcessor').generateVideoPlaceholder(newFilename);
  }
  // The placeholder returns null when storage refuses it too. Fail here,
  // before the old original and poster are deleted, rather than publish a
  // video row the grid would load as its own tile.
  if (!thumbnailPath) throw new Error('No poster could be stored for the replacement video');
  return {
    thumbnailPath,
    width: metadata?.width ?? null,
    height: metadata?.height ?? null,
    videoColumns: {
      duration: metadata?.duration ?? null,
      video_codec: metadata?.videoCodec ?? null,
      audio_codec: metadata?.audioCodec ?? null,
      processing_error: posterError,
    },
  };
}

/**
 * Replace an existing photo's file while preserving its DB identity.
 *
 * @param {Object} existingPhoto - The current photo DB row
 * @param {string} newFileTempPath - Path to the new file (will be moved)
 * @param {Object} opts - { originalFilename, mimeType, event }
 * @returns {{ success: boolean, photo?: Object, error?: string }}
 */
async function replacePhoto(existingPhoto, newFileTempPath, { originalFilename, mimeType, event, uploadReservation = null }) {
  const categorySlug = existingPhoto.type === 'collage' ? 'collages' : 'individual';
  let object;
  let storage;
  let promotionSettled = false;
  let releaseClaim = null;
  let switched = false;
  let finalKey;
  let newFilename;
  let thumbnailPath = null;

  try {
    // Generate new filename + storage key
    const ext = path.extname(originalFilename);
    newFilename = generatePhotoFilename(event.event_name, categorySlug, Date.now(), ext);
    const relativePath = path.posix.join(event.slug, categorySlug, newFilename);
    finalKey = path.posix.join('events/active', relativePath);
    storage = getStorage();

    // Sharp/EXIF need a local file. The temp file from multer still satisfies
    // that — we read metadata before uploading the original to storage.
    let capturedAt = null;
    try {
      capturedAt = await extractCaptureDate(newFileTempPath);
    } catch {
      // No EXIF — keep null
    }

    const stats = await fsp.stat(newFileTempPath);
    // The row now holds other bytes: its content hash follows (issue 1733, C2).
    const contentSha256 = await require('./photoDuplicates').sha256File(newFileTempPath);

    // Credit (#1561): an automatic one describes the file, so the new file's
    // EXIF replaces it. Guest and manual credits are decisions about the
    // photo and stay.
    const isVideoReplacement = !!mimeType?.startsWith('video/');
    // Read while the temp file is still here, like the date above.
    const exif = isVideoReplacement ? {} : await exifColumn(newFileTempPath);
    const autoCredit = existingPhoto.uploaded_by !== 'guest'
      && (!existingPhoto.credit_source || existingPhoto.credit_source === 'exif')
      ? await resolveCredit({ localPath: newFileTempPath, isVideo: isVideoReplacement })
      : null;

    // RAW/DNG isn't sharp-decodable — extract the embedded JPEG preview first
    // (pass-through for ordinary images), then measure + thumbnail that. Mirrors
    // the ingest paths (processPhoto / processUploadedPhotos).
    let width = null;
    let height = null;
    let videoColumns = {};
    const thumbMeta = {};
    if (isVideoReplacement) {
      // A video gets its poster frame and metadata from ffmpeg, as on ingest
      // (photoProcessor). sharp cannot read one, and a video left with no
      // thumbnail makes the grid fetch the whole original as its tile.
      ({ thumbnailPath, width, height, videoColumns } = await replacementVideoPoster(newFileTempPath, newFilename, thumbMeta));
    } else {
      // Detect/name by the unique stored filename (newFilename), not the
      // client-supplied original, so RAW derivative keys can't collide.
      const proc = await withProcessableImage(newFileTempPath, newFilename);
      try {
        try {
          const metadata = await sharp(proc.path).metadata();
          // Oriented, not raw — see imageProcessor.orientedDimensions (#1185).
          ({ width, height } = require('./imageProcessor').orientedDimensions(metadata));
        } catch (error) {
          if (isResourceError(error)) throw error;
          // Non-image or corrupt
        }
        try {
          thumbnailPath = await generateThumbnail(proc.path, { outputBasename: proc.outputBasename, meta: thumbMeta });
        } catch (error) {
          if (isResourceError(error)) throw error;
          logger.warn('Failed to generate thumbnail for replaced photo', { photoId: existingPhoto.id });
        }
      } finally {
        await proc.cleanup();
      }
    }

    if (uploadReservation) object = await uploadQuota.prepareObject(uploadReservation, finalKey, stats.size);
    const videoRendition = require('./videoRenditionService');

    // Upload the new original first. The old files are deleted only once the
    // row points at the new one (see removeReplacedAssets below): a failed
    // upload used to leave the unchanged row pointing at a deleted original.
    //
    // `putFromFile` COPIES (LocalFsStorage) or
    // uploads (S3) — neither consumes the source, and this function used to
    // leave it behind. The v1 route additionally stops its own cleanup on the
    // (wrong) assumption that this moved the file, so every replacement
    // stranded up to 100 MB in storage/temp. Cleaning up here closes the v1
    // and the admin path at once: adminPhotos only unlinks in its
    // new-files branch, so replaced files leaked there too.
    // Claimed until the row points at it, so the file watcher does not
    // import the new file as a photo of its own (issue 1970).
    releaseClaim = claimPromotion(finalKey);
    await storage.putFromFile(finalKey, newFileTempPath, { contentType: mimeType });
    promotionSettled = true;
    if (uploadReservation) {
      const promoted = await storage.stat(finalKey);
      if (!promoted || promoted.size !== stats.size) throw new Error('Size mismatch after replacement upload');
    }
    await fsp.unlink(newFileTempPath).catch(() => {});

    // Update DB record — preserve id, event_id, category_id, type, visibility,
    // uploaded_at, sort_order, feedback counts, view/download counts
    const updates = {
      filename: newFilename,
      original_filename: originalFilename,
      // source_filename is deliberately NOT in this list. It holds the
      // camera-original name and must survive a replace, otherwise the
      // Lightroom round-trip (#745) loses its match key the first time an
      // editor uploads a renamed render over the proof. Backfilled here only
      // when the row predates migration 193 and has nothing stored yet.
      // One repair: a row matched only through its latin1-decoded legacy name
      // (issue 2072) whose source_filename is that same mangled string, or
      // empty, gets the correctly decoded name; any other camera name is kept.
      ...(repairsLegacySource(existingPhoto)
        ? { source_filename: originalFilename }
        : existingPhoto.source_filename
          ? {}
          : { source_filename: existingPhoto.original_filename || originalFilename }),
      path: relativePath,
      thumbnail_path: thumbnailPath,
      // The old hash describes the replaced image; none beats a wrong one.
      thumb_hash: thumbMeta.thumbHash || null,
      // The preview, hero and watermark were cut from the old picture, and
      // their readers keep any readable file the row names: left set, the
      // new photo went on showing the old one. Cleared, they regenerate.
      preview_path: null,
      hero_path: null,
      hero_anchor: null,
      watermark_path: null,
      watermark_generated_at: null,
      size_bytes: stats.size,
      content_sha256: contentSha256,
      width,
      height,
      captured_at: capturedAt,
      // Camera details describe the file (issue 1733, D1): the new file's,
      // or none. NULL leaves an unreadable one to the backfill.
      exif_json: null,
      ...exif,
      mime_type: mimeType,
      media_type: mimeType?.startsWith('video/') ? 'video' : 'image',
      // The new clip's length and codecs; an image keeps none.
      duration: null,
      video_codec: null,
      audio_codec: null,
      ...videoColumns,
      // A replaced video is queued for a new copy while the setting is on;
      // anything else starts over with none.
      web_path: null,
      // The new file starts its own attempts: a worker still busy with the
      // old one loses its claim and can publish nothing.
      processing_attempt_id: null,
      web_attempt_id: null,
      web_attempts: 0,
      web_retry_at: null,
      // Either setting queues it (metadata stripping, issue 2102, included).
      web_status: isVideoReplacement && await videoRendition.queuesVideos() ? 'pending' : null,
      web_started_at: null,
      web_error: null,
      // The ladder starts over the same way; the queue picks a video up.
      hls_path: null,
      hls_status: null,
      hls_attempt_id: null,
      hls_attempts: 0,
      hls_retry_at: null,
      hls_started_at: null,
      hls_error: null,
      // The replacement lives in the managed backend, so the row has to say
      // so. resolvePhotoStorageKey gives photo.source_origin precedence over
      // everything and returns null for 'reference'/'external' — so leaving
      // this set meant the new file was stored and recorded while every
      // viewer kept being served the untouched NAS original, with the upload
      // orphaned and the API reporting success.
      //
      // external_relpath is deliberately KEPT. It is no longer used to
      // resolve the photo — source_origin decides that, and every other
      // consumer reads the two together — but it is still the key
      // adminExternalMedia dedupes on when the folder is re-scanned
      // (`where({ event_id, external_relpath })`) and the column the unique
      // index from migration 186 covers. Clearing it would make the next scan
      // treat the NAS original as a new file and import a duplicate
      // alongside the photo that just replaced it.
      //
      // The external file itself is never touched: this repoints the row, it
      // does not delete or move anything on the share.
      source_origin: 'managed',
      // A photo whose share file had vanished (issue 2121) is served from
      // the new upload now; the scan no longer looks after it.
      unavailable_reason: null,
    };

    // Face data (#1074): the row keeps its id but now points at a DIFFERENT
    // image, so every stored face describes the old picture. Left alone the
    // gallery would keep showing the previous subject's identities on the new
    // photo. Drop them, then re-queue if the event has detection on.
    try {
      const { purgePhotoFaces } = require('./faceProcessor');
      const { isEnabledForEvent } = require('./faceSettings');
      await purgePhotoFaces(existingPhoto.id);

      const event = await db('events').where({ id: existingPhoto.event_id }).first();
      updates.face_status = (await isEnabledForEvent(event)) ? 'pending' : null;
      updates.face_count = null;
      updates.face_started_at = null;
      updates.face_attempt_id = null;
      updates.face_error = null;
    } catch (err) {
      logger.warn(`replacePhoto: face reset failed for photo ${existingPhoto.id}`, {
        error: err.message,
      });
    }

    // The adaptive streaming ladder (issue 1733) describes the old bytes too.
    // Its files are listed now and removed once the row has started over:
    // by then a transcode of the old file has lost its claim and cannot
    // publish behind the sweep, and whatever another replica writes for the
    // new file in between is not on the list.
    const sweepOldLadder = await require('./videoHlsService').captureLadder(existingPhoto);

    // Scene tags (issue 1733) describe the old picture too: drop them and
    // re-queue when the gallery has tagging on.
    try {
      const { purgePhotoTags } = require('./tagProcessor');
      await purgePhotoTags(existingPhoto.id);
      const event = await db('events').where({ id: existingPhoto.event_id }).first();
      updates.tag_status = (await require('./tagSettings').isEnabledForEvent(event)) ? 'pending' : null;
      updates.tag_started_at = null;
      updates.tag_attempt_id = null;
      updates.tag_error = null;
    } catch (err) {
      logger.warn(`replacePhoto: tag reset failed for photo ${existingPhoto.id}`, {
        error: err.message,
      });
    }

    if (object) {
      await uploadQuota.commitObject(object, 'photo', async conn => {
        if (await conn('photos').where({ id: existingPhoto.id, event_id: event.id }).update(updates) !== 1) {
          throw new Error('Replacement target no longer exists');
        }
        return existingPhoto.id;
      });
    } else await db('photos').where({ id: existingPhoto.id }).update(updates);
    switched = true;
    releaseClaim();
    await removeReplacedAssets(existingPhoto, { event, finalKey, thumbnailPath, storage, videoRendition });
    await sweepOldLadder();
    if (autoCredit) {
      // Fenced like the upload worker: a manual credit set meanwhile wins,
      // and so does a replacement that installed another file since.
      await db('photos')
        .where({ id: existingPhoto.id, path: updates.path, filename: updates.filename })
        .where((q) => q.whereNull('credit_source').orWhere('credit_source', 'exif'))
        .update({ credit_name: autoCredit.credit_name || null, credit_source: autoCredit.credit_source || null });
    }

    const updatedPhoto = await db('photos').where({ id: existingPhoto.id }).first();
    if (object && updatedPhoto && !['pending', 'processing', 'failed'].includes(updatedPhoto.processing_status)) {
      try { await uploadQuota.processingComplete(existingPhoto.id); }
      catch (err) { logger.warn('Replacement pending charge retained', { photoId: existingPhoto.id, error: err.message }); }
    }

    logger.info('Photo replaced', {
      photoId: existingPhoto.id,
      oldFilename: existingPhoto.filename,
      newFilename,
      originalFilename,
    });

    return {
      success: true,
      photo: updatedPhoto,
      previousFilename: existingPhoto.filename,
    };
  } catch (err) {
    if (object) {
      try { await uploadQuota.failedObject(object, { storage, settled: promotionSettled }); }
      catch (cleanupError) {
        logger.warn('Replacement object cleanup failed; charge retained', { objectId: object.id, error: cleanupError.message });
      }
    }
    // The row still names the old files, so what was written for the new one
    // is nobody's. (failedObject above owns the original when quota-tracked.)
    // A commit whose acknowledgement was lost did switch it: asked, not assumed.
    if (!switched && storage) {
      try {
        const committed = newFilename && await db('photos').where({ id: existingPhoto.id, filename: newFilename }).first('id');
        if (!committed) {
          if (!object && promotionSettled && finalKey !== resolvePhotoStorageKey(event, existingPhoto)) {
            await storage.delete(finalKey).catch(() => {});
          }
          if (thumbnailPath && thumbnailPath !== existingPhoto.thumbnail_path) await storage.delete(thumbnailPath).catch(() => {});
        }
      } catch (cleanupError) {
        logger.warn('Replacement upload cleanup failed', { photoId: existingPhoto.id, error: cleanupError.message });
      }
    }
    logger.error('replacePhoto error', { photoId: existingPhoto.id, error: err.message });
    return { success: false, error: err.message };
  } finally {
    releaseClaim?.();
  }
}

module.exports = { trailingDigitRun, findReplacementCandidate, replacePhoto };
