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
const {
  withLocalCopy, resizeToBox, ensurePreviewImage, withProcessableImage, orientedDimensions,
  withRawContainerTags,
} = require('./imageProcessor');
const sharp = require('./isolatedSharp');
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
 * Whether the image in `buffer` is no larger than `box`, as displayed: a
 * still by its oriented dimensions, an animation by one frame (its height
 * spans every frame, and resizeToBox never rotates one).
 */
async function fitsBox(buffer, box) {
  try {
    const metadata = await sharp(buffer, { failOn: 'none' }).metadata();
    const { width, height } = (metadata.pages || 1) > 1
      ? { width: metadata.width, height: metadata.pageHeight || metadata.height }
      : orientedDimensions(metadata);
    return !!(width && height && width <= box.width && height <= box.height);
  } catch {
    return false;
  }
}

/**
 * The photo at most `box` large. The box is the gallery's download cap, so
 * the original must never stand in for it: resizeToBox hands back its input
 * for HEIC/AVIF (it cannot encode them in kind), for camera RAW, and for any
 * source it fails on. Those go out as a JPEG inside the box, made from what
 * sharp can read (the embedded preview of a RAW, a decoded HEVC HEIC), and a
 * source that cannot be read at all is refused.
 */
async function capToBox(localPath, box, sourceName) {
  if (!isRawFilename(sourceName)) {
    const resized = await resizeToBox(await fs.promises.readFile(localPath), box, { sourceName });
    if (await fitsBox(resized, box)) return resized;
  }
  const proc = await withProcessableImage(localPath, sourceName);
  try {
    return await sharp(proc.path, { limitInputPixels: 268402689, failOn: 'none' })
      .rotate()
      .resize(box.width, box.height, { fit: 'inside', withoutEnlargement: true })
      .keepMetadata()
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer();
  } finally {
    await proc.cleanup();
  }
}

/**
 * @param {object}  event
 * @param {object}  photo
 * @param {object?} box                {width,height} or null for original size
 * @param {object?} watermarkSettings  effective settings, or null to skip
 * @returns {Promise<Buffer|null>}     null = serve the stored bytes unchanged
 */
async function renderPhotoForDownload(event, photo, box, watermarkSettings) {
  // A video ships as stored: neither the cap nor the image watermark applies,
  // and the fail-closed mark would refuse every video of a watermarked gallery.
  if (isVideo(photo)) return null;
  const wantsResize = !!box;
  const wantsWatermark = !!(watermarkSettings && watermarkSettings.enabled);
  if (!wantsResize && !wantsWatermark) return null;

  const storageKey = resolvePhotoStorageKey(event, photo);

  const sourceName = photo.original_filename || photo.filename;
  // failClosed: a mark that cannot be applied refuses the download. The
  // caller skips the photo or answers 500; the clean original never goes out
  // in its place.
  const mark = (input) => watermarkService.applyWatermark(input, watermarkSettings, { keepMetadata: true, failClosed: true });

  const render = async (localPath) => {
    if (!wantsResize) {
      // A RAW cannot be marked as stored: the mark goes on its embedded
      // preview, which ships as a JPEG. As a Buffer, so the temp file's
      // random path does not become a watermark cache key.
      if (isRawFilename(sourceName)) {
        const proc = await withProcessableImage(localPath, sourceName);
        try {
          return await mark(await fs.promises.readFile(proc.path));
        } finally {
          await proc.cleanup();
        }
      }
      // No resize → hand applyWatermark the PATH. Buffer inputs intentionally
      // bypass its cache, so buffering here would re-run sharp over the
      // full-size original for every download of an unresized gallery.
      // keepMetadata: a download carries the photo's EXIF/XMP/IPTC (issue
      // 1649); the gallery-view rendition the same function makes does not.
      return mark(localPath);
    }
    const buffer = await capToBox(localPath, box, sourceName);
    return wantsWatermark ? mark(buffer) : buffer;
  };
  // A RAW ships as a JPEG of its embedded preview, which carries no metadata
  // of its own: the container's goes onto the finished bytes, after the mark.
  const transform = async (localPath) => {
    const rendition = await render(localPath);
    return isRawFilename(sourceName) ? withRawContainerTags(localPath, rendition) : rendition;
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
  // null is a failed lookup, not "no watermark": whether one applies, and
  // what it draws, is unknown, so the download is refused.
  if (settings === null) throw new Error('The watermark settings could not be read');
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
  getStorage,
};
