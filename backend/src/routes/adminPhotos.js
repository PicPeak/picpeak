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
const { escapeLikePattern } = require('../utils/sqlSecurity');
const { validateUploadedFiles } = require('../middleware/uploadValidation');
const { getMaxFilesPerUpload, getAllowedMimeTypes } = require('../services/uploadSettings');
const { processUploadedPhotos } = require('../services/photoProcessor');
const chunkedUpload = require('../services/chunkedUploadService');
const watermarkGeneratorService = require('../services/watermarkGeneratorService');
const downloadZipService = require('../services/downloadZipService');
const { findReplacementCandidate, replacePhoto } = require('../services/photoReplacementService');
const { requireEventOwnership } = require('../middleware/ownership');
const { getStorage } = require('../services/storage');
const router = express.Router();

// Get storage path from environment or default
const getStoragePath = () => process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');

// Configure multer for file uploads
// IMPORTANT: Using synchronous functions to prevent file corruption
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    console.log('Multer destination called for file:', file.originalname);
    const { eventId } = req.params;
    
    // We'll validate the event exists in the route handler
    // For now, just create a temp destination
    const tempPath = path.join(getStoragePath(), 'temp', `upload_${Date.now()}_${Math.random().toString(36).substring(7)}`);
    
    // Create directory synchronously
    require('fs').mkdirSync(tempPath, { recursive: true });
    console.log('Temp destination path:', tempPath);
    
    // Store temp path for cleanup
    req.tempUploadPath = tempPath;
    
    cb(null, tempPath);
  },
  filename: (req, file, cb) => {
    console.log('Multer filename called for file:', file.originalname);
    // Use a simple temporary filename
    const tempName = `temp_${Date.now()}_${Math.round(Math.random() * 1E9)}${path.extname(file.originalname)}`;
    console.log('Temp filename:', tempName);
    cb(null, tempName);
  }
});

const { validateFileType, createFileUploadValidator } = require('../utils/fileSecurityUtils');

// Create a multer instance that uses dynamically resolved allowed MIME types.
// The allowed types are fetched from the database once per request (before multer
// processes files) and attached to req.allowedMimeTypes so that the fileFilter
// callback can read them synchronously.
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 * 1024, // 10GB limit per file to support large videos
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
    console.error('Failed to resolve allowed MIME types:', error);
    req.allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
  }
  next();
};

// Dynamic content validator middleware that reads allowed types from req
const validateUploadContent = async (req, res, next) => {
  const allowedTypes = req.allowedMimeTypes || ['image/jpeg', 'image/png', 'image/webp'];
  const validator = createFileUploadValidator({
    allowedTypes,
    maxFileSize: 10 * 1024 * 1024 * 1024, // 10GB to support large videos
    validateContent: true
  });
  return validator(req, res, next);
};

// Request timeout middleware for uploads
const uploadTimeout = (timeout = 300000) => { // 5 minutes default
  return (req, res, next) => {
    // Set timeout for the request
    req.setTimeout(timeout, () => {
      console.error('Upload request timed out');
      if (!res.headersSent) {
        res.status(408).json({ error: 'Upload request timed out' });
      }
    });
    
    // Set response timeout as well
    res.setTimeout(timeout, () => {
      console.error('Upload response timed out');
    });
    
    next();
  };
};

