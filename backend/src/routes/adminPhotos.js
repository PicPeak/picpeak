const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { db, logActivity } = require('../database/db');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { ensureThumbnail } = require('../services/imageProcessor');
const { isVideoMimeType } = require('../services/videoProcessor');
const { generatePhotoFilename, buildContentDisposition } = require('../utils/filenameSanitizer');
const {
  getUseOriginalFilenames,
  pickRawDownloadName,
} = require('../services/downloadFilenameService');
const { escapeLikePattern, likeWithEscape } = require('../utils/sqlSecurity');
const { COLOR_LABELS, dominantColorLabel, SHARED_COLOR_LABEL_IDENTITY } = require('../constants/colorLabels');
const feedbackService = require('../services/feedbackService');
const photoAdminMarksService = require('../services/photoAdminMarksService');
const { validateUploadedFiles } = require('../middleware/uploadValidation');
const {
  getMaxFilesPerUpload,
  getAllowedMimeTypes,
  getMaxFileSizeBytes,
  getMaxVideoSizeBytes,
  DEFAULT_MAX_FILE_SIZE_MB,
  DEFAULT_MAX_VIDEO_SIZE_MB,
  EXTENSION_TO_MIME
} = require('../services/uploadSettings');
const { resolvePhotoContentType } = require('../utils/photoContentType');
const { processUploadedPhotos } = require('../services/photoProcessor');
const chunkedUpload = require('../services/chunkedUploadService');
const watermarkGeneratorService = require('../services/watermarkGeneratorService');
const downloadZipService = require('../services/downloadZipService');
const { findReplacementCandidate, replacePhoto } = require('../services/photoReplacementService');
const { requireEventOwnership } = require('../middleware/ownership');
const { getStorage } = require('../services/storage');
const { errorResponse } = require('../utils/routeHelpers');
const logger = require('../utils/logger');
const router = express.Router();

// Get storage path from environment or default
const getStoragePath = () => process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');

// Resolve a numeric category id within the scope of one event: it must belong
// to that event or be a global category (#500 / #525 — the same contract the
// public v1 upload route enforces). Returns undefined for an out-of-scope id,
// which every caller turns into a 400 rather than silently filing the photo
// under another event's category.
const findScopedCategory = (eventId, categoryId) => db('photo_categories')
  .where({ id: categoryId })
  .andWhere(function () {
    this.where({ event_id: eventId }).orWhere('is_global', true);
  })
  .first();

const outOfScopeCategoryError = (categoryId) => ({
  error: `Unknown or out-of-scope category_id ${categoryId}`
});

// Configure multer for file uploads
// IMPORTANT: Using synchronous functions to prevent file corruption
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    logger.info('Multer destination called for file:', file.originalname);

    // We'll validate the event exists in the route handler
    // For now, just create a temp destination.
    // One directory per REQUEST, not per file: this callback runs for every
    // file and used to overwrite req.tempUploadPath each time, so cleanup
    // only ever removed the last file's directory and a multi-file upload
    // left the rest behind. Temp filenames are already collision-proof.
    if (!req.tempUploadPath) {
      const tempPath = path.join(getStoragePath(), 'temp', `upload_${Date.now()}_${Math.random().toString(36).substring(7)}`);

      // Create directory synchronously
      require('fs').mkdirSync(tempPath, { recursive: true });
      logger.info('Temp destination path:', tempPath);

      // Store temp path for cleanup
      req.tempUploadPath = tempPath;
    }

    cb(null, req.tempUploadPath);
  },
  filename: (req, file, cb) => {
    logger.info('Multer filename called for file:', file.originalname);
    // Use a simple temporary filename
    const tempName = `temp_${Date.now()}_${Math.round(Math.random() * 1E9)}${path.extname(file.originalname)}`;
    logger.info('Temp filename:', tempName);
    cb(null, tempName);
  }
});

const { validateFileType, createFileUploadValidator } = require('../utils/fileSecurityUtils');

// Create a multer instance that uses dynamically resolved allowed MIME types.
// The allowed types are fetched from the database once per request (before multer
// processes files) and attached to req.allowedMimeTypes so that the fileFilter
// callback can read them synchronously.
//
// The per-file size cap is resolved per request too (general_max_file_size_mb),
// so the uploader has to be built per request like the transfer routes do. It
// was hardcoded to 10GB here, which meant the advertised "max. 50MB per file"
// in the dropzone was never enforced anywhere server-side. getMaxFileSizeBytes()
// clamps to MAX_ALLOWED_FILE_SIZE_MB (10GB), so that hard ceiling still applies.
const createUpload = (maxFileSizeBytes) => multer({
  storage: storage,
  limits: {
    fileSize: maxFileSizeBytes,
    files: 2000, // Hard safety ceiling; actual limit enforced dynamically
    fieldSize: 10 * 1024 * 1024, // 10MB for non-file fields
    parts: 10000,
    headerPairs: 2000
  },
  fileFilter: (req, file, cb) => {
    // req.allowedMimeTypes is populated by the middleware that runs before multer
    const allowedMimeTypes = req.allowedMimeTypes || ['image/jpeg', 'image/png', 'image/webp'];

    if (validateFileType(file.originalname, file.mimetype, allowedMimeTypes)) {
      return cb(null, true);
    } else {
      cb(new Error('Invalid file type. Check allowed file types in system settings.'));
    }
  },
  abortOnLimit: true
});

// Middleware to resolve allowed MIME types from settings before multer runs
const resolveAllowedTypes = async (req, res, next) => {
  try {
    req.allowedMimeTypes = await getAllowedMimeTypes();
  } catch (error) {
    logger.error('Failed to resolve allowed MIME types:', error);
    req.allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
  }
  next();
};

// Dynamic content validator middleware that reads allowed types from req
const validateUploadContent = async (req, res, next) => {
  const allowedTypes = req.allowedMimeTypes || ['image/jpeg', 'image/png', 'image/webp'];
  const photoCapBytes = req.maxFileSizeBytes || DEFAULT_MAX_FILE_SIZE_MB * 1024 * 1024;
  const videoCapBytes = req.maxVideoSizeBytes || DEFAULT_MAX_VIDEO_SIZE_MB * 1024 * 1024;
  const capFor = (file) => (isVideoMimeType(file.mimetype) ? videoCapBytes : photoCapBytes);

  // Photos and videos have separate caps (general_max_file_size_mb /
  // general_max_video_size_mb), but multer's limit is global — it streamed
  // against the larger of the two because it can't branch on MIME type. So
  // the per-kind decision has to happen here, where the type is known,
  // otherwise a 50MB photo cap would be silently raised to the video cap.
  const oversized = (req.files || []).find((file) => file.size > capFor(file));
  if (oversized) {
    const capMb = Math.floor(capFor(oversized) / (1024 * 1024));
    return res.status(400).json({ error: `File too large. Maximum size is ${capMb} MB per file.` });
  }

  const validator = createFileUploadValidator({
    allowedTypes,
    // Same per-request caps as above, so the two layers can't disagree.
    maxFileSize: photoCapBytes,
    maxVideoFileSize: videoCapBytes,
    validateContent: true
  });
  return validator(req, res, next);
};

// Remove the multer temp directory on every exit path — success, validation
// 4xx, multer error, server 5xx or a client disconnect. Registered BEFORE
// multer runs (the closure reads req.tempUploadPath lazily) because a
// rejected upload never reaches the final handler, where this used to live:
// every rejection leaked its temp directory and the file inside it.
const registerTempUploadCleanup = (req, res, next) => {
  let cleanupDone = false;
  const cleanupTempDir = async () => {
    if (cleanupDone || !req.tempUploadPath) return;
    cleanupDone = true;
    try {
      await fs.rm(req.tempUploadPath, { recursive: true, force: true });
    } catch (e) {
      logger.error('Failed to clean up temp upload directory:', e);
    }
  };
  res.on('finish', cleanupTempDir);
  res.on('close', cleanupTempDir);
  next();
};

