const crypto = require('crypto');
const { toTimestamp } = require('../../utils/dateNormalize');
const { isTrue } = require('../../utils/galleryLifecycle');

/** Earn only time that overlaps a still-valid purchase. */
function pauseCompensatedExpiry(record, gallery, now = Date.now()) {
  let end = toTimestamp(record?.expires_at);
  if (!Number.isFinite(end)) return null;
  if (isTrue(gallery?.temporarily_disabled)) {
    const start = Math.max(toTimestamp(gallery.temporarily_disabled_at), toTimestamp(record.purchased_at));
    // An expired/revoked row is never revived by a later pause.
    if (Number.isFinite(start) && end > start) end += Math.max(0, now - start);
  }
  return new Date(end).toISOString();
}

/** Gallery expiry limits access, without permanently shortening earned time. */
function pauseAdjustedExpiry(record, gallery, now = Date.now()) {
  const expiry = pauseCompensatedExpiry(record, gallery, now);
  if (!expiry) return null;
  const cutoff = toTimestamp(gallery?.expires_at);
  return Number.isFinite(cutoff) ? new Date(Math.min(Date.parse(expiry), cutoff)).toISOString() : expiry;
}

function createPurchaseAccessToken() {
  return crypto.randomBytes(24).toString('hex');
}

function isPurchaseAccessActive(record, gallery) {
  if (!record || !record.expires_at) return false;
  const expiresAt = new Date(gallery ? pauseAdjustedExpiry(record, gallery) : record.expires_at);
  if (!Number.isFinite(expiresAt.getTime())) return false;
  return expiresAt.getTime() > Date.now();
}

function verifyPurchaseAccess(record, gallery) {
  return !!record && isPurchaseAccessActive(record, gallery);
}

function findValidPhotoPurchaseAccess({ galleryId, photoId, accessToken, rows = [] } = {}) {
  if (!galleryId || !photoId || !accessToken || !Array.isArray(rows)) return null;

  const targetGalleryId = Number(galleryId);
  const targetPhotoId = Number(photoId);
  const token = String(accessToken);

  for (const row of rows) {
    if (!row) continue;
    if (Number(row.gallery_id ?? row.galleryId) !== targetGalleryId) continue;
    if (Number(row.photo_id ?? row.photoId) !== targetPhotoId) continue;
    if (String(row.access_token ?? row.accessToken ?? '') !== token) continue;
    if (!verifyPurchaseAccess(row)) continue;
    return row;
  }

  return null;
}

/**
 * The valid purchase access this gallery request holds for one photo: the
 * `access_token` (or `accessToken`) query parameter, looked up among the
 * photo's purchases. Null without a token or without a valid purchase.
 */
async function requestPhotoPurchaseAccess(req, photo) {
  const accessToken = req.query?.access_token || req.query?.accessToken || null;
  if (!accessToken) return null;
  // Loaded here, not at the top: the rest of this module is pure.
  const { db } = require('../../database/db');
  return findValidPhotoPurchaseAccess({
    galleryId: req.event.id,
    photoId: photo.id,
    accessToken,
    rows: await db('photo_purchases')
      .where({ access_token: accessToken, gallery_id: req.event.id, photo_id: photo.id })
      .select('id', 'gallery_id', 'photo_id', 'access_token', 'expires_at'),
  });
}

function buildPurchasedDownloadUrl({ baseUrl = '', accessToken } = {}) {
  const normalized = String(baseUrl || '').replace(/\/$/, '');
  const path = `/purchased-downloads/${accessToken}`;
  return normalized ? `${normalized}${path}` : path;
}

module.exports = {
  pauseCompensatedExpiry,
  pauseAdjustedExpiry,
  createPurchaseAccessToken,
  isPurchaseAccessActive,
  verifyPurchaseAccess,
  findValidPhotoPurchaseAccess,
  requestPhotoPurchaseAccess,
  buildPurchasedDownloadUrl,
};
