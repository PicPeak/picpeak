/**
 * Token Revocation System
 * Provides ability to invalidate tokens before expiration
 */

const { db } = require('../database/db');
const logger = require('./logger');

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
    // Extract token info without full verification (it might be compromised)
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid token format');
    }

    // Decode payload
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());

    // user_id is integer-typed in revoked_tokens; for non-admin tokens
    // we may not have an integer (customer) or any id at all (gallery
    // tokens use eventId). Coerce to null instead of letting an
    // undefined/string slip through and cause an INSERT type error.
    const userIdNumeric = Number.isInteger(payload.id) ? payload.id : null;

    // onConflict.ignore: revoking an already-revoked token is a no-op,
    // not an error. Hits the unique (token_id) index when the same JWT
    // is logged out twice (e.g. duplicate /logout from two tabs, or a
    // session-expiry path that races with an explicit logout). The
    // previous insert was authoritative; nothing to do.
    await db('revoked_tokens').insert({
      token_id: buildTokenId(payload),
      user_id: userIdNumeric,
      token_type: payload.type,
      revoked_at: new Date().toISOString(),
      expires_at: new Date(payload.exp * 1000).toISOString(),
      reason,
      metadata: JSON.stringify(metadata)
    }).onConflict('token_id').ignore();

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
 * Revoke all tokens for a user
 * @param {number} userId - User ID
 * @param {string} reason - Reason for revocation
 */
async function revokeAllUserTokens(userId, reason) {
  try {
    // This effectively revokes all tokens by setting a revocation time
    // Any token issued before this time will be considered revoked
    await db('user_token_revocations').insert({
      user_id: userId,
      revoked_at: new Date().toISOString(),
      reason
    }).onConflict('user_id').merge();
    
    logger.info('All user tokens revoked', { userId, reason });
    return true;
  } catch (error) {
    logger.error('Failed to revoke user tokens', error);
    return false;
  }
}

/**
 * Clean up expired revoked tokens
 * Should be run periodically
 */
async function cleanupExpiredRevocations() {
  try {
    const deleted = await db('revoked_tokens')
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
function initializeRevocationCleanup() {
  // Run cleanup every 6 hours
  setInterval(cleanupExpiredRevocations, 6 * 60 * 60 * 1000);
  
  // Run initial cleanup
  cleanupExpiredRevocations();
}

module.exports = {
  revokeToken,
  isTokenRevoked,
  revokeAllUserTokens,
  cleanupExpiredRevocations,
  initializeRevocationCleanup
};