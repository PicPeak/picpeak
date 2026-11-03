const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { requiresGalleryPassword } = require('../utils/galleryLifecycle');
const { toDateOnly } = require('../utils/dateOnly');
const { publicThemeFields } = require('./galleryTheme');
const { setGalleryAuthCookies } = require('../utils/tokenUtils');
const { AppError } = require('../utils/errors');
const { revokeToken } = require('../utils/tokenRevocation');
const { clientPinEntryClaim } = require('../utils/galleryCredentialCutoff');

/** Change this gallery session's role without extending its remaining lifetime. */
async function replaceGallerySession(res, event, source, accessLevel, ip, presentedToken) {
  const now = Math.floor(Date.now() / 1000);
  const lifetime = Math.min(24 * 60 * 60, Number.isFinite(source.exp) ? source.exp - now : 24 * 60 * 60);
  if (lifetime <= 0) throw new AppError('Session expired', 401, 'TOKEN_EXPIRED');

  // A portal-derived session must remain subject to account/assignment and
  // parent-session revocation checks after either role change.
  const provenance = source.via === 'customer' ? {
    via: 'customer', customerId: source.customerId,
    ...(source.contactId !== undefined && { contactId: source.contactId }),
    parentIat: source.parentIat, parentJti: source.parentJti,
  } : {};
  const token = jwt.sign({
    type: 'gallery', eventId: event.id, eventSlug: event.slug,
    jti: crypto.randomUUID(), iat: now, accessLevel, ip, loginTime: Date.now(), ...provenance,
    ...(accessLevel === 'client' ? clientPinEntryClaim(event) : {}),
  }, process.env.JWT_SECRET, { expiresIn: lifetime, issuer: 'picpeak-auth' });
  const theme = await publicThemeFields(event);
  // Prepare everything first: a failed theme/settings read must not strand
  // the visitor with an already-revoked source session. Neither the token nor
  // its cookies leave the server unless revocation succeeds.
  if (!presentedToken || !(await revokeToken(presentedToken,
    accessLevel === 'client' ? 'client_mode_entered' : 'client_mode_ended')))
    throw new AppError('Could not replace the gallery session. Please try again.', 503, 'SESSION_REPLACEMENT_FAILED');
  setGalleryAuthCookies(res, token, event.slug, lifetime * 1000);
  return {
    token, accessLevel, viaCustomer: source.via === 'customer', viaClientPin: accessLevel === 'client',
    event: {
      id: event.id, event_name: event.event_name, event_type: event.event_type,
      event_date: toDateOnly(event.event_date), expires_at: event.expires_at,
      welcome_message: event.welcome_message, color_theme: theme.color_theme,
      allow_user_uploads: event.allow_user_uploads, upload_category_id: event.upload_category_id,
      require_password: requiresGalleryPassword(event),
    },
  };
}

module.exports = { replaceGallerySession };
