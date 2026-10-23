const express = require('express');
const fs = require('fs');
const { db } = require('../../database/db');
const { livePhotos } = require('../../utils/photoVisibility');
const { errorResponse } = require('../../utils/routeHelpers');
const { verifyPurchaseAccess, buildPurchasedDownloadUrl } = require('../../modules/photoSales/purchaseAccess');
const { resolvePhotoStorageKey, resolvePhotoFilePath } = require('../../services/photoResolver');
const { getStorage } = require('../../services/storage');
const { resolvePhotoContentType } = require('../../utils/photoContentType');
const { getUseOriginalFilenames, pickRawDownloadName } = require('../../services/downloadFilenameService');
const { buildContentDisposition } = require('../../utils/filenameSanitizer');
const { pipeStreamToResponse } = require('../../utils/streamResponse');
const logger = require('../../utils/logger');

const router = express.Router();

/**
 * The order behind a purchase link and that photo's purchase row, both
 * unexpired. Null when the link does not grant the photo.
 */
async function activePurchase(accessToken, photoId) {
  const order = await db('photo_purchase_orders').where({ access_token: accessToken }).first();
  if (!order || !verifyPurchaseAccess(order)) return null;
  const row = await db('photo_purchases')
    .where({ order_id: order.order_id, access_token: accessToken, photo_id: photoId })
    .first('id', 'photo_id', 'expires_at');
  return row && verifyPurchaseAccess(row) ? { order, row } : null;
}

router.get('/purchased-downloads/:accessToken', async (req, res) => {
  try {
    const { accessToken } = req.params;
    const order = await db('photo_purchase_orders')
      .where({ access_token: accessToken })
      .first();

    if (!order) {
      return res.status(404).json({ error: 'Purchase link not found' });
    }

    if (!verifyPurchaseAccess(order)) {
      return res.status(403).json({ error: 'Access expired' });
    }

    const gallery = await db('events')
      .where({ id: order.gallery_id })
      .first('id', 'slug', 'event_name');

    const accessRows = await db('photo_purchases')
      .where({ order_id: order.order_id, access_token: accessToken })
      .select('id', 'photo_id', 'expires_at', 'gallery_id', 'access_token');

    const activeRows = accessRows.filter((row) => verifyPurchaseAccess(row));
    if (!activeRows.length) {
      return res.status(403).json({ error: 'Access expired' });
    }

    const photoIds = activeRows.map((row) => row.photo_id);
    const photos = await livePhotos(db)
      .whereIn('id', photoIds)
      .where('event_id', order.gallery_id)
      .select('*');

    const byId = new Map(photos.map((photo) => [Number(photo.id), photo]));
    const validPhotos = photoIds
      .map((id) => byId.get(Number(id)))
      .filter(Boolean);

    return res.json({
      access_token: accessToken,
      order_id: order.order_id,
      gallery_id: order.gallery_id,
      gallery_slug: gallery?.slug || null,
      buyer_email: order.buyer_email,
      expires_at: order.expires_at,
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
// unexpired, and the photo must still be a live photo of the order's gallery.
router.get('/purchased-downloads/:accessToken/photos/:photoId', async (req, res) => {
  try {
    const photoId = Number(req.params.photoId);
    if (!Number.isInteger(photoId) || photoId <= 0) {
      return res.status(404).json({ error: 'Photo not found' });
    }
    const purchase = await activePurchase(req.params.accessToken, photoId);
    if (!purchase) {
      return res.status(403).json({ error: 'This purchase link does not include this photo or has expired' });
    }

    const event = await db('events').where({ id: purchase.order.gallery_id }).first();
    const photo = event
      ? await livePhotos(db).where({ id: photoId, event_id: event.id }).first()
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
