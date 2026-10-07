/**
 * PicPeak-owned, data-only telemetry. Never load or re-serve provider code.
 * Legacy script, arbitrary beacon, config, feature-flag and replay endpoints
 * are intentionally absent. The one POST builds a closed provider payload,
 * pins each network connection, and discards all upstream content except a
 * bounded opaque Umami cache token returned in our own JSON envelope.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { rateLimitKey } = require('../utils/rateLimitKey');
const { getAppSetting } = require('../utils/appSettings');
const { integrationRelay } = require('../utils/integrationHttp');
const { clientIpForAudit } = require('../utils/clientIp');
const { validateEvent, validCache } = require('../utils/analyticsEventPolicy');
const logger = require('../utils/logger');
const router = express.Router();
const MAX_RESPONSE_BYTES = 16 * 1024;
let cache = { at: 0, value: undefined };

async function resolveUpstream() {
  if (cache.value !== undefined && Date.now() - cache.at < 30000) return cache.value;
  const explicit = await getAppSetting('analytics_tracker_provider', null);
  const legacy = !explicit && await getAppSetting('analytics_umami_enabled', false);
  const provider = explicit || ((legacy === true || legacy === 'true') ? 'umami' : 'none');
  let value = null;
  if (provider === 'umami' || provider === 'rybbit') {
    const raw = await getAppSetting('analytics_' + provider + '_url', null);
    const site = await getAppSetting('analytics_' + provider + '_website_id', null);
    try {
      const url = new URL(raw);
      const insecureDev = process.env.NODE_ENV !== 'production' && process.env.ANALYTICS_ALLOW_INSECURE_HTTP === 'true';
      if ((url.protocol === 'https:' || (url.protocol === 'http:' && insecureDev))
        && typeof site === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(site)) {
        // Strip userinfo, query and fragment. Existing base subpaths survive.
        value = { provider, site, base: url.origin + url.pathname.replace(/\/+$/, '') };
      } else logger.warn('Analytics: configure an HTTPS collector and valid site ID; custom scripts are disabled');
    } catch (_) { logger.warn('Analytics: invalid collector URL'); }
  }
  cache = { at: Date.now(), value };
  return value;
}

router.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  next();
});
router.use(rateLimit({
  windowMs: 60000, max: 120, standardHeaders: true, legacyHeaders: false,
  keyGenerator: rateLimitKey, handler: (req, res) => res.sendStatus(429),
}));
router.post('/events', express.json({ limit: '4kb', strict: true }), async (req, res) => {
  const event = validateEvent(req.body);
  if (!event) return res.status(400).json({ error: 'Invalid analytics event' });
  // Independent of the browser preference, never relay an opted-out request.
  if (req.get('DNT') === '1' || req.get('Sec-GPC') === '1') return res.sendStatus(204);
  let upstream;
  try { upstream = await resolveUpstream(); }
  catch (err) {
    logger.debug('Analytics: collector settings unavailable', { error: err.message });
    return res.sendStatus(502);
  }
  if (!upstream) return res.sendStatus(404);
  const headers = { 'content-type': 'application/json' };
  if (req.get('user-agent')) headers['user-agent'] = req.get('user-agent');
  const ip = clientIpForAudit(req);
  if (ip) { headers['x-forwarded-for'] = ip; headers['x-real-ip'] = ip; }
  let payload; let endpoint;
  if (upstream.provider === 'umami') {
    endpoint = '/api/send';
    payload = { type: 'event', payload: {
      website: upstream.site, hostname: event.hostname, language: event.language,
      screen: event.screenWidth + 'x' + event.screenHeight,
      url: event.path, title: '', referrer: '',
      ...(event.type === 'event' ? { name: event.name, data: event.data } : {}),
    } };
    if (event.cache?.site === upstream.site) headers['x-umami-cache'] = event.cache.token;
  } else {
    endpoint = '/api/track';
    payload = {
      site_id: upstream.site, hostname: event.hostname, pathname: event.path,
      querystring: '', screenWidth: event.screenWidth, screenHeight: event.screenHeight,
      language: event.language, page_title: '', referrer: '',
      type: event.type === 'pageview' ? 'pageview' : 'custom_event',
      ...(event.type === 'event' ? { event_name: event.name, properties: JSON.stringify(event.data) } : {}),
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await integrationRelay(upstream.base + endpoint, {
      method: 'POST', headers, body: Buffer.from(JSON.stringify(payload)),
      signal: controller.signal, maxBytes: MAX_RESPONSE_BYTES,
      allowPrivate: process.env.NODE_ENV !== 'production',
    });
    if (response.status < 200 || response.status >= 300) return res.sendStatus(502);
    // Never forward status/body/headers verbatim, including JavaScript MIME,
    // Set-Cookie, redirects, provider globals or response-defined commands.
    let safeCache;
    if (upstream.provider === 'umami') {
      try {
        const parsed = JSON.parse(response.body.toString('utf8'));
        const candidate = { site: upstream.site, token: parsed?.cache };
        if (validCache(candidate)) safeCache = candidate;
      } catch (_) { /* An opaque/non-JSON provider response is discarded. */ }
    }
    return res.json(safeCache ? { cache: safeCache } : {});
  } catch (err) {
    logger.debug('Analytics: event forwarding failed', { error: err.message });
    return res.sendStatus(502);
  } finally { clearTimeout(timer); }
});
router.all('*', (req, res) => res.sendStatus(404));
module.exports = router;
