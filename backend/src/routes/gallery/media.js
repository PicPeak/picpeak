const express = require('express');
const { db } = require('../../database/db');
const path = require('path');
const { resolvePhotoContentType } = require('../../utils/photoContentType');
const router = express.Router();
const watermarkService = require('../../services/watermarkService');
const watermarkGeneratorService = require('../../services/watermarkGeneratorService');
const { verifyGalleryAccess, denySlideshowToken } = require('../../middleware/gallery');
const withPreview = (req, url) => (req.isAdminPreview ? `${url}${url.includes('?') ? '&' : '?'}admin_preview=1` : url);
const secureImageService = require('../../services/secureImageService');
const logger = require('../../utils/logger');
const { pipeStreamToResponse } = require('../../utils/streamResponse');

const { errorResponse } = require('../../utils/routeHelpers');
const { blockHiddenGallery } = require('../../utils/revealMode');
const { isPhotoHiddenFromViewer } = require('../../utils/photoVisibility');
const { ensureThumbnail, ensureHeroImage, ensurePreviewImage, withLocalCopy } = require('../../services/imageProcessor');
const { getStorage } = require('../../services/storage');
const fs = require('fs');
const { getStoragePath } = require('../../config/storage');
const { safePathJoin } = require('../../utils/fileSecurityUtils');
const {
  isOriginalWithheld, currentDownloadLimit, grantedPhotoIds, grantDownloads, checkDownloads,
  drawsOnQuota, clientOnlyError, refuseDownload, downloadLimitError, settleWhenDone, responseDelivered,
} = require('../../services/downloadQuota');

