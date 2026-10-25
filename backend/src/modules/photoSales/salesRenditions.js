'use strict';

/**
 * Photo sales — persisted watermarked lightbox previews.
 *
 * Paid photos in priced galleries are always shown watermarked (tiled)
 * before checkout. Compositing that mark with sharp on every lightbox
 * open is the slowest image path in the gallery, so the first viewer's
 * request queues a background render of the watermarked 1920px preview
 * into storage; every later request streams the persisted file instead.
 *
 * The persisted key embeds a fingerprint of the forced mark settings, so
 * ANY change (logo, watermark text, company name, opacity/size bumps, the
 * photo moving in/out of the free quota) makes the stored row stop
 * matching — serving falls back to on-the-fly rendering and re-persists.
 */

const crypto = require('crypto');
const pLimit = require('p-limit');
const { db } = require('../../database/db');
const { livePhotos } = require('../../utils/photoVisibility');
const { getStorage } = require('../../services/storage');
const logger = require('../../utils/logger');

const STORE_DIR = 'watermarks_sales';
// Same ceiling as watermarkGeneratorService: never decode more than two
// images in parallel for this background work.
const generateLimit = pLimit(2);

function salesSettingsFingerprint(settings) {
  const material = [
    settings.tiled === true ? 'tiled-v2' : 'single',
    settings.position,
    settings.opacity,
    settings.size,
    settings.text || '',
    settings.logoPath || '',
  ].join('|');
  return crypto.createHash('sha1').update(material).digest('hex').slice(0, 12);
}

function salesPreviewKey(photoId, fingerprint) {
  return `${STORE_DIR}/${photoId}_sales_preview_${fingerprint}.jpg`;
}

/**
 * The persisted rendition path when it matches the CURRENT forced settings
 * for this photo — null otherwise (never generated, stale settings, or the
 * file went away).
 */
async function findPersistedSalesPreview(event, photo, settings) {
  if (!event || !photo || !settings || !settings.enabled || !settings.tiled) return null;
  const fingerprint = salesSettingsFingerprint(settings);
  const row = await db('photos')
    .where({ id: photo.id })
    .first('photo_sales_preview_key', 'photo_sales_preview_path');
  if (!row || row.photo_sales_preview_key !== fingerprint || !row.photo_sales_preview_path) {
    return null;
  }
  try {
    const stat = await getStorage().stat(row.photo_sales_preview_path);
    return stat ? row.photo_sales_preview_path : null;
  } catch {
    return null;
  }
}

/**
 * Background job: render the forced (tiled) watermark onto the canonical
 * 1920px preview and persist it. Fire-and-forget from the serving route.
 */
async function generateSalesPreviewForPhoto(photoId) {
  return generateLimit(async () => {
    try {
      const photo = await livePhotos(db)
        .join('events', 'photos.event_id', 'events.id')
        .where('photos.id', photoId)
        .select(
          'photos.*',
          'events.slug',
          'events.source_mode',
          'events.external_path',
          'events.is_priced',
          'events.free_photo_count',
          'events.photo_price',
          'events.watermark_text'
        )
        .first();
      if (!photo) return { success: false, error: 'Photo not found' };

      const { isGalleryPriced, resolvePhotoSalesWatermarkSettings } = require('./priceRules');
      const event = {
        id: photo.event_id,
        is_priced: photo.is_priced,
        free_photo_count: photo.free_photo_count,
        photo_price: photo.photo_price,
        watermark_text: photo.watermark_text,
      };

      // Every photo of a priced gallery carries the forced tiled mark until
      // checkout (the free quota is decided per order).
      if (!isGalleryPriced(event)) {
        return { success: false, error: 'Gallery is not priced' };
      }
      const settings = await resolvePhotoSalesWatermarkSettings(event, photo);
      if (!settings || !settings.enabled) {
        return { success: false, error: 'No forced watermark settings' };
      }

      const { ensurePreviewImage, withLocalCopy } = require('../../services/imageProcessor');
      const previewPath = await ensurePreviewImage(photo);
      if (!previewPath) return { success: false, error: 'Preview unavailable' };

      const watermarkService = require('../../services/watermarkService');
      // failClosed: a failed composite must throw, never persist the clean
      // preview under the current fingerprint for every later guest.
      const buffer = await withLocalCopy(previewPath, (localPath) =>
        watermarkService.applyWatermark(localPath, settings, { failClosed: true })
      );

      const fingerprint = salesSettingsFingerprint(settings);
      const key = salesPreviewKey(photo.id, fingerprint);
      await getStorage().put(key, buffer, {
        contentType: previewPath.endsWith('.webp') ? 'image/webp' : 'image/jpeg',
      });

      // Replace the previous persisted rendition for this photo (settings
      // change → new fingerprint → new key). Best-effort cleanup.
      const previous = await db('photos')
        .where({ id: photo.id })
        .first('photo_sales_preview_path');
      if (previous && previous.photo_sales_preview_path && previous.photo_sales_preview_path !== key) {
        await getStorage().delete(previous.photo_sales_preview_path).catch(() => {});
      }

      await db('photos').where({ id: photo.id }).update({
        photo_sales_preview_key: fingerprint,
        photo_sales_preview_path: key,
      });

      return { success: true, key };
    } catch (error) {
      logger.warn(`Sales preview generation failed for photo ${photoId}: ${error.message}`);
      return { success: false, error: error.message };
    }
  });
}

/**
 * Pre-generate the watermarked lightbox preview for every photo of a priced
 * gallery — called when photos finish upload processing and when a gallery
 * is switched to priced, so the first visitor never pays the sharp cost.
 * Fire-and-forget; individual failures are logged and lazy fallback stays.
 */
async function queueForEvent(eventId) {
  try {
    const photos = await livePhotos(db)
      .where('photos.event_id', eventId)
      .whereNot(function () {
        this.where('photos.media_type', 'video')
          .orWhere('photos.mime_type', 'like', 'video/%');
      })
      .select('photos.id');
    const results = await Promise.all(
      photos.map((photo) => generateSalesPreviewForPhoto(photo.id).catch((error) => ({ success: false, error: error.message })))
    );
    const failed = results.filter((r) => !r.success).length;
    if (failed > 0) {
      logger.warn(`Sales preview pre-generation for event ${eventId}: ${failed}/${photos.length} failed`);
    }
    return { total: photos.length, failed };
  } catch (error) {
    logger.warn(`Sales preview pre-generation for event ${eventId} failed: ${error.message}`);
    return { total: 0, failed: 0 };
  }
}

module.exports = {
  salesSettingsFingerprint,
  findPersistedSalesPreview,
  generateSalesPreviewForPhoto,
  queueForEvent,
};
