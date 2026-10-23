function isGalleryPriced(event) {
  return !!(event && (event.is_priced === true || event.is_priced === 1 || event.is_priced === '1'));
}

function normaliseFreeCount(event) {
  const raw = Number(event?.free_photo_count ?? 0);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

function normalisePrice(event) {
  const raw = Number(event?.photo_price ?? 0);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/**
 * Per-ORDER free allocation: in a priced gallery the first
 * `free_photo_count` line items of a checkout are free — the buyer's own
 * choice, in the order they were added. Every line beyond that carries the
 * gallery price (or its per-photo override). Mirrors the client-side cart
 * allocation in frontend/src/features/photo-sales, and is re-verified here
 * at order.completed against the DB.
 */
function allocateFreeLines(event, items) {
  const freeCount = normaliseFreeCount(event);
  const lines = [];
  (Array.isArray(items) ? items : []).forEach((item, index) => {
    const photoId = Number(item?.photoId ?? item?.photo_id ?? item?.id ?? 0);
    const validId = Number.isFinite(photoId) && photoId > 0;
    const free = validId && index < freeCount;
    lines.push({
      photoId: validId ? photoId : null,
      free,
      amountCents: free ? 0 : Math.round(effectivePhotoPrice(event, item) * 100),
    });
  });
  return lines;
}

/**
 * True for EVERY photo of a priced gallery. Which photos end up free is
 * decided per order (see allocateFreeLines) — before checkout no photo may
 * be served clean, so the forced watermark applies to all of them.
 */
function shouldForceWatermarkForPhoto(event, _photo) {
  return isGalleryPriced(event);
}

/**
 * The effective price of ONE paid photo: the per-photo override when set,
 * otherwise the gallery default. NULL/empty override = gallery default.
 */
function effectivePhotoPrice(event, photo) {
  const override = photo?.photo_price;
  if (override !== null && override !== undefined && override !== '') {
    const value = Number(override);
    if (Number.isFinite(value)) return value;
  }
  return normalisePrice(event);
}

/**
 * Effective watermark settings for one photo. For paid photos in priced
 * galleries the existing watermark pipeline is FORCED on — stronger and
 * tiled across the whole image, regardless of the global/gallery watermark
 * setting. For everything else the original global-OR-event rule applies
 * unchanged.
 */
async function resolvePhotoSalesWatermarkSettings(event, _photo) {
  const watermarkService = require('../../services/watermarkService');
  const settings = await watermarkService.getWatermarkSettings();

  // PHOTO-SALES: every photo of a priced gallery carries the forced tiled
  // mark before purchase. The free quota is decided per ORDER, so no photo
  // can be served clean in advance.
  if (isGalleryPriced(event)) {
    return {
      ...(settings || {}),
      enabled: true,
      tiled: true,
      position: 'center',
      opacity: Math.max(Number(settings?.opacity) || 0, 40),
      size: Math.max(Number(settings?.size) || 0, 20),
      text: event.watermark_text || settings?.companyName || 'Preview',
    };
  }

  const eventEnabled = event.watermark_downloads === true
    || event.watermark_downloads === 1
    || event.watermark_downloads === '1';
  const shouldApply = (settings && settings.enabled) || eventEnabled;
  if (!shouldApply) return null;
  return {
    ...settings,
    enabled: true,
    text: event.watermark_text || settings?.text || 'Protected',
  };
}

/**
 * Watermark settings for a PRE-CHECKOUT download of any photo in a priced
 * gallery. No original may leave the server before checkout, so every photo
 * ships watermarked (tiled, strong) — the free quota only decides the price,
 * never what the buyer sees beforehand.
 */
async function resolveForcedWatermarkSettingsForPhoto(event, photo) {
  const settings = await resolvePhotoSalesWatermarkSettings(event, photo);
  if (settings) return settings;
  const watermarkService = require('../../services/watermarkService');
  const global = await watermarkService.getWatermarkSettings();
  return {
    ...(global || {}),
    enabled: true,
    tiled: true,
    position: 'center',
    opacity: Math.max(Number(global?.opacity) || 0, 40),
    size: Math.max(Number(global?.size) || 0, 20),
    text: event.watermark_text || global?.companyName || 'Preview',
  };
}

module.exports = {
  isGalleryPriced,
  normaliseFreeCount,
  normalisePrice,
  effectivePhotoPrice,
  allocateFreeLines,
  shouldForceWatermarkForPhoto,
  resolvePhotoSalesWatermarkSettings,
  resolveForcedWatermarkSettingsForPhoto,
};
