/**
 * Gate that applies the app-wide general rate limiter to /api requests.
 *
 * Why this exists rather than a plain `app.use('/api/', generalRateLimiter)`:
 * the limiter is built asynchronously (it reads its window and its budget from
 * app_settings), so it does not exist yet when the routers are mounted at module
 * load. It was therefore registered from inside initializeRateLimiters(), which
 * runs after the database is up — long after every router, the /api 404 handler
 * and the error handler are already on the stack. Express dispatches middleware
 * in registration order, so that app.use() landed BELOW everything that answers
 * a request and never executed: the app-wide /api budget was silently inert.
 *
 * This gate is a stable function that can be registered at the right depth
 * immediately and resolves the limiter per request, so whether the limit applies
 * no longer depends on boot timing.
 *
 * Register it with `app.use(gate)` and NOT `app.use('/api', gate)`: Express
 * strips the mount path from req.url for the duration of a mounted middleware,
 * and rateLimitService's own decisions are written against the full path
 * (`req.path.startsWith('/api/public/')` for the public-endpoints-only mode, and
 * the `/api/(gallery|secure-images)/:slug` regex that finds the gallery token to
 * skip on). Mounting it would silently break both.
 */

// Prefixes the general limiter must not cover.
const EXEMPT_PREFIXES = [
  // Client file transfer, both directions: one request per file, from a link
  // holder who carries no admin/gallery JWT and is therefore never skipped as
  // "authenticated". A 100-per-15-minutes IP budget would cut a large upload or
  // download off midway. Both already carry their own per-minute limiters
  // (publicTransfer.js, publicTransferUpload.js), which is the right shape for
  // bulk traffic. This prefix covers /api/public/transfer-upload as well.
  '/api/public/transfer',
];

// Login and gallery-password endpoints are exempt for a subtler reason. The
// limiter returns rate_limit_auth_max_requests (5, not 100) as the budget for
// these paths, but counts them into the SAME per-IP bucket as every other /api
// request. Five ordinary unauthenticated calls — the branding and settings
// fetches a login page makes before anyone types a password — would therefore
// 429 the login itself for a whole window. Giving them a real per-IP budget
// means giving them their own bucket, which is what the (currently unreachable)
// dedicated authRateLimiter is for; until that is wired up they keep today's
// behaviour, where brute force is bounded by the per-account lockout in
// utils/authSecurity.js.
//
// The pattern is deliberately identical to rateLimitService's own isAuthEndpoint
// check, so the exempt set is exactly the set that would get the 5 budget.
const AUTH_ENDPOINT_RE = /\/(auth|login|gallery\/[^/]+\/verify)$/;

/**
 * @param {() => import('express').RequestHandler|undefined} getLimiter
 *   Reads the current general rate limiter. Returns undefined until
 *   initializeRateLimiters() has resolved.
 * @returns {import('express').RequestHandler}
 */
function createApiRateLimitGate(getLimiter) {
  return function apiRateLimitGate(req, res, next) {
    if (!req.path.startsWith('/api/')) return next();
    if (EXEMPT_PREFIXES.some((prefix) => req.path.startsWith(prefix))) return next();
    if (AUTH_ENDPOINT_RE.test(req.path)) return next();

    const limiter = getLimiter();
    // Boot window: the database is not up yet, so there is nothing to delegate
    // to. Passing through is what every request did before this fix.
    if (typeof limiter !== 'function') return next();

    return limiter(req, res, next);
  };
}

module.exports = { createApiRateLimitGate };