// Upload photos for an event
// Max file count is configurable via general settings
router.post('/:eventId/upload', adminAuth, requirePermission('photos.upload'), requireEventOwnership, uploadTimeout(600000), resolveAllowedTypes, async (req, res, next) => { // 10 minute timeout
  let maxFilesPerUpload;
  try {
    maxFilesPerUpload = await getMaxFilesPerUpload();
  } catch (error) {
    console.error('Failed to resolve max files per upload:', error);
    return res.status(500).json({ error: 'Unable to determine upload limits' });
  }

  upload.array('photos', maxFilesPerUpload)(req, res, (err) => {
    if (err) {
      console.error('Multer error:', err);
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'File too large. Maximum size is 10GB per file.' });
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
  // Single cleanup site for the multer temp directory — runs on every
  // exit path (success, validation 4xx, server 5xx, multer error). The
  // previous code had three inline cleanup blocks for individual early
  // returns and missed the success path entirely, leaving an empty
  // per-request directory behind on every successful upload (#357 review).
  let tempCleanupDone = false;
  const cleanupTempDir = async () => {
    if (tempCleanupDone || !req.tempUploadPath) return;
    tempCleanupDone = true;
    try {
      await fs.rm(req.tempUploadPath, { recursive: true, force: true });
    } catch (e) {
      console.error('Failed to clean up temp upload directory:', e);
    }
  };
  res.on('finish', cleanupTempDir);
  res.on('close', cleanupTempDir);

  try {
    const { eventId } = req.params;
    const { category_id, replace_by_name } = req.body;
    const replaceByName = replace_by_name === 'true' || replace_by_name === true;

    console.log('Upload request received for event:', eventId);
    console.log('Body:', req.body);
    console.log('Files:', req.files ? req.files.length : 'none');
    console.log('File details:', req.files?.map(f => ({ name: f.originalname, size: f.size, mimetype: f.mimetype })));
    console.log('Category ID received:', category_id);

    // Verify event exists and admin has access
    const event = await db('events').where({ id: eventId }).first();
    if (!event) {
      console.error('Event not found:', eventId);
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
          const candidate = await findReplacementCandidate(parseInt(eventId), file.originalname);
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
      console.error('No files in request. req.files:', req.files);
      console.error('Request body keys:', Object.keys(req.body));
      return res.status(400).json({ error: 'No files uploaded' });
    }
    
    // Parse category_id to number if provided (handle string values like 'individual', 'collage')
    const rawParsed = category_id ? parseInt(category_id, 10) : NaN;
    const parsedCategoryId = !isNaN(rawParsed) ? rawParsed : null;

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
      const category = await db('photo_categories')
        .where({ id: parsedCategoryId })
        .andWhere(function () {
          this.where({ event_id: event.id }).orWhere('is_global', true);
        })
        .first();
      if (!category) {
        return res.status(400).json({
          error: `Unknown or out-of-scope category_id ${parsedCategoryId}`
        });
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
        const candidate = await findReplacementCandidate(parseInt(eventId), file.originalname);
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
            reason: `${candidate.count} photos share this name — uploaded as new`,
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

    // Counter base — same approximation as before. Strict uniqueness is
    // already enforced by the filename template + DB unique index, so a
    // small race here just retries a counter on conflict (rare).
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
        console.error(`Error queuing file ${file.originalname}:`, err);
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
    console.error('Error uploading photos:', error);
    // Temp directory cleanup is handled by the response finish/close
    // listeners above, regardless of which exit path fires.
    res.status(500).json({ error: 'Failed to upload photos' });
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
      console.error('Error reading upload status:', error);
      res.status(500).json({ error: 'Failed to read upload status' });
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
        console.error('Upload stream poll error:', e);
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

      // Editor role: only allow retry on photos in events they own.
      if (req.admin.roleName === 'editor') {
        const event = await db('events')
          .where({ id: photo.event_id, created_by: req.admin.id })
          .first();
        if (!event) return res.status(404).json({ error: 'Photo not found' });
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
      console.error('Error retrying photo processing:', error);
      res.status(500).json({ error: 'Failed to retry photo processing' });
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
      console.error('Error deleting photo file:', error);
    }

    // photo.thumbnail_path is stored as the canonical storage key
    // (e.g. "thumbnails/thumb_foo.jpg"), so pass it through verbatim.
    if (photo.thumbnail_path) {
      try {
        await storage.delete(photo.thumbnail_path);
      } catch (error) {
        console.error('Error deleting thumbnail:', error);
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

    // Delete pre-generated watermark if exists
    if (photo.watermark_path) {
      await watermarkGeneratorService.deleteForPhoto(photo.id);
    }

    // Remove from database
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
    console.error('Error deleting photo:', error);
    res.status(500).json({ error: 'Failed to delete photo' });
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
      // Handle numeric category IDs from photo_categories table
      const numericCategoryId = parseInt(category_id, 10);
      if (!isNaN(numericCategoryId)) {
        updateData.category_id = numericCategoryId;
      } else {
        updateData.category_id = null;
      }
    }

    // Update photo
    await db('photos')
      .where({ id: photoId, event_id: eventId })
      .update(updateData);

    // Fetch and return the updated photo
    const updatedPhoto = await db('photos')
      .where({ id: photoId, event_id: eventId })
      .first();

    res.json({
      message: 'Photo updated successfully',
      photo: updatedPhoto
    });
  } catch (error) {
    console.error('Error updating photo:', error);
    res.status(500).json({ error: 'Failed to update photo' });
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
        console.error('Error deleting photo file:', error);
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
      if (photo.watermark_path) {
        await watermarkGeneratorService.deleteForPhoto(photo.id);
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
    console.error('Error bulk deleting photos:', error);
    res.status(500).json({ error: 'Failed to delete photos' });
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
        const numericCategoryId = parseInt(updates.category_id, 10);
        if (!isNaN(numericCategoryId)) {
          updateData.category_id = numericCategoryId;
        } else {
          updateData.category_id = null;
        }
      }
    }

    await db('photos')
      .whereIn('id', photoIds)
      .where('event_id', eventId)
      .update(updateData);

    res.json({ message: `${photoIds.length} photos updated successfully` });
  } catch (error) {
    console.error('Error bulk updating photos:', error);
    res.status(500).json({ error: 'Failed to update photos' });
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
        'Content-Type': photo.mime_type || 'application/octet-stream',
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
      'Content-Type': photo.mime_type || 'application/octet-stream',
      'Content-Disposition': contentDisposition,
    });
    res.sendFile(filePath);
  } catch (error) {
    console.error('Error downloading photo:', error);
    res.status(500).json({ error: 'Failed to download photo' });
  }
});

