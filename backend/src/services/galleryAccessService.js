const { db } = require('../database/db');
const { userHasAllPermissions } = require('../middleware/permissions');
const { canAccessEvent } = require('../middleware/ownership');
const { assertGalleryAvailable, requiresGalleryPassword } = require('../utils/galleryLifecycle');
const { isTokenBeforeCutoff } = require('../utils/sessionCutoff');
const { AppError } = require('../utils/errors');
const { assertGalleryCredentialCurrent } = require('../utils/galleryCredentialCutoff');
const sessions = require('./sessionAccessService');

// These claims identify a session for revocation; no raw JWT, IP or password
// enters a media URL. Only use grants from this service or a verified signature.
// parentIat/parentJti identify the portal session a gallery token was minted from.
const CLAIMS = ['type', 'id', 'customerId', 'eventId', 'eventSlug', 'iat', 'exp', 'jti', 'via', 'accessLevel',
  'parentIat', 'parentJti'];

class GalleryAccessService {
  grant(event, kind, decoded) {
    const session = decoded && Object.fromEntries(CLAIMS
      .filter((key) => decoded[key] !== undefined).map((key) => [key, decoded[key]]));
    return { kind, eventId: event.id, issuedAt: Math.floor(Date.now() / 1000), ...(session && { session }) };
  }

  async authorize(event, grant) {
    if (!grant || !['public', 'gallery', 'admin'].includes(grant.kind)
      || !event || Number(grant.eventId) !== Number(event.id)) {
      throw new AppError('Invalid gallery grant', 403, 'INVALID_GALLERY_GRANT');
    }
    assertGalleryAvailable(event, { adminPreview: grant.kind === 'admin' });
    if (!Number.isFinite(grant.issuedAt) || await isTokenBeforeCutoff({ iat: grant.issuedAt })) {
      throw new AppError('Session invalidated', 401, 'SESSION_INVALIDATED');
    }
    const session = grant.session;
    if (grant.kind === 'admin') {
      // adminAuth gates the whole admin API on must_change_password
      // (middleware/auth.js:52), but the gallery preview never passes through
      // adminAuth - it authorizes here - so without this an admin issued a
      // temporary password was locked out of the admin API and could still
      // list, view and download gallery photos through ?admin_preview=1. The
      // flag exists to force a rotation; a path that ignores it makes the
      // rotation optional.
      //
      // No includeProfile: sessionAccessService projects the flag
      // unconditionally. Asking for the profile would also pull in
      // roles.display_name, making this path fail - and fall back to a
      // fabricated super_admin - on a schema missing only that column.
      const account = await sessions.admin(session);
      if (account.must_change_password) {
        throw new AppError('Password change required before continuing', 403, 'MUST_CHANGE_PASSWORD');
      }
      const principal = { id: account.id, roleName: account.role_name };
      if (!canAccessEvent(principal, event)
        || !await userHasAllPermissions(account.id, ['events.view', 'photos.view'])) {
        throw new AppError('Access denied', 403, 'FORBIDDEN');
      }
    } else if (grant.kind === 'gallery') {
      await sessions.assertActive(session, 'gallery');
      if (Number(session.eventId) !== Number(event.id)) {
        throw new AppError('Token does not match requested gallery', 403, 'INVALID_GALLERY_GRANT');
      }
      assertGalleryCredentialCurrent(event, session);
      if (session.via === 'customer') {
        await sessions.customer(session, { derived: true });
        const assignment = await db('event_customer_assignments')
          .where({ event_id: event.id, customer_account_id: session.customerId }).first();
        if (!assignment) {
          throw new AppError('Access to this gallery has been revoked', 403, 'CUSTOMER_ASSIGNMENT_REVOKED');
        }
      }
    } else if (requiresGalleryPassword(event)) {
      throw new AppError('No token provided', 401, 'NO_TOKEN');
    }
    return grant;
  }
}

module.exports = new GalleryAccessService();
