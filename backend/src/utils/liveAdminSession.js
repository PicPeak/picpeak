/**
 * Would adminAuth accept this admin JWT right now?
 *
 * Two places hand out a resource on the strength of an admin token before
 * any route-level authentication runs: the general rate limiter skips the
 * per-IP budget for it, and largeJsonBody selects the 50 MB parser for it.
 * Both used to check the signature alone, so a token invalidated by logout,
 * a password change, a global session cutoff, deactivation or idle timeout
 * kept both privileges until its signed expiry. This applies the same live
 * checks adminAuth and sessionTimeoutMiddleware apply (sessionAccessService
 * plus isSessionExpired) and fails closed on any error.
 *
 * The result is cached per token for a few seconds, bounded in size, so the
 * limiter does not add two queries to every request of a live session. Only
 * a token whose signature verifies reaches the cache, so a forged header
 * cannot fill it.
 */
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const sessionAccess = require('../services/sessionAccessService');
const { isSessionExpired } = require('../middleware/sessionTimeout');

const CACHE_TTL_MS = 5000;
const CACHE_MAX_ENTRIES = 1000;
const cache = new Map(); // sha256(token) -> { eligible, expiry }

/**
 * @param {string} token raw admin JWT
 * @returns {Promise<object|null>} the decoded payload when the session is live, else null
 */
async function verifyLiveAdminJwt(token) {
  if (!token || typeof token !== 'string') return null;
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'], issuer: 'picpeak-auth' });
  } catch {
    return null;
  }
  if (!decoded || typeof decoded !== 'object' || decoded.type !== 'admin') return null;

  const key = crypto.createHash('sha256').update(token).digest('hex');
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now < hit.expiry) return hit.eligible ? decoded : null;

  let eligible = false;
  try {
    const account = await sessionAccess.admin(decoded);
    eligible = !account.must_change_password && !(await isSessionExpired(token, decoded));
  } catch {
    eligible = false;
  }
  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { eligible, expiry: now + CACHE_TTL_MS });
  return eligible ? decoded : null;
}

module.exports = { verifyLiveAdminJwt };
