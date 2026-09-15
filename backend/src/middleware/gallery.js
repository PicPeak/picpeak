const jwt = require('jsonwebtoken');
const { db, withRetry } = require('../database/db');
const { getGalleryTokenFromRequest } = require('../utils/tokenUtils');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errors');
const { isSessionExpired } = require('./sessionTimeout');
const access = require('../services/galleryAccessService');

// Cookie first: a coexisting gallery Bearer must not shadow an admin preview.
function readAdminPreview(req) {
  if (req.query?.admin_preview !== '1') return null;
  const candidates = [req.cookies?.admin_token];
  const header = req.headers?.authorization;
  if (header?.startsWith('Bearer ')) candidates.push(header.slice(7));
  for (const token of candidates.filter(Boolean)) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET, {
        issuer: 'picpeak-auth', algorithms: ['HS256'],
      });
      if (decoded.type === 'admin') return { token, decoded };
    } catch { /* try the next candidate */ }
  }
  return null;
}

function decodeAdminPreview(req) {
  return readAdminPreview(req)?.decoded || null;
}

// Signature-only predicate retained for UI-intent callers. It never authorizes.
function isAdminPreview(req) {
  return decodeAdminPreview(req) !== null;
}

function attachAccess(req, event, grant) {
  req.event = event;
  req.galleryAccess = grant;
  req.isAdminPreview = grant.kind === 'admin';
  req.accessLevel = grant.session?.accessLevel || 'guest';
  req.viaCustomer = grant.session?.via === 'customer';
  req.sessionID = req.isAdminPreview ? `gallery_admin_preview_${event.id}`
    : `gallery_${grant.kind === 'public' ? 'public_' : ''}${event.id}_${Date.now()}`;
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const userAgent = req.get?.('User-Agent') || 'unknown';
  req.clientInfo = {
    ip, userAgent, fingerprint: `${ip}-${userAgent}`.substring(0, 32), timestamp: Date.now(),
  };
}

async function verifyAdminPreview(req, event) {
  if (req.isAdminPreview && req.galleryAccess && (!event || event.id === req.event?.id)) return true;
  const preview = readAdminPreview(req);
  if (!preview) return false;
  const { token, decoded } = preview;
  try {
    // sessionTimeoutMiddleware only guards /api/admin, so an admin session
    // that idled out there could still preview galleries until its exp.
    if (await isSessionExpired(token, decoded)) {
      throw new AppError('Session expired', 401, 'SESSION_TIMEOUT');
    }
    const slug = req.params?.slug || req.requestedSlug;
    if (!event && !slug) return false;
    event = event || await db('events').where({ slug }).select('*').first();
    if (!event) return false;
    const grant = access.grant(event, 'admin', decoded);
    await access.authorize(event, grant);
    attachAccess(req, event, grant);
    return true;
  } catch (error) {
    logger.debug('Admin gallery preview denied', { code: error.code });
    req.adminPreviewDenied = error;
    return false;
  }
}

function decodeGalleryToken(token) {
  try {
    return jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'], issuer: 'picpeak-auth' });
  } catch (error) {
    // Legacy gallery tokens lacked an issuer, but still need the same type,
    // lifecycle and session checks as current tokens.
    if (error.name === 'JsonWebTokenError' && error.message.includes('jwt issuer invalid')) {
      return jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    }
    throw error;
  }
}

async function verifyGalleryAccess(req, res, next) {
  try {
    if (await verifyAdminPreview(req)) return next();
    // The caller asked for a preview explicitly: report why it was refused
    // instead of falling through to a misleading guest-token error.
    if (req.adminPreviewDenied?.isOperational) throw req.adminPreviewDenied;
    const slug = req.params.slug || req.requestedSlug;
    const token = getGalleryTokenFromRequest(req, slug);
    const decoded = token ? decodeGalleryToken(token) : null;
    if (decoded && decoded.type !== 'gallery') {
      return res.status(403).json({ error: 'Invalid token type for gallery access' });
    }
    if (!slug && !decoded?.eventId) return res.status(401).json({ error: 'No token provided' });
    const event = await withRetry(() => db('events').where(slug ? { slug } : { id: decoded.eventId }).select('*').first());
    if (!event) return res.status(404).json({ error: 'Gallery not found or expired' });
    const grant = access.grant(event, decoded ? 'gallery' : 'public', decoded);
    await access.authorize(event, grant);
    attachAccess(req, event, grant);
    return next();
  } catch (error) {
    if (!error.isOperational) logger.error('Error verifying gallery access', { error: error.message });
    return res.status(error.statusCode || 401).json({
      error: error.isOperational ? error.message : 'Invalid token',
      ...(error.code && error.isOperational && { code: error.code }),
    });
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
