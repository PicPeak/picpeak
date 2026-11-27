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
const { clientIpForAudit } = require('../utils/clientIp');
const { validateEvent, validCache } = require('../utils/analyticsEventPolicy');
const { getFrontendBaseUrl } = require('../utils/frontendUrl');
const { resolveUpstream, optedOut, forwardEvent } = require('../services/trackers/forwardEvent');
const logger = require('../utils/logger');
const router = express.Router();

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
  if (await optedOut({ gpc: req.get('Sec-GPC'), dnt: req.get('DNT') })) return res.sendStatus(204);
  let upstream;
  try { upstream = await resolveUpstream(); }
  catch (err) {
    logger.debug('Analytics: collector settings unavailable', { error: err.message });
    return res.sendStatus(502);
  }
  if (!upstream) return res.sendStatus(404);
  // The site reports its own hostname; the browser's claim is never relayed.
  let hostname = req.hostname || '';
  try { hostname = new URL(await getFrontendBaseUrl(req)).hostname || hostname; } catch (_) { /* no public origin known */ }
  try {
    const response = await forwardEvent(upstream, event, {
      userAgent: req.get('user-agent'),
      ip: clientIpForAudit(req),
      hostname,
      cacheToken: event.cache?.site === upstream.site ? event.cache.token : undefined,
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
  }
});
router.all('*', (req, res) => res.sendStatus(404));
module.exports = router;
