/**
 * Download renditions (#858).
 *
 * One place that answers "what bytes does this photo ship as for this
 * download?" — used by the single-photo route, the selected-photos archive,
 * the cached download-all build, and the custom-resolution job builder.
 *
 * The ordering matters and is the whole reason this is centralised: the
 * watermark is sized relative to its input's width, so it MUST be applied
 * after the resize. Watermarking the original and then downscaling would
 * resample the mark and burn CPU on pixels that get thrown away.
 *
 * Returns null when the photo needs no transformation at all, which lets
 * callers stream the original straight from storage instead of buffering it.
 */

const { resolvePhotoStorageKey, resolvePhotoFilePath } = require('./photoResolver');
const { withLocalCopy, resizeToBox, ensurePreviewImage } = require('./imageProcessor');
const { isRawFilename } = require('../utils/rawFormats');
const watermarkService = require('./watermarkService');
const { isGalleryPriced, resolvePhotoSalesWatermarkSettings } = require('../modules/photoSales/priceRules');
const { getStorage } = require('./storage');
const fs = require('fs');
const { isPresentationRenditionKey } = require('./galleryAssetPolicy');
const { resolvePhotoContentType } = require('../utils/photoContentType');
const { sniffImageType, ALLOWED_IMAGE_TYPES } = require('../utils/fileSecurityUtils');

/** Videos have no resize path — they always ship as stored. */
function isVideo(photo) {
  return photo.media_type === 'video'
    || (photo.mime_type && String(photo.mime_type).startsWith('video/'));
}

/**
 * Neither does camera RAW. A resolution choice is meaningless for a file the
 * client is downloading precisely to edit at full size, and re-encoding one to
 * JPEG under its own name would produce something no converter can open.
 *
 * That is already the behaviour, but by accident: sharp throws on the RAW and
 * resizeToBox hands back what it was given, after the whole 55 MB original has
 * been read into a Buffer for nothing.
 */
function shipsAsStored(photo) {
  return isVideo(photo) || isRawFilename(photo.original_filename || photo.filename);
}

/**
 * @param {object}  event
 * @param {object}  photo
 * @param {object?} box                {width,height} or null for original size
 * @param {object?} watermarkSettings  effective settings, or null to skip
 * @returns {Promise<Buffer|null>}     null = serve the stored bytes unchanged
 */
async function renderPhotoForDownload(event, photo, box, watermarkSettings) {
  const wantsResize = !!box && !shipsAsStored(photo);
  const wantsWatermark = !!(watermarkSettings && watermarkSettings.enabled);
  if (!wantsResize && !wantsWatermark) return null;

  const storageKey = resolvePhotoStorageKey(event, photo);

  const transform = async (localPath) => {
    // No resize → hand applyWatermark the PATH. Buffer inputs intentionally
    // bypass its cache, so buffering here would re-run sharp over the
    // full-size original for every download of an unresized gallery.
    if (!wantsResize) {
      // keepMetadata: a download carries the photo's EXIF/XMP/IPTC (issue
      // 1649); the gallery-view rendition the same function makes does not.
      return watermarkService.applyWatermark(localPath, watermarkSettings, { keepMetadata: true });
    }
    const buffer = await resizeToBox(await fs.promises.readFile(localPath), box, {
      sourceName: photo.original_filename || photo.filename,
    });
    return wantsWatermark
      ? watermarkService.applyWatermark(buffer, watermarkSettings, { keepMetadata: true })
      : buffer;
  };

  // Managed photos live behind the storage abstraction (possibly S3); external
  // / reference photos are already on a local mount.
  return storageKey
    ? withLocalCopy(storageKey, transform)
    : transform(resolvePhotoFilePath(event, photo));
}

/**
 * The preview-size copy of a photo as a download (issue 1560): what a guest
 * of a gallery with a download limit gets instead of the original. The same
 * rendition the lightbox shows them, watermarked like any other download.
 *
 * @returns {Promise<{buffer: Buffer, contentType: string, extension: string}|null>}
 *          null for a video (no preview tier) or when no preview can be made
 */
async function renderPreviewForDownload(photo, watermarkSettings) {
  if (isVideo(photo)) return null;
  const previewKey = await ensurePreviewImage(photo);
  if (!isPresentationRenditionKey(previewKey, 'preview')) return null;
  const wantsWatermark = !!(watermarkSettings && watermarkSettings.enabled);
  const buffer = await withLocalCopy(previewKey, (localPath) => (wantsWatermark
    ? watermarkService.applyWatermark(localPath, watermarkSettings, { failClosed: true })
    : fs.promises.readFile(localPath)));
  const webp = previewKey.endsWith('.webp');
  return { buffer, contentType: webp ? 'image/webp' : 'image/jpeg', extension: webp ? '.webp' : '.jpg' };
}

/** A download name with the preview's extension in place of the original's. */
function previewDownloadName(name, extension) {
  return `${String(name).replace(/\.[^./\\]*$/, '')}${extension}`;
}

/**
 * Content-Type and download name for a renderPhotoForDownload buffer. The
 * watermark re-encodes anything but PNG/WebP as JPEG, and resizeToBox turns
 * TIFF/AVIF into JPEG, so the stored type can name the wrong format (issue
 * 2178). The bytes decide; the stored type stands when they prove nothing.
 */
function renderedDownloadType(buffer, photo, name) {
  const storedType = resolvePhotoContentType(photo);
  const contentType = sniffImageType(buffer) || storedType;
  return {
    contentType,
    name: contentType === storedType
      ? name
      : previewDownloadName(name, ALLOWED_IMAGE_TYPES[contentType].extensions[0]),
  };
}

/**
 * Resolve the effective watermark settings for an event, or null when no
 * watermark applies. Same global-OR-event rule the download routes already
 * used, lifted here so the job builder can't drift from it. Deliberately
 * does NOT include the per-photo photo-sales forcing — that needs the photo
 * and lives in resolveWatermarkSettingsForPhoto below.
 */
async function resolveWatermarkSettings(event) {
  const settings = await watermarkService.getWatermarkSettings();
  const eventEnabled = event.watermark_downloads === true || event.watermark_downloads === 1;
  const shouldApply = (settings && settings.enabled) || eventEnabled;
  if (!shouldApply) return null;
  return {
    ...watermarkService.forEvent(settings, event),
    enabled: true,
  };
}

/**
 * Photo sales: per-photo watermark settings.
 *
 * Priced galleries resolve through the photo-sales rules: a paid photo
 * (outside the free quota) is watermarked FORCEDLY even when the global /
 * gallery watermark is off; a free photo keeps the original global-OR-event
 * rule. Non-priced galleries go through the unchanged event-level resolver,
 * so their bytes never drift from upstream PicPeak.
 */
async function resolveWatermarkSettingsForPhoto(event, photo) {
  if (isGalleryPriced(event)) {
    return resolvePhotoSalesWatermarkSettings(event, photo);
  }
  return resolveWatermarkSettings(event);
}

module.exports = {
  renderPhotoForDownload,
  renderPreviewForDownload,
  previewDownloadName,
  renderedDownloadType,
  resolveWatermarkSettings,
  resolveWatermarkSettingsForPhoto,
  isVideo,
  shipsAsStored,
  getStorage,
};
