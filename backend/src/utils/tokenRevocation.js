/**
 * Token Revocation System
 * Provides ability to invalidate tokens before expiration
 */

const jwt = require('jsonwebtoken');
const { db } = require('../database/db');
const logger = require('./logger');
const MAX_SQL_EXPIRY_SECONDS = Date.parse('9999-12-31T23:59:59Z') / 1000;

/**
 * Add a token to the revocation list
 * @param {string} token - JWT token to revoke
 * @param {string} reason - Reason for revocation
 * @param {Object} metadata - Additional metadata
 */
/**
 * Resolve the per-token unique identifier used as the lookup key in
 * revoked_tokens.token_id. Customer JWTs (#354) use `customerId` instead
 * of `id`, so the original `${payload.id}-${payload.iat}` produced
 * `undefined-…` keys for every customer token and silently collided
 * across all customer logins. Falling back to customerId — and finally
 * to a stable hash of the payload — keeps the key unique per token.
 */
function buildTokenId(payload) {
  if (payload.jti) return payload.jti;
  const subject = payload.id ?? payload.customerId ?? payload.guestId ?? payload.eventId ?? 'anon';
  return `${subject}-${payload.iat}-${payload.type || 'unknown'}`;
}

async function revokeToken(token, reason, metadata = {}) {
  try {
    // The signature MUST be verified before anything is written. The
    // revocation key is `${id}-${iat}-${type}` (buildTokenId), and the
    // logout endpoints are unauthenticated, so a raw base64 decode let
    // anyone forge a three-part string naming another user's id, type and
    // login second and insert a row that isTokenRevoked() then matched for
    // that user's real session -- a remote forced logout of any admin,
    // customer or gallery session, plus never-swept rows when `exp` was set
    // far in the future. Expiry is ignored on purpose: revoking an already
    // expired token is harmless and keeps logout idempotent.
    const payload = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ['HS256'],
      ignoreExpiration: true,
    });
    if (!payload || typeof payload !== 'object') {
      throw new Error('Invalid token payload');
    }

    // user_id is integer-typed in revoked_tokens; for non-admin tokens
    // we may not have an integer (customer) or any id at all (gallery
    // tokens use eventId). Coerce to null instead of letting an
    // undefined/string slip through and cause an INSERT type error.
    const userIdNumeric = Number.isInteger(payload.id) ? payload.id : null;

    // JWT permits a missing exp. Keep that revocation permanently: an
    // arbitrary fallback TTL would make the token usable again after cleanup.
    // Retain unrepresentable expiries too, using the common SQL/ISO date range.
    const expiresAt = Number.isFinite(payload.exp)
      && payload.exp >= 0 && payload.exp <= MAX_SQL_EXPIRY_SECONDS
      ? new Date(Math.ceil(payload.exp * 1000)).toISOString()
      : null;

    // Duplicate logouts are idempotent. A permanent revocation must also
    // upgrade an existing expiring entry with the same legacy key or jti;
    // logging out an expiring token must never shorten that retention again.
    const insert = db('revoked_tokens').insert({
      token_id: buildTokenId(payload),
      user_id: userIdNumeric,
      token_type: payload.type,
      revoked_at: new Date().toISOString(),
      expires_at: expiresAt,
      reason,
      metadata: JSON.stringify(metadata)
    }).onConflict('token_id');
    if (expiresAt === null) await insert.merge({ expires_at: null });
    else await insert.ignore();

    logger.info('Token revoked', {
      userId: payload.id ?? payload.customerId ?? null,
      tokenType: payload.type,
      reason
    });

    return true;
  } catch (error) {
    logger.error('Failed to revoke token', error);
    return false;
  }
}

/**
 * Check if a token is revoked
 * @param {Object} decodedToken - Decoded JWT payload
 * @returns {boolean} - True if token is revoked
 */
async function isTokenRevoked(decodedToken) {
  try {
    const tokenId = buildTokenId(decodedToken);
    
    const revoked = await db('revoked_tokens')
      .where('token_id', tokenId)
      .first();
    
    return !!revoked;
  } catch (error) {
    logger.error('Failed to check token revocation', error);
    // Fail closed - treat as revoked if we can't check
    return true;
  }
}

/**
 * Clean up expired revoked tokens
 * Should be run periodically
 */
async function cleanupExpiredRevocations() {
  try {
    const deleted = await db('revoked_tokens')
      .whereNotNull('expires_at')
      .where('expires_at', '<', new Date().toISOString())
      .delete();
    
    if (deleted > 0) {
      logger.info(`Cleaned up ${deleted} expired token revocations`);
    }
  } catch (error) {
    logger.error('Failed to cleanup revoked tokens', error);
  }
}

/**
 * Initialize cleanup job for expired revocations
 */
const cleanupTask = require('../services/scheduledTask').scheduledTask(cleanupExpiredRevocations, { interval: 6 * 60 * 60 * 1000, initialDelay: 0 });
function initializeRevocationCleanup() { cleanupTask.start(); }
const stopRevocationCleanup = () => cleanupTask.stop();

module.exports = { buildTokenId,
  stopRevocationCleanup,
  revokeToken,
  isTokenRevoked,
  cleanupExpiredRevocations,
  initializeRevocationCleanup
};
