const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { requiresGalleryPassword } = require('../utils/galleryLifecycle');
const { toDateOnly } = require('../utils/dateOnly');
const { publicThemeFields } = require('./galleryTheme');
const { setGalleryAuthCookies } = require('../utils/tokenUtils');
const { AppError } = require('../utils/errors');

/** Change this gallery session's role without extending its remaining lifetime. */
async function replaceGallerySession(res, event, source, accessLevel, ip) {
  const now = Math.floor(Date.now() / 1000);
  const lifetime = Math.min(24 * 60 * 60, Number.isFinite(source.exp) ? source.exp - now : 24 * 60 * 60);
  if (lifetime <= 0) throw new AppError('Session expired', 401, 'TOKEN_EXPIRED');

  // A portal-derived session must remain subject to account/assignment and
  // parent-session revocation checks after either role change.
  const provenance = source.via === 'customer' ? {
    via: 'customer', customerId: source.customerId,
    parentIat: source.parentIat, parentJti: source.parentJti,
  } : {};
  const token = jwt.sign({
    type: 'gallery', eventId: event.id, eventSlug: event.slug,
    jti: crypto.randomUUID(), iat: now, accessLevel, ip, loginTime: Date.now(), ...provenance,
  }, process.env.JWT_SECRET, { expiresIn: lifetime, issuer: 'picpeak-auth' });
  const theme = await publicThemeFields(event);
  setGalleryAuthCookies(res, token, event.slug, lifetime * 1000);
  return {
    token, accessLevel, viaCustomer: source.via === 'customer',
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
