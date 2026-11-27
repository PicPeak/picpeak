/**
 * What a gallery guest is shown of a photo's view tiers: its watermark and,
 * at maximum protection, the capped copy. The gallery's media routes and the
 * public website (issue 2618) both decide and render through here, so the
 * website is never looser than the gallery.
 */
const sharp = require('./isolatedSharp');
const watermarkService = require('./watermarkService');
const { withLocalCopy } = require('./imageProcessor');
const { MAXIMUM_PROTECTION_CAP } = require('./galleryAssetPolicy');
const { isGalleryPriced, resolvePhotoSalesWatermarkSettings } = require('../modules/photoSales/priceRules');

/**
 * The watermark a view tier (thumbnail, hero, preview) carries: the event's
 * watermark settings, or in a priced gallery the photo-sales mark, which
 * every tier keeps independent of the global setting. The photo route has
 * its own rule (event-only mark, purchased viewers).
 */
async function viewWatermarkSettings(event, photo) {
  const settings = await watermarkService.getWatermarkSettingsForEvent(event);
  return isGalleryPriced(event) ? resolvePhotoSalesWatermarkSettings(event, photo) : settings;
}

/**
 * A preview rendition inside MAXIMUM_PROTECTION_CAP (issue 2152), re-encoded
 * at its quality, with no metadata (sharp strips it). Maximum protection
 * serves this from both the photo and the preview route, so the lightbox gets
 * the cap whether it loads the preview tier or the original. The preview tier
 * is the source, so a request decodes at most a 1920px image, in the image
 * worker pool (`interactive`: refused with a 503 under a flood, not queued);
 * no further derived file is stored. The watermark goes on first, through the
 * same path-keyed cache the preview route uses, and is scaled down with the
 * picture; marking after the resize would re-encode at the watermark's own
 * quality. A WebP preview (alpha or animation) stays WebP, and without a
 * watermark an animated one keeps its frames: the preview generator leaves
 * them unrotated, so they are not rotated here either (`.rotate()` flattens).
 */
async function capPreviewRendition(previewPath, watermarkSettings) {
  const webp = previewPath.endsWith('.webp');
  const { width, height, quality } = MAXIMUM_PROTECTION_CAP;
  const buffer = await withLocalCopy(previewPath, async (localPath) => {
    const input = watermarkSettings?.enabled
      ? await watermarkService.applyWatermark(localPath, watermarkSettings, { failClosed: true })
      : localPath;
    const animated = webp && !watermarkSettings?.enabled
      && ((await sharp(input, { interactive: true, failOn: 'none' }).metadata()).pages || 1) > 1;
    let image = sharp(input, { interactive: true, failOn: 'none', animated });
    if (!animated) image = image.rotate();
    image = image.resize(width, height, { fit: 'inside', withoutEnlargement: true });
    return (webp ? image.webp({ quality }) : image.jpeg({ quality, progressive: true, mozjpeg: true })).toBuffer();
  });
  return { buffer, contentType: webp ? 'image/webp' : 'image/jpeg' };
}

/**
 * A preview rendition with `watermarkSettings` drawn on (fail closed), in the
 * preview's own format, through applyWatermark's path-keyed cache.
 */
async function watermarkPreviewRendition(previewPath, watermarkSettings) {
  return withLocalCopy(previewPath, (localPath) =>
    watermarkService.applyWatermark(localPath, watermarkSettings, { failClosed: true }));
}

module.exports = { viewWatermarkSettings, capPreviewRendition, watermarkPreviewRendition };