// Get all photos for an event
router.get('/:eventId/photos', adminAuth, requirePermission('photos.view'), requireEventOwnership, async (req, res) => {
  try {
    const { eventId } = req.params;
    const { category_id, type, search, sort = 'date', has_likes, has_favorites, has_comments, min_rating } = req.query;
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

    // Search by filename
    if (search) {
      const escapedSearch = escapeLikePattern(search);
      query = query.where('photos.filename', 'like', `%${escapedSearch}%`);
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
        favorite_count: photo.favorite_count || 0
      }))
    });
  } catch (error) {
    console.error('Error fetching photos:', error);
    res.status(500).json({ error: 'Failed to fetch photos' });
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

    res.setHeader('Content-Type', `image/${path.extname(photo.filename).slice(1)}`);
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
    console.error('Error serving photo:', error);
    res.status(500).json({ error: 'Failed to serve photo' });
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
      console.error(`Photo not found: ${photoId}, event ${eventId}`);
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
      console.error(`Failed to generate thumbnail for photo ${photoId}`);
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
    console.error('Error serving thumbnail:', error);
    console.error('Photo ID:', req.params.photoId);
    console.error('Event ID:', req.params.eventId);
    res.status(500).json({ error: 'Failed to serve thumbnail' });
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
    console.error('Error fetching admin photo debug data:', error);
    res.status(500).json({ error: 'Failed to fetch photo debug data' });
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
    const { filename, fileSize, mimeType, totalChunks } = req.body;

    // Validate event exists
    const event = await db('events').where({ id: eventId }).first();
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Validate required fields
    if (!filename || !fileSize || !mimeType) {
      return res.status(400).json({ error: 'Missing required fields: filename, fileSize, mimeType' });
    }

    // Validate file size (max 10GB)
    const maxSize = 10 * 1024 * 1024 * 1024;
    if (fileSize > maxSize) {
      return res.status(400).json({ error: `File too large. Maximum size is 10GB.` });
    }

    const result = await chunkedUpload.initializeUpload({
      filename,
      fileSize,
      mimeType,
      eventId: parseInt(eventId),
      totalChunks
    });

    res.json(result);
  } catch (error) {
    console.error('Error initializing chunked upload:', error);
    res.status(500).json({ error: 'Failed to initialize upload' });
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
    console.error('Error uploading chunk:', error);
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
      console.warn('Failed to clean up temp directory:', cleanupErr.message);
    }

    res.json({
      success: true,
      uploaded: uploadedPhotos.length,
      photos: uploadedPhotos
    });
  } catch (error) {
    console.error('Error completing chunked upload:', error);
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
    console.error('Error getting upload status:', error);
    res.status(500).json({ error: 'Failed to get upload status' });
  }
});

// Abort chunked upload
router.delete('/:eventId/chunked-upload/:uploadId', adminAuth, requirePermission('photos.delete'), requireEventOwnership, async (req, res) => {
  try {
    const { uploadId } = req.params;

    await chunkedUpload.abortUpload(uploadId);

    res.json({ success: true, message: 'Upload aborted' });
  } catch (error) {
    console.error('Error aborting upload:', error);
    res.status(500).json({ error: 'Failed to abort upload' });
  }
});

module.exports = router;
