const jwt = require('jsonwebtoken');
const { db, withRetry } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const { getGalleryTokenFromRequest } = require('../utils/tokenUtils');
const logger = require('../utils/logger');

// Check if the request carries a valid admin preview token (Feature 3)
function isAdminPreview(req) {
  const previewToken = req.query?.preview;
  if (!previewToken) return false;
  try {
    const decoded = jwt.verify(previewToken, process.env.JWT_SECRET, { issuer: 'picpeak-auth' });
    return decoded.type === 'admin';
  } catch {
    return false;
  }
}

// Middleware to verify gallery access
async function verifyGalleryAccess(req, res, next) {
  try {
    const requestedSlug = req.params.slug || req.requestedSlug;
    const token = getGalleryTokenFromRequest(req, requestedSlug);
    let event;

    if (!token) {
      if (!requestedSlug) {
        return res.status(401).json({ error: 'No token provided' });
      }

      const adminPreview = isAdminPreview(req);
      event = await withRetry(async () => {
        const q = db('events')
          .where({
            slug: requestedSlug,
            is_active: formatBoolean(true),
            is_archived: formatBoolean(false)
          });
        if (!adminPreview) {
          q.where({ is_draft: formatBoolean(false) });
        }
        return await q.select('*').first();
      });

      if (!event) {
        return res.status(404).json({ error: 'Gallery not found or expired' });
      }

      const requiresPassword = !(event.require_password === false || event.require_password === 0 || event.require_password === '0');
      if (!requiresPassword) {
        req.event = event;
        req.sessionID = `gallery_public_${event.id}_${Date.now()}`;
        req.clientInfo = {
          ip: req.ip || req.connection.remoteAddress || 'unknown',
          userAgent: req.get('User-Agent') || 'unknown',
          fingerprint: `${req.ip}-${req.get('User-Agent')}`.substring(0, 32),
          timestamp: Date.now()
        };
        return next();
      }

      return res.status(401).json({ error: 'No token provided' });
    }
    
    // Try to verify with issuer first, fallback to no issuer for backward compatibility
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET, {
        issuer: 'picpeak-auth'
      });
    } catch (error) {
      // If verification fails with issuer, try without issuer (backward compatibility)
      if (error.name === 'JsonWebTokenError' && error.message.includes('jwt issuer invalid')) {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
      } else {
        throw error;
      }
    }
    logger.debug('[verifyGalleryAccess] Token decoded successfully', { eventId: decoded.eventId, slug: requestedSlug });
    
    // If we have a slug in the URL params or from pre-middleware, verify it matches
    if (requestedSlug) {
      // Verify by slug and ensure it matches the token's event
      const adminPreviewToken = isAdminPreview(req);
      event = await withRetry(async () => {
        const q = db('events')
          .where({
            slug: requestedSlug,
            is_active: formatBoolean(true),
            is_archived: formatBoolean(false)
          });
        if (!adminPreviewToken) {
          q.where({ is_draft: formatBoolean(false) });
        }
        return await q.select('*').first();
      });
      
      // Verify the token's eventId matches
      if (event && event.id !== decoded.eventId) {
        return res.status(403).json({ error: 'Token does not match requested gallery' });
      }
    } else {
      // Fallback to using eventId from token
      const adminPreviewFallback = isAdminPreview(req);
      event = await withRetry(async () => {
        const q = db('events')
          .where({
            id: decoded.eventId,
            is_active: formatBoolean(true),
            is_archived: formatBoolean(false)
          });
        if (!adminPreviewFallback) {
          q.where({ is_draft: formatBoolean(false) });
        }
        return await q.select('*').first();
      });
    }
    
    if (!event) {
      logger.warn('[verifyGalleryAccess] Event not found for slug', { slug: requestedSlug || 'no-slug', tokenEventId: decoded.eventId });
      return res.status(404).json({ error: 'Gallery not found or expired' });
    }

    // Customer-minted gallery JWTs (#354): when the customer obtained
    // this token via /api/customer/events/:slug/access-token, the
    // payload carries `via:'customer'` and `customerId`. The admin
    // can revoke the customer's access at any time by removing the
    // event_customer_assignments row from the "Manage galleries"
    // dialog on the customer detail page. Re-check that row here so
    // the revocation takes effect on the customer's very next
    // request — no token-blacklisting machinery required.
    if (decoded.via === 'customer' && decoded.customerId) {
      const assignment = await withRetry(async () => {
        return await db('event_customer_assignments')
          .where({
            event_id: event.id,
            customer_account_id: decoded.customerId,
          })
          .first();
      });
      if (!assignment) {
        logger.info('[verifyGalleryAccess] Customer assignment revoked, rejecting token', {
          customerId: decoded.customerId,
          eventId: event.id,
        });
        return res.status(403).json({
          error: 'Access to this gallery has been revoked',
          code: 'CUSTOMER_ASSIGNMENT_REVOKED',
        });
      }
    }

    logger.debug('[verifyGalleryAccess] Event located', { eventId: event.id, slug: event.slug });
    req.event = event;
    req.accessLevel = decoded.accessLevel || 'guest';
    req.sessionID = decoded.sessionId || `gallery_${event.id}_${Date.now()}`;

    // Create client info for logging (similar to secureImageMiddleware but simpler)
    req.clientInfo = {
      ip: req.ip || req.connection.remoteAddress || 'unknown',
      userAgent: req.get('User-Agent') || 'unknown',
      fingerprint: `${req.ip}-${req.get('User-Agent')}`.substring(0, 32), // Limit to 32 chars for DB column
      timestamp: Date.now()
    };
    
    logger.debug('[verifyGalleryAccess] Access granted', { eventId: event.id, slug: event.slug });
    next();
  } catch (error) {
    logger.error('Error verifying gallery access', { error: error.message, stack: error.stack });
    res.status(401).json({ error: 'Invalid token' });
  }
}

/**
 * Deny a slideshow-scoped JWT. The Live Slideshow token (accessLevel
 * 'slideshow') is reused as a `type:'gallery'` token so it can read photos for
 * the kiosk, which means every verifyGalleryAccess-protected route would
 * otherwise accept it. A projector URL is meant to be display-only and is
 * comparatively easy to leak (browser history, venue laptop, USB), so this
 * gate is placed AFTER verifyGalleryAccess on the write/bulk-download routes to
 * keep a leaked slideshow link from downloading, uploading, or posting
 * feedback. (#646 review)
 */
function denySlideshowToken(req, res, next) {
  if (req.accessLevel === 'slideshow') {
    return res.status(403).json({ error: 'Slideshow tokens are display-only' });
  }
  next();
}

module.exports = {
  verifyGalleryAccess,
  denySlideshowToken,
  isAdminPreview
};
