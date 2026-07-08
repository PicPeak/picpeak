/**
 * Umami v2 metrics-API adapter (#663 — extracted from `services/umamiClient.js`
 * during the pluggable-tracker refactor in #663 Phase 1).
 *
 * Contract — every tracker adapter implements `fetchDeviceBreakdown` with
 * the same signature so the dashboard route can call them interchangeably
 * via the factory in `./index.js`:
 *
 *   fetchDeviceBreakdown({ startMs, endMs }) → { desktop, mobile, tablet } | null
 *
 * Returns null on missing config / non-2xx / parse error / network error so
 * the route layer can fall back to the local access_logs heuristic.
 *
 * Auth: per-account API keys generated in Umami → Settings → Profile → API
 * Keys. Sent via the `x-umami-api-key` header. Older session-cookie auth is
 * intentionally NOT supported — operators should issue an API key rather
 * than embedding their Umami password in PicPeak.
 */

const logger = require('../../utils/logger');

const REQUEST_TIMEOUT_MS = 5000;

function buildAdapter({ baseUrl, websiteId, apiKey }) {
  return {
    provider: 'umami',
    async fetchDeviceBreakdown({ startMs, endMs }) {
      if (!baseUrl || !websiteId || !apiKey) return null;

      const trimmedBase = String(baseUrl).replace(/\/+$/, '');
      const url = `${trimmedBase}/api/websites/${encodeURIComponent(websiteId)}/metrics`
        + `?type=device&startAt=${encodeURIComponent(startMs)}&endAt=${encodeURIComponent(endMs)}`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(url, {
          method: 'GET',
          headers: {
            'x-umami-api-key': apiKey,
            Accept: 'application/json',
          },
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') {
          logger.warn('Umami device fetch: timeout', { url });
          return null;
        }
        logger.warn('Umami device fetch: network error', { error: err.message });
        return null;
      }
      clearTimeout(timer);

      if (!response.ok) {
        logger.warn('Umami device fetch: non-2xx', { status: response.status });
        return null;
      }

      let data;
      try {
        data = await response.json();
      } catch (err) {
        logger.warn('Umami device fetch: invalid JSON', { error: err.message });
        return null;
      }

      if (!Array.isArray(data)) return null;

      // Umami buckets device types into these strings: `desktop`, `mobile`,
      // `tablet`, `laptop`. Map `laptop` → `desktop` for our 3-bucket UI; drop
      // anything we don't recognise (vs. silently miscategorising).
      const counts = { desktop: 0, mobile: 0, tablet: 0 };
      let total = 0;
      for (const entry of data) {
        if (!entry || typeof entry.x !== 'string') continue;
        const n = Number(entry.y);
        if (!Number.isFinite(n) || n <= 0) continue;
        const key = entry.x === 'laptop' ? 'desktop' : entry.x;
        if (key in counts) {
          counts[key] += n;
          total += n;
        }
      }

      if (total === 0) return null;

      return {
        desktop: Math.round((counts.desktop / total) * 100),
        mobile: Math.round((counts.mobile / total) * 100),
        tablet: Math.round((counts.tablet / total) * 100),
      };
    },
  };
}

module.exports = { buildAdapter };