/**
 * Download limit (issue 1560): a video has no preview tier, so playing it
 * streams the original, and on a limited gallery that takes a slot like a
 * download. One slot per video: once it is granted, replays and every further
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

router.post('/:slug/photo/:photoId/view',
  verifyGalleryAccess,
  denySlideshowToken,
  blockHiddenGallery,
  async (req, res) => {
    try {
      const photo = await db('photos')
        .where({ id: req.params.photoId, event_id: req.event.id })
        .first('id', 'visibility');
      if (!photo) {
        return res.status(404).json({ error: 'Photo not found' });
      }
      if (isPhotoHiddenFromViewer(photo, req.accessLevel)) {
        return res.status(403).json({ error: 'Photo not available' });
      }
      // Admin preview (#981 review) is excluded from per-photo view analytics.
      if (!req.isAdminPreview) {
        await db('photos').where('id', photo.id).increment('view_count', 1);
      }
      res.status(204).end();
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to record view');
    }
  });

// View single photo (with watermark if enabled)
router.get('/:slug/photo/:photoId',
  verifyGalleryAccess,
  blockHiddenGallery,
  async (req, res) => {
    try {
      const { photoId } = req.params;

      const photo = await db('photos')
        .where({ id: photoId, event_id: req.event.id })
        .first();

      if (!photo) {
        return res.status(404).json({ error: 'Photo not found' });
      }

      // Block guest access to hidden photos
      if (isPhotoHiddenFromViewer(photo, req.accessLevel)) {
        return res.status(403).json({ error: 'Photo not available' });
      }

      // Check if this is a video
      const isVideo = photo.media_type === 'video' || (photo.mime_type && photo.mime_type.startsWith('video/'));

      // Every protection level is served here. Enhanced/maximum used to answer
      // a 302 JSON pointing at /api/secure-images/.../generate-token, which no
      // shipped frontend code calls, so still images at those levels were a
      // broken tile (#1370 exempted videos from the same bounce). The levels
      // are client-side rendering modes; the guest still needs a valid gallery
      // token to get here at all.

      // Download limit (issue 1560). While one applies, guests get the preview
      // tier rather than the original, which would otherwise be a full-size
      // copy one long-press away from every counted download. Videos have no
      // preview tier: playing one is counted instead (admitVideoStream, below
      // once the file is known to exist).
      if (!isVideo && await isOriginalWithheld(req.event, photo, { isAdminPreview: req.isAdminPreview })) {
        // Keep the query (the ?v= cache-buster) so the preview is not served
        // from a stale cache entry.
        const queryAt = req.originalUrl.indexOf('?');
        const query = queryAt === -1 ? '' : req.originalUrl.slice(queryAt);
        return res.redirect(`/api/gallery/${req.params.slug}/preview/${photoId}${query}`);
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
        if (!(await admitVideoStream(req, res, photo))) return;
        const range = req.headers.range;

        if (range) {
          const parts = range.replace(/bytes=/, '').split('-');
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
          // Validate before writing the 206: a NaN, inverted or out-of-file
          // range used to be committed to the headers and then throw while
          // streaming (or read past the end).
          if (!Number.isInteger(start) || !Number.isInteger(end)
              || start < 0 || end < start || start >= fileSize) {
            res.set('Content-Range', `bytes */${fileSize}`);
            return res.status(416).end();
          }
          const boundedEnd = Math.min(end, fileSize - 1);
          const chunksize = (boundedEnd - start) + 1;

          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${boundedEnd}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': resolvePhotoContentType(photo),
            'Cache-Control': 'private, max-age=1800',
            'X-Protection-Level': 'basic'
          });

          const file = useStorageBackend
            ? await storage.getRange(storageKey, start, boundedEnd)
            : fs.createReadStream(filePath, { start, end: boundedEnd });
          pipeStreamToResponse(file, res, { context: `video range for photo ${photo.id}` });
        } else {
          res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': resolvePhotoContentType(photo),
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'private, max-age=1800',
            'X-Protection-Level': 'basic'
          });
          const file = useStorageBackend
            ? await storage.get(storageKey)
            : fs.createReadStream(filePath);
          pipeStreamToResponse(file, res, { context: `video for photo ${photo.id}` });
        }
        return;
      }

      // Image path
      const watermarkSettings = await watermarkService.getWatermarkSettings();

      const mtimeMs = stat.mtime ? stat.mtime.getTime() : 0;
      const watermarkHash = watermarkSettings?.enabled
        ? `-wm${watermarkSettings.opacity}${watermarkSettings.position}${watermarkSettings.size}`
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
      const etag = `"${photoId}-${mtimeMs}${watermarkHash}${orientationVersion}"`;

      if (req.headers['if-none-match'] === etag) {
        return res.status(304).end();
      }

      if (watermarkSettings && watermarkSettings.enabled) {
        // Pre-generated watermarked file: served via the storage backend
        // (managed) or directly from local fs (external).
        if (photo.watermark_path) {
          try {
            if (useStorageBackend) {
              const wmStat = await storage.stat(photo.watermark_path);
              if (wmStat) {
                res.set({
                  'Content-Type': resolvePhotoContentType(photo),
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
                res.set({
                  'Content-Type': resolvePhotoContentType(photo),
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
        const watermarkedBuffer = useStorageBackend
          ? await withLocalCopy(storageKey, (localPath) =>
            watermarkService.applyWatermark(localPath, watermarkSettings))
          : await watermarkService.applyWatermark(filePath, watermarkSettings);

        // Queue watermark generation in background for next request
        watermarkGeneratorService.generateForPhoto(photo.id)
          .catch(err => logger.warn(`Background watermark generation failed for photo ${photo.id}:`, err.message));

        res.set({
          'Content-Type': resolvePhotoContentType(photo),
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
          res.sendFile(absolutePath);
        }
      }
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to serve photo');
    }
  }
);

// Serve thumbnail
router.get('/:slug/thumbnail/:photoId',
  verifyGalleryAccess,
  blockHiddenGallery,
  async (req, res) => {
    try {
      const { photoId } = req.params;

      const photo = await db('photos')
        .where({ id: photoId, event_id: req.event.id })
        .first();

      if (!photo) {
        return res.status(404).json({ error: 'Photo not found' });
      }

      // Block guest access to hidden photos
      if (isPhotoHiddenFromViewer(photo, req.accessLevel)) {
        return res.status(403).json({ error: 'Photo not available' });
      }

      // Ensure thumbnail exists and is valid, regenerate if needed
      // Responsive tier (#1095), whitelisted the same way the preview route's
      // is. Unrecognised or absent falls through to the canonical 300px
      // thumbnail, so existing clients are untouched.
      const { THUMBNAIL_WIDTHS, normalizeTierWidth, ensureThumbnailAtWidth } =
        require('../../services/imageProcessor');
      const thumbTier = normalizeTierWidth(req.query.w, THUMBNAIL_WIDTHS);

      const thumbnailPath = thumbTier
        ? (await ensureThumbnailAtWidth(photo, thumbTier)) || (await ensureThumbnail(photo))
        : await ensureThumbnail(photo);

      // What was actually resolved, not what was asked for. A tier request can
      // land on the canonical thumbnail — generation failed, or the row is a
      // video — and stamping the requested tier into the ETag below would then
      // have the client cache a 300px image under its 900px key for the full
      // max-age, with no way to notice.
      const servedTier = thumbTier && thumbnailPath
        && path.basename(thumbnailPath).startsWith(`thumb_w${thumbTier}_`)
        ? thumbTier
        : null;

      if (!thumbnailPath) {
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
      const watermarkSettings = await watermarkService.getWatermarkSettings();

      // ETag uses storage stat mtime + photo id + watermark hash.
      const mtimeMs = stat.mtime ? stat.mtime.getTime() : 0;
      const watermarkHash = watermarkSettings?.enabled
        ? `-wm${watermarkSettings.opacity}${watermarkSettings.position}${watermarkSettings.size}`
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
        'Cache-Control': 'private, max-age=1800', // Reduced cache time
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
          watermarkService.applyWatermark(localPath, watermarkSettings)
        );
        res.send(watermarkedBuffer);
      } else {
        res.setHeader('Content-Length', stat.size);
        const stream = await storage.get(thumbnailPath);
        pipeStreamToResponse(stream, res, { context: `thumbnail for photo ${photoId}` });
      }
    } catch (error) {
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

      const photo = await db('photos')
        .where({ id: photoId, event_id: req.event.id })
        .first();

      if (!photo) {
        return res.status(404).json({ error: 'Photo not found' });
      }

      // Block guest access to hidden photos
      if (isPhotoHiddenFromViewer(photo, req.accessLevel)) {
        return res.status(403).json({ error: 'Photo not available' });
      }

      // Videos don't get hero images. Their hero is the poster frame the
      // thumbnail route serves — never the original: a hero is an image
      // background, and on a limited gallery /photo streams a video by
      // taking a download slot (issue 1560), so merely loading the page
      // would have spent one.
      const isVideo = photo.media_type === 'video' || (photo.mime_type && photo.mime_type.startsWith('video/'));
      if (isVideo) {
        return res.redirect(withPreview(req, `/api/gallery/${req.params.slug}/thumbnail/${photoId}`));
      }

      // Ensure hero image exists and is valid, regenerate if needed
      const heroPath = await ensureHeroImage(photo);

      if (!heroPath) {
        // If hero generation fails, fall back to original photo
        logger.warn(`Failed to generate hero image for photo ${photoId}, falling back to original`);
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
      const etag = `"hero-${photoId}-${mtimeMs}"`;
      if (req.headers['if-none-match'] === etag) {
        return res.status(304).end();
      }

      const watermarkSettings = await watermarkService.getWatermarkSettings();

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
          watermarkService.applyWatermark(localPath, watermarkSettings)
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
      // Fall back to original photo on any error
      res.redirect(withPreview(req, `/api/gallery/${req.params.slug}/photo/${req.params.photoId}`));
    }
  }
);

// Lightbox preview tier (#492). Aspect-preserved JPEG capped at 1920px
// long edge — admin-controlled opt-in via app_settings.lightbox_preview_enabled.
// Mirrors the hero route shape: same auth, ETag from preview mtime,
// fall back to original on any failure so the lightbox never shows a
// broken image. The watermark application path is preserved so a
// preview surfaced in the lightbox carries the same protection a
// guest would see on the full original.
// A preview that cannot be served falls back to the original, so the lightbox
// always renders. Not while a download limit withholds that original (issue
// 1560): /photo would send the request straight back here.
async function fallBackToOriginal(req, res, photo) {
  if (req.event && await isOriginalWithheld(req.event, photo, { isAdminPreview: req.isAdminPreview })) {
    return res.status(404).json({ error: 'Preview not available' });
  }
  return res.redirect(withPreview(req, `/api/gallery/${req.params.slug}/photo/${req.params.photoId}`));
}

router.get('/:slug/preview/:photoId',
  verifyGalleryAccess,
  blockHiddenGallery,
  async (req, res) => {
    try {
      const { photoId } = req.params;

      const photo = await db('photos')
        .where({ id: photoId, event_id: req.event.id })
        .first();

      if (!photo) {
        return res.status(404).json({ error: 'Photo not found' });
      }

      if (isPhotoHiddenFromViewer(photo, req.accessLevel)) {
        return res.status(403).json({ error: 'Photo not available' });
      }

      // Videos don't get a preview tier — fall through to the regular
      // photo endpoint (which serves the source). The frontend should
      // already be checking media_type before requesting /preview but
      // belt-and-braces in case a stale tab does.
      const isVideo = photo.media_type === 'video' || (photo.mime_type && photo.mime_type.startsWith('video/'));
      if (isVideo) {
        return res.redirect(withPreview(req, `/api/gallery/${req.params.slug}/photo/${photoId}`));
      }

      // Responsive tier (#1095). Whitelisted only — an open ?w= would let
      // anyone fill the disk with renditions nobody asked for. An unrecognised
      // or absent value falls through to the canonical 1920 preview, so old
      // clients and hand-typed URLs behave exactly as before.
      const { PREVIEW_WIDTHS, normalizeTierWidth, ensurePreviewImageAtWidth } =
        require('../../services/imageProcessor');
      const tierWidth = normalizeTierWidth(req.query.w, PREVIEW_WIDTHS);

      // Lazy generation: ensurePreviewImage returns null on any
      // failure (corrupt source, sharp OOM, storage unavailable, …).
      // Fall back to the original so the lightbox always renders.
      const previewPath = tierWidth
        ? (await ensurePreviewImageAtWidth(photo, tierWidth)) || (await ensurePreviewImage(photo))
        : await ensurePreviewImage(photo);
      if (!previewPath) {
        logger.warn(`Failed to generate preview for photo ${photoId}, falling back to original`);
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
      const watermarkSettings = await watermarkService.getWatermarkSettings();
      const watermarkHash = watermarkSettings?.enabled
        ? `-wm${watermarkSettings.opacity}${watermarkSettings.position}${watermarkSettings.size}`
        : '-nowm';
      // Tier is part of the etag: without it a client that already holds the
      // 1920 rendition would get a 304 for its 640 request and render the
      // wrong size, which is the whole point of the feature inverted.
      const etag = `"preview-${photoId}-${tierWidth || 'def'}-${mtimeMs}${watermarkHash}"`;
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

      if (watermarkSettings && watermarkSettings.enabled) {
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
          watermarkService.applyWatermark(localPath, watermarkSettings)
        );
        res.send(watermarkedBuffer);
      } else {
        res.setHeader('Content-Length', stat.size);
        const stream = await storage.get(previewPath);
        pipeStreamToResponse(stream, res, { context: `preview for photo ${photoId}` });
      }
    } catch (error) {
      logger.error('Error serving preview image:', {
        error: error.message,
        photoId: req.params.photoId,
        eventId: req.event?.id,
      });
      if (res.headersSent) return;
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
