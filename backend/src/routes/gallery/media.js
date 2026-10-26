const express = require('express');
const { db } = require('../../database/db');
const path = require('path');
const { resolvePhotoContentType } = require('../../utils/photoContentType');
const { parsePositiveInt32 } = require('../../utils/parsers');
const router = express.Router();

// A photoId that is not a plausible row id is refused here (issue 2078);
// PostgreSQL answers a non-numeric or int4-overflowing id with a 500.
router.param('photoId', (req, res, next, value) => {
  if (parsePositiveInt32(value) === null) {
    return res.status(404).json({ error: 'Photo not found' });
  }
  next();
});
const watermarkService = require('../../services/watermarkService');
const watermarkGeneratorService = require('../../services/watermarkGeneratorService');
const { verifyGalleryAccess, denySlideshowToken } = require('../../middleware/gallery');
const withPreview = (req, url) => (req.isAdminPreview ? `${url}${url.includes('?') ? '&' : '?'}admin_preview=1` : url);

// Whether a video thumbnail request names another frame pick than the row
// has (issue 2263, item 4): `poster` is the pick, absent for the default.
function posterVersionStale(photo, asked) {
  const isVideo = photo.media_type === 'video' || (photo.mime_type && photo.mime_type.startsWith('video/'));
  if (!isVideo) return false;
  const current = photo.poster_offset_seconds != null ? String(photo.poster_offset_seconds) : '';
  return (typeof asked === 'string' ? asked : '') !== current;
}
const secureImageService = require('../../services/secureImageService');
const logger = require('../../utils/logger');
const { pipeStreamToResponse, answerVanished } = require('../../utils/streamResponse');

const { errorResponse } = require('../../utils/routeHelpers');
const { blockHiddenGallery } = require('../../utils/revealMode');
const { isPhotoHiddenFromViewer, isPhotoProcessed, livePhotos } = require('../../utils/photoVisibility');
const { ensureThumbnail, ensureHeroImage, ensurePreviewImage, withLocalCopy } = require('../../services/imageProcessor');
const { isStorageUnavailableError, isStorageNotFoundError } = require('../../services/storage/storageErrors');
const { heroQueryRedirect } = require('../../utils/heroAnchor');
const { getStorage } = require('../../services/storage');
const fs = require('fs');
const { getStoragePath } = require('../../config/storage');
const { safePathJoin, sniffImageType, sniffImageFileType } = require('../../utils/fileSecurityUtils');
const {
  originalAssetDenial, grantDenial, isPresentationRenditionKey, isRemuxWebKey, fullResolutionDenial,
  MAXIMUM_PROTECTION_CAP, capsFullSizeView,
} = require('../../services/galleryAssetPolicy');
const sharp = require('../../services/isolatedSharp');
const imageResourcePolicy = require('../../services/imageResourcePolicy');
const {
  currentDownloadLimit, grantedPhotoIds, grantDownloads, checkDownloads,
  drawsOnQuota, clientOnlyError, refuseDownload, downloadLimitError, settleWhenDone, responseDelivered,
} = require('../../services/downloadQuota');
const videoHls = require('../../services/videoHlsService');
const { refundRateLimit } = require('../../services/rateLimitService');

// The image type a stored object's first bytes prove, or null. A stored
// watermark is usually the JPEG applyWatermark re-encoded, but it can be the
// untouched original when there was nothing to draw (issue 2178).
async function sniffStoredImageType(storage, key) {
  try {
    const chunks = [];
    for await (const chunk of await storage.getRange(key, 0, 63)) chunks.push(chunk);
    return sniffImageType(Buffer.concat(chunks));
  } catch {
    return null;
  }
}

// Photo sales: priced galleries force the existing
// watermark pipeline for paid photos and keep unpaid guests on the
// low-quality preview tier; valid purchase tokens see the original.
const { isGalleryPriced, shouldForceWatermarkForPhoto, resolvePhotoSalesWatermarkSettings } = require('../../modules/photoSales/priceRules');
const { findValidPhotoPurchaseAccess } = require('../../modules/photoSales/purchaseAccess');

/**
 * Download limit (issue 1560): a video without a web copy has no preview
 * tier, so playing it streams the original, and on a limited gallery that
 * takes a slot like a download. Playing the web copy takes none, like an
 * image preview. One slot per video: once it is granted, replays and every further
 * Range request are free. Only the client may draw on the quota; a guest
 * plays a video someone already granted and is refused any other. Returns
 * false once it has answered the request itself.
 */
async function admitVideoStream(req, res, photo) {
  if (req.isAdminPreview || !(await currentDownloadLimit(req.event))) return true;
  const photoId = Number(photo.id);
  const delivered = await grantedPhotoIds(req.event.id, [photoId], db, { deliveredOnly: true });
  if (delivered.has(photoId)) return true;
  if (!drawsOnQuota(req)) {
    res.status(403).json(clientOnlyError());
    return false;
  }
  // A HEAD probe answers without taking any of the quota.
  if (req.method === 'HEAD') {
    const check = await checkDownloads(req.event, [photoId]);
    if (check.ok) return true;
    res.status(403).json(downloadLimitError(check));
    return false;
  }
  const quota = await grantDownloads(req.event, [photoId], { reserve: true });
  if (!quota.ok) {
    refuseDownload(res, quota);
    return false;
  }
  settleWhenDone(res, req.event.id, quota, responseDelivered(res, [photoId]));
  return true;
}

/**
 * Is this photo outside what the viewer's grant may reach?
 *
 * Client-hidden photos are blocked for everyone but the client. A slideshow
 * session of an event that pins show_category_id sees that category only:
 * the list is filtered that way server-side (galleryQueryService), and the
 * media routes must agree, or a link holder could request every other
 * category's photos by id. Applied by every route below that resolves a photo.
 */
function isPhotoOutsideGrant(req, photo) {
  if (isPhotoHiddenFromViewer(photo, req.accessLevel)) return true;
  // A photo the worker has not finished, or failed on, is not in the gallery
  // list (wherePhotoProcessed); by id it must not be either. The admin
  // preview keeps reaching it, as the admin views do.
  if (!req.isAdminPreview && !isPhotoProcessed(photo)) return true;
  return req.accessLevel === 'slideshow' && req.event?.show_category_id != null
    && Number(photo.category_id) !== Number(req.event.show_category_id);
}

/**
 * A preview rendition inside MAXIMUM_PROTECTION_CAP (issue 2152), re-encoded
 * at its quality, with no metadata (sharp strips it). Maximum protection
 * serves this from both the photo and the preview route, so the lightbox gets
 * the cap whether it loads the preview tier or the original. The preview tier
 * is the source, so a request decodes at most a 1920px image, in the image
 * worker pool (`interactive`: refused with a 503 under a flood, not queued);
 * no further derived file is stored. The watermark goes on first, through the
 * same path-keyed cache the preview route uses, and is scaled down with the
 * picture; marking after the resize would re-encode at the watermark's own
 * quality. A WebP preview (alpha or animation) stays WebP, and without a
 * watermark an animated one keeps its frames: the preview generator leaves
 * them unrotated, so they are not rotated here either (`.rotate()` flattens).
 */
