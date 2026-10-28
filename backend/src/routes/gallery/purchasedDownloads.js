const express = require('express');
const fs = require('fs');
const { db } = require('../../database/db');
const { sellablePhotos } = require('../../modules/photoSales/sellable');
const { errorResponse } = require('../../utils/routeHelpers');
const { verifyPurchaseAccess, buildPurchasedDownloadUrl, pauseAdjustedExpiry } = require('../../modules/photoSales/purchaseAccess');
const { resolvePhotoStorageKey, resolvePhotoFilePath } = require('../../services/photoResolver');
const { getStorage } = require('../../services/storage');
const { resolvePhotoContentType } = require('../../utils/photoContentType');
const { getUseOriginalFilenames, pickRawDownloadName } = require('../../services/downloadFilenameService');
const { buildContentDisposition } = require('../../utils/filenameSanitizer');
const { pipeStreamToResponse } = require('../../utils/streamResponse');
const logger = require('../../utils/logger');
const { getSupportEmail } = require('../../services/emailProcessor');
const { noStoreCache } = require('../../middleware/noStoreCache');
const { toIso } = require('../../utils/dateNormalize');

const router = express.Router();

const isTrue = (value) => value === true || value === 1 || value === '1';

/**
 * A granted order (not refunded, charged back or cancelled — the webhook
 * revokes those) whose access has not expired.
 */
function isOrderActive(order, gallery) {
  return !!order && order.status === 'completed' && verifyPurchaseAccess(order, gallery);
}

/**
 * The gallery of an order while the photographer still offers it: an
 * inactive or archived gallery takes its purchase links down with it. Expiry
 * does both, so the webhook never sells access past the gallery's expiry.
 */
async function orderGallery(order) {
  const gallery = await db('events').where({ id: order.gallery_id }).first();
  return gallery && isTrue(gallery.is_active) && !isTrue(gallery.is_archived) ? gallery : null;
}

/**
 * The order behind a purchase link and that photo's purchase row, both
 * unexpired. Null when the link does not grant the photo.
 */
async function activePurchase(accessToken, photoId) {
  const order = await db('photo_purchase_orders').where({ access_token: accessToken }).first();
  if (!order) return null;
  const gallery = await orderGallery(order);
  if (!isOrderActive(order, gallery)) return null;
  const row = await db('photo_purchases')
    .where({ order_id: order.order_id, access_token: accessToken, photo_id: photoId })
    .first('id', 'photo_id', 'expires_at', 'purchased_at');
  return row && verifyPurchaseAccess(row, gallery) ? { order, row, gallery } : null;
}