// Request timeout middleware for uploads
const uploadTimeout = (timeout = 300000) => { // 5 minutes default
  return (req, res, next) => {
    // Set timeout for the request
    req.setTimeout(timeout, () => {
      logger.error('Upload request timed out');
      if (!res.headersSent) {
        res.status(408).json({ error: 'Upload request timed out' });
      }
    });
    
    // Set response timeout as well
    res.setTimeout(timeout, () => {
      logger.error('Upload response timed out');
    });
    
    next();
  };
};

// Upload photos for an event
// Max file count and max file size are configurable via general settings
router.post('/:eventId/upload', adminAuth, requirePermission('photos.upload'), requireEventOwnership, uploadTimeout(600000), resolveAllowedTypes, registerTempUploadCleanup, async (req, res, next) => { // 10 minute timeout
  let maxFilesPerUpload;
  let maxFileSizeBytes;
  let maxVideoSizeBytes;
  try {
    maxFilesPerUpload = await getMaxFilesPerUpload();
    maxFileSizeBytes = await getMaxFileSizeBytes();
    maxVideoSizeBytes = await getMaxVideoSizeBytes();
  } catch (error) {
    return errorResponse(res, error, 500, 'Unable to determine upload limits');
  }
  req.maxFileSizeBytes = maxFileSizeBytes;
  req.maxVideoSizeBytes = maxVideoSizeBytes;
  // multer's limit is global, so it has to be the larger of the two caps;
  // validateUploadContent then holds each file to the cap for its own kind.
  const multerLimitBytes = Math.max(maxFileSizeBytes, maxVideoSizeBytes);
  const maxFileSizeMb = Math.floor(multerLimitBytes / (1024 * 1024));

  createUpload(multerLimitBytes).array('photos', maxFilesPerUpload)(req, res, (err) => {
    if (err) {
      logger.error('Multer error:', err);
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: `File too large. Maximum size is ${maxFileSizeMb} MB per file.` });
        }
        if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
          return res.status(400).json({ error: `Too many files. Maximum ${maxFilesPerUpload} files per upload.` });
        }
        return res.status(400).json({ error: `Upload error: ${err.message}` });
      }
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }
    next();
  });
}, validateUploadContent, validateUploadedFiles, async (req, res) => {
  // Temp-directory cleanup is registered by registerTempUploadCleanup above,
  // before multer runs, so it also covers the exit paths that never reach
  // this handler (multer errors and validation 4xx).
  try {
    const { eventId } = req.params;
    const { category_id, replace_by_name, match_mode } = req.body;
    const replaceByName = replace_by_name === 'true' || replace_by_name === true;
    // How replace_by_name finds its target (#745). 'exact' is the historical
    // behaviour and stays the default; 'number_token' matches on the trailing
    // digit run so a render renamed in Lightroom still lands on its proof.
    // Anything else falls back to 'exact' rather than erroring — an unknown
    // mode must not silently widen the match.
    const matchMode = match_mode === 'number_token' ? 'number_token' : 'exact';

    logger.info('Upload request received for event:', eventId);
    logger.info('Body:', req.body);
    logger.info('Files:', req.files ? req.files.length : 'none');
    logger.info('File details:', req.files?.map(f => ({ name: f.originalname, size: f.size, mimetype: f.mimetype })));
    logger.info('Category ID received:', category_id);

    // Verify event exists and admin has access
    const event = await db('events').where({ id: eventId }).first();
    if (!event) {
      logger.error('Event not found:', eventId);
      return res.status(404).json({ error: 'Event not found' });
    }

    // Enforce photo cap if set (replacements don't count as new)
    if (event.photo_cap && event.photo_cap > 0) {
      const existingPhotoCount = await db('photos')
        .where({ event_id: eventId })
        .count('id as count')
        .first();
      const currentCount = parseInt(existingPhotoCount.count) || 0;
      let newFilesCount = (req.files && req.files.length) || 0;
      // Subtract likely replacements from cap calculation
      if (replaceByName && req.files) {
        for (const file of req.files) {
          const candidate = await findReplacementCandidate(
            parseInt(eventId), file.originalname, { matchMode }
          );
          if (candidate && !candidate.ambiguous) newFilesCount--;
        }
      }
      if (currentCount + newFilesCount > event.photo_cap) {
        return res.status(400).json({
          error: `Photo cap exceeded. This event allows a maximum of ${event.photo_cap} photos. Currently ${currentCount} photos exist, and you are trying to upload ${newFilesCount} more.`
        });
      }
    }

    if (!req.files || req.files.length === 0) {
      logger.error('No files in request. req.files:', req.files);
      logger.error('Request body keys:', Object.keys(req.body));
      return res.status(400).json({ error: 'No files uploaded' });
    }
    
    // Parse category_id to number if provided (handle string values like 'individual', 'collage')
    // Same 0-is-not-a-category rule as the PATCH route below: '0' is truthy, so
    // it parsed to 0 and the scope-validation guard (`if (parsedCategoryId && ...)`)
    // then skipped on the falsy 0 and let it into the insert unvalidated.
    const rawParsed = category_id ? parseInt(category_id, 10) : NaN;
    const parsedCategoryId = rawParsed > 0 ? rawParsed : null;

    // Determine photo type and category name
    let photoType = 'individual'; // default
    let categoryName = 'individual';

    // Look up the actual category from database if provided. Scope the
    // lookup to (event_id = event.id OR is_global = true) — same contract
    // the public v1 upload route enforces (#500 / #525). Without it, the
    // admin upload silently accepts any category id including ones that
    // belong to a different event. The v1 route rejects out-of-scope ids
    // with 400; mirror that here so admin and v1 stay consistent.
    if (parsedCategoryId && !isNaN(parsedCategoryId)) {
      const category = await findScopedCategory(event.id, parsedCategoryId);
      if (!category) {
        return res.status(400).json(outOfScopeCategoryError(parsedCategoryId));
      }
      categoryName = category.slug || category.name.toLowerCase().replace(/\s+/g, '_');
      // Use category slug for type determination
      if (category.slug === 'collage' || category.slug === 'collages') {
        photoType = 'collage';
      }
    } else if (category_id === 'collage') {
      // For backwards compatibility, accept string values
      photoType = 'collage';
      categoryName = 'collages';
    }
    
    // Final destination key prefix under the storage backend (no local mkdir
    // needed — LocalFsStorage creates the parent dir on put, S3 has no dirs).
    const finalDestPathRel = path.posix.join('events/active', event.slug);
    
    const uploadedPhotos = [];
    const replacedPhotos = [];
    const skippedReplacements = [];
    const errors = [];

    // Handle replacements first if enabled
    let filesToUpload = req.files;
    if (replaceByName && req.files.length > 0) {
      const newFiles = [];
      for (const file of req.files) {
        const candidate = await findReplacementCandidate(
          parseInt(eventId), file.originalname, { matchMode }
        );
        if (candidate && !candidate.ambiguous) {
          // Replace existing photo
          const result = await replacePhoto(candidate, file.path, {
            originalFilename: file.originalname,
            mimeType: file.mimetype,
            event,
          });
          if (result.success) {
            replacedPhotos.push({
              id: result.photo.id,
              filename: result.photo.filename,
              original_filename: file.originalname,
              previous_filename: result.previousFilename,
            });
          } else {
            errors.push({ filename: file.originalname, error: `Replacement failed: ${result.error}` });
          }
        } else if (candidate && candidate.ambiguous) {
          skippedReplacements.push({
            filename: file.originalname,
            reason: matchMode === 'number_token'
              ? `${candidate.count} photos share this number — uploaded as new. `
                + 'Multi-camera shoots should prefix the camera index into the '
                + 'filename (cam11234.jpg / cam21234.jpg) and keep it in the '
                + 'delivery name.'
              : `${candidate.count} photos share this name — uploaded as new`,
          });
          newFiles.push(file);
        } else {
          newFiles.push(file);
        }
      }
      filesToUpload = newFiles;
    }

    // Async-processing flow:
    //   1. Move each file to its final storage location.
    //   2. Insert a photo row with processing_status='pending' and a
    //      shared upload_id. EXIF / sharp / thumbnails / ffmpeg /
    //      watermark / webhook all happen in the background worker
    //      (services/backgroundProcessor.js) so the request returns in
    //      seconds even on NFS-backed storage.
    //
    // The previous code processed thumbnails+EXIF synchronously in
    // batches of 25 inside this handler, which is why large uploads on
    // slow storage looked frozen — see #357 review.
    const crypto = require('crypto');
    const uploadId = crypto.randomBytes(16).toString('hex');

    // Counter base — a per-request approximation (concurrent upload
    // requests can compute the same base; there is NO unique index on
    // photos.filename). Uniqueness of the final path comes from the
    // random suffix inside generatePhotoFilename (#931).
    const existingCount = await db('photos')
      .where({ event_id: eventId, type: photoType })
      .count('id as count')
      .first();
    let counter = (parseInt(existingCount.count) || 0) + 1;
    const storage = getStorage();

    for (const file of filesToUpload) {
      try {
        const tempStats = await fs.stat(file.path);
        if (tempStats.size === 0) {
          throw new Error('File is empty - upload may have been interrupted');
        }

        const extension = path.extname(file.originalname);
        const newFilename = generatePhotoFilename(
          event.event_name,
          categoryName,
          counter,
          extension
        );
        counter += 1;

        const finalKey = path.posix.join(finalDestPathRel, newFilename);
        const relativePath = path.posix.join(event.slug, newFilename);
        const isVideo = isVideoMimeType(file.mimetype);

        // 1. Move file to its final storage key first. If the worker
        //    later picks up the photo row, the file is guaranteed to
        //    exist at the recorded path.
        await storage.putFromFile(finalKey, file.path, {
          contentType: file.mimetype,
        });
        await fs.unlink(file.path).catch(() => {});

        // Sanity check the round-tripped size — same guard as before.
        const stat = await storage.stat(finalKey);
        if (!stat || stat.size !== tempStats.size) {
          throw new Error(
            `Size mismatch after upload: expected ${tempStats.size}, got ${stat ? stat.size : 'null'}`
          );
        }

        // 2. Insert a pending photo row. The background processor
        //    will pick it up, generate thumbnail/dimensions/EXIF, and
        //    flip status to 'complete' (or 'failed' with the error).
        const inserted = await db('photos')
          .insert({
            event_id: parseInt(eventId, 10),
            filename: newFilename,
            original_filename: file.originalname,
            // Camera-original name, kept separate so a later replace can
            // overwrite original_filename without losing the Lightroom
            // round-trip's match key (migration 193, #745).
            source_filename: file.originalname,
            path: relativePath,
            thumbnail_path: null,
            type: photoType,
            category_id: parsedCategoryId,
            size_bytes: tempStats.size,
            captured_at: null,
            media_type: isVideo ? 'video' : 'image',
            mime_type: file.mimetype,
            processing_status: 'pending',
            upload_id: uploadId,
          })
          .returning('id');
        const photoId = inserted[0]?.id || inserted[0];

        uploadedPhotos.push({
          id: photoId,
          filename: newFilename,
          size: tempStats.size,
          category_id: parsedCategoryId,
        });
      } catch (err) {
        logger.error(`Error queuing file ${file.originalname}:`, err);
        errors.push({ filename: file.originalname, error: err.message });
      }
    }
    
    // Log activity
    await logActivity('photos_uploaded',
      { count: uploadedPhotos.length, replacedCount: replacedPhotos.length, eventName: event.event_name },
      eventId,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );

    // Log individual replacements for audit trail
    for (const rp of replacedPhotos) {
      await logActivity('photo_replaced',
        { photoId: rp.id, originalFilename: rp.original_filename, previousFilename: rp.previous_filename, eventName: event.event_name },
        eventId,
        { type: 'admin', id: req.admin.id, name: req.admin.username }
      );
    }

    // Include any files that were invalid from the validation middleware
    const totalInvalidFiles = (req.invalidFiles || []).concat(errors);

    // Prepare response. The new fields (upload_id, count, photo_ids)
    // are what the new frontend uses to poll for processing status; the
    // existing fields (successCount, replacedCount, ...) are kept for
    // back-compat with older clients that haven't upgraded yet.
    const totalAttempted = req.files.length + (req.invalidFiles ? req.invalidFiles.length : 0);
    const uploadMsg = uploadedPhotos.length > 0 ? `${uploadedPhotos.length} queued` : '';
    const replaceMsg = replacedPhotos.length > 0 ? `${replacedPhotos.length} replaced` : '';
    const parts = [uploadMsg, replaceMsg].filter(Boolean).join(', ');
    const response = {
      // New async-processing fields
      upload_id: uploadId,
      count: uploadedPhotos.length,
      photo_ids: uploadedPhotos.map((p) => p.id),
      // Existing back-compat fields
      message: parts ? `Successfully ${parts}` : 'No photos processed',
      photos: uploadedPhotos,
      replaced: replacedPhotos,
      replacedCount: replacedPhotos.length,
      skippedReplacements,
      totalFiles: totalAttempted,
      successCount: uploadedPhotos.length + replacedPhotos.length,
      failureCount: totalInvalidFiles.length,
    };

    // Include error details if any files failed
    if (totalInvalidFiles.length > 0) {
      response.errors = totalInvalidFiles;
      response.message = `Queued ${uploadedPhotos.length} of ${totalAttempted} photos. ${totalInvalidFiles.length} failed.`;
    }

    // Invalidate download zip cache after successful upload or replacement
    if (uploadedPhotos.length > 0 || replacedPhotos.length > 0) {
      downloadZipService.invalidate(parseInt(eventId));
    }

    // 202 Accepted — files stored, processing happens in background.
    res.status(202).json(response);
  } catch (error) {
    // Temp directory cleanup is handled by the response finish/close
    // listeners above, regardless of which exit path fires.
    errorResponse(res, error, 500, 'Failed to upload photos');
  }
});

