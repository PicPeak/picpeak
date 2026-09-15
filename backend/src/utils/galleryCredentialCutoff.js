/**
 * Gallery sessions end when the credential they were opened with changes.
 *
 * Guest sessions come from the gallery password (or the share link of a gallery
 * without one), client sessions from the client password or the client link.
 * Portal sessions (`via: 'customer'`) are bound to the customer account and
 * slideshow sessions to the slideshow link, so neither is cut off here.
 */
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

function assertGalleryCredentialCurrent(event, session) {
  if (!event || !session || session.via === 'customer' || session.accessLevel === 'slideshow') return;
  const changedAt = event[session.accessLevel === 'client' ? COLUMN.client : COLUMN.gallery];
  if (changedAt == null) return;
  const changed = toTimestamp(changedAt);
  // Same-second convention as account password changes: a session opened in
  // the second of the change is the one made with the new credential.
  if (Number.isFinite(changed) && session.iat < Math.floor(changed / 1000)) {
    throw new AppError('Gallery password changed', 401, 'GALLERY_PASSWORD_CHANGED');
  }
}

module.exports = { credentialChangeColumns, assertGalleryCredentialCurrent };
