const router = require('express').Router();
const bcrypt = require('bcrypt');
const { body, validationResult } = require('express-validator');
const { verifyGalleryAccess } = require('../middleware/gallery');
const { parseBooleanInput } = require('../utils/parsers');
const { MAX_PASSWORD_LENGTH } = require('../utils/passwordValidation');
const { trackFailedAttempt, trackSuccessfulLogin, checkAccountLockout } = require('../utils/authSecurity');
const { getClientIp } = require('../utils/requestIp');
const { getGalleryTokenFromRequest } = require('../utils/tokenUtils');
const { revokeToken } = require('../utils/tokenRevocation');
const { replaceGallerySession } = require('../services/galleryClientSessionService');
const { errorResponse, safeValidationErrors } = require('../utils/routeHelpers');

/** Public/no-token access, slideshow tokens and admin previews cannot change roles. */
function requireGallerySession(req, res, next) {
  if (req.galleryAccess?.kind !== 'gallery' || !['guest', 'client'].includes(req.accessLevel)) {
    return res.status(403).json({ error: 'A gallery session is required', code: 'GALLERY_SESSION_REQUIRED' });
  }
  next();
}

router.post('/:slug/client-elevate', verifyGalleryAccess, requireGallerySession, [
  body('password').isString().bail().isLength({ min: 1, max: MAX_PASSWORD_LENGTH }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: safeValidationErrors(errors) });
    const event = req.event;
    if (!parseBooleanInput(event.client_access_enabled, false)
      || !parseBooleanInput(event.client_pin_entry_enabled, false) || !event.client_password_hash) {
      return res.status(403).json({ error: 'Gallery PIN entry is not enabled', code: 'CLIENT_ACCESS_UNAVAILABLE' });
    }
    const ip = getClientIp(req);
    const userAgent = req.headers['user-agent'] || '';
    const identifier = `client:${event.slug}`;
    const lockout = await checkAccountLockout(identifier, ip);
    if (lockout.isLocked) {
      return res.status(423).json({ error: 'Too many failed attempts. Please try again later.', retryAfter: lockout.remainingTime });
    }
    if (!(await bcrypt.compare(req.body.password, event.client_password_hash))) {
      await trackFailedAttempt(identifier, ip, userAgent);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    await trackSuccessfulLogin(identifier, ip, userAgent);
    res.json(await replaceGallerySession(res, event, req.galleryAccess.session, 'client', ip));
  } catch (error) { errorResponse(res, error, 500, 'Client access failed'); }
});

router.post('/:slug/client-downgrade', verifyGalleryAccess, requireGallerySession, async (req, res) => {
  try {
    if (req.accessLevel !== 'client') return res.status(403).json({ error: 'Client access required' });
    const token = getGalleryTokenFromRequest(req, req.params.slug);
    if (!(await revokeToken(token, 'client_mode_ended'))) {
      return res.status(503).json({ error: 'Could not end client access. Please try again.' });
    }
    res.json(await replaceGallerySession(res, req.event, req.galleryAccess.session, 'guest', getClientIp(req)));
  } catch (error) { errorResponse(res, error, 500, 'Could not end client access'); }
});

module.exports = router;