// Helper — load the upload group + verify the requesting admin owns the
// underlying event. Returns { event, photos } or sends a 4xx response.
async function loadUploadGroup(req, res) {
  const { upload_id: uploadId } = req.params;
  if (!uploadId || typeof uploadId !== 'string' || uploadId.length > 64) {
    res.status(400).json({ error: 'Invalid upload_id' });
    return null;
  }

  const photos = await db('photos').where({ upload_id: uploadId });
  if (photos.length === 0) {
    res.status(404).json({ error: 'Upload group not found' });
    return null;
  }

  const eventId = photos[0].event_id;
  let eventQuery = db('events').where('id', eventId);
  if (req.admin.roleName === 'editor') {
    eventQuery = eventQuery.where('created_by', req.admin.id);
  }
  const event = await eventQuery.first();
  if (!event) {
    res.status(404).json({ error: 'Event not found' });
    return null;
  }
  return { event, photos, uploadId };
}

function summariseUpload(photos) {
  const summary = {
    total: photos.length,
    pending: 0,
    processing: 0,
    complete: 0,
    failed: 0,
    photos: photos.map((p) => ({
      id: p.id,
      filename: p.filename,
      original_filename: p.original_filename,
      status: p.processing_status,
      error: p.processing_error || null,
    })),
  };
  for (const p of photos) {
    summary[p.processing_status] = (summary[p.processing_status] || 0) + 1;
  }
  return summary;
}

// JSON snapshot of upload status — frontends poll this every 1.5s while
// any photo in the group is still pending or processing.
router.get(
  '/uploads/:upload_id/status',
  adminAuth,
  requirePermission('photos.view'),
  async (req, res) => {
    try {
      const group = await loadUploadGroup(req, res);
      if (!group) return;
      res.json({
        upload_id: group.uploadId,
        event_id: group.event.id,
        ...summariseUpload(group.photos),
      });
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to read upload status');
    }
  }
);

