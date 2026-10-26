const router = require('express').Router();
const bcrypt = require('bcrypt');
const { body, validationResult } = require('express-validator');
const { verifyGalleryAccess } = require('../middleware/gallery');
const { parseBooleanInput } = require('../utils/parsers');
const { MAX_PASSWORD_LENGTH } = require('../utils/passwordValidation');
const pinEntry = require('../services/galleryPinEntryService');
const { getClientIp } = require('../utils/requestIp');
const { getGalleryTokenFromRequest } = require('../utils/tokenUtils');
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
  body('password').isString().bail().isLength({ min: pinEntry.MIN_PIN_LENGTH, max: MAX_PASSWORD_LENGTH })
    .custom((value) => Array.from(value.trim()).length >= pinEntry.MIN_PIN_LENGTH),
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
    const attempt = await pinEntry.reserve(event.id, ip, req.headers['user-agent'] || '');
    const valid = await bcrypt.compare(req.body.password, attempt.passwordHash);
    const currentEvent = await pinEntry.complete(attempt, valid);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    res.json(await replaceGallerySession(res, currentEvent, req.galleryAccess.session, 'client', ip,
      getGalleryTokenFromRequest(req, req.params.slug)));
  } catch (error) {
    if (error.isOperational) {
      if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
      return res.status(error.statusCode).json({ error: error.message, code: error.code,
        ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) });
    }
    errorResponse(res, error, 503, 'Client access is temporarily unavailable');
  }
});

router.post('/:slug/client-downgrade', verifyGalleryAccess, requireGallerySession, async (req, res) => {
  try {
    if (req.accessLevel !== 'client') return res.status(403).json({ error: 'Client access required' });
    res.json(await replaceGallerySession(res, req.event, req.galleryAccess.session, 'guest', getClientIp(req),
      getGalleryTokenFromRequest(req, req.params.slug)));
  } catch (error) { errorResponse(res, error, 503, 'Could not end client access. Please try again.'); }
});

module.exports = router;
