/**
 * Gallery sessions end when the credential they were opened with changes.
 *
 * Guest sessions come from the gallery password (or the share link of a gallery
 * without one), client sessions from the client password or the client link.
 * Slideshow sessions come from the slideshow link: the session carries a digest
 * of the link it was opened with, and rotating or disabling the link ends every
 * session opened with the old one. Portal sessions (`via: 'customer'`) are bound
 * to the customer account, so they are not cut off here.
 */
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { hasColumnCached } = require('./schemaCache');
const { toTimestamp } = require('./dateNormalize');
const { AppError } = require('./errors');

const COLUMN = { gallery: 'gallery_password_changed_at', client: 'client_password_changed_at' };

/**
 * Columns stamping a credential change, for the same UPDATE that changes it.
 * Call outside any transaction: hasColumnCached reads through the global pool.
 * @param {...('gallery'|'client')} kinds
 */
async function credentialChangeColumns(...kinds) {
  const columns = {};
  const now = new Date().toISOString();
  for (const kind of kinds) {
    if (await hasColumnCached('events', COLUMN[kind])) columns[COLUMN[kind]] = now;
  }
  return columns;
}

/**
 * Does a submitted gallery or client password equal the one already stored?
 * Resubmitting the current password (e.g. in "Send gallery email") is not a
 * change and must not end the sessions opened with it.
 */
async function sameAsStored(plain, storedHash) {
  if (!plain || !storedHash) return false;
  try {
    return await bcrypt.compare(plain, storedHash);
  } catch {
    return false;
  }
}

function slideshowLinkDigest(showShareToken) {
  return crypto.createHash('sha256').update(String(showShareToken)).digest('hex').slice(0, 16);
}

/**
 * Claim for a slideshow session JWT naming the link it was opened with. Not
 * the link itself: the JWT is sent on every image request.
 */
function slideshowCredentialClaim(event) {
  return { showLink: slideshowLinkDigest(event.show_share_token) };
}

function assertGalleryCredentialCurrent(event, session) {
  if (!event || !session || session.via === 'customer') return;
  if (session.accessLevel === 'slideshow') {
    // A session without the claim predates it. It lives 12 hours at most and
    // is left to expire rather than blanking every running projector at the
    // deploy that introduced the claim.
    if (session.showLink === undefined) return;
    if (!event.show_share_token || session.showLink !== slideshowLinkDigest(event.show_share_token)) {
      throw new AppError('Slideshow link changed', 401, 'SLIDESHOW_LINK_CHANGED');
    }
    return;
  }
  const changedAt = event[session.accessLevel === 'client' ? COLUMN.client : COLUMN.gallery];
  if (changedAt == null) return;
  const changed = toTimestamp(changedAt);
  // Same-second convention as account password changes: a session opened in
  // the second of the change is the one made with the new credential.
  if (Number.isFinite(changed) && session.iat < Math.floor(changed / 1000)) {
    throw new AppError('Gallery password changed', 401, 'GALLERY_PASSWORD_CHANGED');
  }
}

module.exports = { credentialChangeColumns, sameAsStored, slideshowCredentialClaim, assertGalleryCredentialCurrent };