// Server-Sent Events stream for upload progress. Optional upgrade over
// the polling endpoint above. Streams the current snapshot on connect,
// then re-emits whenever the snapshot changes (debounced) until all
// photos in the group reach a terminal state.
router.get(
  '/uploads/:upload_id/stream',
  adminAuth,
  requirePermission('photos.view'),
  async (req, res) => {
    const group = await loadUploadGroup(req, res);
    if (!group) return;

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    let lastJson = '';
    let closed = false;
    let timer = null;

    const send = async () => {
      if (closed) return;
      try {
        const photos = await db('photos').where({ upload_id: group.uploadId });
        const summary = summariseUpload(photos);
        const payload = JSON.stringify({
          upload_id: group.uploadId,
          event_id: group.event.id,
          ...summary,
        });
        if (payload !== lastJson) {
          lastJson = payload;
          res.write(`data: ${payload}\n\n`);
        }
        // Stop streaming once everything has reached a terminal state.
        if (summary.pending === 0 && summary.processing === 0) {
          closed = true;
          clearInterval(timer);
          res.end();
          return;
        }
      } catch (e) {
        logger.error('Upload stream poll error:', e);
      }
    };

    await send();
    timer = setInterval(send, 1500);

    req.on('close', () => {
      closed = true;
      if (timer) clearInterval(timer);
    });
  }
);

// Retry a failed photo — flip back to 'pending' so the worker picks it
// up again. Used by the admin grid's "Retry" button when a previous run
// hit a transient sharp/ffmpeg error.
router.post(
  '/photos/:photoId/retry',
  adminAuth,
  requirePermission('photos.edit'),
  async (req, res) => {
    try {
      const photo = await db('photos').where({ id: req.params.photoId }).first();
      if (!photo) return res.status(404).json({ error: 'Photo not found' });

      // Ownership scope: any non-super_admin may only retry photos in events
      // they own — matching requireEventOwnership (which scopes both the
      // admin and editor roles; only super_admin bypasses). Previously this
      // checked the editor role alone, leaving admin-role users able to
      // reprocess another admin's photos.
      if (req.admin.roleName !== 'super_admin') {
        const event = await db('events')
          .where({ id: photo.event_id })
          .first();
        if (event && event.created_by && event.created_by !== req.admin.id) {
          return res.status(404).json({ error: 'Photo not found' });
        }
      }

      if (photo.processing_status !== 'failed') {
        return res.status(409).json({
          error: `Photo is in '${photo.processing_status}' state and cannot be retried`,
        });
      }

      await db('photos').where({ id: photo.id }).update({
        processing_status: 'pending',
        processing_error: null,
        processing_started_at: null,
      });
      res.json({ id: photo.id, status: 'pending' });
    } catch (error) {
      errorResponse(res, error, 500, 'Failed to retry photo processing');
    }
  }
);

// Delete a photo
router.delete('/:eventId/photos/:photoId', adminAuth, requirePermission('photos.delete'), requireEventOwnership, async (req, res) => {
  try {
    const { eventId, photoId } = req.params;
    
    // Get photo details
    const photo = await db('photos')
      .where({ id: photoId, event_id: eventId })
      .first();
    
    if (!photo) {
      return res.status(404).json({ error: 'Photo not found' });
    }
    
    // Delete original + thumbnail through the storage backend.
    const storage = getStorage();
    const { resolvePhotoStorageKey } = require('../services/photoResolver');
    const event = await db('events').where({ id: eventId }).first();

    try {
      const originalKey = resolvePhotoStorageKey(event, photo);
      if (originalKey) await storage.delete(originalKey);
    } catch (error) {
      logger.error('Error deleting photo file:', error);
    }

    // photo.thumbnail_path is stored as the canonical storage key
    // (e.g. "thumbnails/thumb_foo.jpg"), so pass it through verbatim.
    if (photo.thumbnail_path) {
      try {
        await storage.delete(photo.thumbnail_path);
      } catch (error) {
        logger.error('Error deleting thumbnail:', error);
      }
    }
    if (photo.hero_path) {
      await storage.delete(photo.hero_path).catch(() => {});
    }
    // Lightbox preview tier (#492). Same disposable-derived semantics
    // as thumbnail / hero — wipe on photo delete so we don't leak
    // orphaned files into previews/ that no DB row references.
    if (photo.preview_path) {
      await storage.delete(photo.preview_path).catch(() => {});
    }
    // Outside the preview_path guard on purpose: a responsive tier (#1095) can
    // exist when the canonical rendition never did — they are generated
    // independently, on demand — so keying their cleanup off preview_path
    // would strand exactly the photos that were only ever viewed on a phone.
    await require('../services/imageProcessor').deletePreviewTiers(photo);
    await require('../services/imageProcessor').deleteThumbnailTiers(photo);

    // Delete pre-generated watermark if exists
    if (photo.watermark_path) {
      await watermarkGeneratorService.deleteForPhoto(photo.id);
    }

    // Remove from database
    // Face data (#1074): the FK cascade is inert on SQLite, and cannot fix up
    // event_people counts anyway. See faceProcessor.purgePhotoFaces.
    try {
      const { purgePhotoFaces } = require('../services/faceProcessor');
      await purgePhotoFaces(photoId);
    } catch (err) {
      logger.warn(`deletePhoto: face purge failed for photo ${photoId}`, { error: err.message });
    }

    await db('photos').where({ id: photoId }).delete();

    // Log activity (event was fetched above for storage key resolution)
    await logActivity('photo_deleted',
      { filename: photo.filename, eventName: event.event_name },
      eventId,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );

    // Webhook (#327): single-photo delete.
    try {
      const webhookService = require('../services/webhookService');
      await webhookService.fire('photo.deleted', {
        event: { id: parseInt(eventId, 10), slug: event?.slug, event_name: event?.event_name },
        photo: { id: parseInt(photoId, 10), filename: photo.filename },
      });
    } catch (e) { /* non-fatal */ }

    downloadZipService.invalidate(parseInt(eventId));
    res.json({ message: 'Photo deleted successfully' });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to delete photo');
  }
});

// The photographer's own star / colour mark on a photo (#1044 follow-up).
//
// Separate from guest feedback in every sense: its own table, its own
// endpoint, and never surfaced to the gallery. `rating` and `color_label` are
// tri-state — omit a key to leave that half alone, send null to clear it — so
// the lightbox's colour keys and star keys don't wipe each other.
router.put('/:eventId/photos/:photoId/mark', adminAuth, requirePermission('photos.edit'), requireEventOwnership, async (req, res) => {
  try {
    const { eventId } = req.params;
    // Parse before querying: Postgres errors on `where id = 'abc'` (22P02),
    // which would answer 500 for what is really a bad URL. SQLite just fails
    // to match, so without this the two engines disagree.
    const photoId = parseInt(req.params.photoId, 10);
    if (!Number.isInteger(photoId) || photoId < 1) {
      return res.status(404).json({ error: 'Photo not found' });
    }

    // requireEventOwnership proves the caller owns the EVENT; this proves the
    // photo is in it, so a photo id from another event can't be marked
    // through an event the caller does own.
    const photo = await db('photos')
      .where({ id: photoId, event_id: eventId })
      .first();
    if (!photo) {
      return res.status(404).json({ error: 'Photo not found' });
    }

    const mark = {};
    if (Object.prototype.hasOwnProperty.call(req.body, 'rating')) {
      mark.rating = req.body.rating === null ? null : req.body.rating;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'color_label')) {
      mark.colorLabel = req.body.color_label === null ? null : req.body.color_label;
    }
    if (Object.keys(mark).length === 0) {
      return res.status(400).json({ error: 'Send rating and/or color_label' });
    }

    const result = await photoAdminMarksService.setMark(
      parseInt(eventId, 10), photoId, req.admin.id, mark,
    );

    res.json({ success: true, mark: result });
  } catch (error) {
    // Validation errors from the service are the caller's fault, not a 500.
    // Keyed on the code, not the message: matching text would couple this
    // status to the service's wording.
    if (error.code === photoAdminMarksService.INVALID_MARK) {
      return res.status(400).json({ error: error.message });
    }
    errorResponse(res, error, 500, 'Failed to save mark');
  }
});

