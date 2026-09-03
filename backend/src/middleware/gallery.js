const jwt = require('jsonwebtoken');
const { db, withRetry } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const { getGalleryTokenFromRequest } = require('../utils/tokenUtils');
const logger = require('../utils/logger');
const { isTokenRevoked } = require('../utils/tokenRevocation');
const { isTokenBeforeCutoff } = require('../utils/sessionCutoff');

/**
 * True when a logged-in admin is explicitly previewing this gallery (#868).
 *
 * Two conditions, both required:
 *   1. The explicit intent flag `?admin_preview=1` is present. The plain share
 *      link stays byte-identical to a guest's, so the password gate is still
 *      testable as a guest while logged in as admin — and the bypass is visible
 *      in the URL without being reusable (it carries no secret).
 *   2. A VERIFIED admin session — the httpOnly `admin_token` cookie (rides along
 *      on same-origin API calls) or an Authorization: Bearer header, never the
 *      URL. Must decode as `type: 'admin'`, issuer `picpeak-auth`.
 *
 * The cookie is tried FIRST and the Bearer is accepted only when it is itself an
 * admin token (#981 review): the frontend attaches a gallery Bearer to gallery
 * endpoints, and a header-first, type-blind read would let a coexisting gallery
 * session shadow the admin cookie and wrongly disable the preview.
 *
 * Fails closed on any verification error. Replaces the old `?preview=<raw-JWT>`
 * scheme, which leaked a 24h admin token into the address bar.
 */
function decodeAdminPreview(req) {
  if (req.query?.admin_preview !== '1') return null;
  // Cookie first, then a Bearer — but only an admin-typed token satisfies it.
  const candidates = [];
  if (req.cookies?.admin_token) candidates.push(req.cookies.admin_token);
  const header = req.headers?.authorization;
  if (header && header.startsWith('Bearer ')) candidates.push(header.slice(7));
  for (const token of candidates) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'picpeak-auth' });
      if (decoded.type === 'admin') return decoded;
    } catch { /* try the next candidate */ }
  }
  return null;
}

function isAdminPreview(req) {
  return decodeAdminPreview(req) !== null;
}

/**
 * The full session check behind the preview bypass. A verified signature is
 * not a live session: adminAuth also rejects revoked tokens, tokens issued
 * before the restore cutoff, deactivated admins and tokens minted before the
 * admin's last password change. Without those a logged-out or deactivated
 * admin token kept unlocking every draft and password gallery until `exp`
 * (30 days with remember-me). Sets req.isAdminPreview on success so the
 * downstream reveal-mode and logging checks read one verified flag.
 */
async function verifyAdminPreview(req) {
  if (req.isAdminPreview === true) return true;
  const decoded = decodeAdminPreview(req);
  if (!decoded) return false;
  try {
    if (await isTokenRevoked(decoded) || await isTokenBeforeCutoff(decoded)) return false;
    const admin = await withRetry(async () => db('admin_users')
      .where({ id: decoded.id, is_active: formatBoolean(true) })
      .select('id', 'password_changed_at')
      .first());
    if (!admin) return false;
    if (admin.password_changed_at) {
      const changedSeconds = Math.floor(new Date(admin.password_changed_at).getTime() / 1000);
      if (decoded.iat < changedSeconds) return false;
    }
  } catch (err) {
    logger.warn('Admin preview session check failed', { error: err.message });
    return false;
  }
  req.isAdminPreview = true;
  return true;
}

// Middleware to verify gallery access
async function verifyGalleryAccess(req, res, next) {
  try {
    const requestedSlug = req.params.slug || req.requestedSlug;

    // Admin preview (#868) is resolved BEFORE any gallery credential (#981
    // review): a coexisting gallery token/Bearer must not shadow it, and the
    // admin session must never fall into the `type !== 'gallery'` reject path
    // below. Per-request bypass — draft + password relaxed, NO gallery JWT
    // minted (a lingering guest cookie would muddy the coexisting-cookies case).
    // req.isAdminPreview flags downstream logging to keep it out of guest stats.
    if (await verifyAdminPreview(req)) {
      if (!requestedSlug) {
        return res.status(401).json({ error: 'No token provided' });
      }
      const previewEvent = await withRetry(async () => db('events')
        .where({ slug: requestedSlug, is_active: formatBoolean(true), is_archived: formatBoolean(false) })
        .select('*').first());
      if (!previewEvent) {
        return res.status(404).json({ error: 'Gallery not found or expired' });
      }
      req.event = previewEvent;
      req.isAdminPreview = true;
      req.sessionID = `gallery_admin_preview_${previewEvent.id}`;
      req.clientInfo = {
        ip: req.ip || req.connection.remoteAddress || 'unknown',
        userAgent: req.get('User-Agent') || 'unknown',
        fingerprint: `${req.ip}-${req.get('User-Agent')}`.substring(0, 32),
        timestamp: Date.now()
      };
      return next();
    }

    const token = getGalleryTokenFromRequest(req, requestedSlug);
    let event;

    if (!token) {
      if (!requestedSlug) {
        return res.status(401).json({ error: 'No token provided' });
      }

      event = await withRetry(async () => db('events')
        .where({
          slug: requestedSlug,
          is_active: formatBoolean(true),
          is_archived: formatBoolean(false),
          is_draft: formatBoolean(false)
        })
        .select('*').first());

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
        algorithms: ['HS256'],
        issuer: 'picpeak-auth'
      });
    } catch (error) {
      // If verification fails with issuer, try without issuer (backward compatibility)
      if (error.name === 'JsonWebTokenError' && error.message.includes('jwt issuer invalid')) {
        decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
      } else {
        throw error;
      }
    }
    logger.debug('[verifyGalleryAccess] Token decoded successfully', { eventId: decoded.eventId, slug: requestedSlug });

    // Only gallery-scoped tokens grant gallery access. Every legitimate
    // path (password login, share link, client access, customer-minted,
    // slideshow) mints type:'gallery'. Reject anything else — e.g. a guest
    // identity token (type:'guest', for feedback attribution) that carries a
    // matching eventId — instead of relying on other token types incidentally
    // lacking an eventId to fail the id match below.
    if (decoded.type !== 'gallery') {
      return res.status(403).json({ error: 'Invalid token type for gallery access' });
    }

    // If we have a slug in the URL params or from pre-middleware, verify it matches.
    // (Admin preview never reaches here — it returns above — so drafts stay
    // filtered for every real gallery-token request.)
    if (requestedSlug) {
      // Verify by slug and ensure it matches the token's event
      event = await withRetry(async () => db('events')
        .where({
          slug: requestedSlug,
          is_active: formatBoolean(true),
          is_archived: formatBoolean(false),
          is_draft: formatBoolean(false)
        })
        .select('*').first());

      // Verify the token's eventId matches
      if (event && event.id !== decoded.eventId) {
        return res.status(403).json({ error: 'Token does not match requested gallery' });
      }
    } else {
      // Fallback to using eventId from token
      event = await withRetry(async () => db('events')
        .where({
          id: decoded.eventId,
          is_active: formatBoolean(true),
          is_archived: formatBoolean(false),
          is_draft: formatBoolean(false)
        })
        .select('*').first());
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
    // Customer-portal provenance (#746/#849): portal-minted tokens carry
    // via:'customer' but NO accessLevel (they default to guest), while
    // PIN-client logins carry accessLevel:'client' without `via`. Activity
    // attribution/dedup needs the distinction, so surface it explicitly.
    req.viaCustomer = decoded.via === 'customer';
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
  isAdminPreview,
  verifyAdminPreview
};