router.get('/purchased-downloads/:accessToken', noStoreCache, async (req, res) => {
  try {
    const { accessToken } = req.params;
    const order = await db('photo_purchase_orders')
      .where({ access_token: accessToken })
      .first();

    if (!order) {
      return res.status(404).json({ error: 'Purchase link not found' });
    }

    const gallery = await orderGallery(order);
    if (!isOrderActive(order, gallery)) {
      return res.status(403).json({ error: 'Access expired' });
    }

    if (!gallery) {
      return res.status(404).json({ error: 'Gallery not available' });
    }

    const accessRows = await db('photo_purchases')
      .where({ order_id: order.order_id, access_token: accessToken })
      .select('id', 'photo_id', 'expires_at', 'purchased_at', 'gallery_id', 'access_token');

    const activeRows = accessRows.filter((row) => verifyPurchaseAccess(row, gallery));
    if (!activeRows.length) {
      return res.status(403).json({ error: 'Access expired' });
    }

    if (isTrue(gallery.temporarily_disabled)) {
      // The order and entitlement remain intact. This response confirms a
      // valid purchase without offering file URLs while the gallery is paused.
      return res.json({
        order_id: order.order_id,
        gallery_slug: gallery.slug,
        gallery_name: gallery.event_name || null,
        buyer_email: order.buyer_email,
        expires_at: pauseAdjustedExpiry(order, gallery),
        temporarily_disabled: true,
        gallery_expires_at: toIso(gallery.expires_at) || null,
        support_email: await getSupportEmail(),
        photo_count: activeRows.length,
        photos: [],
      });
    }

    const photoIds = activeRows.map((row) => row.photo_id);
    const photos = await sellablePhotos(db, order.gallery_id)
      .whereIn('photos.id', photoIds)
      .select('photos.*');

    const byId = new Map(photos.map((photo) => [Number(photo.id), photo]));
    const validPhotos = photoIds
      .map((id) => byId.get(Number(id)))
      .filter(Boolean);

    return res.json({
      access_token: accessToken,
      order_id: order.order_id,
      gallery_id: order.gallery_id,
      gallery_slug: gallery?.slug || null,
      gallery_name: gallery?.event_name || null,
      buyer_email: order.buyer_email,
      expires_at: pauseAdjustedExpiry(order, gallery),
      photo_ids: validPhotos.map((photo) => Number(photo.id)),
      photos: validPhotos.map((photo) => ({
        id: Number(photo.id),
        filename: photo.original_filename || photo.filename || null,
        // The purchase link alone authorizes the download: the buyer often
        // opens the email on a device that never logged into the gallery.
        photo_url: `/api/gallery/purchased-downloads/${encodeURIComponent(accessToken)}/photos/${photo.id}`,
      })),
      download_url: buildPurchasedDownloadUrl({ accessToken }),
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to load purchased download access');
  }
});

// The original of one bought photo. Authorized by the purchase link only (no
// gallery session): the order and the photo's purchase row must both be
// unexpired, and the photo must still be a sellable photo of the order's
// gallery.
router.get('/purchased-downloads/:accessToken/photos/:photoId', noStoreCache, async (req, res) => {
  try {
    const photoId = Number(req.params.photoId);
    if (!Number.isInteger(photoId) || photoId <= 0) {
      return res.status(404).json({ error: 'Photo not found' });
    }
    const purchase = await activePurchase(req.params.accessToken, photoId);
    if (!purchase) {
      return res.status(403).json({ error: 'This purchase link does not include this photo or has expired' });
    }

    const event = purchase.gallery;
    if (isTrue(event?.temporarily_disabled)) {
      return res.status(403).json({ error: 'This gallery is temporarily unavailable.', code: 'GALLERY_TEMPORARILY_DISABLED' });
    }
    const photo = event
      ? await sellablePhotos(db, event.id).where('photos.id', photoId).first('photos.*')
      : null;
    if (!photo) return res.status(404).json({ error: 'Photo not found' });

    const headers = {
      'Content-Type': resolvePhotoContentType(photo),
      'Content-Disposition': buildContentDisposition(pickRawDownloadName(photo, await getUseOriginalFilenames())),
      'Cache-Control': 'private, no-store',
    };

    // Managed photos go through the storage backend (local or S3); external
    // and reference photos live on a local mount.
    const storageKey = resolvePhotoStorageKey(event, photo);
    if (storageKey) {
      const storage = getStorage();
      const stat = await storage.stat(storageKey);
      if (!stat) return res.status(404).json({ error: 'Photo file not found' });
      const stream = await storage.get(storageKey);
      res.set({ ...headers, 'Content-Length': stat.size });
      return pipeStreamToResponse(stream, res, { context: `purchased download of photo ${photo.id}` });
    }

    const filePath = resolvePhotoFilePath(event, photo);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Photo file not found' });
    res.set(headers);
    return res.sendFile(filePath, (error) => {
      if (error && !res.headersSent) {
        logger.warn(`Purchased download of photo ${photo.id} failed: ${error.message}`);
        res.status(500).json({ error: 'Failed to download photo' });
      }
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to download purchased photo');
  }
});

module.exports = router;
