/**
 * Same-origin proxy for the admin-configured analytics tracker.
 *
 * WHY THIS EXISTS
 * ---------------
 * Settings → Analytics lets an admin point PicPeak at a self-hosted Umami or
 * Rybbit instance on an arbitrary domain, but the shipped CSP is a static
 * allowlist (`script-src 'self' https://www.google.com …` in
 * `frontend/nginx.conf` and in helmet's directives in `server.js`). Injecting
 * `<script src="https://analytics.example.com/script.js">` was therefore
 * ALWAYS blocked by the browser — silently, with only a console error, so
 * "not configured" and "configured but broken" looked identical to the admin.
 * The tracker's beacon endpoint had the same problem against `connect-src`.
 *
 * The CSP itself can't be made dynamic in the default Docker deployment:
 * nginx serves `index.html` off disk (`try_files … /index.html`) and strips
 * the backend's CSP with `proxy_hide_header Content-Security-Policy`, so
 * nginx's static header is the only policy governing the SPA document, and
 * the tracker URL lives in the DB rather than the environment.
 *
 * So instead of widening the policy, we remove the need to: the tracker
 * script and every endpoint it talks to are served from PicPeak's own origin
 * and proxied here. `script-src 'self'` and `connect-src 'self'` already
 * cover that, unchanged. This is the same first-party proxy setup both
 * vendors document (and recommend — it also survives ad blockers).
 *
 * SECURITY MODEL
 * --------------
 * The upstream base URL is admin-supplied, so this is an SSRF surface. It is
 * bounded by:
 *   - scheme restricted to http/https; userinfo (`https://u:p@host`) dropped
 *     by rebuilding from `origin` + `pathname`;
 *   - a DNS-resolving private/internal-address check (`isHostAllowed`) in
 *     production, matching the `s3Storage` precedent — development keeps
 *     working against a localhost tracker;
 *   - a per-provider allowlist of the exact paths each tracker's script
 *     actually calls, so this is not an open relay to the tracker host;
 *   - `redirect: 'error'`, a request timeout, a request-body cap and a
 *     streamed response-body cap;
 *   - a fixed forwarded-header set (never cookies, Authorization or
 *     arbitrary client headers);
 *   - a sanitised response Content-Type plus `nosniff`, so a tracker host
 *     cannot serve HTML/SVG through PicPeak's origin and get it rendered.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { getAppSetting } = require('../utils/appSettings');
const { isHostAllowed } = require('../utils/networkValidation');
const { clientIpForAudit } = require('../utils/clientIp');
const logger = require('../utils/logger');

const router = express.Router();

const REQUEST_TIMEOUT_MS = 5000;
// Beacon payloads are a few hundred bytes; 64 KB is generous headroom.
const MAX_REQUEST_BYTES = 64 * 1024;
// Umami's script.js is ~6 KB; Rybbit's full bundle (rrweb session replay)
// is a few hundred KB. 2 MB caps a hostile/broken upstream.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
// The settings read happens per beacon, so cache the resolved upstream.
// Short enough that saving Settings → Analytics takes effect without a
// restart, which is the whole point of not templating this at boot.
const CONFIG_TTL_MS = 30 * 1000;

/**
 * Per-provider mapping. `prefix` is what the tracker's own path is relative
 * to on the upstream, and `routes` is the closed set of method + path pairs
 * the tracker script is known to call.
 *
 * Umami   — `<script-dir>/script.js`, collect at `<script-dir>/api/send`
 *           (tracker: `host = data-host-url || currentScript.src` dir,
 *           `endpoint = host + '/api/send'`).
 * Rybbit  — `<prefix>/script.js` upstream `/api/script.js`, and the script
 *           derives `analyticsHost = src.split('/script.js')[0]`, then calls
 *           `<prefix>/track`, `<prefix>/site/tracking-config/<id>` and
 *           `<prefix>/site/<id>/feature-flags/evaluate`. That matches the
 *           mapping in Rybbit's own proxy guide.
 *           Session replay (`<prefix>/session-replay/record/<id>`) is
 *           deliberately NOT proxied: replaying gallery pages would ship the
 *           share token in the recording (GHSA-7m6c).
 */
const PROVIDERS = {
  umami: {
    urlKey: 'analytics_umami_url',
    prefix: '',
    routes: [
      ['GET', /^\/script\.js$/],
      ['POST', /^\/api\/send$/],
    ],
  },
  rybbit: {
    urlKey: 'analytics_rybbit_url',
    prefix: '/api',
    routes: [
      ['GET', /^\/script\.js$/],
      ['POST', /^\/track$/],
      ['GET', /^\/site\/tracking-config\/[A-Za-z0-9_-]{1,64}$/],
      ['POST', /^\/site\/[A-Za-z0-9_-]{1,64}\/feature-flags\/evaluate$/],
    ],
  },
};

// Client request headers forwarded upstream. `user-agent` and the client IP
// are what let the tracker keep doing device/geo attribution once traffic is
// first-party; `x-umami-cache` is an opaque session token Umami's own script
// echoes back. Everything else — cookies, Authorization, Referer, Origin —
// is dropped.
const FORWARDED_HEADERS = ['accept', 'accept-language', 'content-type', 'user-agent', 'x-umami-cache'];

// Response Content-Types we are willing to re-serve from our own origin.
// Anything else (text/html, image/svg+xml, …) becomes an inert download.
const SAFE_CONTENT_TYPES = new Set([
  'text/javascript',
  'application/javascript',
  'application/json',
  'text/plain',
]);

