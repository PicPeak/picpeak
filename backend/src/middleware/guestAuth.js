const jwt = require('jsonwebtoken');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { getGuestTokenFromRequest } = require('../utils/tokenUtils');

/**
 * Non-blocking middleware. Reads an optional guest token from the request and,
 * if present and valid, populates req.guest with { id, identifier, name, eventId }.
 *
 * If the token is missing, malformed, or expired → req.guest = null and the
 * request continues. Downstream handlers (e.g. feedback submission) enforce
 * presence explicitly based on event feedback settings (identity_mode).
 */
async function resolveGuest(req, res, next) {
  try {
    const slug = req.params?.slug;
    const token = getGuestTokenFromRequest(req, slug);
    if (!token) {
      req.guest = null;
      return next();
    }

    let decoded;
    try {
      const verified = jwt.verify(token, process.env.JWT_SECRET, {
        algorithms: ['HS256'],
        issuer: 'picpeak-auth',
        complete: true,
      });
      decoded = verified.payload;
    } catch (err) {
      // Invalid or expired guest tokens are silently ignored so that public
      // gallery browsing continues to work even if the token is stale.
      logger.debug('Invalid guest token', { reason: err.message });
      req.guest = null;
      return next();
    }

    if (decoded.type !== 'guest') {
      req.guest = null;
      return next();
    }

    // Verify the guest row still exists and is not soft-deleted.
    const guest = await db('gallery_guests')
      .where({ id: decoded.guestId, event_id: decoded.eventId, is_deleted: false })
      .first();

    if (!guest) {
      req.guest = null;
      return next();
    }

    req.guest = {
      id: guest.id,
      eventId: guest.event_id,
      identifier: guest.identifier,
      name: guest.name,
      email: guest.email || null,
    };

    return next();
  } catch (error) {
    logger.error('resolveGuest middleware error', { error: error.message });
    req.guest = null;
    return next();
  }
}

/**
 * Blocking middleware that 401s if no guest identity was resolved.
 * Use this on endpoints that require a valid guest session.
 */
function requireGuest(req, res, next) {
  if (!req.guest) {
    return res.status(401).json({ error: 'Guest identity required' });
  }
  return next();
}

/**
 * How long a guest stays recognised (#1210).
 *
 * Was 24h, matching the gallery token, and every call site took that default —
 * so a client reviewing a gallery across two weekends lost their identity in
 * between and registered again. Each of those re-registrations is a fresh
 * gallery_guests row, and their likes and favourites scatter across the
 * duplicates until an admin merges them, which is the harm reported in #1210.
 *
 * A guest token is a weaker thing than an admin session: it is scoped to one
 * event, carries no admin capability, and the gallery itself is already behind
 * whatever password or share link protects it. 30 days is the shape of a real
 * proofing cycle. Configurable for operators who want it shorter — the value
 * goes straight to jsonwebtoken, so it takes any zeit/ms string ('7d', '12h').
 */
const GUEST_TOKEN_TTL = process.env.GUEST_TOKEN_TTL || '30d';

/**
 * Sign a new guest JWT. Scoped to a specific event and guest row.
 */
function signGuestToken({ guestId, eventId, identifier, name }, expiresIn = GUEST_TOKEN_TTL) {
  return jwt.sign(
    {
      type: 'guest',
      guestId,
      eventId,
      identifier,
      name,
    },
    process.env.JWT_SECRET,
    {
      issuer: 'picpeak-auth',
      expiresIn,
    }
  );
}

module.exports = {
  resolveGuest,
  requireGuest,
  signGuestToken,
};
