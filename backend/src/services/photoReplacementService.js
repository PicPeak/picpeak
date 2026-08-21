/**
 * PhotoReplacementService
 *
 * Handles replacing existing photos by matching original_filename.
 * Preserves the photo's ID, position, feedback, category, and visibility
 * while updating the physical file and metadata.
 */

const path = require('path');
const fsp = require('fs/promises');
const sharp = require('sharp');
const { db } = require('../database/db');
const {
  generateThumbnail, extractCaptureDate, withProcessableImage,
  deleteThumbnailTiers, deletePreviewTiers,
} = require('./imageProcessor');
const { generatePhotoFilename } = require('../utils/filenameSanitizer');
const watermarkGeneratorService = require('./watermarkGeneratorService');
const { getStorage } = require('./storage');
const { resolvePhotoStorageKey } = require('./photoResolver');
const logger = require('../utils/logger');

/**
 * Find a replacement candidate by matching original_filename (case-insensitive).
 * Returns the photo row if exactly one match, { ambiguous: true, count } if multiple, or null.
 */
async function findReplacementCandidate(eventId, originalFilename) {
  if (!originalFilename) return null;

  const matches = await db('photos')
    .where({ event_id: eventId })
    .whereRaw('LOWER(original_filename) = LOWER(?)', [originalFilename]);

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return { ambiguous: true, count: matches.length };
  return null;
}

/**
 * Replace an existing photo's file while preserving its DB identity.
 *
 * @param {Object} existingPhoto - The current photo DB row
 * @param {string} newFileTempPath - Path to the new file (will be moved)
 * @param {Object} opts - { originalFilename, mimeType, event }
 * @returns {{ success: boolean, photo?: Object, error?: string }}
 */
async function replacePhoto(existingPhoto, newFileTempPath, { originalFilename, mimeType, event }) {
  const categorySlug = existingPhoto.type === 'collage' ? 'collages' : 'individual';

  try {
    // Generate new filename + storage key
    const ext = path.extname(originalFilename);
    const newFilename = generatePhotoFilename(event.event_name, categorySlug, Date.now(), ext);
    const relativePath = path.posix.join(event.slug, categorySlug, newFilename);
    const finalKey = path.posix.join('events/active', relativePath);
    const storage = getStorage();

    // Sharp/EXIF need a local file. The temp file from multer still satisfies
    // that — we read metadata before uploading the original to storage.
    let capturedAt = null;
    try {
      capturedAt = await extractCaptureDate(newFileTempPath);
    } catch {
      // No EXIF — keep null
    }

    const stats = await fsp.stat(newFileTempPath);

    // RAW/DNG isn't sharp-decodable — extract the embedded JPEG preview first
    // (pass-through for ordinary images), then measure + thumbnail that. Mirrors
    // the ingest paths (processPhoto / processUploadedPhotos).
    let width = null;
    let height = null;
    let thumbnailPath = null;
    // Detect/name by the unique stored filename (newFilename), not the
    // client-supplied original, so RAW derivative keys can't collide.
    const proc = await withProcessableImage(newFileTempPath, newFilename);
    try {
      try {
        const metadata = await sharp(proc.path).metadata();
        width = metadata.width || null;
        height = metadata.height || null;
      } catch {
        // Non-image or corrupt
      }
      try {
        thumbnailPath = await generateThumbnail(proc.path, { outputBasename: proc.outputBasename });
      } catch {
        logger.warn('Failed to generate thumbnail for replaced photo', { photoId: existingPhoto.id });
      }
    } finally {
      await proc.cleanup();
    }

    // Delete old assets BEFORE uploading the new key — if they share the path
    // (rare but possible if filename collision), we want the new content.
    const oldOriginalKey = resolvePhotoStorageKey(event, existingPhoto);
    if (oldOriginalKey && oldOriginalKey !== finalKey) {
      await storage.delete(oldOriginalKey).catch(() => {});
    }
    if (existingPhoto.thumbnail_path && existingPhoto.thumbnail_path !== thumbnailPath) {
      await storage.delete(existingPhoto.thumbnail_path).catch(() => {});
    }
    // Responsive tiers, keyed off the OLD row (#1095 / #492). Their key embeds
    // the basename, which the update below replaces — so this is the last
    // moment they can be derived at all. Miss it and a later delete or archive
    // computes keys from the new basename and leaves them in storage forever.
    await deleteThumbnailTiers(existingPhoto);
    await deletePreviewTiers(existingPhoto);
    try {
      await watermarkGeneratorService.deleteForPhoto(existingPhoto.id);
    } catch {
      // Ignore — watermark may not exist
    }

    // Upload the new original.
    await storage.putFromFile(finalKey, newFileTempPath, { contentType: mimeType });

    // Update DB record — preserve id, event_id, category_id, type, visibility,
    // uploaded_at, sort_order, feedback counts, view/download counts
    const updates = {
      filename: newFilename,
      original_filename: originalFilename,
      path: relativePath,
      thumbnail_path: thumbnailPath,
      size_bytes: stats.size,
      width,
      height,
      captured_at: capturedAt,
      mime_type: mimeType,
      media_type: mimeType?.startsWith('video/') ? 'video' : 'image',
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
      updates.face_error = null;
    } catch (err) {
      logger.warn(`replacePhoto: face reset failed for photo ${existingPhoto.id}`, {
        error: err.message,
      });
    }

    await db('photos').where({ id: existingPhoto.id }).update(updates);

    const updatedPhoto = await db('photos').where({ id: existingPhoto.id }).first();

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
    logger.error('replacePhoto error', { photoId: existingPhoto.id, error: err.message });
    return { success: false, error: err.message };
  }
}

module.exports = { findReplacementCandidate, replacePhoto };
