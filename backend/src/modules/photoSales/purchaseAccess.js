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
  buildPurchasedDownloadUrl,
};
