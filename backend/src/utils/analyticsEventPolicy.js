'use strict';

// Only known PicPeak events and bounded non-identifying properties cross the
// analytics boundary. No DOM contents, bearer URLs, user IDs or free text.
const EVENT_NAMES = new Set([
  'gallery_password_entry', 'gallery_photo_view', 'gallery_photo_download',
  'gallery_gallery_expired', 'gallery_bulk_download', 'photo_download',
  'expiration_warning_viewed', 'search_performed', 'gallery_devtools_detected',
  'thumbnail_protection_violation', 'lightbox_devtools_detected', 'lightbox_protection_violation',
]);
const NUMBERS = new Set(['photo_count', 'days_remaining', 'query_length', 'results_count', 'statusCode', 'zoom']);
const BOOLEANS = new Set(['success', 'bulk', 'is_download_all']);
const ENUMS = {
  context: ['gallery'],
  protectionLevel: ['basic', 'standard', 'enhanced', 'maximum'],
  violationType: ['devtools_detected', 'print_screen_detected', 'canvas_access_blocked',
    'right_click', 'drag_attempt', 'keyboard_shortcut', 'screenshot_attempt',
    'context_menu', 'print_attempt', 'canvas_access', 'save_attempt', 'drag_start',
    'text_selection', 'suspicious_visibility_change', 'clipboard_copy', 'clipboard_paste'],
};
const PRIVATE_ROOTS = new Set(['admin', 'customer', 's', 'invite', 'quote', 'contract',
  'payment-check', 'transfer', 'transfer-upload', 'slideshow']);

/** A closed route representation, not an opaque-token length heuristic. */
function analyticsPath(raw) {
  if (typeof raw !== 'string' || raw.length > 2048 || !raw.startsWith('/')) return null;
  let path;
  try { path = decodeURIComponent(raw.split(/[?#]/)[0]); } catch (_) { return null; }
  if (/[\\%?#]/.test(path) || Array.from(path).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return null;
  const parts = path.split('/').filter(Boolean);
  if (parts.some(p => p === '.' || p === '..')) return null;
  const first = (parts[0] || '').toLowerCase();
  if (PRIVATE_ROOTS.has(first)) return null;
  if (first === 'gallery') {
    if (!parts[1] || !/^[A-Za-z0-9_-]{1,100}$/.test(parts[1])
      || ['client-access', 'show'].includes((parts[2] || '').toLowerCase())) return null;
    // Every suffix is a capability or private gallery state, even a short or
    // percent-encoded token. Never preserve it based on its apparent entropy.
    return '/gallery/' + parts[1] + (parts.length > 2 ? '/[redacted]' : '');
  }
  if (!parts.length) return '/';
  // Public CMS/legal pages have one slug. Unknown nested routes fail closed.
  return parts.length === 1 && /^[A-Za-z0-9_-]{1,100}$/.test(parts[0]) ? '/' + parts[0] : null;
}

function validProperty(key, value) {
  if (NUMBERS.has(key)) return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000000;
  if (BOOLEANS.has(key)) return typeof value === 'boolean';
  return Object.hasOwn(ENUMS, key) && ENUMS[key].includes(value);
}

function validCache(cache) {
  return cache && typeof cache === 'object' && !Array.isArray(cache)
    && Object.keys(cache).every(k => k === 'site' || k === 'token')
    && typeof cache.site === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(cache.site)
    && typeof cache.token === 'string' && cache.token.length <= 2048
    && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cache.token);
}

function validateEvent(body) {
  const keys = new Set(['type', 'path', 'hostname', 'language', 'screenWidth', 'screenHeight', 'name', 'data', 'cache']);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !keys.has(k))) return null;
  if (body.type !== 'pageview' && body.type !== 'event') return null;
  const path = analyticsPath(body.path);
  // Clients still send a hostname; it is shape-checked and then dropped. The
  // route derives the reported hostname from the site itself.
  if (!path || (body.hostname !== undefined
    && (typeof body.hostname !== 'string' || !/^[A-Za-z0-9.[\]:-]{1,100}$/.test(body.hostname)))) return null;
  if (typeof body.language !== 'string' || !/^[A-Za-z0-9-]{0,35}$/.test(body.language)) return null;
  if (![body.screenWidth, body.screenHeight].every(n => Number.isInteger(n) && n >= 0 && n <= 9999)) return null;
  if (body.cache !== undefined && !validCache(body.cache)) return null;
  if (body.type === 'pageview' && (body.name !== undefined || body.data !== undefined)) return null;
  if (body.type === 'event') {
    if (!EVENT_NAMES.has(body.name) || !body.data || typeof body.data !== 'object' || Array.isArray(body.data)
      || Object.entries(body.data).some(([k, v]) => !validProperty(k, v))) return null;
  }
  const { hostname: _clientHostname, ...event } = body;
  return { ...event, path };
}

module.exports = { analyticsPath, validateEvent, validCache };
