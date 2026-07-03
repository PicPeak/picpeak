/**
 * publicTokenGuards — shared validators for the public token tables
 * (`contract_action_tokens`, `quote_action_tokens`). Centralises the
 * checks that every public-facing route MUST run before doing work,
 * so future routes can't accidentally skip a guard.
 *
 * What this enforces:
 *   1. **Existence**         — 404 when the token doesn't match a row.
 *   2. **Expiry**            — 410 when `expires_at` is in the past
 *                              OR is NULL (defensive: NULL = expired,
 *                              not "valid forever" — historical bug).
 *   3. **One-shot semantics** — when `requireUnused: true`, 409 if
 *                              `used_at` is already set. Prevents
 *                              replay of leaked tokens on the upload
 *                              path. The sign path historically allowed
 *                              re-signing for in-browser flows; opt in
 *                              per call site.
 *   4. **Attempt throttling** — non-existent tokens increment a per-IP
 *                              counter; the IP is locked out for 15 min
 *                              after 20 invalid attempts. Mitigates the
 *                              token-prefix brute force route that
 *                              standard rate-limiters don't catch
 *                              (large token space, low miss rate per
 *                              IP, but distributed crawlers add up).
 *
 * Returns the validated token row on success. Sends the appropriate
 * HTTP response and returns `null` on failure — the caller must check
 * for null and `return` immediately.
 */

const { db } = require('../database/db');
const { clientIpForAudit } = require('./clientIp');
const logger = require('./logger');

// In-memory bad-attempt counter. Per-process; cleared on restart.
// Keyed by IP. Each entry: { count, firstAt }. We could persist this
// in app_settings or a dedicated table, but in-memory is simpler and
// good enough for the threat (distributed brute force is the only
// case where IP locking helps anyway, and that needs more than one
// IP to be effective).
const BAD_ATTEMPT_LIMIT = 20;
const BAD_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const badAttempts = new Map();

function recordBadAttempt(ip) {
  if (!ip) return;
  const now = Date.now();
  const entry = badAttempts.get(ip);
  if (!entry || (now - entry.firstAt) > BAD_ATTEMPT_WINDOW_MS) {
    badAttempts.set(ip, { count: 1, firstAt: now });
    return;
  }
  entry.count += 1;
}

function isIpLocked(ip) {
  if (!ip) return false;
  const entry = badAttempts.get(ip);
  if (!entry) return false;
  if ((Date.now() - entry.firstAt) > BAD_ATTEMPT_WINDOW_MS) {
    badAttempts.delete(ip);
    return false;
  }
  return entry.count >= BAD_ATTEMPT_LIMIT;
}

/**
 * Validate a public action token. Returns the token row on success,
 * sends a response + returns null on failure.
 *
 * @param {object} req                    Express request (for IP)
 * @param {object} res                    Express response (to send errors)
 * @param {object} opts
 * @param {string} opts.tableName         'contract_action_tokens' | 'quote_action_tokens'
 * @param {string} opts.token             64-hex token string
 * @param {boolean} [opts.requireUnused]  refuse when used_at is set (default false)
 */
async function loadActionToken(req, res, opts) {
  const { tableName, token, requireUnused = false } = opts;
  const ip = clientIpForAudit(req);

  if (isIpLocked(ip)) {
    res.status(429).json({
      error: 'Too many invalid token attempts. Try again in 15 minutes.',
      code: 'TOKEN_LOOKUP_LOCKED',
    });
    return null;
  }

  const row = await db(tableName).where({ token }).first();
  if (!row) {
    recordBadAttempt(ip);
    res.status(404).json({ error: 'Not found' });
    return null;
  }

  // Defensive: NULL expires_at counts as expired. Historical bug —
  // old seed rows could land without an expiry value, granting
  // permanent unauthenticated access. We refuse rather than guess.
  if (!row.expires_at) {
    logger.warn('publicTokenGuards: token has NULL expires_at — refusing', {
      tableName, tokenPrefix: token.slice(0, 12),
    });
    res.status(410).json({ error: 'This link has expired', code: 'TOKEN_NO_EXPIRY' });
    return null;
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    res.status(410).json({ error: 'This link has expired', code: 'TOKEN_EXPIRED' });
    return null;
  }

  if (requireUnused && row.used_at) {
    res.status(409).json({
      error: 'This link has already been used',
      code: 'TOKEN_ALREADY_USED',
    });
    return null;
  }

  return row;
}

/**
 * Pre-multer guard for upload routes. Runs the same validation as
 * loadActionToken but DOES NOT mutate state — it just rejects bad
 * tokens before multer reads the request body and writes to disk.
 * Without this, a captured/expired token can DoS disk by spamming
 * uploads that get rejected post-write.
 *
 * Wired in as middleware before `multer.single(...)`.
 */
function preMulterTokenGuard(tableName) {
  return async (req, res, next) => {
    try {
      const token = req.params.token;
      if (!token || !/^[a-f0-9]{64}$/i.test(token)) {
        return res.status(400).json({ error: 'Invalid token format' });
      }
      const row = await loadActionToken(req, res, { tableName, token, requireUnused: true });
      if (!row) return; // loadActionToken already responded
      // Attach for downstream handler — saves a duplicate DB lookup.
      req.publicTokenRow = row;
      next();
    } catch (err) {
      logger.error('preMulterTokenGuard: unexpected error', { err: err.message });
      return res.status(500).json({ error: 'Internal error' });
    }
  };
}

module.exports = {
  loadActionToken,
  preMulterTokenGuard,
  // Exported for tests + future routes that need the same lock
  // surface (e.g. payment-check actions).
  _internal: { recordBadAttempt, isIpLocked, badAttempts },
};
