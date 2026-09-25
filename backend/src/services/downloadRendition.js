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
const watermarkService = require('./watermarkService');
const { getStorage } = require('./storage');
const fs = require('fs');

/** Videos have no resize path — they always ship as stored. */
function isVideo(photo) {
  return photo.media_type === 'video'
    || (photo.mime_type && String(photo.mime_type).startsWith('video/'));
}

/**
 * @param {object}  event
 * @param {object}  photo
 * @param {object?} box                {width,height} or null for original size
 * @param {object?} watermarkSettings  effective settings, or null to skip
 * @returns {Promise<Buffer|null>}     null = serve the stored bytes unchanged
 */
async function renderPhotoForDownload(event, photo, box, watermarkSettings) {
  const wantsResize = !!box && !isVideo(photo);
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
    const buffer = await resizeToBox(await fs.promises.readFile(localPath), box);
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
  if (!previewKey) return null;
  const wantsWatermark = !!(watermarkSettings && watermarkSettings.enabled);
  const buffer = await withLocalCopy(previewKey, (localPath) => (wantsWatermark
    ? watermarkService.applyWatermark(localPath, watermarkSettings)
    : fs.promises.readFile(localPath)));
  const webp = previewKey.endsWith('.webp');
  return { buffer, contentType: webp ? 'image/webp' : 'image/jpeg', extension: webp ? '.webp' : '.jpg' };
}

/** A download name with the preview's extension in place of the original's. */
function previewDownloadName(name, extension) {
  return `${String(name).replace(/\.[^./\\]*$/, '')}${extension}`;
}

/**
 * Resolve the effective watermark settings for an event, or null when no
 * watermark applies. Same global-OR-event rule the download routes already
 * used, lifted here so the job builder can't drift from it.
 */
async function resolveWatermarkSettings(event) {
  const settings = await watermarkService.getWatermarkSettings();
  const eventEnabled = event.watermark_downloads === true || event.watermark_downloads === 1;
  const shouldApply = (settings && settings.enabled) || eventEnabled;
  if (!shouldApply) return null;
  return {
    ...settings,
    enabled: true,
    text: event.watermark_text || settings?.text || 'Protected',
  };
}

module.exports = {
  renderPhotoForDownload,
  renderPreviewForDownload,
  previewDownloadName,
  resolveWatermarkSettings,
  isVideo,
  getStorage,
};
