const express = require('express');
const { db } = require('../../database/db');

const router = express.Router();
const { verifyGalleryAccess, denySlideshowToken } = require('../../middleware/gallery');
const { noStoreCache } = require('../../middleware/noStoreCache');
const logger = require('../../utils/logger');
const { errorResponse } = require('../../utils/routeHelpers');

router.post('/:eventId/upload', verifyGalleryAccess, denySlideshowToken, async (req, res) => {
  try {
    const eventId = parseInt(req.params.eventId);

    // Verify the event matches the token
    if (req.event.id !== eventId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Check if user uploads are allowed
    if (!req.event.allow_user_uploads) {
      return res.status(403).json({ error: 'User uploads are not allowed for this event' });
    }

    // Ensure temp upload directory exists
    const fs = require('fs');
    const tempUploadDir = '/tmp/uploads/';
    if (!fs.existsSync(tempUploadDir)) {
      try {
        fs.mkdirSync(tempUploadDir, { recursive: true, mode: 0o755 });
        logger.info('Created temp upload directory:', tempUploadDir);
      } catch (mkdirErr) {
        return errorResponse(res, mkdirErr, 500, 'Server configuration error: unable to create upload directory');
      }
    }

    // Import multer and photo processing
    const multer = require('multer');
    const { getAllowedMimeTypes, getMaxFilesPerUpload, getMaxFileSizeBytes, DEFAULT_MAX_FILE_SIZE_MB } = require('../../services/uploadSettings');
    const { validateFileType, normalizeUploadMimeType } = require('../../utils/fileSecurityUtils');

    // Resolve allowed MIME types from settings
    let allowedMimeTypes;
    try {
      allowedMimeTypes = await getAllowedMimeTypes();
    } catch {
      allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
    }

    // #613 — per-batch file count was hardcoded to 10 here, so the admin's
    // Settings → General → "Max Files per Upload" value silently didn't
    // apply to guest uploads (only admin uploads honoured it via
    // adminPhotos.js:131). Zszywany reported uploading 16 files succeeded
    // even with the limit set to 10. Mirror the admin path: resolve from
    // settings (cached for 60s in the service) and feed multer both
    // `limits.files` and the `.array(...)` cap. Fall back to the service's
    // default if the read fails.
    let maxFilesPerUpload;
    try {
      maxFilesPerUpload = await getMaxFilesPerUpload();
    } catch {
      maxFilesPerUpload = 500;
    }

    // Per-file size cap was hardcoded to 50MB here, so the admin's Settings →
    // General → "Max File Size (MB)" value (general_max_file_size_mb) never
    // applied to guest uploads — a guest could not upload a large video even
    // when the admin allowed it (reported on #613 by mat1990dj). Resolve it from
    // settings like the count above; fall back to the 50MB default on read error.
    let maxFileSizeBytes;
    try {
      maxFileSizeBytes = await getMaxFileSizeBytes();
    } catch {
      maxFileSizeBytes = DEFAULT_MAX_FILE_SIZE_MB * 1024 * 1024;
    }

    const upload = multer({
      dest: tempUploadDir,
      limits: {
        fileSize: maxFileSizeBytes,
        files: maxFilesPerUpload,
        // CVE-2026-82333: files arrive as repeated `photos` parts via
        // .array(), not bracket-indexed field names like `photos[0]` — no
        // legitimate field name uses array-index syntax at all. Reject any
        // that do.
        fieldArrayIndexLimit: 0
      },
      fileFilter: (req, file, cb) => {
        // Assigned, not just compared: multer copies this object into
        // req.files, so processing stores the canonical type.
        file.mimetype = normalizeUploadMimeType(file.originalname, file.mimetype);
        if (validateFileType(file.originalname, file.mimetype, allowedMimeTypes)) {
          cb(null, true);
        } else {
          cb(new Error('Invalid file type'));
        }
      }
    }).array('photos', maxFilesPerUpload);
    
    // Handle upload
    upload(req, res, async (err) => {
      if (err) {
        logger.error('Upload error:', err);
        // Turn multer's generic "File too large" into an actionable message
        // that names the configured limit.
        if (err.code === 'LIMIT_FILE_SIZE') {
          const limitMb = Math.floor(maxFileSizeBytes / (1024 * 1024));
          return res.status(400).json({ error: `File too large. Maximum size is ${limitMb} MB per file.` });
        }
        return res.status(400).json({ error: err.message });
      }
      
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
      }

      const { queueFilesForProcessing } = require('../../services/photoProcessor');
      const rawCategory = req.body.category_id || req.event.upload_category_id || null;
      const numericCategoryId = (() => {
        if (rawCategory === null || rawCategory === undefined) return null;
        const n = parseInt(rawCategory, 10);
        return Number.isFinite(n) ? n : null;
      })();

      try {
        // Queue files as 'pending' — the background worker will process
        // thumbnails / EXIF / dimensions off the request thread (#357).
        const result = await queueFilesForProcessing(req.files, {
          eventId,
          photoType: 'individual',
          categoryId: numericCategoryId,
        });

        res.status(202).json({
          message: 'Photos queued for processing',
          upload_id: result.uploadId,
          count: result.photos.length,
          photo_ids: result.photos.map((p) => p.id),
          photos: result.photos,
          errors: result.errors.length > 0 ? result.errors : undefined,
        });
      } catch (processError) {
        errorResponse(res, processError, 500, 'Failed to process photos');
      }
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to upload photos');
  }
});

// A guest upload_id is `crypto.randomBytes(16).toString('hex')`
// (photoProcessor.js). The pattern is deliberately a little wider than that so
// an id-format change does not silently 400, but narrow enough that the value
// can only ever be an opaque token.
const UPLOAD_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
// The guest UI uploads one file per request, so a batch of N files yields N
// upload ids. Batching them into a single poll keeps the request rate flat
// regardless of batch size; the cap bounds the IN-list.
const MAX_UPLOAD_STATUS_IDS = 50;

/**
 * GET /:slug/uploads/status?ids=<upload_id>[,<upload_id>…]
 *
 * Guest-facing processing status for the guest's own uploads (B7).
 *
 * The upload route answers 202 and queues the files, and /photos only returns
 * rows that reached `processing_status: 'complete'`. Without this the gallery
 * had to poll /photos blind, could not say "processing…", and could not tell a
 * slow worker from a photo that failed outright — the guest just watched their
 * upload not appear.
 *
 * Authorization: `verifyGalleryAccess` already resolved `req.event` from the
 * caller's gallery token, and the query is filtered on `event_id = req.event.id`
 * as well as the ids. An id belonging to another gallery therefore matches no
 * row rather than being reported as forbidden — no cross-event read, and no
 * existence oracle either. Slideshow tokens are denied because a kiosk never
 * uploads.
 *
 * The response is counts only. The guest already knows which files they sent;
 * anything more (filenames, `processing_error` strings, which can carry
 * internal paths) would be leaking beyond "how far along is my upload".
 */
router.get('/:slug/uploads/status', verifyGalleryAccess, denySlideshowToken, noStoreCache, async (req, res) => {
  try {
    const ids = String(req.query.ids || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);

    if (ids.length === 0 || ids.length > MAX_UPLOAD_STATUS_IDS || !ids.every((id) => UPLOAD_ID_PATTERN.test(id))) {
      return res.status(400).json({ error: 'Invalid upload ids' });
    }

    const rows = await db('photos')
      .where('event_id', req.event.id)
      .whereIn('upload_id', ids)
      .select('processing_status');

    const summary = { total: rows.length, pending: 0, processing: 0, complete: 0, failed: 0 };
    for (const row of rows) {
      // NULL is a pre-async-migration row, treated as complete exactly as the
      // /photos filter treats it.
      const status = row.processing_status || 'complete';
      if (Object.prototype.hasOwnProperty.call(summary, status) && status !== 'total') {
        summary[status] += 1;
      }
    }

    res.json(summary);
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to read upload status');
  }
});

/**
 * GET /:slug/css-template
 * Get custom CSS template for gallery (public endpoint)
 */

module.exports = router;
