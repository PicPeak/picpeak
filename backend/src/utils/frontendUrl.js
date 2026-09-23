const { db } = require('../database/db');

// Terminal fallback for callers that need an ABSOLUTE url (emails, QR codes,
// payment links). Deliberately not the fallback of getFrontendBaseUrl(): some
// callers (shareLinkService, the SSO redirects in routes/auth) rely on an
// empty base to emit a RELATIVE url, which is the better answer for a
// same-origin redirect.
const DEFAULT_ABSOLUTE_BASE = 'http://localhost:3000';

// A loopback base is treated as "not configured" so a better answer can win.
// Rationale (#705): docker-compose used to inject
// FRONTEND_URL=http://localhost:3000 unconditionally, so millions of installs
// have it baked into their environment; taking it literally means gallery
// links, QR codes and reminder emails point every recipient at THEIR OWN
// machine. The same guard already existed locally in routes/gallery.js for
// the slideshow QR (#848) and is centralised here.
//
// The host token has to end at a real boundary. Bare prefix matching (which is
// what routes/gallery.js did while this only gated the QR) also demotes
// https://localhost-nas.example.com — a legitimate public host, and now that
// this predicate decides "is this configured" for the entire resolver, being
// demoted means the operator's configured address is silently ignored.
// 127. stays a bare prefix on purpose: all of 127.0.0.0/8 is loopback.
const LOOPBACK_BASE_RE = /^https?:\/\/(localhost(?=[:/?#]|$)|127\.|0\.0\.0\.0(?=[:/?#]|$)|\[::1\])/i;

const isLoopbackBase = (url) => !!url && LOOPBACK_BASE_RE.test(url);

const normalise = (val) => (typeof val === 'string' ? val.trim().replace(/\/+$/, '') : '');

// Cached copy of the `general_site_url` setting. Two reasons: this now sits in
// per-request paths (CORS headers), and the sync accessor below has no other
// way to see the database. Invalidated explicitly when settings are written;
// the TTL is the backstop for writes that bypass that path (a restore, a
// direct SQL edit), so the documented worst case is CACHE_MS of staleness.
const CACHE_MS = 30_000;
let cache = { value: '', at: 0, primed: false };

const readSettingFromDb = async () => {
  try {
    const setting = await db('app_settings')
      .where('setting_key', 'general_site_url')
      .select('setting_value')
      .first();

    if (!setting || !setting.setting_value) return '';
    let val = setting.setting_value;
    if (typeof val === 'string') {
      try { val = JSON.parse(val); } catch (_) { /* stored as a bare string */ }
    }
    return normalise(typeof val === 'string' ? val : '');
  } catch (_) {
    return '';
  }
};

const getSiteUrlSetting = async () => {
  const now = Date.now();
  if (cache.primed && now - cache.at < CACHE_MS) return cache.value;
  const value = await readSettingFromDb();
  cache = { value, at: now, primed: true };
  return value;
};

// Expire the entry WITHOUT blanking it, then refresh in the background.
// Blanking would leave the synchronous accessor (the CORS allowlists) with no
// value at all until some async caller happened to re-read, which for
// Access-Control-Allow-Origin means falling back to '*' - a wider header than
// the operator configured. A briefly-stale origin is the safer trade.
const invalidateSiteUrlCache = () => {
  cache = { ...cache, at: 0 };
  primeSiteUrlCache().catch(() => {});
};

// The origin the request itself arrived on. `trust proxy` is configured in
// server.js, so req.protocol honours X-Forwarded-Proto behind the standard
// reverse proxies. frontend/nginx.conf forwards $http_host, port included, but
// an outer proxy that forwards $host still strips a non-default port — which
// is why the setup wizard persists the browser's own window.location.origin
// instead of relying on this. It stays a last resort, and it is unavailable
// entirely to background jobs (reminder emails) that have no request.
const originFromRequest = (req) => {
  if (!req || typeof req.get !== 'function') return '';
  const host = req.get('host');
  if (!host) return '';
  const proto = req.protocol || 'http';
  return normalise(`${proto}://${host}`);
};

const envBase = () => normalise(process.env.FRONTEND_URL);

// The env value ONLY when it actually wins the resolution below — i.e. set and
// not loopback. A loopback FRONTEND_URL is demoted by getFrontendBaseUrl(), so
// reporting it as authoritative would lock the admin UI's Site URL field for
// exactly the operators this exists to unblock: an upgrade that still carries
// the old compose default FRONTEND_URL=http://localhost:3000 must be able to
// configure its public address through the wizard and Settings (#1104).
const envPinnedBase = () => {
  const env = envBase();
  return env && !isLoopbackBase(env) ? env : '';
};

// Is the public origin pinned by the environment? The admin UI uses this to
// show the Site URL field as read-only, so an operator never edits a setting
// that an env var is silently overriding. Mirrors the resolver exactly.
const isEnvPinned = () => !!envPinnedBase();

/**
 * Resolve the public origin, best answer first:
 *   1. FRONTEND_URL, when it is not loopback
 *   2. `options.override` - a purpose-specific env var (ADMIN_URL, APP_URL)
 *      the caller passes in, when it is not loopback
 *   3. the `general_site_url` setting, when it is not loopback
 *   4. the origin this request arrived on, when it is not loopback
 *   5. whichever of the above exists at all (covers a genuine localhost install)
 *   6. '' - caller decides between a relative url and DEFAULT_ABSOLUTE_BASE
 *
 * (2) exists because split-origin deployments are supported (API_URL, #798):
 * an operator who sets ADMIN_URL for a separate admin host has stated an
 * explicit per-purpose intent, and that must beat a value derived from the
 * database or from whichever request happened to trigger the email (#1104).
 * It sits BELOW FRONTEND_URL to preserve the historic
 * `FRONTEND_URL || ADMIN_URL` order those call sites used.
 */
const getFrontendBaseUrl = async (req, options = {}) => {
  // Short-circuit before touching the database: a pinned, non-loopback
  // FRONTEND_URL is the answer, and this runs in per-request paths.
  const env = envBase();
  if (env && !isLoopbackBase(env)) return env;

  const override = normalise(options.override);
  if (override && !isLoopbackBase(override)) return override;

  const setting = await getSiteUrlSetting();
  if (setting && !isLoopbackBase(setting)) return setting;

  const request = originFromRequest(req);
  if (request && !isLoopbackBase(request)) return request;

  return env || override || setting || request || '';
};

/** Same precedence, for callers that must produce an absolute url. */
const getAbsoluteFrontendUrl = async (req, options = {}) =>
  (await getFrontendBaseUrl(req, options)) || DEFAULT_ABSOLUTE_BASE;

/**
 * Synchronous variant for call sites that cannot await (Express middleware
 * setting a response header). Sees the environment and the last cached
 * setting only - it never reaches the database - so prime the cache at boot
 * via primeSiteUrlCache().
 */
const getFrontendBaseUrlSync = (req) => {
  const env = envBase();
  const setting = cache.primed ? cache.value : '';
  const request = originFromRequest(req);

  for (const candidate of [env, setting, request]) {
    if (candidate && !isLoopbackBase(candidate)) return candidate;
  }
  return env || setting || request || '';
};

const primeSiteUrlCache = async () => {
  cache = { value: await readSettingFromDb(), at: Date.now(), primed: true };
  return cache.value;
};

/**
 * Public API origin used for assets that email clients must load. Explicit
 * API_URL wins (split-origin deployments); otherwise it is the resolved
 * public origin + /api, so the wizard's single answer covers it.
 */
const getApiBaseUrl = async (req) => {
  const explicit = normalise(process.env.API_URL);
  if (explicit) return explicit;
  return `${await getAbsoluteFrontendUrl(req)}/api`;
};

module.exports = {
  getFrontendBaseUrl,
  getAbsoluteFrontendUrl,
  getFrontendBaseUrlSync,
  getApiBaseUrl,
  invalidateSiteUrlCache,
  primeSiteUrlCache,
  isLoopbackBase,
  isEnvPinned,
  envPinnedBase,
  DEFAULT_ABSOLUTE_BASE,
};
