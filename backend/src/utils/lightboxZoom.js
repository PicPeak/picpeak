/**
 * Maximum lightbox zoom (issue 2281): how far guests may magnify a photo
 * whose original the lightbox has loaded, in percent of the original's own
 * pixels. 100 keeps the old ceiling: the original's pixels, or 3x of fit when
 * that is more.
 */
const LIGHTBOX_MAX_ZOOM_KEY = 'gallery_lightbox_max_zoom_percent';
const MIN_LIGHTBOX_ZOOM_PERCENT = 100;
const MAX_LIGHTBOX_ZOOM_PERCENT = 1000;
const DEFAULT_LIGHTBOX_ZOOM_PERCENT = 100;

/** The stored value as an integer in range, or null when it is not one. */
function parseLightboxMaxZoomPercent(raw) {
  if (raw === null || raw === undefined || raw === '' || typeof raw === 'boolean') return null;
  const value = Number(raw);
  return Number.isInteger(value)
    && value >= MIN_LIGHTBOX_ZOOM_PERCENT
    && value <= MAX_LIGHTBOX_ZOOM_PERCENT
    ? value
    : null;
}

module.exports = {
  LIGHTBOX_MAX_ZOOM_KEY,
  MIN_LIGHTBOX_ZOOM_PERCENT,
  MAX_LIGHTBOX_ZOOM_PERCENT,
  DEFAULT_LIGHTBOX_ZOOM_PERCENT,
  parseLightboxMaxZoomPercent,
};
