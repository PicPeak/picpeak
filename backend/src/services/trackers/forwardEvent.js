/**
 * Sending one data-only event to the configured analytics collector (Umami
 * or Rybbit), from the server. Shared by the admin app's tracker proxy
 * (routes/analyticsTrackerProxy.js) and the website's page views (issue
 * 2618): no provider script is ever loaded, so no page needs it in its CSP.
 */
const { getAppSetting } = require('../../utils/appSettings');
const { integrationRelay } = require('../../utils/integrationHttp');
const logger = require('../../utils/logger');

const MAX_RESPONSE_BYTES = 16 * 1024;
let cache = { at: 0, value: undefined };

/** The configured collector as { provider, site, base }, or null. Cached 30 s. */
async function resolveUpstream() {
  if (cache.value !== undefined && Date.now() - cache.at < 30000) return cache.value;
  const explicit = await getAppSetting('analytics_tracker_provider', null);
  const legacy = !explicit && await getAppSetting('analytics_umami_enabled', false);
  const provider = explicit || ((legacy === true || legacy === 'true') ? 'umami' : 'none');
  let value = null;
  if (provider === 'umami' || provider === 'rybbit') {
    const raw = await getAppSetting('analytics_' + provider + '_url', null);
    const site = await getAppSetting('analytics_' + provider + '_website_id', null);
    // No collector configured yet is a normal state, not a warning per request.
    if (raw) {
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
  }
  cache = { at: Date.now(), value };
  return value;
}

/**
 * Whether the visitor opted out. Global Privacy Control always counts as one.
 * Do Not Track does unless the operator switched that off (issue 1921);
 * unreadable settings honour it.
 */
async function optedOut({ gpc, dnt }) {
  if (gpc === '1') return true;
  if (dnt !== '1') return false;
  try {
    const stored = await getAppSetting('analytics_honor_do_not_track', true);
    return stored !== false && stored !== 'false';
  } catch (_) {
    return true;
  }
}

/**
 * Relay one event ({ type: 'pageview' | 'event', path, language,
 * screenWidth, screenHeight, name?, data? }) to `upstream`. Returns the
 * relay response; throws on a network failure.
 */
async function forwardEvent(upstream, event, { userAgent, ip, hostname, cacheToken } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (userAgent) headers['user-agent'] = userAgent;
  if (ip) { headers['x-forwarded-for'] = ip; headers['x-real-ip'] = ip; }
  let payload; let endpoint;
  if (upstream.provider === 'umami') {
    endpoint = '/api/send';
    payload = { type: 'event', payload: {
      website: upstream.site, hostname, language: event.language,
      screen: event.screenWidth + 'x' + event.screenHeight,
      url: event.path, title: '', referrer: '',
      ...(event.type === 'event' ? { name: event.name, data: event.data } : {}),
    } };
    if (cacheToken) headers['x-umami-cache'] = cacheToken;
  } else {
    endpoint = '/api/track';
    payload = {
      site_id: upstream.site, hostname, pathname: event.path,
      querystring: '', screenWidth: event.screenWidth, screenHeight: event.screenHeight,
      language: event.language, page_title: '', referrer: '',
      type: event.type === 'pageview' ? 'pageview' : 'custom_event',
      ...(event.type === 'event' ? { event_name: event.name, properties: JSON.stringify(event.data) } : {}),
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    return await integrationRelay(upstream.base + endpoint, {
      method: 'POST', headers, body: Buffer.from(JSON.stringify(payload)),
      signal: controller.signal, maxBytes: MAX_RESPONSE_BYTES,
      allowPrivate: process.env.NODE_ENV !== 'production',
    });
  } finally { clearTimeout(timer); }
}

module.exports = { resolveUpstream, optedOut, forwardEvent };
