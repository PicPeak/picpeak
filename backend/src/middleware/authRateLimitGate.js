/**
 * Per-IP rate limit for the credential-verification endpoints.
 *
 * Same boot-order problem as apiRateLimitGate, same fix: the auth limiter is
 * built asynchronously from app_settings, so it was registered from inside
 * initializeRateLimiters() — which runs after every router, the /api 404
 * handler and the error handler are already on the stack. Express dispatches
 * in registration order, so those five app.use() calls landed below everything
 * that answers a request and never executed. Auth endpoints have therefore
 * never had an IP-based limit; brute force was bounded only by the per-account
 * lockout in utils/authSecurity.js, which is per-identifier, not per-IP, and so
 * does not bound spraying one password across many usernames or many galleries.
 *
 * This gate is a stable function registered at the right depth immediately and
 * resolving the limiter per request, so the limit no longer depends on boot
 * timing. It stays a pass-through until initializeRateLimiters() resolves.
 *
 * Two things it deliberately does NOT do:
 *
 * 1. It does not match on a prefix. The old registrations used
 *    app.use('/api/auth', authRateLimiter), and /api/auth is the mount point of
 *    the whole auth router — so the 5-per-window budget would also have covered
 *    GET /api/auth/session and POST /api/auth/password-strength, both of which
 *    the frontend calls far more than five times per window. Activating them as
 *    written would have locked legitimate users out. The table below is exact
 *    method + exact path.
 *
 * 2. It does not share the general limiter's bucket. Each express-rate-limit
 *    instance owns a MemoryStore, so authRateLimiter counts into its own per-IP
 *    bucket and the ordinary /api traffic a login page makes (branding,
 *    settings) cannot exhaust the login budget.
 *
 * The limiter is configured with skipSuccessfulRequests, so only *failed*
 * attempts consume the budget. That is what makes a 5-per-window budget safe
 * behind NAT: ten guests on one venue wifi who all type the right gallery
 * password consume nothing.
 *
 * Register with app.use(gate) and NOT app.use('/api', gate) — Express strips
 * the mount path from req.url, and these patterns are written against the full
 * path.
 */

// Exact method + path. Anchored, and case-insensitive because Express's
// "case sensitive routing" setting is off by default: POST /api/auth/admin/LOGIN
// reaches the login handler, so a case-sensitive pattern would be a free bypass.
// The optional trailing slash is there for the same reason.
const CREDENTIAL_ENDPOINTS = [
  // Admin password, and the second factor that completes the same login.
  { method: 'POST', path: /^\/api\/auth\/admin\/login\/?$/i },
  { method: 'POST', path: /^\/api\/auth\/admin\/login\/mfa\/?$/i },
  // Gallery password, client PIN, share-link token.
  { method: 'POST', path: /^\/api\/auth\/gallery\/verify\/?$/i },
  { method: 'POST', path: /^\/api\/auth\/gallery\/share-login\/?$/i },
  { method: 'POST', path: /^\/api\/auth\/gallery\/[^/]+\/client-login\/?$/i },
  // First-run bootstrap: both of these take the setup token.
  { method: 'POST', path: /^\/api\/setup\/verify-token\/?$/i },
  { method: 'POST', path: /^\/api\/setup\/admin\/?$/i },
  // Customer portal password, and the reset that replaces it.
  { method: 'POST', path: /^\/api\/customer\/auth\/login\/?$/i },
  { method: 'POST', path: /^\/api\/customer\/auth\/password-reset\/?$/i },
  // Password changes verify the CURRENT password first, so they are a
  // credential check too — one an attacker holding a hijacked session can
  // drive, and one the general limiter never sees because the session's own
  // JWT skips it as authenticated. Only failed attempts count here, so the
  // one legitimate change a user makes costs nothing.
  { method: 'POST', path: /^\/api\/auth\/admin\/change-password\/?$/i },
  { method: 'POST', path: /^\/api\/customer\/profile\/password\/?$/i },
];

/**
 * @param {import('express').Request} req
 * @returns {boolean} true when the request is an attempt to prove a secret.
 */
function isCredentialEndpoint(req) {
  return CREDENTIAL_ENDPOINTS.some(
    (endpoint) => endpoint.method === req.method && endpoint.path.test(req.path)
  );
}

/**
 * @param {() => import('express').RequestHandler|undefined} getLimiter
 *   Reads the current auth rate limiter. Returns undefined until
 *   initializeRateLimiters() has resolved.
 * @returns {import('express').RequestHandler}
 */
function createAuthRateLimitGate(getLimiter) {
  return function authRateLimitGate(req, res, next) {
    if (!isCredentialEndpoint(req)) return next();

    const limiter = getLimiter();
    // Boot window: the database is not up yet, so there is nothing to delegate
    // to. Passing through is what every request did before this fix.
    if (typeof limiter !== 'function') return next();

    return limiter(req, res, next);
  };
}

module.exports = { createAuthRateLimitGate, isCredentialEndpoint, CREDENTIAL_ENDPOINTS };
