/**
 * Cached read of the global Live-Slideshow settings (Settings → Slideshow) +
 * the branding logo URLs the watermark resolves against.
 *
 * Why: a running projector polls `/show/:token/state` every ~3s, and each poll
 * resolved the watermark/fit by firing ~7–10 individual `getAppSetting` reads.
 * A leaked link × N tabs amplifies that linearly (PR #646 review, concern 2).
 * These globals change only via `PUT /admin/settings/slideshow`, so we cache
 * the whole bundle with a short TTL and invalidate on write — admin live-edit
 * stays effectively instant, and steady-state polls drop to ~0 settings reads.
 */
const { getAppSetting } = require('./appSettings');

const TTL_MS = 5000;
let cache = null; // { at, val }

async function getSlideshowGlobals() {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.val;

  const [
    enabled, source, position, opacity, style, size, fit,
    logo, logoDark, favicon,
  ] = await Promise.all([
    getAppSetting('slideshow_watermark_enabled', false),
    getAppSetting('slideshow_watermark_source', 'logo'),
    getAppSetting('slideshow_watermark_position', 'bottom-right'),
    getAppSetting('slideshow_watermark_opacity', 60),
    getAppSetting('slideshow_watermark_style', 'white'),
    getAppSetting('slideshow_watermark_size', 12),
    getAppSetting('slideshow_fit', 'cover'),
    getAppSetting('branding_logo_url', null),
    getAppSetting('branding_logo_url_dark', null),
    getAppSetting('branding_favicon_url', null),
  ]);

  const val = {
    watermark_enabled: enabled === true,
    watermark_source: source || 'logo',
    watermark_position: position || 'bottom-right',
    watermark_opacity: opacity ?? 60,
    watermark_style: style || 'white',
    watermark_size: size ?? 12,
    fit: fit === 'contain' ? 'contain' : 'cover',
    branding_logo_url: logo || null,
    branding_logo_url_dark: logoDark || null,
    branding_favicon_url: favicon || null,
  };
  cache = { at: now, val };
  return val;
}

/** Clear the cache — call after any write to the slideshow_* / branding logo settings. */
function invalidateSlideshowGlobals() {
  cache = null;
}

module.exports = { getSlideshowGlobals, invalidateSlideshowGlobals };