let cache = { at: 0, value: undefined };

/**
 * Read the tracker settings and turn them into `{ base, spec }`, or null when
 * no proxyable tracker is configured. Mirrors `services/trackers/index.js`'s
 * back-compat: a pre-#663 install with only `analytics_umami_enabled` set
 * still resolves to Umami.
 */
async function loadUpstream() {
  const explicit = await getAppSetting('analytics_tracker_provider', null);
  let provider = typeof explicit === 'string' && PROVIDERS[explicit] ? explicit : null;
  if (!explicit) {
    const legacy = await getAppSetting('analytics_umami_enabled', false);
    if (legacy === true || legacy === 'true') provider = 'umami';
  }
  if (!provider) return null;

  const spec = PROVIDERS[provider];
  const raw = await getAppSetting(spec.urlKey, null);
  if (!raw || typeof raw !== 'string') return null;

  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    logger.warn('Analytics tracker proxy: configured URL is not a valid URL', { provider });
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    logger.warn('Analytics tracker proxy: refusing non-HTTP tracker URL', {
      provider,
      protocol: parsed.protocol,
    });
    return null;
  }

  // SSRF: resolve-and-vet the host. Prod-only, matching the s3Storage /
  // MinIO gate — a dev install legitimately points at a localhost tracker,
  // and a tracker that is only reachable on an internal network could never
  // have worked from the browser anyway.
  if (process.env.NODE_ENV === 'production' && !(await isHostAllowed(parsed.hostname))) {
    logger.warn('Analytics tracker proxy: tracker host resolves to a private or internal address', {
      provider,
      host: parsed.hostname,
    });
    return null;
  }

  // Rebuild from origin + pathname: drops any userinfo, query and fragment
  // the admin may have pasted along with the base URL.
  const base = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  return { base, spec };
}

async function resolveUpstream() {
  if (cache.value !== undefined && Date.now() - cache.at < CONFIG_TTL_MS) {
    return cache.value;
  }
  const value = await loadUpstream();
  cache = { at: Date.now(), value };
  return value;
}

/**
 * Drain an upstream response body, aborting once it exceeds `max` bytes so a
 * hostile or broken tracker can't stream us out of memory.
 */
async function readBounded(response, max) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;

  if (!response.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function safeContentType(raw) {
  const base = String(raw || '').split(';')[0].trim().toLowerCase();
  return SAFE_CONTENT_TYPES.has(base)
    ? `${base}; charset=utf-8`
    : 'application/octet-stream';
}

// Gallery visitors are anonymous, so this route has to be unauthenticated —
// cap how hard one client can make PicPeak fetch from the tracker. A real
// visitor fires a handful of beacons a minute; this only bites abuse. Its own
// limiter rather than the app-wide one because that is created asynchronously
// after the database is up, long after this router is mounted.
router.use(rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.sendStatus(429),
}));

// Raw body: mounted before the app-wide express.json so the tracker's beacon
// payload (JSON, or text/plain from navigator.sendBeacon) reaches us intact.
router.use(express.raw({ type: () => true, limit: MAX_REQUEST_BYTES }));

router.all('*', async (req, res) => {
  const upstream = await resolveUpstream();
  if (!upstream) return res.sendStatus(404);

  const path = req.path;
  const allowed = upstream.spec.routes.some(([method, re]) => method === req.method && re.test(path));
  if (!allowed) return res.sendStatus(404);

  const headers = {};
  for (const name of FORWARDED_HEADERS) {
    const value = req.get(name);
    if (value) headers[name] = value;
  }
  // Let the tracker keep attributing visitors now that every request arrives
  // from PicPeak's server. req.ip (not the raw header) so Express's
  // trust-proxy configuration decides what is trustworthy.
  const ip = clientIpForAudit(req);
  if (ip) {
    headers['x-forwarded-for'] = ip;
    headers['x-real-ip'] = ip;
  }

  const body = Buffer.isBuffer(req.body) && req.body.length ? req.body : undefined;
  const controller = new AbortController();
  // The timeout deliberately stays armed across the body read too, so a
  // slow-loris upstream can't pin a request open past REQUEST_TIMEOUT_MS.
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let buffer;
  try {
    const response = await fetch(`${upstream.base}${upstream.spec.prefix}${path}`, {
      method: req.method,
      headers,
      body,
      // Never follow a redirect: an upstream 30x would move the request (and
      // the visitor's forwarded IP) to a host that never passed the checks
      // above.
      redirect: 'error',
      signal: controller.signal,
    });
    buffer = await readBounded(response, MAX_RESPONSE_BYTES);
    if (buffer === null) {
      logger.warn('Analytics tracker proxy: upstream response exceeds the size cap', { path });
      return res.sendStatus(502);
    }
    res.status(response.status);
    res.setHeader('Content-Type', safeContentType(response.headers.get('content-type')));
  } catch (err) {
    logger.debug('Analytics tracker proxy: upstream request failed', {
      path,
      error: err.message,
    });
    return res.sendStatus(502);
  } finally {
    clearTimeout(timer);
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Only the tracker script is safe to cache; beacons and per-site config
  // responses never are.
  res.setHeader('Cache-Control', path === '/script.js' ? 'public, max-age=300' : 'no-store');
  return res.send(buffer);
});

module.exports = router;