async function capPreviewRendition(previewPath, watermarkSettings) {
  const webp = previewPath.endsWith('.webp');
  const { width, height, quality } = MAXIMUM_PROTECTION_CAP;
  const buffer = await withLocalCopy(previewPath, async (localPath) => {
    const input = watermarkSettings?.enabled
      ? await watermarkService.applyWatermark(localPath, watermarkSettings, { failClosed: true })
      : localPath;
    const animated = webp && !watermarkSettings?.enabled
      && ((await sharp(input, { interactive: true, failOn: 'none' }).metadata()).pages || 1) > 1;
    let image = sharp(input, { interactive: true, failOn: 'none', animated });
    if (!animated) image = image.rotate();
    image = image.resize(width, height, { fit: 'inside', withoutEnlargement: true });
    return (webp ? image.webp({ quality }) : image.jpeg({ quality, progressive: true, mozjpeg: true })).toBuffer();
  });
  return { buffer, contentType: webp ? 'image/webp' : 'image/jpeg' };
}

/** The photo route's capped view: its preview rendition, capped. Null when no preview can be made. */
async function renderCappedView(photo, watermarkSettings) {
  let previewPath = await ensurePreviewImage(photo);
  // Same self-heal as the preview route for a legacy pointer shape.
  if (previewPath && !isPresentationRenditionKey(previewPath, 'preview')) {
    previewPath = await ensurePreviewImage({ ...photo, preview_path: null }, { force: true });
  }
  if (!isPresentationRenditionKey(previewPath, 'preview')) return null;
  return capPreviewRendition(previewPath, watermarkSettings);
}

router.post('/:slug/photo/:photoId/view',
  verifyGalleryAccess,
  denySlideshowToken,
  blockHiddenGallery,
  async (req, res) => {
    try {
      const photo = await livePhotos(db)
        .where({ id: req.params.photoId, event_id: req.event.id })
        .first('id', 'visibility', 'moderation_status', 'category_id', 'processing_status', 'unavailable_reason');
      if (!photo) {
        return res.status(404).json({ error: 'Photo not found' });
      }
      if (isPhotoOutsideGrant(req, photo)) {
        return res.status(403).json({ error: 'Photo not available' });
      }
      // Admin preview (#981 review) is excluded from per-photo view analytics.
      if (!req.isAdminPreview) {
        await livePhotos(db).where('id', photo.id).increment('view_count', 1);
      }
      res.status(204).end();
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to record view');
    }
  });