// Update a photo (e.g., change category)
router.patch('/:eventId/photos/:photoId', adminAuth, requirePermission('photos.edit'), requireEventOwnership, async (req, res) => {
  try {
    const { eventId, photoId } = req.params;
    const { category_id, visibility } = req.body;

    // Verify photo belongs to event
    const photo = await db('photos')
      .where({ id: photoId, event_id: eventId })
      .first();

    if (!photo) {
      return res.status(404).json({ error: 'Photo not found' });
    }

    // Prepare update data
    const updateData = {};

    // Handle visibility update (#172)
    if (visibility !== undefined) {
      if (['visible', 'hidden'].includes(visibility)) {
        updateData.visibility = visibility;
      }
    }

    // Handle type-based categories ('individual' or 'collage')
    // These are string values that map to the photo.type field
    if (category_id === 'individual' || category_id === 'collage') {
      updateData.type = category_id;
      updateData.category_id = null; // Clear legacy category_id
    } else if (category_id === null || category_id === undefined) {
      // Explicitly clear category
      updateData.category_id = null;
    } else {
      // Handle numeric category IDs from photo_categories table.
      // 0 and negatives mean "no category", not category zero: photo_categories.id
      // is an increments() column so it starts at 1, and a <select> whose "none"
      // option carries value="0" is exactly how '0' reaches this route. Storing 0
      // left the photo in a black hole — the grid's category filters never match
      // it, and the "uncategorized" filter is whereNull() so it misses it too,
      // while the list mapper renders it as uncategorized because 0 is falsy.
      // NaN (unparseable input) already fell through to null and still does.
      const numericCategoryId = parseInt(category_id, 10);
      if (numericCategoryId > 0) {
        // Same scope check the upload route runs: without it any positive id
        // was accepted, so a photo could be moved into another event's
        // category (the grid then never shows it under any filter).
        const category = await findScopedCategory(parseInt(eventId, 10), numericCategoryId);
        if (!category) {
          return res.status(400).json(outOfScopeCategoryError(numericCategoryId));
        }
        updateData.category_id = numericCategoryId;
      } else {
        updateData.category_id = null;
      }
    }

    // A human just set (or cleared) this category, so it is no longer an
    // automatic assignment (#1074 phase 3). Without resetting the flag,
    // "undo automatic categories" would later wipe the photographer's own
    // choice — exactly the guarantee the rule engine advertises.
    updateData.auto_categorized = false;

    // Update photo
    await db('photos')
      .where({ id: photoId, event_id: eventId })
      .update(updateData);

    // A visibility or category change alters which photos belong in the
    // guest download bundle — drop the cached ZIP so it rebuilds fresh,
    // otherwise a hide→unhide cycle can leave the stale cache omitting
    // photos added in between (codex review).
    if (updateData.visibility !== undefined
        || Object.prototype.hasOwnProperty.call(updateData, 'category_id')
        || Object.prototype.hasOwnProperty.call(updateData, 'type')) {
      downloadZipService.invalidate(parseInt(eventId, 10));
    }

    // Fetch and return the updated photo
    const updatedPhoto = await db('photos')
      .where({ id: photoId, event_id: eventId })
      .first();

    res.json({
      message: 'Photo updated successfully',
      photo: updatedPhoto
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to update photo');
  }
});

// Bulk delete photos
router.post('/:eventId/photos/bulk-delete', adminAuth, requirePermission('photos.delete'), requireEventOwnership, async (req, res) => {
  try {
    const { eventId } = req.params;
    const { photoIds } = req.body;
    
    if (!Array.isArray(photoIds) || photoIds.length === 0) {
      return res.status(400).json({ error: 'Invalid photo IDs' });
    }
    
    // Get all photos to delete
    const photos = await db('photos')
      .whereIn('id', photoIds)
      .where('event_id', eventId);
    
    if (photos.length === 0) {
      return res.status(404).json({ error: 'No photos found' });
    }
    
    // Delete original + thumbnail + hero through the storage backend.
    const storage = getStorage();
    const event = await db('events').where({ id: eventId }).first();
    const { resolvePhotoStorageKey } = require('../services/photoResolver');

    for (const photo of photos) {
      try {
        const originalKey = resolvePhotoStorageKey(event, photo);
        if (originalKey) await storage.delete(originalKey);
      } catch (error) {
        logger.error('Error deleting photo file:', error);
      }

      if (photo.thumbnail_path) {
        await storage.delete(photo.thumbnail_path).catch(() => {});
      }
      if (photo.hero_path) {
        await storage.delete(photo.hero_path).catch(() => {});
      }
      // Lightbox preview tier (#492) — bulk delete cleanup.
      if (photo.preview_path) {
        await storage.delete(photo.preview_path).catch(() => {});
      }
      // Outside the guard: a tier can exist when the canonical rendition never
      // did, so keying cleanup off preview_path would strand phone-only photos.
      await require('../services/imageProcessor').deletePreviewTiers(photo);
      await require('../services/imageProcessor').deleteThumbnailTiers(photo);
      if (photo.watermark_path) {
        await watermarkGeneratorService.deleteForPhoto(photo.id);
      }
    }

    // Face data (#1074), bulk path. Same reasoning as the single delete: the
    // SQLite FK cascade never fires, and event_people counts need rebuilding
    // regardless of engine.
    // Iterate the VALIDATED rows, not the raw request ids. `photos` is already
    // scoped to this event; `photoIds` is user input, and purgePhotoFaces has
    // no event scope of its own — so looping the raw ids let an editor delete
    // face data (and recompute people) in a gallery they do not own, even
    // though the photo deletion below is correctly scoped.
    for (const photo of photos) {
      try {
        const { purgePhotoFaces } = require('../services/faceProcessor');
        await purgePhotoFaces(photo.id);
      } catch (err) {
        logger.warn(`bulk delete: face purge failed for photo ${photo.id}`, { error: err.message });
      }
    }

    // Delete from database
    await db('photos')
      .whereIn('id', photoIds)
      .where('event_id', eventId)
      .delete();

    // Webhook (#327): one photo.deleted per row in the bulk batch.
    try {
      const webhookService = require('../services/webhookService');
      for (const photo of photos) {
        await webhookService.fire('photo.deleted', {
          event: { id: parseInt(eventId, 10), slug: event?.slug, event_name: event?.event_name },
          photo: { id: photo.id, filename: photo.filename },
        });
      }
    } catch (e) { /* non-fatal */ }

    // Log activity
    await logActivity('photos_bulk_deleted',
      { count: photos.length, eventName: event.event_name },
      eventId,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );
    
    downloadZipService.invalidate(parseInt(eventId));
    res.json({ message: `${photos.length} photos deleted successfully` });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to delete photos');
  }
});

// Bulk update photos
router.post('/:eventId/photos/bulk-update', adminAuth, requirePermission('photos.edit'), requireEventOwnership, async (req, res) => {
  try {
    const { eventId } = req.params;
    const { photoIds, updates } = req.body;
    
    if (!Array.isArray(photoIds) || photoIds.length === 0) {
      return res.status(400).json({ error: 'Invalid photo IDs' });
    }
    
    // Verify all photos belong to the event
    const photoCount = await db('photos')
      .whereIn('id', photoIds)
      .where('event_id', eventId)
      .count('id as count')
      .first();
    
    if (parseInt(photoCount.count) !== photoIds.length) {
      return res.status(400).json({ error: 'Some photos do not belong to this event' });
    }
    
    // Prepare update data
    const updateData = {};

    // Handle visibility update (#172)
    if (updates.visibility !== undefined) {
      if (['visible', 'hidden'].includes(updates.visibility)) {
        updateData.visibility = updates.visibility;
      }
    }

    if (updates.category_id !== undefined) {
      // Handle type-based categories ('individual' or 'collage')
      // These are string values that map to the photo.type field
      if (updates.category_id === 'individual' || updates.category_id === 'collage') {
        updateData.type = updates.category_id;
        updateData.category_id = null; // Clear legacy category_id
      } else if (updates.category_id === null) {
        // Explicitly clear category
        updateData.category_id = null;
      } else {
        // Handle numeric category IDs from photo_categories table
        // (0/negative mean "no category" — see the PATCH route above)
        const numericCategoryId = parseInt(updates.category_id, 10);
        if (numericCategoryId > 0) {
          // Scope check, as on the PATCH and upload routes above.
          const category = await findScopedCategory(parseInt(eventId, 10), numericCategoryId);
          if (!category) {
            return res.status(400).json(outOfScopeCategoryError(numericCategoryId));
          }
          updateData.category_id = numericCategoryId;
        } else {
          updateData.category_id = null;
        }
      }

      // A human just set (or cleared) this category, so it is no longer an
      // automatic assignment (#1074 phase 3). Without resetting the flag,
      // "undo automatic categories" would later wipe the photographer's own
      // choice — exactly the guarantee the rule engine advertises.
      updateData.auto_categorized = false;
    }

    await db('photos')
      .whereIn('id', photoIds)
      .where('event_id', eventId)
      .update(updateData);

    // Visibility/category changes alter the guest download bundle — drop the
    // cached ZIP so it rebuilds fresh (codex review).
    if (updateData.visibility !== undefined
        || Object.prototype.hasOwnProperty.call(updateData, 'category_id')
        || Object.prototype.hasOwnProperty.call(updateData, 'type')) {
      downloadZipService.invalidate(parseInt(eventId, 10));
    }

    res.json({ message: `${photoIds.length} photos updated successfully` });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to update photos');
  }
});

// Download a photo
router.get('/:eventId/photos/:photoId/download', adminAuth, requirePermission('photos.download'), requireEventOwnership, async (req, res) => {
  try {
    const { eventId, photoId } = req.params;
    
    const photo = await db('photos')
      .where({ id: photoId, event_id: eventId })
      .first();
    
    if (!photo) {
      return res.status(404).json({ error: 'Photo not found' });
    }
    
    const { resolvePhotoFilePath, resolvePhotoStorageKey } = require('../services/photoResolver');
    const event = await db('events').where('id', eventId).first();
    const storage = getStorage();
    const storageKey = resolvePhotoStorageKey(event, photo);

    // #493: respect the original-filenames toggle for admin downloads too.
    const useOriginal = await getUseOriginalFilenames();
    const downloadName = pickRawDownloadName(photo, useOriginal);
    const contentDisposition = buildContentDisposition(downloadName);

    if (storageKey) {
      const stat = await storage.stat(storageKey);
      if (!stat) {
        return res.status(404).json({ error: 'Photo file not found' });
      }
      res.set({
        'Content-Type': resolvePhotoContentType(photo),
        'Content-Length': stat.size,
        'Content-Disposition': contentDisposition,
      });
      const stream = await storage.get(storageKey);
      stream.pipe(res);
      return;
    }

    // External-mode photos still live on local disk.
    const filePath = resolvePhotoFilePath(event, photo);
    try {
      await fs.access(filePath);
    } catch (error) {
      return res.status(404).json({ error: 'Photo file not found' });
    }
    res.set({
      'Content-Type': resolvePhotoContentType(photo),
      'Content-Disposition': contentDisposition,
    });
    res.sendFile(filePath);
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to download photo');
  }
});

// Get all photos for an event
router.get('/:eventId/photos', adminAuth, requirePermission('photos.view'), requireEventOwnership, async (req, res) => {
  try {
    const { eventId } = req.params;
    const { category_id, type, search, sort = 'date', has_likes, has_favorites, has_comments, min_rating, color_label } = req.query;
    const order = ['asc', 'desc'].includes(req.query.order) ? req.query.order : 'desc';
    const logic = req.query.logic === 'OR' ? 'OR' : 'AND';

    let query = db('photos')
      .where({ 'photos.event_id': eventId })
      .leftJoin('photo_categories', 'photos.category_id', 'photo_categories.id')
      .select('photos.*', 'photo_categories.name as pc_name', 'photo_categories.slug as pc_slug');

    // Filter by category_id
    if (category_id !== undefined && category_id !== '' && category_id !== '0') {
      if (category_id === 'individual' || category_id === 'collage') {
        // Legacy type-based filtering
        query = query.where({ 'photos.type': category_id });
      } else if (category_id === 'uncategorized') {
        // Filter for photos with no category assigned
        query = query.whereNull('photos.category_id');
      } else {
        // Numeric category ID from photo_categories table
        const numericCategoryId = parseInt(category_id, 10);
        if (!isNaN(numericCategoryId)) {
          query = query.where({ 'photos.category_id': numericCategoryId });
        }
      }
    }

    // Keep type filter for backwards compatibility
    if (type) {
      query = query.where({ 'photos.type': type });
    }

    // Search by filename. original_filename is included because that is the
    // name printed on every card ("Original: …") — matching only the stored
    // renamed filename returned 0 results for a substring the admin can read
    // on screen. Grouped, because the feedback AND/OR conditions are appended
    // right below and a bare orWhere would leak across them.
    if (search) {
      const pattern = `%${escapeLikePattern(search)}%`;
      query = query.where((qb) => {
        qb.whereRaw(likeWithEscape('photos.filename'), [pattern])
          .orWhereRaw(likeWithEscape('photos.original_filename'), [pattern]);
      });
    }

    // Feedback filters (has likes / favorites / comments / min rating) with AND/OR logic
    const feedbackConditions = [];
    if (has_likes === 'true' || has_likes === true) {
      feedbackConditions.push(qb => qb.where('photos.like_count', '>', 0));
    }
    if (has_favorites === 'true' || has_favorites === true) {
      feedbackConditions.push(qb => qb.where('photos.favorite_count', '>', 0));
    }
    if (has_comments === 'true' || has_comments === true) {
      feedbackConditions.push(qb => qb.where('photos.comment_count', '>', 0));
    }
    if (min_rating !== undefined && min_rating !== null && min_rating !== '') {
      const minRatingNum = parseFloat(min_rating);
      if (!isNaN(minRatingNum)) {
        feedbackConditions.push(qb => qb.where('photos.average_rating', '>=', minRatingNum));
      }
    }
    // Colour-label filter (#1044). Comma-separated colours; unknown values are
    // dropped rather than passed to the query. Unlike its siblings this can't
    // read a denormalized count column — "any label" and "a GREEN label" are
    // different questions — so it runs as an EXISTS over photo_feedback,
    // which the migration-180 index covers.
    const requestedColorLabels = String(color_label || '')
      .split(',')
      .map(value => value.trim().toLowerCase())
      .filter(value => COLOR_LABELS.includes(value));
    if (requestedColorLabels.length > 0) {
      // Only the colour-label set the event's mode actually uses (#1197).
      // Switching identity_mode leaves the other set in place, and a filter
      // that matched it would return photos whose badge shows no such colour.
      const { identity_mode: identityMode } =
        await feedbackService.getEventFeedbackSettings(eventId);
      feedbackConditions.push(qb => qb.whereExists(function () {
        this.select('*')
          .from('photo_feedback')
          .whereRaw('photo_feedback.photo_id = photos.id')
          .where('photo_feedback.feedback_type', 'color_label')
          .where('photo_feedback.is_hidden', false)
          .whereIn('photo_feedback.color_label', requestedColorLabels);
        if (identityMode === 'shared') {
          this.where('photo_feedback.guest_identifier', SHARED_COLOR_LABEL_IDENTITY);
        } else {
          this.where(function () {
            this.whereNot('photo_feedback.guest_identifier', SHARED_COLOR_LABEL_IDENTITY)
              .orWhereNull('photo_feedback.guest_identifier');
          });
        }
      }));
    }
    // The same filter against the caller's OWN marks (#1044 follow-up).
    // Scoped to req.admin.id: one photographer's triage must not filter by
    // another's, even on a shared event.
    const requestedMyColorLabels = String(req.query.my_color_label || '')
      .split(',')
      .map(value => value.trim().toLowerCase())
      .filter(value => COLOR_LABELS.includes(value));
    if (requestedMyColorLabels.length > 0) {
      feedbackConditions.push(qb => qb.whereExists(function () {
        this.select('*')
          .from('photo_admin_marks')
          .whereRaw('photo_admin_marks.photo_id = photos.id')
          .where('photo_admin_marks.admin_id', req.admin.id)
          .whereIn('photo_admin_marks.color_label', requestedMyColorLabels);
      }));
    }
    if (feedbackConditions.length > 0) {
      if (logic === 'OR') {
        query = query.where(builder => {
          feedbackConditions.forEach((cond, idx) => {
            if (idx === 0) {
              cond(builder);
            } else {
              builder.orWhere(sub => cond(sub));
            }
          });
        });
      } else {
        feedbackConditions.forEach(cond => {
          query = query.where(builder => cond(builder));
        });
      }
    }

    // Sorting
    let orderByColumn = 'photos.uploaded_at';
    if (sort === 'name') {
      orderByColumn = 'photos.filename';
    } else if (sort === 'size') {
      orderByColumn = 'photos.size_bytes';
    }
    
    const photos = await query.orderBy(orderByColumn, order);
    
    // Get comment counts separately
    const commentCounts = await db('photo_feedback')
      .whereIn('photo_id', photos.map(p => p.id))
      .where('feedback_type', 'comment')
      .where('is_approved', true)
      .where('is_hidden', false)
      .groupBy('photo_id')
      .select('photo_id', db.raw('COUNT(*) as comment_count'));
    
    // Create a map for quick lookup
    const commentMap = {};
    commentCounts.forEach(c => {
      commentMap[c.photo_id] = parseInt(c.comment_count);
    });

    // Per-colour tallies for the grid badges (#1044) — one grouped query for
    // the whole page, same shape as commentMap above.
    const colorLabelMap = await feedbackService.getEventColorLabelCounts(
      parseInt(eventId, 10),
      photos.map(p => p.id),
    );

    // The caller's own marks for this page (#1044 follow-up).
    const myMarks = await photoAdminMarksService.getEventMarks(
      parseInt(eventId, 10),
      req.admin.id,
      photos.map(p => p.id),
    );
    
    res.json({
      photos: photos.map(photo => ({
        id: photo.id,
        filename: photo.filename,
        original_filename: photo.original_filename || null,
        // Use the correct admin photos router base for serving images
        url: `/admin/photos/${eventId}/photo/${photo.id}`,
        // Always expose a thumbnail URL; backend will generate on demand if missing
        thumbnail_url: `/admin/photos/${eventId}/thumbnail/${photo.id}`,
        type: photo.type,
        // Guest visibility (#172). This explicit mapper never included it,
        // so the admin grid's "Hidden" badge could never render and a photo
        // hidden from clients looked identical to a visible one (QA warning).
        visibility: photo.visibility === 'hidden' ? 'hidden' : 'visible',
        // Same omission: the grid's "Processing…" and "Failed"/Retry
        // placeholders read this, so neither could ever render either.
        processing_status: photo.processing_status || 'complete',
        category_id: photo.category_id || photo.type,
        category_name: photo.pc_name || (photo.type === 'individual' ? 'Individual Photos' : 'Collages'),
        category_slug: photo.pc_slug || photo.type,
        media_type: photo.media_type || 'image',
        mime_type: photo.mime_type || null,
        width: photo.width || null,
        height: photo.height || null,
        duration: photo.duration || null,
        size: photo.size_bytes,
        uploaded_at: photo.uploaded_at,
        // Feedback data
        has_feedback: (commentMap[photo.id] > 0 || photo.average_rating > 0 || photo.like_count > 0),
        average_rating: photo.average_rating || 0,
        comment_count: commentMap[photo.id] || 0,
        like_count: photo.like_count || 0,
        favorite_count: photo.favorite_count || 0,
        color_label_count: photo.color_label_count || 0,
        color_labels: colorLabelMap[photo.id] || {},
        dominant_color_label: dominantColorLabel(colorLabelMap[photo.id]),
        // The requesting admin's own mark — never the whole team's, and never
        // shown to guests.
        my_rating: myMarks[photo.id]?.rating ?? null,
        my_color_label: myMarks[photo.id]?.color_label ?? null,
        // Engagement counters (#895 follow-up): the grid reads these, but
        // this explicit mapper never included them — so the Engagement
        // column showed 0 regardless of what the DB counted. This, not
        // stale data, was why per-image downloads always displayed 0.
        view_count: photo.view_count || 0,
        download_count: photo.download_count || 0
      }))
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to fetch photos');
  }
});

// Serve photo with admin authentication
router.get('/:eventId/photo/:photoId', adminAuth, requirePermission('photos.view'), requireEventOwnership, async (req, res) => {
  try {
    const { eventId, photoId } = req.params;

    const photo = await db('photos')
      .where({ id: photoId, event_id: eventId })
      .first();

    if (!photo) {
      return res.status(404).json({ error: 'Photo not found' });
    }

    // Photos still in async processing don't have all metadata in the DB
    // yet; serving the original is fine, but downstream consumers (admin
    // grid lightbox) read width/height which won't be set until processing
    // completes. We let the original through here — the file is on disk —
    // but tell the caller it's not done yet via a header so they can
    // poll /uploads/:upload_id/status if they care.
    if (photo.processing_status && photo.processing_status !== 'complete') {
      res.setHeader('X-PicPeak-Photo-Status', photo.processing_status);
    }

    const { resolvePhotoFilePath, resolvePhotoStorageKey } = require('../services/photoResolver');
    const event = await db('events').where('id', eventId).first();
    const storageKey = resolvePhotoStorageKey(event, photo);

    // Content-Type resolution (#908 + external review) lives in
    // utils/photoContentType so the gallery routes apply the same rule.
    const contentType = resolvePhotoContentType(photo);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    if (storageKey) {
      const storage = getStorage();
      const stat = await storage.stat(storageKey);
      if (!stat) {
        return res.status(404).json({ error: 'Photo file not found' });
      }
      res.setHeader('Content-Length', stat.size);
      const stream = await storage.get(storageKey);
      stream.pipe(res);
      return;
    }

    // External-mode photos still live on local disk.
    const filePath = resolvePhotoFilePath(event, photo);
    try {
      await fs.access(filePath);
    } catch (error) {
      return res.status(404).json({ error: 'Photo file not found' });
    }
    res.sendFile(path.resolve(filePath));
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to serve photo');
  }
});

// Serve thumbnail with admin authentication
router.get('/:eventId/thumbnail/:photoId', adminAuth, requirePermission('photos.view'), requireEventOwnership, async (req, res) => {
  try {
    const { eventId, photoId } = req.params;
    
    const photo = await db('photos')
      .where({ id: photoId, event_id: eventId })
      .first();

    if (!photo) {
      logger.error(`Photo not found: ${photoId}, event ${eventId}`);
      return res.status(404).json({ error: 'Photo not found' });
    }

    // Async processing is still working on this one — no thumbnail yet.
    // Return 503 with Retry-After so the admin grid (which auto-refreshes
    // every 2s while any photo is non-complete) keeps the placeholder
    // until the worker catches up.
    if (photo.processing_status === 'pending' || photo.processing_status === 'processing') {
      res.setHeader('Retry-After', '2');
      return res.status(503).json({ error: 'Thumbnail not ready', status: photo.processing_status });
    }
    if (photo.processing_status === 'failed') {
      return res.status(422).json({
        error: 'Photo processing failed',
        status: 'failed',
        details: photo.processing_error || null,
      });
    }

    // Ensure thumbnail exists and is valid, regenerate if needed
    const thumbnailPath = await ensureThumbnail(photo);

    if (!thumbnailPath) {
      logger.error(`Failed to generate thumbnail for photo ${photoId}`);
      return res.status(404).json({ error: 'Thumbnail generation failed' });
    }

    res.setHeader('Content-Type', 'image/jpeg'); // Thumbnails are always JPEG
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    const storage = getStorage();
    const stat = await storage.stat(thumbnailPath);
    if (!stat) {
      return res.status(404).json({ error: 'Thumbnail not found' });
    }
    res.setHeader('Content-Length', stat.size);
    const stream = await storage.get(thumbnailPath);
    stream.pipe(res);
  } catch (error) {
    logger.error('Error serving thumbnail:', error);
    logger.error('Photo ID:', req.params.photoId);
    errorResponse(res, error, 500, 'Failed to serve thumbnail');
  }
});

/**
 * Aspect-preserved rendition for admin surfaces that need one.
 *
 * The face avatars need this specifically. faceCropStyle positions a crop by
 * scaling the WHOLE frame and offsetting so the face lands centre, which only
 * works while the rendition is the entire image at a uniform scale. Thumbnails
 * are not: thumbnail_fit is seeded to 'cover' (migration 040), so they are
 * centre-cropped and every face avatar rendered against one is silently
 * offset. Previews use fit: 'inside', so they are safe.
 *
 * ?w= is whitelisted the same way the gallery route's is — an open parameter
 * would let anyone fill the disk with renditions.
 */
router.get('/:eventId/preview/:photoId', adminAuth, requirePermission('photos.view'), requireEventOwnership, async (req, res) => {
  try {
    const { eventId, photoId } = req.params;

    const photo = await db('photos').where({ id: photoId, event_id: eventId }).first();
    if (!photo) return res.status(404).json({ error: 'Photo not found' });

    if (photo.processing_status === 'pending' || photo.processing_status === 'processing') {
      res.setHeader('Retry-After', '2');
      return res.status(503).json({ error: 'Preview not ready', status: photo.processing_status });
    }

    const { PREVIEW_WIDTHS, normalizeTierWidth, ensurePreviewImageAtWidth, ensurePreviewImage } =
      require('../services/imageProcessor');
    const tierWidth = normalizeTierWidth(req.query.w, PREVIEW_WIDTHS);

    const previewPath = tierWidth
      ? (await ensurePreviewImageAtWidth(photo, tierWidth)) || (await ensurePreviewImage(photo))
      : await ensurePreviewImage(photo);

    if (!previewPath) {
      return res.status(404).json({ error: 'Preview generation failed' });
    }

    const storage = getStorage();
    const stat = await storage.stat(previewPath);
    if (!stat) return res.status(404).json({ error: 'Preview not found' });

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Content-Length', stat.size);
    (await storage.get(previewPath)).pipe(res);
  } catch (error) {
    logger.error('Error serving admin preview:', error);
    errorResponse(res, error, 500, 'Failed to serve preview');
  }
});

// Debug endpoint to check photo existence
router.get('/:eventId/debug', adminAuth, requirePermission('photos.view'), requireEventOwnership, async (req, res) => {
  try {
    const { eventId } = req.params;
    
    const event = await db('events').where({ id: eventId }).first();
    const photoCount = await db('photos').where({ event_id: eventId }).count('id as count').first();
    const photos = await db('photos').where({ event_id: eventId }).limit(5);
    
    res.json({
      event: event || 'Not found',
      photoCount: photoCount.count,
      samplePhotos: photos,
      storagePath: getStoragePath()
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to fetch photo debug data');
  }
});

// ============================================
// CHUNKED UPLOAD ENDPOINTS
// For large file uploads (videos up to 10GB)
// ============================================

// Initialize a chunked upload
router.post('/:eventId/chunked-upload/init', adminAuth, requirePermission('photos.upload'), requireEventOwnership, async (req, res) => {
  try {
    const { eventId } = req.params;
    const { filename, fileSize, totalChunks } = req.body;

    // Validate event exists
    const event = await db('events').where({ id: eventId }).first();
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Validate required fields
    if (!filename || !fileSize) {
      return res.status(400).json({ error: 'Missing required fields: filename, fileSize' });
    }

    // The client-declared mimeType is not trusted. It used to be stored on
    // the photo row verbatim and echoed as Content-Type by the gallery
    // routes, so a JPEG/HTML polyglot declared as text/html rendered inline
    // on the app origin. The MIME is derived from the extension instead,
    // and the extension has to be on the admin's allow-list, which is what
    // the multipart path enforces through its multer fileFilter.
    const ext = path.extname(String(filename)).slice(1).toLowerCase();
    const mimeType = Object.prototype.hasOwnProperty.call(EXTENSION_TO_MIME, ext)
      ? EXTENSION_TO_MIME[ext]
      : null;
    const allowedMimeTypes = await getAllowedMimeTypes();
    if (!mimeType || !allowedMimeTypes.includes(mimeType)) {
      return res.status(400).json({ error: 'File type not allowed' });
    }

    // Validate file size against the configured per-file cap. Hardcoding 10GB
    // here let the chunked path sidestep general_max_file_size_mb entirely.
    let maxSize;
    try {
      maxSize = await getMaxFileSizeBytes();
    } catch {
      maxSize = DEFAULT_MAX_FILE_SIZE_MB * 1024 * 1024;
    }
    if (fileSize > maxSize) {
      return res.status(400).json({
        error: `File too large. Maximum size is ${Math.floor(maxSize / (1024 * 1024))} MB per file.`
      });
    }

    const result = await chunkedUpload.initializeUpload({
      filename,
      fileSize,
      mimeType,
      eventId: parseInt(eventId),
      totalChunks,
      // The declared fileSize check above is client-controlled; the service
      // enforces this cap on the bytes it actually receives and merges.
      maxFileSizeBytes: maxSize
    });

    res.json(result);
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to initialize upload');
  }
});

// Upload a chunk
router.post('/:eventId/chunked-upload/:uploadId/chunk/:chunkIndex', adminAuth, requirePermission('photos.upload'), requireEventOwnership, async (req, res) => {
  try {
    const { uploadId, chunkIndex } = req.params;

    // Get chunk data from request body
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const chunkData = Buffer.concat(chunks);

    const result = await chunkedUpload.uploadChunk(uploadId, parseInt(chunkIndex), chunkData);

    res.json(result);
  } catch (error) {
    if (error.statusCode === 413 || error.statusCode === 400) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    logger.error('Error uploading chunk:', error);
    res.status(500).json({ error: error.message || 'Failed to upload chunk' });
  }
});

// Complete chunked upload and process the file
router.post('/:eventId/chunked-upload/:uploadId/complete', adminAuth, requirePermission('photos.upload'), requireEventOwnership, async (req, res) => {
  try {
    const { eventId, uploadId } = req.params;
    const { category_id } = req.body;

    // Complete the chunked upload (merge chunks)
    const mergedFile = await chunkedUpload.completeUpload(uploadId);

    // Process the merged file as a regular upload
    const fileObj = {
      originalname: mergedFile.filename,
      mimetype: mergedFile.mimeType,
      size: mergedFile.size,
      path: mergedFile.path
    };

    const uploadedPhotos = await processUploadedPhotos(
      [fileObj],
      parseInt(eventId),
      'admin',
      category_id || null
    );

    // Clean up temp directory
    try {
      await fs.rm(mergedFile.tempDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      logger.warn('Failed to clean up temp directory:', cleanupErr.message);
    }

    res.json({
      success: true,
      uploaded: uploadedPhotos.length,
      photos: uploadedPhotos
    });
  } catch (error) {
    if (error.statusCode === 413) {
      return res.status(413).json({ error: error.message });
    }
    logger.error('Error completing chunked upload:', error);
    res.status(500).json({ error: error.message || 'Failed to complete upload' });
  }
});

// Get upload status
router.get('/:eventId/chunked-upload/:uploadId/status', adminAuth, requirePermission('photos.view'), requireEventOwnership, async (req, res) => {
  try {
    const { uploadId } = req.params;

    const status = chunkedUpload.getUploadStatus(uploadId);

    if (!status) {
      return res.status(404).json({ error: 'Upload not found or expired' });
    }

    res.json(status);
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to get upload status');
  }
});

// Abort chunked upload
router.delete('/:eventId/chunked-upload/:uploadId', adminAuth, requirePermission('photos.delete'), requireEventOwnership, async (req, res) => {
  try {
    const { uploadId } = req.params;

    await chunkedUpload.abortUpload(uploadId);

    res.json({ success: true, message: 'Upload aborted' });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to abort upload');
  }
});

module.exports = router;
