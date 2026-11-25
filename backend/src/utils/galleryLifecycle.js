const { toTimestamp } = require('./dateNormalize');
const { AppError } = require('./errors');
const logger = require('./logger');
const { formatBoolean } = require('./dbCompat');

const warnedExpiry = new Set();

const isTrue = (value) => value === true || value === 1 || value === '1';
// An explicit off, for flags whose NULL / unset means on.
const isFalse = (value) => value === false || value === 0 || value === '0';

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
  return !isFalse(event.require_password);
}

/**
 * The events-row filter a token-only surface (share link, slideshow, embed)
 * looks a gallery up with: active, not archived and, unless `includeDrafts`,
 * not a draft. A where-object for knex, built per call (formatBoolean depends
 * on the database client). Drafts are for a verified admin preview only
 * (#1386): a caller passing `includeDrafts` must authorize before returning
 * anything it matched.
 */
function publishedEventFilter({ includeDrafts = false } = {}) {
  return {
    is_active: formatBoolean(true),
    is_archived: formatBoolean(false),
    ...(includeDrafts ? {} : { is_draft: formatBoolean(false) }),
  };
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

module.exports = { isTrue, isFalse, publishedEventFilter, isGalleryAvailable, assertGalleryAvailable, assertGalleryEnabled, isGalleryExpired, requiresGalleryPassword };
