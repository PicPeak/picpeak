const crypto = require('crypto');

function createPurchaseAccessToken() {
  return crypto.randomBytes(24).toString('hex');
}

function isPurchaseAccessActive(record) {
  if (!record || !record.expires_at) return false;
  const expiresAt = new Date(record.expires_at);
  if (!Number.isFinite(expiresAt.getTime())) return false;
  return expiresAt.getTime() > Date.now();
}

function verifyPurchaseAccess(record) {
  return !!record && isPurchaseAccessActive(record);
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
  createPurchaseAccessToken,
  isPurchaseAccessActive,
  verifyPurchaseAccess,
  findValidPhotoPurchaseAccess,
  buildPurchasedDownloadUrl,
};