// View single photo (with watermark if enabled)
router.get('/:slug/photo/:photoId',
  verifyGalleryAccess,
  // This route answers with the stored original (or the source video). A
  // slideshow session is display-only and the kiosk renders the preview tier
  // (slideshow_url), so it has no business here.
  denySlideshowToken,
  blockHiddenGallery,
  async (req, res) => {
    try {
      const { photoId } = req.params;

      const photo = await livePhotos(db)
        .where({ id: photoId, event_id: req.event.id })
        .first();

      if (!photo) {
        return res.status(404).json({ error: 'Photo not found' });
      }

      // Block guest access to hidden photos
      if (isPhotoOutsideGrant(req, photo)) {
        return res.status(403).json({ error: 'Photo not available' });
      }

      // Check if this is a video
      const isVideo = photo.media_type === 'video' || (photo.mime_type && photo.mime_type.startsWith('video/'));

      // Every protection level is served here. Enhanced/maximum used to answer
      // a 302 JSON pointing at /api/secure-images/.../generate-token, which no
      // shipped frontend code calls, so still images at those levels were a
      // broken tile (#1370 exempted videos from the same bounce). The levels
      // are client-side rendering modes; the guest still needs a valid gallery
      // token to get here at all. Maximum also caps the still image's size
      // and quality (issue 2152, below).

      // Download limit (issue 1560). While one applies, guests get the preview
      // tier rather than the original, which would otherwise be a full-size
      // copy one long-press away from every counted download. Videos have no
      // preview tier: playing one is counted instead (admitVideoStream, below
      // once the file is known to exist).
      const originalDenial = await originalAssetDenial(req, photo, { display: true });
      // Full-resolution zoom (issue 1733). `?zoom=1` asks for the untouched
      // original and nothing else: where the viewer may not download exactly
      // that, it is refused rather than answered with the preview or a
      // watermarked copy, so the lightbox never takes one for the original.
      // A view, like every other answer of this route: no download counter.
      if (req.query.zoom === '1') {
        const zoomDenial = await fullResolutionDenial(req, photo);
        if (zoomDenial) return res.status(403).json(zoomDenial);
      }
      if (!isVideo && originalDenial) {
        // Keep the query (the ?v= cache-buster) so the preview is not served
        // from a stale cache entry.
        const queryAt = req.originalUrl.indexOf('?');
        const query = queryAt === -1 ? '' : req.originalUrl.slice(queryAt);
        return res.redirect(`/api/gallery/${req.params.slug}/preview/${photoId}${query}`);
      }
      // A video keeps playing where its original may not be downloaded: the
      // web copy when there is one, the source inline otherwise. Only a
      // refusal of the grant itself stops it.
      if (isVideo && grantDenial(req, photo)) {
        return res.status(403).json(originalDenial);
      }

      // Photo sales: a paid photo (outside the free quota)
      // is only ever shown as the low-quality preview rendition to viewers
      // without a valid purchase access token. With a valid token the
      // original is served unwatermarked below. There is no client-side
      // escape hatch: a failed preview render answers 404 in
      // fallBackToOriginal, so no redirect loop exists to break.
      let purchasedViewer = false;
      if (!isVideo && !req.isAdminPreview && await shouldForceWatermarkForPhoto(req.event, photo)) {
        const accessToken = req.query?.access_token || req.query?.accessToken || null;
        if (accessToken) {
          purchasedViewer = !!findValidPhotoPurchaseAccess({
            galleryId: req.event.id,
            photoId: photo.id,
            accessToken,
            rows: await db('photo_purchases')
              .where({ access_token: accessToken, gallery_id: req.event.id, photo_id: photo.id })
              .select('id', 'gallery_id', 'photo_id', 'access_token', 'expires_at'),
          });
        }
        if (!purchasedViewer) {
          const queryAt = req.originalUrl.indexOf('?');
          const query = queryAt === -1 ? '' : req.originalUrl.slice(queryAt);
          return res.redirect(`/api/gallery/${req.params.slug}/preview/${photoId}${query}`);
        }
      }

      // Resolve where to read the photo bytes from. For external/reference
      // photos the source is always a local mount path. For managed photos
      // we go through the storage abstraction so S3 deployments work too
      // (#432 — previously this route did fs.* directly and 500'd in S3
      // mode because the file wasn't on the container's local fs).
      const { resolvePhotoStorageKey, resolvePhotoFilePath } = require('../../services/photoResolver');
      const storage = getStorage();
      const isExternal = photo.source_origin === 'external' || photo.source_origin === 'reference';
      const useStorageBackend = !isExternal;

      let filePath = null;     // Local fs path (external photos OR LocalFs storage)
      let storageKey = null;   // Relative storage key (managed photos via storage abstraction)
      let stat;
      let fileSize;

      if (useStorageBackend) {
        try {
          storageKey = resolvePhotoStorageKey(req.event, photo);
        } catch (resolveError) {
          logger.error('Failed to resolve photo storage key', {
            slug: req.params.slug,
            photoId,
            eventId: req.event.id,
            error: resolveError.message,
            photoPath: photo.path,
            photoFilename: photo.filename
          });
          return res.status(404).json({ error: 'Photo file not found' });
        }
        stat = await storage.stat(storageKey);
        if (!stat) {
          logger.error('Photo not found in storage backend', {
            slug: req.params.slug,
            photoId,
            eventId: req.event.id,
            storageKey
          });
          return res.status(404).json({ error: 'Photo file not found' });
        }
        fileSize = stat.size;
      } else {
        try {
          filePath = resolvePhotoFilePath(req.event, photo);
        } catch (resolveError) {
          logger.error('Failed to resolve photo path', {
            slug: req.params.slug,
            photoId,
            eventId: req.event.id,
            error: resolveError.message,
            photoPath: photo.path,
            photoFilename: photo.filename
          });
          return res.status(404).json({ error: 'Photo file not found' });
        }
        if (!fs.existsSync(filePath)) {
          logger.error('Photo file does not exist at resolved path', {
            slug: req.params.slug,
            photoId,
            eventId: req.event.id,
            resolvedPath: filePath,
            photoPath: photo.path
          });
          return res.status(404).json({ error: 'Photo file not found' });
        }
        stat = fs.statSync(filePath);
        fileSize = stat.size;
      }

      // Handle video streaming with range requests
      if (isVideo) {
        // Browser-playable copy (issue 1430, item 8): when the queue wrote
        // one, the player gets it instead of the original. It always lives
        // in the managed backend, external originals included. A copy the
        // row points at but storage no longer has falls back to the original
        // rather than a 404 player.
        let videoKey = storageKey;
        let videoPath = filePath;
        let videoSize = fileSize;
        let videoViaStorage = useStorageBackend;
        let videoContentType = resolvePhotoContentType(photo);
        let servesWebCopy = false;
        // The pointer is a row value: only a key in the web-copy namespace is
        // read, and a restricted viewer only gets this video's own copy.
        if (photo.web_path && photo.web_status === 'complete'
            && isPresentationRenditionKey(photo.web_path, 'web')
            && (!originalDenial || (photo.web_path.startsWith(`videos/web_${photo.id}_`)
              && photo.web_path.endsWith('.mp4')))) {
          // stat() answers null for a key the backend does not have and
          // throws for anything else (network, credentials): only the first
          // is "the copy is gone". A failing backend serves the original for
          // this request and keeps the pointer.
          let webStat = null;
          let webMissing = false;
          try {
            webStat = await storage.stat(photo.web_path);
            webMissing = !webStat;
          } catch (statErr) {
            logger.warn(`Could not stat the web copy of video ${photo.id}: ${statErr.message}`);
          }
          if (webStat) {
            videoKey = photo.web_path;
            videoPath = null;
            videoSize = webStat.size;
            videoViaStorage = true;
            videoContentType = 'video/mp4';
            servesWebCopy = true;
          } else if (webMissing) {
            // The row names a copy storage does not have — a backup restored
            // without videos/, or a bucket cleaned by hand. Left at
            // `complete` it would never be rebuilt (the switch-on backfill
            // takes NULL and failed rows only), so it goes back to the queue
            // now while either video setting is on (copies or metadata
            // stripping), or to `failed` for the next switch-on. Guarded on the stale pointer, so a concurrent
            // worker's fresh publish is not undone.
            const { queuesVideos } = require('../../services/videoRenditionService');
            const enabled = await queuesVideos().catch(() => false);
            await livePhotos(db).where({ id: photo.id, web_path: photo.web_path, web_status: 'complete' }).update({
              web_path: null,
              web_status: enabled ? 'pending' : 'failed',
              web_started_at: null,
              web_error: 'copy missing from storage',
            }).catch((e) => logger.warn(`Could not re-queue the missing web copy of video ${photo.id}: ${e.message}`));
          }
        }
        // The quota counts original bytes. The web copy is a presentation
        // rendition and plays free for the client and the guest alike. A
        // remux (issue 2102) is the original's picture without its metadata:
        // it counts like the original it stands in for.
        if ((!servesWebCopy || isRemuxWebKey(videoKey)) && !(await admitVideoStream(req, res, photo))) return;
        // Playback, not a download, for a viewer who may not take the
        // original: never an attachment or a filename.
        const disposition = originalDenial ? { 'Content-Disposition': 'inline' } : {};
        const range = req.headers.range;

        if (range) {
          const parts = range.replace(/bytes=/, '').split('-');
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : videoSize - 1;
          // Validate before writing the 206: a NaN, inverted or out-of-file
          // range used to be committed to the headers and then throw while
          // streaming (or read past the end).
          if (!Number.isInteger(start) || !Number.isInteger(end)
              || start < 0 || end < start || start >= videoSize) {
            res.set('Content-Range', `bytes */${videoSize}`);
            return res.status(416).end();
          }
          const boundedEnd = Math.min(end, videoSize - 1);
          const chunksize = (boundedEnd - start) + 1;

          // Opened before any header, and the headers only staged: a storage
          // that fails before the first byte still answers an error, so the
          // slot admitVideoStream reserved goes back (responseDelivered).
          const file = videoViaStorage
            ? await storage.getRange(videoKey, start, boundedEnd)
            : fs.createReadStream(videoPath, { start, end: boundedEnd });
          res.status(206).set({
            'Content-Range': `bytes ${start}-${boundedEnd}/${videoSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': videoContentType,
            'Cache-Control': 'private, max-age=1800',
            'X-Protection-Level': 'basic',
            ...disposition
          });
          pipeStreamToResponse(file, res, { context: `video range for photo ${photo.id}` });
        } else {
          const file = videoViaStorage
            ? await storage.get(videoKey)
            : fs.createReadStream(videoPath);
          res.status(200).set({
            'Content-Length': videoSize,
            'Content-Type': videoContentType,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'private, max-age=1800',
            'X-Protection-Level': 'basic',
            ...disposition
          });
          pipeStreamToResponse(file, res, { context: `video for photo ${photo.id}` });
        }
        return;
      }

      // Image path
      let watermarkSettings = await watermarkService.getWatermarkSettingsForEvent(req.event);
      // The per-event "watermark downloads" flag follows the same global-OR-event
      // rule as the download routes. This route hands out the full-size original
      // (it only falls back to the preview tier where originals are withheld),
      // so leaving it unmarked would let a guest save an unwatermarked copy
      // around the flag (issue 2076). The pre-generated watermark file is
      // rendered from the global settings, so an event-only watermark is
      // applied on the fly.
      const eventOnlyWatermark = !watermarkSettings?.enabled
        && (req.event.watermark_downloads === true || req.event.watermark_downloads === 1
          || req.event.watermark_downloads === '1');
      if (eventOnlyWatermark) {
        watermarkSettings = { ...watermarkSettings, enabled: true };
        if (!watermarkService.watermarkLabel(watermarkSettings)) watermarkSettings.text = 'Protected';
      }
      // Photo sales: purchased viewers get the original
      // unwatermarked; a priced gallery forces the tiled mark (only the admin
      // preview reaches here unpurchased — guests were sent to /preview).
      if (purchasedViewer) {
        watermarkSettings = null;
      } else if (isGalleryPriced(req.event)) {
        watermarkSettings = await resolvePhotoSalesWatermarkSettings(req.event, photo);
      }

      const mtimeMs = stat.mtime ? stat.mtime.getTime() : 0;
      const watermarkHash = watermarkSettings?.enabled
        ? `-wm${watermarkService.versionTag(watermarkSettings)}${eventOnlyWatermark ? '-ev' : ''}`
        : '-nowm';
      // orientation_checked_at participates because the backfill (#1198) can
      // change these bytes without touching either of the other two inputs:
      // it rewrites the derived renditions while the ORIGINAL's mtime and the
      // watermark settings both stay exactly as they were. Without it a guest
      // holding a pre-fix ETag keeps getting 304 and keeps their cached
      // sideways image, however many times the backfill succeeds.
      const orientationVersion = photo.orientation_checked_at
        ? `-o${new Date(photo.orientation_checked_at).getTime()}`
        : '';
      // Maximum protection answers a capped copy (issue 2152), the admin
      // preview included, so it shows what guests get. Its own ETag: a level
      // change must not revalidate a cached original, or the other way round.
      const capped = capsFullSizeView(req.event);
      const capVersion = capped ? `-cap${MAXIMUM_PROTECTION_CAP.tag}` : '';
      const etag = `"${photoId}-${mtimeMs}${watermarkHash}${orientationVersion}${capVersion}"`;

      if (req.headers['if-none-match'] === etag) {
        return res.status(304).end();
      }

      if (capped) {
        const view = await renderCappedView(photo, watermarkSettings);
        if (!view) {
          logger.warn(`No preview to cap photo ${photoId} from at maximum protection`);
          res.set('Cache-Control', 'no-store');
          return res.status(404).json({ error: 'Photo not available' });
        }
        res.set({
          'Content-Type': view.contentType,
          'Content-Length': view.buffer.length,
          'Cache-Control': 'private, max-age=1800',
          'ETag': etag,
          'X-Protection-Level': 'basic'
        });
        return res.send(view.buffer);
      }

      if (watermarkSettings && watermarkSettings.enabled) {
        // Pre-generated watermarked file: served via the storage backend
        // (managed) or directly from local fs (external), when it was cut
        // with the gallery's current watermark text.
        if (photo.watermark_path && !eventOnlyWatermark
          && watermarkService.storedWatermarkCurrent(photo.watermark_path, watermarkSettings)) {
          try {
            if (useStorageBackend) {
              const wmStat = await storage.stat(photo.watermark_path);
              if (wmStat) {
                res.set({
                  'Content-Type': await sniffStoredImageType(storage, photo.watermark_path)
                    || resolvePhotoContentType(photo),
                  'Content-Length': wmStat.size,
                  'Cache-Control': 'private, max-age=1800',
                  'ETag': etag,
                  'X-Protection-Level': 'basic'
                });
                const wmStream = await storage.get(photo.watermark_path);
                return pipeStreamToResponse(wmStream, res, { context: `watermarked photo ${photo.id}` });
              }
            } else {
              // The column is a storage-relative key written by
              // watermarkService, but it is read straight from a row that a
              // crafted .picpeak import (or a compromised DB) can poison, so
              // a raw join would let a `../` value hand any file the process
              // can read to a gallery guest. safePathJoin throws on escape and
              // the catch below falls back to on-the-fly watermarking.
              const watermarkFilePath = safePathJoin(getStoragePath(), photo.watermark_path);
              if (fs.existsSync(watermarkFilePath)) {
                // The file keeps the original's extension but holds what
                // applyWatermark encoded: JPEG for a HEIC/GIF/TIFF (issue 2178).
                res.set({
                  'Content-Type': await sniffImageFileType(watermarkFilePath) || resolvePhotoContentType(photo),
                  'Cache-Control': 'private, max-age=1800',
                  'ETag': etag,
                  'X-Protection-Level': 'basic'
                });
                return res.sendFile(watermarkFilePath);
              }
            }
          } catch (err) {
            logger.warn(`Pre-generated watermark unusable for photo ${photoId} (${err.message}), falling back to on-the-fly`);
          }
        }

        // Fallback: apply watermark on-the-fly. applyWatermark needs a
        // local file path (sharp + fs.readFile) — for managed photos in
        // S3 mode, withLocalCopy materializes to a tmp file and cleans up.
        // Fails closed: the preview and hero routes redirect here when their
        // own watermark fails, and an unmarked original must not answer that.
        const watermarkedBuffer = useStorageBackend
          ? await withLocalCopy(storageKey, (localPath) =>
            watermarkService.applyWatermark(localPath, watermarkSettings, { failClosed: true }))
          : await watermarkService.applyWatermark(filePath, watermarkSettings, { failClosed: true });

        // Queue watermark generation in background for next request
        if (!eventOnlyWatermark) {
          watermarkGeneratorService.generateForPhoto(photo.id)
            .catch(err => logger.warn(`Background watermark generation failed for photo ${photo.id}:`, err.message));
        }

        res.set({
          'Content-Type': sniffImageType(watermarkedBuffer) || resolvePhotoContentType(photo),
          'Cache-Control': 'private, max-age=1800',
          'ETag': etag,
          'X-Protection-Level': 'basic'
        });

        res.send(watermarkedBuffer);
      } else {
        res.set({
          'Cache-Control': 'private, max-age=1800',
          'ETag': etag,
          'X-Protection-Level': 'basic'
        });
        if (useStorageBackend) {
          res.set('Content-Length', stat.size);
          res.set('Content-Type', resolvePhotoContentType(photo));
          const stream = await storage.get(storageKey);
          pipeStreamToResponse(stream, res, { context: `photo ${photo.id}` });
        } else {
          const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
          // Set before sendFile, which then keeps it instead of guessing from
          // the extension (issue 2178).
          res.set('Content-Type', resolvePhotoContentType(photo));
          res.sendFile(absolutePath);
        }
      }
    } catch (error) {
      if (answerVanished(res, error, 'Photo file not found')) return;
      errorResponse(res, error, 500, 'Failed to serve photo');
    }
  }
);

// Adaptive streaming (issue 1733, D4): the HLS ladder videoHlsService wrote
// for a video, proxied from storage on both backends so there is one auth
// path. With the setting off none of this is reachable.
async function requireAdaptiveStreaming(req, res, next) {
  if (await videoHls.isEnabled()) return next();
  return res.status(404).json({ error: 'Not found' });
}

/**
 * The photo behind an HLS request, through the checks the photo route above
 * applies to a video; null once it has answered the request itself.
 */
async function loadStreamedVideo(req, res) {
  const photo = /^\d+$/.test(req.params.photoId)
    ? await livePhotos(db).where({ id: req.params.photoId, event_id: req.event.id }).first()
    : null;
  if (!photo) {
    res.status(404).json({ error: 'Photo not found' });
    return null;
  }
  if (isPhotoOutsideGrant(req, photo) || grantDenial(req, photo)) {
    res.status(403).json({ error: 'Photo not available' });
    return null;
  }
  return photo;
}

/**
 * Download limit (issue 1560) for a stream. The ladder stands in for what
 * the photo route would play: free where that is the web copy (this video's
 * own key in its namespace, and in storage, not the row's word for it), one slot
 * where it is the original or its remux (issue 2102). Fetching the master playlist is the playback, so
 * that is what takes the slot, once per video and for the client only, as
 * admitVideoStream does for the file. Unlike a file the grant is delivered
 * at once: the playlist is a few hundred bytes, and the rung requests right
 * behind it are answered on a delivered grant only. A slot that is merely
 * held (a ZIP still being built) goes back when that download is abandoned,
 * so it opens nothing here. Rung playlists and segments never take a slot,
 * so nobody plays around the master.
 */
async function admitStream(req, res, photo, { playback }) {
  if (req.isAdminPreview || !(await currentDownloadLimit(req.event))) return true;
  if (photo.web_path && photo.web_status === 'complete' && isPresentationRenditionKey(photo.web_path, 'web')
      && !isRemuxWebKey(photo.web_path)
      && photo.web_path.startsWith(`videos/web_${photo.id}_`) && photo.web_path.endsWith('.mp4')
      && await getStorage().stat(photo.web_path).catch(() => null)) return true;
  const photoId = Number(photo.id);
  if ((await grantedPhotoIds(req.event.id, [photoId], db, { deliveredOnly: true })).has(photoId)) return true;
  if (!playback || !drawsOnQuota(req)) {
    res.status(403).json(clientOnlyError());
    return false;
  }
  // A HEAD probe answers without taking any of the quota.
  if (req.method === 'HEAD') {
    const check = await checkDownloads(req.event, [photoId]);
    if (check.ok) return true;
    res.status(403).json(downloadLimitError(check));
    return false;
  }
  const quota = await grantDownloads(req.event, [photoId]);
  if (!quota.ok) {
    refuseDownload(res, quota);
    return false;
  }
  return true;
}

/**
 * A request that names a ladder (`v`: from the photo list, passed on by the
 * playlists) is answered from that ladder only. After a re-transcode a
 * player still holding the old playlists would otherwise be handed the new
 * ladder's segments for the old init file, cached under the old URL; a 404
 * makes it fall back to the file instead.
 */
function namesAnotherLadder(req, photo) {
  return req.query.v !== undefined && req.query.v !== String(photo.hls_path).slice(-12);
}

/** What a playlist passes on to the URLs in it: nothing but these two. */
function streamQuery(req) {
  const parts = [];
  if (typeof req.query.v === 'string' && /^[a-z0-9]{1,16}$/i.test(req.query.v)) parts.push(`v=${req.query.v}`);
  if (req.query.admin_preview === '1') parts.push('admin_preview=1');
  return parts.join('&');
}

async function readPlaylist(req, key, kind) {
  const chunks = [];
  for await (const chunk of await getStorage().get(key)) chunks.push(chunk);
  return videoHls.rewritePlaylist(Buffer.concat(chunks).toString('utf8'), kind, streamQuery(req));
}

function answerPlaylist(res, body) {
  res.set({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'private, no-cache' });
  res.send(body);
}

async function sendPlaylist(req, res, key, kind) {
  answerPlaylist(res, await readPlaylist(req, key, kind));
}

/**
 * The row names a ladder storage does not have (a restore without hls/, a
 * bucket cleaned by hand). The row starts over, the queue transcodes again,
 * and this player falls back to the original.
 */
async function answerMissingLadder(res, photo) {
  await livePhotos(db).where({ id: photo.id, hls_path: photo.hls_path, hls_status: 'complete' })
    .update({ hls_path: null, hls_status: null, hls_error: 'ladder missing from storage' })
    .catch((e) => logger.warn(`Could not re-queue the missing ladder of video ${photo.id}: ${e.message}`));
  return res.status(404).json({ error: 'No stream for this video' });
}

const hlsAccess = [requireAdaptiveStreaming, verifyGalleryAccess, denySlideshowToken, blockHiddenGallery];

router.get('/:slug/hls/:photoId/master.m3u8', ...hlsAccess, async (req, res) => {
  try {
    const photo = await loadStreamedVideo(req, res);
    if (!photo) return;
    const key = videoHls.ladderKey(photo, undefined, 'master.m3u8');
    if (!key || namesAnotherLadder(req, photo)) return res.status(404).json({ error: 'No stream for this video' });
    if (!(await getStorage().stat(key))) return await answerMissingLadder(res, photo);
    // Read before the slot is taken: the grant is delivered as soon as it is
    // made, so a playlist storage then fails to return would cost the guest
    // a download for a video that never played.
    let body;
    try {
      body = await readPlaylist(req, key, 'master');
    } catch (error) {
      // Removed since the stat (issue 2118): the same answer as above.
      if (isStorageNotFoundError(error)) return await answerMissingLadder(res, photo);
      throw error;
    }
    if (!(await admitStream(req, res, photo, { playback: true }))) return;
    refundRateLimit(req);
    answerPlaylist(res, body);
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to serve video stream');
  }
});

// One rung's playlist (index.m3u8) or one of its files. The names are
// checked against the shapes the transcode writes (ladderKey); the photo id
// comes from the route and the storage prefix from the row.
router.get('/:slug/hls/:photoId/:rung/:file', ...hlsAccess, async (req, res) => {
  try {
    const photo = await loadStreamedVideo(req, res);
    if (!photo) return;
    const key = videoHls.ladderKey(photo, req.params.rung, req.params.file);
    const stat = key && !namesAnotherLadder(req, photo) ? await getStorage().stat(key) : null;
    if (!stat) return res.status(404).json({ error: 'No stream for this video' });
    if (!(await admitStream(req, res, photo, { playback: false }))) return;
    // Authorised, and one of many requests of a single playback: it does
    // not count against the address's API budget (rateLimitService).
    refundRateLimit(req);
    if (req.params.file === 'index.m3u8') return await sendPlaylist(req, res, key, 'media');
    const headers = {
      'Content-Length': stat.size,
      'Content-Type': req.params.file === 'init.mp4' ? 'video/mp4' : 'video/iso.segment',
      'Cache-Control': 'private, max-age=1800',
      'Content-Disposition': 'inline',
    };
    if (req.method === 'HEAD') return res.writeHead(200, headers).end();
    // Opened before any header, and the headers only staged: a file removed
    // since the stat (issue 2118) still answers 404, here on S3, whose get()
    // rejects, or in pipeStreamToResponse for the lazy local stream.
    const file = await getStorage().get(key);
    res.status(200).set(headers);
    pipeStreamToResponse(file, res, { context: `video segment for photo ${photo.id}` });
  } catch (error) {
    if (answerVanished(res, error, 'No stream for this video')) return;
    errorResponse(res, error, 500, 'Failed to serve video stream');
  }
});

// Serve thumbnail
router.get('/:slug/thumbnail/:photoId',
  verifyGalleryAccess,
  blockHiddenGallery,
  async (req, res) => {
    try {
      const { photoId } = req.params;

      const photo = await livePhotos(db)
        .where({ id: photoId, event_id: req.event.id })
        .first();

      if (!photo) {
        return res.status(404).json({ error: 'Photo not found' });
      }

      // Block guest access to hidden photos
      if (isPhotoOutsideGrant(req, photo)) {
        return res.status(403).json({ error: 'Photo not available' });
      }

      // Ensure thumbnail exists and is valid, regenerate if needed
      // Responsive tier (#1095), whitelisted the same way the preview route's
      // is. Unrecognised or absent falls through to the canonical 300px
      // thumbnail, so existing clients are untouched.
      const {
        THUMBNAIL_WIDTHS, normalizeTierWidth, ensureThumbnailAtWidth,
        isThumbnailValid, queueVideoThumbnail, videoPlaceholderImage,
      } = require('../../services/imageProcessor');
      const thumbTier = normalizeTierWidth(req.query.w, THUMBNAIL_WIDTHS);

      let thumbnailPath;
      const isVideo = photo.media_type === 'video' || (photo.mime_type && photo.mime_type.startsWith('video/'));
      if (isVideo) {
        // A video's poster is never built on the request (issue 2263): on S3
        // that copied up to 512 MB and ran ffmpeg for up to a minute while
        // the tile waited. The rebuild is queued and the placeholder answers
        // now, uncached, so the next request gets the real frame. Videos
        // have no tiers, so the canonical poster serves every width.
        const canonical = Boolean(photo.thumbnail_path)
          && isPresentationRenditionKey(photo.thumbnail_path, 'thumbnail');
        if (!canonical || !(await isThumbnailValid(photo.thumbnail_path))) {
          // A legacy key is rebuilt forced, as below for a photo.
          queueVideoThumbnail(photo, photo.thumbnail_path && !canonical ? { force: true, checkSettings: true } : {});
          const placeholder = await videoPlaceholderImage();
          res.set({
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'no-store',
            // The image client shows these bytes and asks again after
            // Retry-After: the tile's URL never changes, so without the
            // signal it kept the placeholder until the gallery was reloaded.
            'X-Poster-Pending': '1',
            'Retry-After': '10',
            'Cross-Origin-Resource-Policy': 'cross-origin',
            'X-Content-Type-Options': 'nosniff',
            'Content-Length': placeholder.length,
          });
          // end(), not send(): no validator for bytes that stand in.
          return res.status(200).end(placeholder);
        }
        thumbnailPath = photo.thumbnail_path;
      } else {
        thumbnailPath = thumbTier
          ? (await ensureThumbnailAtWidth(photo, thumbTier)) || (await ensureThumbnail(photo))
          : await ensureThumbnail(photo);
        // A stored pointer outside the rendition namespace (a legacy
        // `./thumbnails/...` or backslash shape) is rebuilt rather than served
        // or left to 404 forever; the rebuild writes a canonical key. Checked
        // against a concurrent settings change (issue 2140); the row keeps its
        // pointer so a dropped render does not hand that pointer back.
        if (thumbnailPath && !isPresentationRenditionKey(thumbnailPath, 'thumbnail')) {
          thumbnailPath = await ensureThumbnail(photo, { force: true, checkSettings: true });
        }
      }

      // What was actually resolved, not what was asked for. A tier request can
      // land on the canonical thumbnail — generation failed, or the row is a
      // video — and stamping the requested tier into the ETag below would then
      // have the client cache a 300px image under its 900px key for the full
      // max-age, with no way to notice.
      const servedTier = thumbTier && thumbnailPath
        && path.basename(thumbnailPath).startsWith(`thumb_w${thumbTier}_`)
        ? thumbTier
        : null;

      if (!isPresentationRenditionKey(thumbnailPath, 'thumbnail')) {
        logger.error(`Failed to generate thumbnail for photo ${photoId}`);
        return res.status(404).json({ error: 'Thumbnail generation failed' });
      }

      // Read thumbnail metadata via the storage abstraction so we work in
      // both LocalFs and S3 modes (#432). The previous fs.statSync on the
      // resolved local path 500'd in S3 deployments because the thumbnail
      // only exists in the bucket, not on the container's local fs.
      const storage = getStorage();
      const stat = await storage.stat(thumbnailPath);
      if (!stat) {
        logger.error(`Thumbnail not found in storage backend for photo ${photoId}`, { thumbnailPath });
        return res.status(404).json({ error: 'Thumbnail not found' });
      }

      // Log thumbnail access
      await secureImageService.logImageAccess(
        photoId,
        req.event.id,
        req.clientInfo,
        'thumbnail'
      );

      // Check if watermarks are enabled and apply to thumbnail
      let watermarkSettings = await watermarkService.getWatermarkSettingsForEvent(req.event);
      // Photo sales: priced galleries keep the forced mark
      // on every tier, independent of the global setting.
      if (isGalleryPriced(req.event)) {
        watermarkSettings = await resolvePhotoSalesWatermarkSettings(req.event, photo);
      }

      // ETag uses storage stat mtime + photo id + watermark hash.
      const mtimeMs = stat.mtime ? stat.mtime.getTime() : 0;
      const watermarkHash = watermarkSettings?.enabled
        ? `-wm${watermarkService.versionTag(watermarkSettings)}`
        : '-nowm';
      // Tier in the ETag, same reason as the preview route: without it a
      // client holding the 300px thumbnail gets a 304 for its 600px request
      // and renders the small one, which is this feature inverted.
      const etag = `"thumb-${photoId}-${servedTier || 'def'}-${mtimeMs}${watermarkHash}"`;

      // Check if client has valid cached version
      if (req.headers['if-none-match'] === etag) {
        return res.status(304).end();
      }

      // Set appropriate headers with enhanced security
      res.set({
        'Content-Type': 'image/jpeg',
        // A video's URL names its frame pick (galleryQueryService); one
        // naming another pick than the row's (an older photo list) gets the
        // current poster uncached, or that URL would show the wrong frame
        // once the pick came back to it.
        'Cache-Control': posterVersionStale(photo, req.query.poster) ? 'no-store' : 'private, max-age=1800', // Reduced cache time
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'X-Content-Type-Options': 'nosniff',
        'X-Protected-Thumbnail': 'true',
        'ETag': etag
      });

      if (watermarkSettings && watermarkSettings.enabled) {
        // Watermarking needs a local file path (sharp + fs.readFile).
        // Materialize via withLocalCopy — no-op in local mode, downloads
        // to a tmp file then cleans up in S3 mode.
        const watermarkedBuffer = await withLocalCopy(thumbnailPath, (localPath) =>
          watermarkService.applyWatermark(localPath, watermarkSettings, { failClosed: true })
        );
        res.send(watermarkedBuffer);
      } else {
        res.setHeader('Content-Length', stat.size);
        const stream = await storage.get(thumbnailPath);
        pipeStreamToResponse(stream, res, { context: `thumbnail for photo ${photoId}` });
      }
    } catch (error) {
      if (answerVanished(res, error, 'Thumbnail not found')) return;
      errorResponse(res, error, 500, 'Failed to serve thumbnail');
    }
  }
);

// Serve hero-optimized image (1920x1080 for full-width hero sections)
router.get('/:slug/hero/:photoId',
  verifyGalleryAccess,
  // Reveal-gated too: this route serves a 1920px derivative of ANY photo id,
  // not just the chosen hero — an open bypass while hidden (review round 1).
  blockHiddenGallery,
  async (req, res) => {
    try {
      const { photoId } = req.params;

      const photo = await livePhotos(db)
        .where({ id: photoId, event_id: req.event.id })
        .first();

      if (!photo) {
        return res.status(404).json({ error: 'Photo not found' });
      }

      // Block guest access to hidden photos
      if (isPhotoOutsideGrant(req, photo)) {
        return res.status(403).json({ error: 'Photo not available' });
      }

      // Videos don't get hero images. Their hero is the poster frame the
      // thumbnail route serves — never the original: a hero is an image
      // background, and on a limited gallery /photo streams a video by
      // taking a download slot (issue 1560), so merely loading the page
      // would have spent one.
      const isVideo = photo.media_type === 'video' || (photo.mime_type && photo.mime_type.startsWith('video/'));
      if (isVideo) {
        // With the frame an admin picked, as the gallery's thumbnail URL.
        const poster = photo.poster_offset_seconds != null ? `?poster=${photo.poster_offset_seconds}` : '';
        return res.redirect(withPreview(req, `/api/gallery/${req.params.slug}/thumbnail/${photoId}${poster}`));
      }

      // The rendition follows the event's focal point and the response below
      // is cached for an hour under the URL it was requested at (issue 1737).
      // A URL whose `fp` is not the current anchor — an open tab whose payload
      // predates the admin moving it — is sent to the current crop's URL
      // instead of being served bytes that would then sit in the cache under
      // the wrong URL. A redirect is not cached.
      const redirectQuery = heroQueryRedirect(req.query, req.event.hero_image_anchor);
      if (redirectQuery !== null) {
        return res.redirect(`/api/gallery/${req.params.slug}/hero/${photoId}${redirectQuery}`);
      }

      // Ensure hero image exists, is valid and was cut at the event's focal
      // point (issue 1737); regenerate if needed.
      const heroPath = await ensureHeroImage(photo, { anchor: req.event.hero_image_anchor });

      if (!isPresentationRenditionKey(heroPath, 'hero')) {
        // If hero generation fails, hand over to the photo route, which
        // applies the viewer's own policy.
        logger.warn(`Failed to generate hero image for photo ${photoId}, redirecting to the photo route`);
        return res.redirect(withPreview(req, `/api/gallery/${req.params.slug}/photo/${photoId}`));
      }

      // Hero images are always written via the storage abstraction (see
      // imageProcessor.generateHeroImage), so they're a managed-storage
      // key in both LocalFs and S3 modes (#432). Read via storage.
      const storage = getStorage();
      const stat = await storage.stat(heroPath);
      if (!stat) {
        logger.error('Hero image file does not exist in storage backend', {
          slug: req.params.slug,
          photoId,
          eventId: req.event.id,
          heroPath
        });
        return res.redirect(withPreview(req, `/api/gallery/${req.params.slug}/photo/${photoId}`));
      }

      const mtimeMs = stat.mtime ? stat.mtime.getTime() : 0;
      // The mark is part of the bytes: a changed gallery text must not 304.
      let watermarkSettings = await watermarkService.getWatermarkSettingsForEvent(req.event);
      // Photo sales: this route renders any photo id at 1920px, so a priced
      // gallery forces the mark here exactly as on /photo, /preview and
      // /thumbnail.
      if (isGalleryPriced(req.event)) {
        watermarkSettings = await resolvePhotoSalesWatermarkSettings(req.event, photo);
      }
      const watermarkHash = watermarkSettings?.enabled ? `-wm${watermarkService.versionTag(watermarkSettings)}` : '';
      const etag = `"hero-${photoId}-${mtimeMs}${watermarkHash}"`;
      if (req.headers['if-none-match'] === etag) {
        return res.status(304).end();
      }

      res.set({
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'private, max-age=3600', // Cache for 1 hour
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'X-Content-Type-Options': 'nosniff',
        'X-Hero-Image': 'true',
        'ETag': etag
      });

      if (watermarkSettings && watermarkSettings.enabled) {
        // applyWatermark needs a local file path; materialize via
        // withLocalCopy so this works in S3 mode too.
        const watermarkedBuffer = await withLocalCopy(heroPath, (localPath) =>
          watermarkService.applyWatermark(localPath, watermarkSettings, { failClosed: true })
        );
        res.send(watermarkedBuffer);
      } else {
        res.setHeader('Content-Length', stat.size);
        const stream = await storage.get(heroPath);
        pipeStreamToResponse(stream, res, { context: `hero for photo ${photoId}` });
      }
    } catch (error) {
      logger.error('Error serving hero image:', {
        error: error.message,
        photoId: req.params.photoId,
        eventId: req.event?.id
      });
      // Fall back to original photo on any error. Unlike the preview route
      // this one keeps redirecting when storage cannot be reached (issue
      // 1785): the hero is loaded as a CSS background by the Premium layout
      // and with the original as fallbackSrc by HeroHeader, and neither can
      // retry a 503. What changed is upstream: an unreachable backend no
      // longer makes ensureHeroImage regenerate a healthy rendition.
      // The hero's ETag and hour-long lifetime may already be staged; left on
      // the redirect, the browser keeps a transient failure (issue 2138).
      res.removeHeader('ETag');
      res.set('Cache-Control', 'no-store');
      res.redirect(withPreview(req, `/api/gallery/${req.params.slug}/photo/${req.params.photoId}`));
    }
  }
);

// Storage that cannot be reached is not a broken rendition (issue 1785). The
// original sits behind the same backend and is many times the size, so
// redirecting there only adds load to whatever is already failing. A 503 lets
// the client retry the small file instead. The headers staged for the image
// go first: Express keeps a Content-Type that is already set, and the JSON
// would leave as image/jpeg.
function answerStorageUnavailable(res) {
  res.removeHeader('ETag');
  res.removeHeader('Content-Type');
  res.removeHeader('Content-Length');
  res.set({ 'Retry-After': '5', 'Cache-Control': 'no-store' });
  return res.status(503).json({ error: 'Storage temporarily unavailable', code: 'STORAGE_UNAVAILABLE' });
}

// Lightbox preview tier (#492). Aspect-preserved JPEG capped at 1920px
// long edge — admin-controlled opt-in via app_settings.lightbox_preview_enabled.
// Mirrors the hero route shape: same auth, ETag from preview mtime,
// fall back to original when the rendition is broken so the lightbox never
// shows a broken image (storage that cannot be reached answers 503 instead,
// see answerStorageUnavailable). The watermark application path is preserved so a
// preview surfaced in the lightbox carries the same protection a
// guest would see on the full original.
// A preview that cannot be served falls back to the original, so the lightbox
// always renders. Not while a download limit withholds that original (issue
// 1560): /photo would send the request straight back here.
// Nor for a slideshow session, which /photo refuses (denySlideshowToken).
async function fallBackToOriginal(req, res, photo) {
  if (!photo?.event_id) photo = await livePhotos(db).where({ id: req.params.photoId, event_id: req.event.id }).first();
  // Photo sales: in a priced gallery the preview IS the product
  // gate — falling back to the original would hand it out, so a failed
  // preview render answers 404 like a withheld original does.
  if (!photo || await originalAssetDenial(req, photo, { display: true })
      || (req.event && !req.isAdminPreview && await shouldForceWatermarkForPhoto(req.event, photo))) {
    res.removeHeader('ETag');
    res.removeHeader('Content-Type');
    res.removeHeader('Content-Length');
    res.set('Cache-Control', 'no-store');
    return res.status(404).json({ error: 'Preview not available' });
  }
  // Same for the redirect: the preview's ETag and lifetime may already be
  // staged, and the browser would keep a transient failure (issue 2138).
  res.removeHeader('ETag');
  res.set('Cache-Control', 'no-store');
  return res.redirect(withPreview(req, `/api/gallery/${req.params.slug}/photo/${req.params.photoId}`));
}

router.get('/:slug/preview/:photoId',
  verifyGalleryAccess,
  blockHiddenGallery,
  async (req, res) => {
    try {
      const { photoId } = req.params;

      const photo = await livePhotos(db)
        .where({ id: photoId, event_id: req.event.id })
        .first();

      if (!photo) {
        return res.status(404).json({ error: 'Photo not found' });
      }

      if (isPhotoOutsideGrant(req, photo)) {
        return res.status(403).json({ error: 'Photo not available' });
      }

      // Videos don't get a preview tier — fall through to the regular
      // photo endpoint (which serves the source). The frontend should
      // already be checking media_type before requesting /preview but
      // belt-and-braces in case a stale tab does.
      const isVideo = photo.media_type === 'video' || (photo.mime_type && photo.mime_type.startsWith('video/'));
      if (isVideo) {
        // /photo rechecks source authority and may select a bounded web copy;
        // keep this established video URL redirect, not an original fallback.
        if (req.accessLevel === 'slideshow') return fallBackToOriginal(req, res, photo);
        return res.redirect(withPreview(req, `/api/gallery/${req.params.slug}/photo/${photoId}`));
      }

      // Responsive tier (#1095). Whitelisted only — an open ?w= would let
      // anyone fill the disk with renditions nobody asked for. An unrecognised
      // or absent value falls through to the canonical 1920 preview, so old
      // clients and hand-typed URLs behave exactly as before.
      const { PREVIEW_WIDTHS, normalizeTierWidth, ensurePreviewImageAtWidth } =
        require('../../services/imageProcessor');
      const tierWidth = normalizeTierWidth(req.query.w, PREVIEW_WIDTHS);

      // Lazy generation: ensurePreviewImage returns null when it cannot
      // make the rendition (corrupt source, sharp OOM, …). Fall back to the
      // original so the lightbox always renders. It throws when the storage
      // backend cannot be reached while checking the stored rendition; the
      // catch below answers that with a 503.
      let previewPath = tierWidth
        ? (await ensurePreviewImageAtWidth(photo, tierWidth)) || (await ensurePreviewImage(photo))
        : await ensurePreviewImage(photo);
      // Same self-heal as the thumbnail route for a legacy pointer shape.
      if (previewPath && !isPresentationRenditionKey(previewPath, 'preview')) {
        previewPath = await ensurePreviewImage({ ...photo, preview_path: null }, { force: true });
      }
      if (!isPresentationRenditionKey(previewPath, 'preview')) {
        logger.warn(`No usable preview for photo ${photoId}, redirecting to the photo route where the viewer may have it`);
        return fallBackToOriginal(req, res, photo);
      }

      const storage = getStorage();
      const stat = await storage.stat(previewPath);
      if (!stat) {
        logger.error('Preview file does not exist in storage backend', {
          slug: req.params.slug, photoId, eventId: req.event.id, previewPath,
        });
        return fallBackToOriginal(req, res, photo);
      }

      const mtimeMs = stat.mtime ? stat.mtime.getTime() : 0;
      let watermarkSettings = await watermarkService.getWatermarkSettingsForEvent(req.event);
      // Photo sales: priced galleries keep the forced mark
      // on every tier, independent of the global setting.
      if (isGalleryPriced(req.event)) {
        watermarkSettings = await resolvePhotoSalesWatermarkSettings(req.event, photo);
      }
      const watermarkHash = watermarkSettings?.enabled
        ? `-wm${watermarkService.versionTag(watermarkSettings)}`
        : '-nowm';
      // Tier is part of the etag: without it a client that already holds the
      // 1920 rendition would get a 304 for its 640 request and render the
      // wrong size, which is the whole point of the feature inverted.
      // Maximum protection caps the preview too (issue 2152), with its own
      // ETag so a level change never revalidates the other variant.
      const capped = capsFullSizeView(req.event);
      const capVersion = capped ? `-cap${MAXIMUM_PROTECTION_CAP.tag}` : '';
      const etag = `"preview-${photoId}-${tierWidth || 'def'}-${mtimeMs}${watermarkHash}${capVersion}"`;
      if (req.headers['if-none-match'] === etag) {
        return res.status(304).end();
      }

      res.set({
        // From the key, not hard-coded: a preview of a transparent or animated
        // source is WebP, because JPEG carries neither. `nosniff` below means
        // getting this wrong shows a broken image rather than being silently
        // corrected by the browser. Pre-existing keys have no .webp suffix and
        // are JPEG, so they keep their old header.
        'Content-Type': previewPath.endsWith('.webp') ? 'image/webp' : 'image/jpeg',
        // Cache aggressively — preview only changes on photo
        // re-upload (which generates a new preview key) or settings
        // regenerate (which writes a new mtime + ETag).
        'Cache-Control': 'private, max-age=3600',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'X-Content-Type-Options': 'nosniff',
        'X-Preview-Image': 'true',
        'ETag': etag,
      });

      // Photo sales: paid photos stream their persisted
      // watermarked preview (rendered in the background on the first
      // request) instead of re-compositing with sharp every time. Only the
      // canonical 1920 rendition is persisted; responsive ?w= tiers and the
      // maximum-protection cap keep the on-the-fly path.
      if (!capped && watermarkSettings && watermarkSettings.enabled && watermarkSettings.tiled && !tierWidth) {
        const salesRenditions = require('../../modules/photoSales/salesRenditions');
        const persistedSalesPreview = await salesRenditions.findPersistedSalesPreview(req.event, photo, watermarkSettings);
        if (persistedSalesPreview) {
          const salesStat = await storage.stat(persistedSalesPreview);
          if (salesStat) {
            res.setHeader('Content-Length', salesStat.size);
            const salesStream = await storage.get(persistedSalesPreview);
            return pipeStreamToResponse(salesStream, res, { context: `sales preview for photo ${photo.id}` });
          }
        }
      }

      if (capped) {
        const view = await capPreviewRendition(previewPath, watermarkSettings);
        res.set({ 'Content-Type': view.contentType, 'Content-Length': view.buffer.length });
        res.send(view.buffer);
      } else if (watermarkSettings && watermarkSettings.enabled) {
        // Photo sales: queue the background render so the
        // next viewer gets the persisted file instead.
        if (watermarkSettings.tiled && !tierWidth) {
          require('../../modules/photoSales/salesRenditions')
            .generateSalesPreviewForPhoto(photo.id)
            .catch(() => {});
        }
        // No Content-Type override here. applyWatermark PRESERVES the source
        // format (watermarkService.js: png -> png, webp -> webp, else jpeg),
        // and its input is this preview — so the output format matches the key
        // the header was already derived from. Forcing image/jpeg would
        // mislabel a watermarked WebP preview, and `nosniff` means the browser
        // will not correct it.
        //
        // What is still lost is the animation: the compositor flattens a
        // multi-frame source to one frame while keeping the WebP container.
        // That is a separate problem and a much larger one.
        const watermarkedBuffer = await withLocalCopy(previewPath, (localPath) =>
          watermarkService.applyWatermark(localPath, watermarkSettings, { failClosed: true })
        );
        res.send(watermarkedBuffer);
      } else {
        res.setHeader('Content-Length', stat.size);
        const stream = await storage.get(previewPath);
        pipeStreamToResponse(stream, res, {
          context: `preview for photo ${photoId}`,
          onStorageUnavailable: answerStorageUnavailable,
        });
      }
    } catch (error) {
      logger.error('Error serving preview image:', {
        error: error.message,
        photoId: req.params.photoId,
        eventId: req.event?.id,
      });
      if (res.headersSent) return;
      if (isStorageUnavailableError(error)) return answerStorageUnavailable(res);
      // The capped copy at maximum protection (issue 2152) is cut per request:
      // a busy or timed-out image worker is "try again", not a broken
      // rendition to fall back from.
      if (imageResourcePolicy.isTransient(error)) {
        for (const name of ['ETag', 'Content-Type', 'Content-Length']) res.removeHeader(name);
        res.set({ 'Retry-After': String(error.retryAfter || 5), 'Cache-Control': 'no-store' });
        return res.status(503).json({ error: 'Image processing is busy, try again shortly', code: error.code });
      }
      try {
        await fallBackToOriginal(req, res, { id: req.params.photoId });
      } catch (fallbackError) {
        if (!res.headersSent) res.status(500).json({ error: 'Failed to serve preview' });
      }
    }
  }
);

// GET /:slug/feedback-settings lives in galleryFeedback.js. A duplicate of it
// used to sit here, and since server.js mounts galleryRoutes before
// galleryFeedback it shadowed the real handler — dropping the per-guest caps
// (#655) from the guest payload, so the gallery could never render the
// favorite/like limits or their counters (#1030).

// Get photo stats. no-store: view/download/visitor counters are private
// gallery analytics and change on every request.

module.exports = router;
