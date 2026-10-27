const { toTimestamp } = require('./dateNormalize');
const { AppError } = require('./errors');
const logger = require('./logger');

const warnedExpiry = new Set();

const isTrue = (value) => value === true || value === 1 || value === '1';

function isGalleryExpired(event, now = Date.now()) {
  if (event.expires_at == null || event.expires_at === '') return false;
  const expiry = toTimestamp(event.expires_at);
  if (!Number.isFinite(expiry)) {
    // Fail closed, but name the row once so an operator can repair it.
    if (!warnedExpiry.has(event.id)) {
      warnedExpiry.add(event.id);
      logger.warn('Unparseable events.expires_at treated as expired', { eventId: event.id, expires_at: String(event.expires_at) });
    }
    return true;
  }
  return expiry <= now;
}

function requiresGalleryPassword(event) {
  return !(event.require_password === false || event.require_password === 0 || event.require_password === '0');
}

function isGalleryAvailable(event, { adminPreview = false, allowTemporarilyDisabled = false } = {}) {
  return !!event && isTrue(event.is_active) && !isTrue(event.is_archived)
    && (adminPreview || ((!isTrue(event.temporarily_disabled) || allowTemporarilyDisabled)
      && !isTrue(event.is_draft) && !isGalleryExpired(event)));
}

function assertGalleryEnabled(event, { adminPreview = false } = {}) {
  // Drafts, expiry, archiving and deletion keep their existing refusal. Only
  // an otherwise live gallery advertises that its pause is temporary.
  if (!adminPreview && isTrue(event?.temporarily_disabled)
      && isGalleryAvailable(event, { allowTemporarilyDisabled: true })) {
    throw new AppError('This gallery is temporarily unavailable.', 403, 'GALLERY_TEMPORARILY_DISABLED');
  }
}

function assertGalleryAvailable(event, { adminPreview = false } = {}) {
  if (!isGalleryAvailable(event, { adminPreview })) {
    assertGalleryEnabled(event, { adminPreview });
    throw new AppError('Gallery not found or expired', 404, 'GALLERY_UNAVAILABLE');
  }
}

module.exports = { isTrue, isGalleryAvailable, assertGalleryAvailable, assertGalleryEnabled, isGalleryExpired, requiresGalleryPassword };
