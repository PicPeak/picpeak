/**
 * Rybbit metrics-API adapter (#663 Phase 1).
 *
 * Rybbit is a self-hosted privacy-friendly analytics product (https://rybbit.io).
 * Reporter @alexvaltchev specifically asked for it in #661 follow-up, hence
 * its inclusion as the second native adapter alongside Umami.
 *
 * Contract: matches `umamiAdapter` exactly so the dashboard route can call
 * either via the factory.
 *
 * Auth: Rybbit v1 issues per-account API keys (Account → Settings → API
 * Keys). Sent via `Authorization: Bearer <key>`. Their docs at
 * https://rybbit.io/docs/api describe the analytics endpoints.
 *
 * Endpoint shape (Rybbit v1 stats API, devices breakdown):
 *
 *   GET {baseUrl}/api/site/{websiteId}/breakdown
 *     ?dimension=device
 *     &start={iso8601-or-epoch-ms}
 *     &end={iso8601-or-epoch-ms}
 *
 * Returns rows like `[{ device: 'desktop', visitors: 123, sessions: 456 }, …]`.
 * We aggregate `sessions` into the same 3-bucket shape Umami returns.
 *
 * Per-bucket naming: Rybbit reports `desktop` / `mobile` / `tablet`
 * directly (matches our UI). Anything unrecognised is dropped rather than
 * silently miscategorised.
 *
 * NOTE: Rybbit's API is on v0.x at the time of writing. The endpoint /
 * dimension names below match the documented v1 GA shape; if a tester
 * confirms a deviation in the wild we adjust here, and the rest of the
 * codebase keeps working because the adapter returns null on shape
 * mismatch (route falls back to access_logs).
 */

const logger = require('../../utils/logger');

const REQUEST_TIMEOUT_MS = 5000;

function buildAdapter({ baseUrl, websiteId, apiKey }) {
  return {
    provider: 'rybbit',
    async fetchDeviceBreakdown({ startMs, endMs }) {
      if (!baseUrl || !websiteId || !apiKey) return null;

      const trimmedBase = String(baseUrl).replace(/\/+$/, '');
      const startIso = new Date(startMs).toISOString();
      const endIso = new Date(endMs).toISOString();
      const url = `${trimmedBase}/api/site/${encodeURIComponent(websiteId)}/breakdown`
        + `?dimension=device&start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
          },
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') {
          logger.warn('Rybbit device fetch: timeout', { url });
          return null;
        }
        logger.warn('Rybbit device fetch: network error', { error: err.message });
        return null;
      }
      clearTimeout(timer);

      if (!response.ok) {
        logger.warn('Rybbit device fetch: non-2xx', { status: response.status });
        return null;
      }

      let data;
      try {
        data = await response.json();
      } catch (err) {
        logger.warn('Rybbit device fetch: invalid JSON', { error: err.message });
        return null;
      }

      // Rybbit might return either `[…]` or `{ data: [...] }` depending on
      // version. Accept both shapes defensively.
      const rows = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : null);
      if (!rows) return null;

      const counts = { desktop: 0, mobile: 0, tablet: 0 };
      let total = 0;
      for (const entry of rows) {
        if (!entry) continue;
        // Tolerate either `device` or generic `dimension` key for the bucket
        // label. Numeric metric prefers sessions, falls back to visitors.
        const bucket = entry.device || entry.dimension || entry.name;
        if (typeof bucket !== 'string') continue;
        const n = Number(entry.sessions ?? entry.visitors ?? entry.value ?? entry.count);
        if (!Number.isFinite(n) || n <= 0) continue;
        const key = bucket.toLowerCase();
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
