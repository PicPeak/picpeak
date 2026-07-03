/**
 * Cache-Control: no-store helper for sensitive endpoints.
 *
 * Why a dedicated middleware: shipping the wrong cache-control header
 * on a session-bearing endpoint is a class-of-bug that bites long
 * after the original mistake. The PR #458 / PR #470 history is the
 * concrete trigger:
 *
 *   - #458 mounted requireCustomerPortalEnabled which 410'd every
 *     /api/customer/* and /api/admin/customers/* request when the
 *     master toggle was off.
 *   - Some browsers cached the 410 (the response carried no explicit
 *     Cache-Control header, so heuristic freshness applied — for an
 *     authenticated/sensitive surface that's the wrong default).
 *   - #470 reverted the middleware, but a customer whose tab cached
 *     the 410 still saw 410s until they hard-refreshed.
 *
 * Mounting `noStoreCache` in front of these routes belt-and-braces
 * the future: any 4xx/5xx (or 200) response from these endpoints
 * carries `Cache-Control: no-store`, so a transient kill-switch,
 * permission flip, or backend restart can never get pinned in
 * intermediate caches.
 *
 * No-op cost (one setHeader per request); applied per route group
 * rather than globally so static assets + galleries keep their
 * own caching strategy.
 */

function noStoreCache(req, res, next) {
  // `no-store` is the strongest signal — no cache, no revalidation,
  // no offline retention. Pair with `private` so any well-behaved
  // intermediate proxy treats the response as user-specific.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache'); // HTTP/1.0 fallback for older proxies
  res.setHeader('Expires', '0');
  next();
}

module.exports = { noStoreCache };
