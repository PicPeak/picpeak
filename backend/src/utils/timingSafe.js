const crypto = require('crypto');

/**
 * Constant-time string comparison for secrets (share tokens, HMAC
 * signatures, etc.). Returns false for non-strings or length mismatch
 * without leaking timing beyond the (non-secret) length. Prevents an
 * attacker from recovering a token byte-by-byte via response-time
 * differences of a naive `a === b`.
 */
function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

module.exports = { timingSafeEqualStr };
