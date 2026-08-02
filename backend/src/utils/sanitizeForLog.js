/**
 * Redact credential-bearing fields before an object reaches the logs
 * (GHSA-pgmp / GHSA-r794).
 *
 * Event create/update routes logged the whole request body. That body can
 * carry a gallery `password`, a bcrypt `client_password_hash`, and — when
 * `regenerate_client_token` is set — a freshly minted `client_share_token`,
 * which is a LIVE bearer credential for client gallery access, not a hash.
 *
 * Deliberately key-name based rather than value-shaped: a deny-set of names is
 * predictable and cheap, whereas guessing at "this looks like a secret" both
 * misses and false-positives. Matching is case-insensitive and substring-based
 * so `client_password_hash` and `smtp_pass` are caught without enumerating
 * every variant.
 */

const DENY_FRAGMENTS = [
  'password',
  'passwd',
  'secret',
  'token',
  'api_key',
  'apikey',
  'authorization',
  'credential',
  'private_key',
];

const REDACTED = '[redacted]';

function isSensitiveKey(key) {
  const k = String(key).toLowerCase();
  return DENY_FRAGMENTS.some((fragment) => k.includes(fragment));
}

/**
 * Return a copy of `value` with sensitive fields replaced by `[redacted]`.
 * Non-objects pass through unchanged. Cycles are handled so a caller can't
 * turn a log line into an infinite loop.
 *
 * @param {*} value
 * @param {number} [depth] internal recursion guard
 * @param {WeakSet} [seen] internal cycle guard
 */
function sanitizeForLog(value, depth = 0, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 6) return '[truncated]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((v) => sanitizeForLog(v, depth + 1, seen));
  }

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : sanitizeForLog(val, depth + 1, seen);
  }
  return out;
}

/**
 * Redact express-validator's `errors.array()` before logging.
 *
 * Each entry carries the SUBMITTED value under `value`, keyed by `path`. A
 * password that fails the length check therefore lands in the log in plaintext
 * — sanitizing only `req.body` does not close that (GHSA-pgmp / r794).
 *
 * @param {Array} errors output of validationResult(req).array()
 */
function sanitizeValidationErrors(errors) {
  if (!Array.isArray(errors)) return errors;
  return errors.map((err) => {
    if (!err || typeof err !== 'object') return err;
    const field = err.path || err.param;
    if (field && isSensitiveKey(field)) {
      return { ...err, value: REDACTED };
    }
    // Even for a non-sensitive field the value may be an object carrying one.
    return 'value' in err ? { ...err, value: sanitizeForLog(err.value) } : err;
  });
}

module.exports = { sanitizeForLog, sanitizeValidationErrors, isSensitiveKey };
