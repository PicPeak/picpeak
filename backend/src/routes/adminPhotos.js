const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { db, logActivity } = require('../database/db');
const { livePhotos } = require('../utils/photoVisibility');
const { RECOVERABLE_PASSWORD_COLUMNS } = require('./adminEvents/helpers');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { ensureThumbnail } = require('../services/imageProcessor');
const { isVideoMimeType } = require('../services/videoProcessor');
const { acceptedUpload, capabilityEvidence } = require('../usage/capabilityEvidence');
const { generatePhotoFilename, buildContentDisposition } = require('../utils/filenameSanitizer');
const {
  getUseOriginalFilenames,
  pickRawDownloadName,
} = require('../services/downloadFilenameService');
const { escapeLikePattern, likeWithEscape } = require('../utils/sqlSecurity');
const { COLOR_LABELS, dominantColorLabel, SHARED_COLOR_LABEL_IDENTITY } = require('../constants/colorLabels');
const { normalizeDecisionFilter, whereDecision } = require('../utils/photoFilterBuilder');
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
const { adminThumbnailUrl, adminThumbnailVersion } = require('../utils/adminThumbnailUrl');
const { IS_VIDEO_SQL, IS_PHOTO_SQL } = require('../utils/mediaTypeSql');
const { captureDateOrderSql } = require('../utils/captureDateSql');
const { toIso, toServerWallClock, cameraWallClock } = require('../utils/dateNormalize');
const { parseStoredExif } = require('../services/photoExif');
const { originalNeedsPreview } = require('../utils/rawFormats');
const { processUploadedPhotos } = require('../services/photoProcessor');
const chunkedUpload = require('../services/chunkedUploadService');
const downloadZipService = require('../services/downloadZipService');
const { findReplacementCandidate, replacePhoto } = require('../services/photoReplacementService');
const { requireEventOwnership, canAccessEvent } = require('../middleware/ownership');
const { mayReviewUploads, adminUploadColumns, moderatePhotos, moderationCounts, MODERATION_STATUSES, MAX_MODERATION_IDS } = require('../services/uploadReviewService');
const { getStorage } = require('../services/storage');
const photoTrash = require('../services/photoTrash');
const { pipeStreamToResponse, answerVanished } = require('../utils/streamResponse');
const { errorResponse } = require('../utils/routeHelpers');
const { withPublicUpload } = require('../middleware/publicUploadStream');
const { createUploadFileGuard } = require('../utils/uploadAdmissionType');
const uploadQuota = require('../services/publicUploadQuota');
const logger = require('../utils/logger');
const router = express.Router();

// Filename order for the photo list: digit runs compare as numbers.
const NATURAL_NAME_ORDER = new Intl.Collator('en', { numeric: true });

// Get storage path from environment or default
const { getStoragePath } = require('../config/storage');

// Category ids are resolved within one event's scope (#500 / #525); shared
// with the gallery upload route.
const { outOfScopeCategoryError, resolveCategoryAssignment } = require('../utils/categoryScope');
const { parseBooleanInput } = require('../utils/parsers');
const { resolveUploadPlacement, placementColumns, afterUploadPlacement } = require('../services/uploadPlacement');

/** `folder_id` from a request as a photo column: a folder of this event, or null for the root. */
async function folderIdUpdate(eventId, raw) {
  // null, '' and 0 mean the gallery root; anything else that is not a
  // positive integer is refused rather than silently moving to the root.
  if (raw === null || raw === undefined || raw === '' || raw === 0 || raw === '0') return { folder_id: null };
  const isWhole = (typeof raw === 'number' && Number.isSafeInteger(raw)) || (typeof raw === 'string' && /^\d{1,10}$/.test(raw));
  const id = isWhole ? Number(raw) : NaN;
  if (!(id > 0 && id <= 2147483647)) return { error: `Invalid folder_id ${JSON.stringify(raw)}` };
  const folder = await require('../services/folderTreeService').findEventFolder(eventId, id);
  if (!folder) return { error: `Unknown folder_id ${id}` };
  return { folder_id: id };
}
const { photoCapOf, countEventPhotos, insertPhotoWithinCap, photoCapError } = require('../services/photoCap');
const { claimPromotion } = require('../services/watchFolderClaims');
const { manualCreditFields, CREDIT_NONE } = require('../services/photoCredit');
const { sha256File, findDuplicate, duplicateName } = require('../services/photoDuplicates');


const { validateFileType, validateFileContent, createFileUploadValidator, normalizeUploadMimeType, isRawUploadFilename } = require('../utils/fileSecurityUtils');

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
//
// The handler reads a few short text fields (category_id, the folder
// placement, replace_by_name, match_mode, detect_duplicates). Busboy buffers every text part in memory before the handler
// runs, so without `fields`/`fieldSize`/`parts` sized to that a caller with
// photos.upload could send thousands of multi-megabyte text parts and hold
// them all on the heap.
const UPLOAD_TEXT_FIELDS = 7;
const createUpload = (maxFileSizeBytes, maxFiles, { storage, streamHandler, rejectBody }) => multer({
  storage,
  streamHandler,
  defParamCharset: 'utf8', // multer's latin1 default turns UTF-8 names into mojibake
  limits: {
    fileSize: maxFileSizeBytes,
    files: maxFiles,
    fields: UPLOAD_TEXT_FIELDS,
    fieldSize: 1024,
    parts: maxFiles + UPLOAD_TEXT_FIELDS,
    headerPairs: 2000,
    // CVE-2026-82333: files arrive as repeated `photos` parts via
    // multer's own .array('photos', N) — not bracket-indexed field names
    // like `photos[0]` — so no legitimate field name uses array-index
    // syntax at all. Reject any that do.
    fieldArrayIndexLimit: 0
  },
  fileFilter: (req, file, cb) => {
    // req.allowedMimeTypes is populated by the middleware that runs before multer
    const allowedMimeTypes = req.allowedMimeTypes || ['image/jpeg', 'image/png', 'image/webp'];
    // Assigned, not just compared: multer copies this object into req.files,
    // so the content validator and the stored mime_type see the canonical type.
    file.mimetype = normalizeUploadMimeType(file.originalname, file.mimetype);

    if (validateFileType(file.originalname, file.mimetype, allowedMimeTypes)) {
      return cb(null, true);
    } else {
      const error = new Error('Invalid file type. Check allowed file types in system settings.');
      rejectBody(error);
      cb(error);
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

  // The storage guard already enforces per-kind caps while streaming. Keep
  // this check and full signature validation as a downstream backstop.
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

// Both mounted admin aliases share this raw-body and persistent admission.
router.post('/:eventId/upload', adminAuth, requirePermission('photos.upload'), requireEventOwnership, resolveAllowedTypes, async (req, res) => {
  const eventId = Number(req.params.eventId);
  if (!/^\d+$/.test(req.params.eventId) || !Number.isSafeInteger(eventId) || eventId < 1) {
    if (!req.readableEnded) res.set('Connection', 'close');
    return res.status(404).json({ error: 'Event not found' });
  }
  // SQLite accepts exponential numeric strings in a lookup, while parseInt
  // interprets them differently. Every downstream consumer must use one id.
  req.params.eventId = String(eventId);
  let maxFilesPerUpload;
  try {
    [maxFilesPerUpload, req.maxFileSizeBytes, req.maxVideoSizeBytes] = await Promise.all([
      getMaxFilesPerUpload(), getMaxFileSizeBytes(), getMaxVideoSizeBytes(),
    ]);
  } catch (error) {
    return errorResponse(res, error, 500, 'Unable to determine upload limits');
  }
  await withPublicUpload(req, res, {
    eventId, mode: 'admin', accountId: req.admin.id, maxFiles: maxFilesPerUpload, fileField: 'photos',
    maxFileBytes: Math.max(req.maxFileSizeBytes, req.maxVideoSizeBytes),
    fileExtension: file => path.extname(file.originalname).toLowerCase(),
    fileGuard: file => createUploadFileGuard(file, req.maxFileSizeBytes, req.maxVideoSizeBytes),
    formatError: err => ({
      status: 400,
      body: { error: err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE'
        ? `Too many files. Maximum ${maxFilesPerUpload} files per upload.`
        : err.code === 'LIMIT_FILE_SIZE'
          ? `File too large. Maximum size is ${Math.floor(Math.max(req.maxFileSizeBytes, req.maxVideoSizeBytes) / (1024 * 1024))} MB per file.`
          : err instanceof multer.MulterError ? `Upload error: ${err.message}`
            : 'Invalid file type. Check allowed file types in system settings.' },
    }),
  }, options => createUpload(Math.max(req.maxFileSizeBytes, req.maxVideoSizeBytes), options.maxFiles, options).array('photos', options.maxFiles),
  async (_session, reply) => {
    // Each file's place among the request's `photos` parts, noted before the
    // validation below drops any: a duplicate is reported by it, since two
    // files of one request can share a name (issue 1733, C2).
    (req.files || []).forEach((file, index) => { file.requestIndex = index; });
    let proceed = false;
    await validateUploadContent(req, reply, () => { proceed = true; });
    if (!proceed) return;
    proceed = false;
    await validateUploadedFiles(req, reply, () => { proceed = true; });
    if (proceed) await handleAdminPhotoUpload(req, reply);
  });
});

async function handleAdminPhotoUpload(req, res) {
  try {
    const { eventId } = req.params;
    const { category_id, replace_by_name, match_mode, detect_duplicates } = req.body;
    // Opt-in per request (issue 1733, C2): with it a file whose bytes this
    // gallery already holds is reported back instead of stored again. Without
    // it every file is stored, as before the check existed.
    const detectDuplicates = detect_duplicates === 'true' || detect_duplicates === true;
    let replaceByName = replace_by_name === 'true' || replace_by_name === true;
    // How replace_by_name finds its target (#745). 'exact' is the historical
    // behaviour and stays the default; 'number_token' matches on the trailing
    // digit run so a render renamed in Lightroom still lands on its proof.
    // Anything else falls back to 'exact' rather than erroring — an unknown
    // mode must not silently widen the match.
    const matchMode = match_mode === 'number_token' ? 'number_token' : 'exact';

    logger.info('Upload request received for event:', eventId);
    logger.info('Body fields:', Object.keys(req.body || {}));
    logger.info('Files:', req.files ? req.files.length : 'none');
    logger.info('File details:', req.files?.map(f => ({ name: f.originalname, size: f.size, mimetype: f.mimetype })));
    logger.info('Category ID received:', category_id);

    // Verify event exists and admin has access
    const event = await db('events').where({ id: eventId }).first();
    if (!event) {
      logger.error('Event not found:', eventId);
      return res.status(404).json({ error: 'Event not found' });
    }
    // The uploading account, and hidden + pending for a team member whose
    // uploads are reviewed (issue 743). Such an upload never replaces a
    // photo: that would change a published photo without the review.
    // Matching files are uploaded as new photos and wait like the rest.
    const uploadColumns = await adminUploadColumns(req.admin, event);
    if (uploadColumns.moderation_status) replaceByName = false;

    // Enforce photo cap if set (replacements don't count as new)
    if (event.photo_cap && event.photo_cap > 0) {
      const existingPhotoCount = await livePhotos(db)
        .where({ event_id: eventId })
        .count('id as count')
        .first();
      const currentCount = parseInt(existingPhotoCount.count) || 0;
      let newFilesCount = (req.files && req.files.length) || 0;
      // Subtract likely replacements from cap calculation, and with
      // detect_duplicates the files that will be skipped as duplicates: of
      // the gallery, or of an earlier file of this request. Otherwise a batch
      // that fits once they are skipped is refused, and a duplicate-only
      // upload at the cap never gets its duplicate report. Replacements run
      // before the new files, so the bytes they bring in count as held too.
      // An estimate like the replacement count; insertPhotoWithinCap below is
      // what holds the cap.
      if ((replaceByName || detectDuplicates) && req.files) {
        const seenHashes = new Set();
        const newFiles = [];
        for (const file of req.files) {
          const candidate = replaceByName ? await findReplacementCandidate(
            parseInt(eventId), file.originalname, { matchMode }
          ) : null;
          if (!candidate || candidate.ambiguous) { newFiles.push(file); continue; }
          newFilesCount--;
          if (detectDuplicates) seenHashes.add(await sha256File(file.path));
        }
        for (const file of detectDuplicates ? newFiles : []) {
          file.contentSha256 = await sha256File(file.path);
          if (seenHashes.has(file.contentSha256) || await findDuplicate(event.id, file.contentSha256)) newFilesCount--;
          seenHashes.add(file.contentSha256);
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
    // Folder, folder request and first-look flag of this batch (issues 1786,
    // 1562); also maps a folder sent as category_id onto folder_id.
    const { placement, category: resolvedCategory, error: placementError } = await resolveUploadPlacement(event.id, req.body);
    if (placementError) {
      return res.status(400).json(placementError);
    }
    if (parsedCategoryId && !isNaN(parsedCategoryId)) {
      const category = resolvedCategory;
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
    const duplicates = [];
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
            uploadReservation: req.publicUploadReservation,
          });
          if (result.success) {
            capabilityEvidence(res, 'photo_replacement');
            acceptedUpload(res, {
              video: isVideoMimeType(file.mimetype),
              raw: isRawUploadFilename(file.originalname),
              s3: process.env.STORAGE_BACKEND === 's3'
            });
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
    // Trashed photos count too: their filenames are still taken.
    const existingCount = await db('photos')
      .where({ event_id: eventId, type: photoType })
      .count('id as count')
      .first();
    let counter = (parseInt(existingCount.count) || 0) + 1;
    const storage = getStorage();

    const imageAdmission = require('../services/imageWorkAdmission');
    const preparedImages = await imageAdmission.prepareBatch(filesToUpload, req.publicUploadReservation?.signal);
    for (const file of filesToUpload) {
      let object;
      let promotionSettled = false;
      let releaseClaim = null;
      try {
        const tempStats = await fs.stat(file.path);
        if (tempStats.size === 0) {
          throw new Error('File is empty - upload may have been interrupted');
        }

        // Hashed here, while the file is still local and before anything is
        // stored or queued: this response is the only place the uploader
        // hears about the file again. Same gallery only.
        const contentSha256 = file.contentSha256 || await sha256File(file.path);
        const existing = detectDuplicates ? await findDuplicate(event.id, contentSha256) : null;
        if (existing) {
          await fs.unlink(file.path).catch(() => {});
          duplicates.push({ index: file.requestIndex, filename: file.originalname, duplicate_of: duplicateName(existing) });
          continue;
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

        if (!isVideo) await imageAdmission.inspect(file.path, newFilename, req.publicUploadReservation?.signal, preparedImages);

        // 1. Move file to its final storage key first. If the worker
        //    later picks up the photo row, the file is guaranteed to
        //    exist at the recorded path.
        object = await uploadQuota.prepareObject(req.publicUploadReservation, finalKey, tempStats.size);
        // Held until the row exists, so the file watcher does not import
        // the file first (issue 1970).
        releaseClaim = claimPromotion(finalKey);
        await storage.putFromFile(finalKey, file.path, {
          contentType: file.mimetype,
        });
        promotionSettled = true;
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
        const photoData = {
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
          ...placementColumns(placement),
          size_bytes: tempStats.size,
          content_sha256: contentSha256,
          captured_at: null,
          media_type: isVideo ? 'video' : 'image',
          mime_type: file.mimetype,
          processing_status: 'pending',
          upload_id: uploadId,
          // Explicit rather than the column default (#1561); the worker
          // reads the EXIF credit for admin rows.
          uploaded_by: 'admin',
          // The uploading account, and hidden + pending under review
          // (issue 743), resolved once above.
          ...uploadColumns,
        };
        const photoId = await uploadQuota.commitObject(object, 'photo', async conn => {
          const inserted = await insertPhotoWithinCap(photoData, photoCapOf(event), conn);
          if (!inserted) throw new Error('Photo cap reached');
          return inserted[0]?.id || inserted[0];
        });

        acceptedUpload(res, { video: isVideo, raw: isRawUploadFilename(file.originalname), s3: process.env.STORAGE_BACKEND === 's3' });

        uploadedPhotos.push({
          id: photoId,
          filename: newFilename,
          size: tempStats.size,
          category_id: placement.category_id,
          folder_id: placement.folder_id,
          media_type: isVideo ? 'video' : 'image',
        });
      } catch (err) {
        if (object) {
          try { await uploadQuota.failedObject(object, { storage, settled: promotionSettled }); }
          catch (cleanupError) {
            logger.warn('Admin upload object cleanup failed; charge retained', { objectId: object.id, error: cleanupError.message });
          }
        }
        logger.error(`Error queuing file ${file.originalname}:`, err);
        errors.push({ filename: file.originalname, error: err.message,
          ...require('../services/imageResourcePolicy').describe(err) });
      } finally {
        releaseClaim?.();
      }
    }
    
    // Log activity
    // The type split lets the activity line say "2 videos" instead of
    // "2 photos" for a video upload (issue 1430, item 3).
    const videoCount = uploadedPhotos.filter((p) => p.media_type === 'video').length;
    // Nothing stored and nothing replaced (every file a duplicate or
    // refused) is not an upload to log (issue 2086).
    if (uploadedPhotos.length > 0 || replacedPhotos.length > 0) {
      await logActivity('photos_uploaded',
        {
          count: uploadedPhotos.length,
          photoCount: uploadedPhotos.length - videoCount,
          videoCount,
          replacedCount: replacedPhotos.length,
          eventName: event.event_name,
        },
        eventId,
        { type: 'admin', id: req.admin.id, name: req.admin.username }
      );
    }

    await afterUploadPlacement(eventId, placement, uploadedPhotos.length,
      { type: 'admin', id: req.admin.id, name: req.admin.username });

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
      // Not stored: this gallery already holds the same bytes. Kept apart
      // from `errors`, the uploader offers "upload anyway" for these; `index`
      // is the file's place among the request's `photos` parts. Always
      // empty unless the request asked for detect_duplicates.
      duplicates,
      duplicateCount: duplicates.length,
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
    // The stream wrapper waits for actual writers/promotions before cleanup.
    errorResponse(res, error, 500, 'Failed to upload photos');
  }
}

// Helper — load the upload group + verify the requesting admin owns the
// underlying event. Returns { event, photos } or sends a 4xx response.
async function loadUploadGroup(req, res) {
  const { upload_id: uploadId } = req.params;
  if (!uploadId || typeof uploadId !== 'string' || uploadId.length > 64) {
    res.status(400).json({ error: 'Invalid upload_id' });
    return null;
  }

  const photos = await livePhotos(db).where({ upload_id: uploadId });
  if (photos.length === 0) {
    res.status(404).json({ error: 'Upload group not found' });
    return null;
  }

  const eventId = photos[0].event_id;
  // Upload status lists the event's photo filenames, so it follows the same
  // rule as the photo routes: 404 unless the admin can act on the event.
  const event = await db('events').where('id', eventId).first();
  if (!event || !canAccessEvent(req.admin, event)) {
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
        const photos = await livePhotos(db).where({ upload_id: group.uploadId });
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
      const photo = await livePhotos(db).where({ id: req.params.photoId }).first();
      if (!photo) return res.status(404).json({ error: 'Photo not found' });

      // Ownership: the rule requireEventOwnership enforces, which can't run
      // here because the route is keyed by photo, not by event. Previously
      // this checked the editor role alone, leaving admin-role users able to
      // reprocess another admin's photos.
      const event = await db('events').where({ id: photo.event_id }).first();
      if (event && !canAccessEvent(req.admin, event)) {
        return res.status(404).json({ error: 'Photo not found' });
      }

      // 'failed', or complete with a note: a video that got the placeholder
      // tile is a usable row whose poster frame is still owed (issue 1430,
      // item 6). Anything else is in flight or has nothing to redo.
      const retryable = photo.processing_status === 'failed'
        || ((photo.processing_status || 'complete') === 'complete' && !!photo.processing_error);
      if (!retryable) {
        return res.status(409).json({
          error: `Photo is in '${photo.processing_status}' state and cannot be retried`,
        });
      }

      await livePhotos(db).where({ id: photo.id }).update({
        processing_status: 'pending',
        processing_error: null,
        processing_started_at: null,
        // An explicit retry starts a new attempt cycle, due at once.
        processing_attempts: 0,
        processing_retry_at: null,
        // A worker still holding the old attempt can no longer write.
        processing_attempt_id: null,
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
    const photo = await livePhotos(db)
      .where({ id: photoId, event_id: eventId })
      .first();
    
    if (!photo) {
      return res.status(404).json({ error: 'Photo not found' });
    }
    
    const event = await db('events').where({ id: eventId }).first();

    // The trash (issue 1733): with a retention the photo is only flagged and
    // stays restorable; 0 days deletes it outright, as before the trash.
    const retentionDays = await photoTrash.getRetentionDays();
    const trashed = retentionDays > 0;
    if (trashed) {
      if (!(await photoTrash.trashPhoto(photo, req.admin.id, retentionDays))) {
        return res.status(404).json({ error: 'Photo not found' });
      }
    } else {
      await photoTrash.deletePhotoForGood(event, photo);
    }

    // Log activity (event was fetched above for storage key resolution)
    await logActivity('photo_deleted',
      { filename: photo.filename, eventName: event.event_name, trashed },
      eventId,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );

    // Webhook (#327): single-photo delete. It fires here, when the photo
    // leaves the gallery, and not again when the trash is purged.
    try {
      const webhookService = require('../services/webhookService');
      await webhookService.fire('photo.deleted', {
        event: { id: parseInt(eventId, 10), slug: event?.slug, event_name: event?.event_name },
        photo: { id: parseInt(photoId, 10), filename: photo.filename },
      });
    } catch (e) { /* non-fatal */ }

    downloadZipService.invalidate(parseInt(eventId));
    res.json({
      message: trashed ? 'Photo moved to trash' : 'Photo deleted successfully',
      trashed: trashed ? 1 : 0,
      deleted: trashed ? 0 : 1,
      retention_days: retentionDays,
    });
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
    const photo = await livePhotos(db)
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

    capabilityEvidence(res, 'photo_admin_marks');
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
    const photo = await livePhotos(db)
      .where({ id: photoId, event_id: eventId })
      .first();

    if (!photo) {
      return res.status(404).json({ error: 'Photo not found' });
    }

    // Prepare update data
    const updateData = {};

    // Photo sales: per-photo price override for priced
    // galleries. null/empty clears the override and falls back to the
    // gallery default; an explicit value replaces it.
    if (Object.prototype.hasOwnProperty.call(req.body, 'photo_price')) {
      const raw = req.body.photo_price;
      if (raw === null || raw === '' || raw === undefined) {
        updateData.photo_price = null;
      } else {
        const price = Number(raw);
        if (!Number.isFinite(price) || price < 0) {
          return res.status(400).json({ error: 'photo_price must be a non-negative number' });
        }
        updateData.photo_price = Math.round(price * 100) / 100;
      }
    }

    // Handle visibility update (#172)
    if (visibility !== undefined) {
      if (['visible', 'hidden'].includes(visibility)) {
        // A photo under review (issue 743) is published by approving it
        // (POST /photos/moderation), which only the owner can do.
        if (visibility === 'visible' && photo.moderation_status) {
          return res.status(409).json({ error: 'This photo is waiting for review. Approve it to publish it.', code: 'PHOTO_UNDER_REVIEW' });
        }
        updateData.visibility = visibility;
      }
    }

    // Handle type-based categories ('individual' or 'collage')
    // These are string values that map to the photo.type field
    if (category_id === 'individual' || category_id === 'collage') {
      updateData.type = category_id;
      updateData.category_id = null; // Clear legacy category_id
    } else if (category_id === undefined && Object.prototype.hasOwnProperty.call(req.body, 'folder_id')) {
      // A folder move alone (issue 1786) leaves the filter category alone.
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
        const assignment = await resolveCategoryAssignment(parseInt(eventId, 10), numericCategoryId);
        if (!assignment) {
          return res.status(400).json(outOfScopeCategoryError(numericCategoryId));
        }
        // A folder sent as category_id (pre-migration-265 client) moves the
        // photo into that folder and leaves its filter category alone.
        if (assignment.folder_id) updateData.folder_id = assignment.folder_id;
        else updateData.category_id = numericCategoryId;
      } else {
        updateData.category_id = null;
      }
    }

    // Folder (issue 1786): null/0 = gallery root.
    if (Object.prototype.hasOwnProperty.call(req.body, 'folder_id')) {
      const folderUpdate = await folderIdUpdate(parseInt(eventId, 10), req.body.folder_id);
      if (folderUpdate.error) return res.status(400).json({ error: folderUpdate.error });
      updateData.folder_id = folderUpdate.folder_id;
      updateData.pending_folder_request_id = null;
    }

    // A human just set (or cleared) this category, so it is no longer an
    // automatic assignment (#1074 phase 3). Without resetting the flag,
    // "undo automatic categories" would later wipe the photographer's own
    // choice — exactly the guarantee the rule engine advertises.
    updateData.auto_categorized = false;

    // Update photo
    await livePhotos(db)
      .where({ id: photoId, event_id: eventId })
      .update(updateData);

    // A visibility or category change alters which photos belong in the
    // guest download bundle — drop the cached ZIP so it rebuilds fresh,
    // otherwise a hide→unhide cycle can leave the stale cache omitting
    // photos added in between (codex review).
    if (updateData.visibility !== undefined
        || Object.prototype.hasOwnProperty.call(updateData, 'category_id')
        || Object.prototype.hasOwnProperty.call(updateData, 'folder_id')
        || Object.prototype.hasOwnProperty.call(updateData, 'type')) {
      downloadZipService.invalidate(parseInt(eventId, 10));
    }

    // Fetch and return the updated photo
    const updatedPhoto = await livePhotos(db)
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
    const photos = await livePhotos(db)
      .whereIn('id', photoIds)
      .where('event_id', eventId);
    
    if (photos.length === 0) {
      return res.status(404).json({ error: 'No photos found' });
    }
    
    const event = await db('events').where({ id: eventId }).first();

    // The trash (issue 1733), as in the single delete. `gone` are the photos
    // this request took out of the gallery; one that another request got to
    // first is not reported twice.
    const retentionDays = await photoTrash.getRetentionDays();
    const trashed = retentionDays > 0;
    const gone = [];
    const failedIds = [];
    for (const photo of photos) {
      try {
        if (!trashed) await photoTrash.deletePhotoForGood(event, photo);
        else if (!(await photoTrash.trashPhoto(photo, req.admin.id, retentionDays))) continue;
        gone.push(photo);
      } catch (error) {
        logger.error(`bulk delete: could not delete photo ${photo.id}`, { error: error.message });
        failedIds.push(photo.id);
      }
    }
    if (gone.length === 0 && failedIds.length > 0) {
      return res.status(500).json({ error: 'Failed to delete photos', failed: failedIds });
    }

    // Webhook (#327): one photo.deleted per row in the bulk batch, trashed
    // or deleted outright.
    try {
      const webhookService = require('../services/webhookService');
      for (const photo of gone) {
        await webhookService.fire('photo.deleted', {
          event: { id: parseInt(eventId, 10), slug: event?.slug, event_name: event?.event_name },
          photo: { id: photo.id, filename: photo.filename },
        });
      }
    } catch (e) { /* non-fatal */ }

    // Log activity
    await logActivity('photos_bulk_deleted',
      { count: gone.length, eventName: event.event_name, trashed: trashed ? gone.length : 0 },
      eventId,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );
    
    downloadZipService.invalidate(parseInt(eventId));
    res.json({
      message: `${gone.length} photos deleted successfully`,
      trashed: trashed ? gone.length : 0,
      deleted: trashed ? 0 : gone.length,
      failed: failedIds,
      retention_days: retentionDays,
    });
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
    const photoCount = await livePhotos(db)
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
          const assignment = await resolveCategoryAssignment(parseInt(eventId, 10), numericCategoryId);
          if (!assignment) {
            return res.status(400).json(outOfScopeCategoryError(numericCategoryId));
          }
          if (assignment.folder_id) updateData.folder_id = assignment.folder_id;
          else updateData.category_id = numericCategoryId;
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

    // Folder (issue 1786): move many photos at once; null/0 = gallery root.
    if (Object.prototype.hasOwnProperty.call(updates, 'folder_id')) {
      const folderUpdate = await folderIdUpdate(parseInt(eventId, 10), updates.folder_id);
      if (folderUpdate.error) return res.status(400).json({ error: folderUpdate.error });
      updateData.folder_id = folderUpdate.folder_id;
      updateData.pending_folder_request_id = null;
    }

    // Credit (#1561): correct or clear a name on many photos at once — the
    // joke name a guest used on 40 uploads is the case this exists for.
    if (Object.prototype.hasOwnProperty.call(updates, 'credit_name')) {
      const creditFields = manualCreditFields(updates.credit_name);
      if (creditFields.error) {
        return res.status(400).json({ error: creditFields.error });
      }
      Object.assign(updateData, creditFields);
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    // Photos under review (issue 743) keep their visibility: only approving
    // them (POST /photos/moderation) publishes them. They are counted back to
    // the caller rather than failing the whole selection.
    const { visibility: visibilityUpdate, ...otherUpdates } = updateData;
    let skippedUnderReview = 0;
    if (Object.keys(otherUpdates).length > 0) {
      await livePhotos(db)
        .whereIn('id', photoIds)
        .where('event_id', eventId)
        .update(otherUpdates);
    }
    if (visibilityUpdate !== undefined) {
      // Counted, not derived from the update's row count: PostgreSQL leaves an
      // unchanged row out of it, and foreign ids are not "under review".
      const [{ count }] = await livePhotos(db)
        .whereIn('id', photoIds)
        .where('event_id', eventId)
        .whereNotNull('moderation_status')
        .count('id as count');
      skippedUnderReview = Number(count) || 0;
      await livePhotos(db)
        .whereIn('id', photoIds)
        .where('event_id', eventId)
        .whereNull('moderation_status')
        .update({ visibility: visibilityUpdate });
    }

    // Visibility/category changes alter the guest download bundle — drop the
    // cached ZIP so it rebuilds fresh (codex review).
    if (updateData.visibility !== undefined
        || Object.prototype.hasOwnProperty.call(updateData, 'category_id')
        || Object.prototype.hasOwnProperty.call(updateData, 'folder_id')
        || Object.prototype.hasOwnProperty.call(updateData, 'type')) {
      downloadZipService.invalidate(parseInt(eventId, 10));
    }

    res.json({ message: `${photoIds.length} photos updated successfully`, skipped_under_review: skippedUnderReview });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to update photos');
  }
});

// The gallery's trash (issue 1733): photos an admin deleted, restorable until
// their retention runs out. Same permission and gallery scope as deleting.
const MAX_TRASH_IDS = 500;
const trashActor = (req) => ({ type: 'admin', id: req.admin.id, name: req.admin.username });

router.get('/:eventId/photos/trash', adminAuth, requirePermission('photos.delete'), requireEventOwnership, async (req, res) => {
  try {
    res.json({
      items: await photoTrash.listTrash(parseInt(req.params.eventId, 10)),
      retention_days: await photoTrash.getRetentionDays(),
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to list the trash');
  }
});

// A trashed photo's thumbnail, for the trash dialog only. Every other photo
// and thumbnail route answers 404 for it. Served as stored: nothing is
// generated for a photo in the trash.
router.get('/:eventId/photos/trash/:photoId/thumbnail', adminAuth, requirePermission('photos.delete'), requireEventOwnership, async (req, res) => {
  try {
    const photoId = parseInt(req.params.photoId, 10);
    const photo = Number.isInteger(photoId) ? await photoTrash.findTrashed(req.params.eventId, photoId) : null;
    const stat = photo?.thumbnail_path ? await getStorage().stat(photo.thumbnail_path) : null;
    if (!stat) return res.status(404).json({ error: 'Thumbnail not found' });
    // A purge can remove the file between the stat and the read (issue
    // 2129): S3's get() then rejects, before any header is staged.
    const stream = await getStorage().get(photo.thumbnail_path);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Content-Length', stat.size);
    pipeStreamToResponse(stream, res, { context: 'trashed photo thumbnail' });
  } catch (error) {
    if (answerVanished(res, error, 'Thumbnail not found')) return;
    errorResponse(res, error, 500, 'Failed to serve thumbnail');
  }
});

/** The event and photo ids a restore or purge request names, or null after answering. */
async function trashRequest(req, res) {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => Number.isInteger(id) && id > 0)) {
    res.status(400).json({ error: 'Invalid photo IDs' });
    return null;
  }
  if (ids.length > MAX_TRASH_IDS) {
    res.status(400).json({ error: `At most ${MAX_TRASH_IDS} photos per request` });
    return null;
  }
  const event = await db('events').where({ id: req.params.eventId }).first();
  if (!event) {
    res.status(404).json({ error: 'Event not found' });
    return null;
  }
  return { event, ids: [...new Set(ids)] };
}

router.post('/:eventId/photos/trash/restore', adminAuth, requirePermission('photos.delete'), requireEventOwnership, async (req, res) => {
  try {
    const found = await trashRequest(req, res);
    if (!found) return;
    const { event, ids } = found;

    const names = new Map((await db('photos').whereIn('id', ids).where({ event_id: event.id }).select('id', 'filename'))
      .map((row) => [Number(row.id), row.filename]));
    const { restored, failed } = await photoTrash.restorePhotos(event, ids);
    const cap = photoCapError(event.photo_cap).error;

    if (restored.length > 0) {
      downloadZipService.invalidate(event.id);
      await logActivity('photos_restored',
        { count: restored.length, photoIds: restored, eventName: event.event_name },
        event.id, trashActor(req));
    }
    res.status(restored.length > 0 ? 200 : 409).json({
      restored: restored.length,
      photo_ids: restored,
      failed: failed.map(({ id, code }) => ({
        id,
        filename: names.get(id) || null,
        code,
        error: code === 'PHOTO_CAP_REACHED' ? cap : 'The photo is not in the trash any more',
      })),
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to restore photos');
  }
});

router.post('/:eventId/photos/trash/purge', adminAuth, requirePermission('photos.delete'), requireEventOwnership, async (req, res) => {
  try {
    const found = await trashRequest(req, res);
    if (!found) return;
    const { event, ids } = found;

    let purged = 0;
    const failed = [];
    for (const id of ids) {
      try {
        const photo = await photoTrash.findTrashed(event.id, id);
        // No webhook: photo.deleted fired when the photo was trashed.
        if (photo && await photoTrash.purgePhoto(event, photo)) purged += 1;
      } catch (error) {
        logger.error(`Could not purge trashed photo ${id}`, { error: error.message });
        failed.push(id);
      }
    }

    if (purged > 0) {
      await logActivity('photos_trash_purged', { count: purged, eventName: event.event_name }, event.id, trashActor(req));
    }
    res.status(purged > 0 || failed.length === 0 ? 200 : 500).json({ purged, failed });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to delete photos from the trash');
  }
});

// How many photos of the event wait for review, or were rejected (issue 743),
// for the photo grid's banner.
router.get('/:eventId/photos/moderation', adminAuth, requirePermission('photos.view'), requireEventOwnership, async (req, res) => {
  try {
    res.json({ moderation: await moderationCounts(req.params.eventId) });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to count photos under review');
  }
});

// Review of team members' uploads (issue 743): approve publishes the photos,
// reject keeps them hidden as 'rejected'. Only photos under review move. The
// owner decides, or a holder of photos.review (a project lead) on a gallery it
// reaches; a team member without it reaches the event through
// requireEventOwnership but not past mayReviewUploads.
router.post('/:eventId/photos/moderation', adminAuth, requirePermission(['photos.edit', 'photos.review']), requireEventOwnership, async (req, res) => {
  try {
    const { eventId } = req.params;
    const { photoIds, action } = req.body || {};
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'action must be approve or reject' });
    }
    if (!Array.isArray(photoIds) || photoIds.length === 0
      || !photoIds.every((id) => Number.isInteger(id) && id > 0)) {
      return res.status(400).json({ error: 'Invalid photo IDs' });
    }
    if (photoIds.length > MAX_MODERATION_IDS) {
      return res.status(400).json({ error: `At most ${MAX_MODERATION_IDS} photos per request` });
    }

    const event = await db('events').where({ id: eventId }).first();
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    if (!(await mayReviewUploads(req.admin, event))) {
      return res.status(403).json({ error: 'Only the gallery owner or a reviewer can review uploads', code: 'REVIEWER_REQUIRED' });
    }

    const { updated, photoIds: moved } = await moderatePhotos(event.id, photoIds, action);
    if (updated > 0) {
      // Approved photos join the guest download bundle.
      if (action === 'approve') downloadZipService.invalidate(event.id);
      await logActivity(action === 'approve' ? 'photos_review_approved' : 'photos_review_rejected',
        { count: updated, photoIds: moved, eventName: event.event_name },
        event.id,
        { type: 'admin', id: req.admin.id, name: req.admin.username }
      );
    }

    res.json({ updated, moderation: await moderationCounts(event.id) });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to review photos');
  }
});

// Photo credits (#1561) — the names on this event's photos with their counts,
// for the grid's filter. `none` counts the photos without a name.
router.get('/:eventId/photos/credits', adminAuth, requirePermission('photos.view'), requireEventOwnership, async (req, res) => {
  try {
    const eventId = parseInt(req.params.eventId, 10);
    const rows = await livePhotos(db)
      .where('event_id', eventId)
      .whereNotNull('credit_name')
      .groupBy('credit_name')
      .select('credit_name')
      .count('id as count')
      .orderBy('credit_name', 'asc');
    const none = await livePhotos(db)
      .where('event_id', eventId)
      .whereNull('credit_name')
      .count('id as count')
      .first();
    res.json({
      credits: rows.map((r) => ({ name: r.credit_name, count: Number(r.count) })),
      none: Number(none?.count || 0),
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to load photo credits');
  }
});

// Correct or clear one photo's credit (#1561). Its own route rather than a
// field on PATCH /photos/:photoId, which clears the category of any request
// that leaves category_id out.
router.put('/:eventId/photos/:photoId/credit', adminAuth, requirePermission('photos.edit'), requireEventOwnership, async (req, res) => {
  try {
    const { eventId, photoId } = req.params;
    const creditFields = manualCreditFields(req.body?.credit_name);
    if (creditFields.error) {
      return res.status(400).json({ error: creditFields.error });
    }
    const updated = await livePhotos(db)
      .where({ id: photoId, event_id: eventId })
      .update(creditFields);
    if (!updated) {
      return res.status(404).json({ error: 'Photo not found' });
    }
    await logActivity('photo_credit_updated', {
      photo_id: Number(photoId), cleared: creditFields.credit_name === null,
    }, parseInt(eventId, 10), { type: 'admin', id: req.admin.id, name: req.admin.username });
    res.json({ credit_name: creditFields.credit_name, credit_source: creditFields.credit_source });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to update photo credit');
  }
});

// The preview image of a video (issue 2263, item 4). Both routes refuse what
// the poster rebuild could not serve: a row still processing, an image, and
// on remote storage a source over the poster's download bound.
async function posterVideo(req, res) {
  const photo = await livePhotos(db)
    .where({ id: req.params.photoId, event_id: req.params.eventId })
    .first();
  if (!photo) {
    res.status(404).json({ error: 'Photo not found' });
    return null;
  }
  if (!(photo.media_type === 'video' || isVideoMimeType(photo.mime_type) || photo.type === 'video')) {
    res.status(400).json({ error: 'Only a video has a preview image to choose' });
    return null;
  }
  if (photo.processing_status === 'pending' || photo.processing_status === 'processing') {
    res.status(409).json({ error: 'The video is still being processed' });
    return null;
  }
  const event = await db('events').where('id', photo.event_id).first();
  const isExternal = photo.source_origin === 'external' || photo.source_origin === 'reference';
  const storage = getStorage();
  if (!isExternal && storage.kind() !== 'local') {
    const { resolvePhotoStorageKey } = require('../services/photoResolver');
    const { videoThumbnailMaxSourceBytes } = require('../services/imageProcessor');
    const stat = await storage.stat(resolvePhotoStorageKey(event, photo));
    if (stat && stat.size > videoThumbnailMaxSourceBytes()) {
      res.status(413).json({ error: 'This video is too large to take preview frames from' });
      return null;
    }
  }
  return { photo, event, isExternal };
}

// Three frames to pick from, generated on request and returned inline: they
// are looked at once, so nothing is stored and nothing needs cleaning up.
router.get('/:eventId/photos/:photoId/poster-candidates', adminAuth, requirePermission('photos.edit'), requireEventOwnership, async (req, res) => {
  try {
    const found = await posterVideo(req, res);
    if (!found) return;
    const { photo, event, isExternal } = found;
    const { resolvePhotoFilePath, resolvePhotoStorageKey } = require('../services/photoResolver');
    const { withLocalCopy } = require('../services/imageProcessor');
    const { generatePosterCandidates, DEFAULT_POSTER_OFFSET_SECONDS } = require('../services/videoProcessor');
    const generate = localPath => generatePosterCandidates(localPath, { duration: photo.duration });
    const result = isExternal
      ? await generate(resolvePhotoFilePath(event, photo))
      : await withLocalCopy(resolvePhotoStorageKey(event, photo), generate);
    if (!result.candidates.length) {
      return res.status(422).json({ error: 'No frame could be read from this video' });
    }
    res.set('Cache-Control', 'no-store');
    res.json({
      duration: result.duration,
      poster_offset_seconds: photo.poster_offset_seconds ?? null,
      default_offset_seconds: DEFAULT_POSTER_OFFSET_SECONDS,
      candidates: result.candidates.map(candidate => ({
        offset_seconds: candidate.offsetSeconds,
        image: `data:image/jpeg;base64,${candidate.jpeg.toString('base64')}`,
      })),
    });
  } catch (error) {
    if (answerVanished(res, error, 'Video file not found')) return;
    errorResponse(res, error, 500, 'Failed to read frames from the video');
  }
});

// Keep a frame as the preview image, or `offset_seconds: null` for the
// default one, and rebuild the poster at it the way a regenerate does.
router.put('/:eventId/photos/:photoId/poster', adminAuth, requirePermission('photos.edit'), requireEventOwnership, async (req, res) => {
  try {
    const raw = req.body?.offset_seconds;
    if (raw !== null && (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0)) {
      return res.status(400).json({ error: 'offset_seconds must be a number of seconds, or null for the default frame' });
    }
    const found = await posterVideo(req, res);
    if (!found) return;
    const { photo } = found;
    // The stored duration is rounded down to the second; a frame of the
    // last second is still inside the clip. Unknown: a day at most.
    const longest = photo.duration != null ? Number(photo.duration) + 1 : 24 * 60 * 60;
    if (raw !== null && raw > longest) {
      return res.status(400).json({ error: 'offset_seconds lies past the end of the video' });
    }
    const offset = raw === null ? null : Math.round(raw * 1000) / 1000;

    const fence = { id: photo.id, event_id: photo.event_id };
    // The pick is written with the poster it shows (ensureThumbnail), never
    // ahead of it: a listing read during the rebuild would hand out the new
    // thumbnail URL for the old frame, and a browser would cache that.
    // Strict: a frame that cannot be taken leaves the current poster and
    // pick as they are, never the placeholder over them.
    const key = await ensureThumbnail(photo, { force: true, strictVideoFrame: true, posterOffsetSeconds: offset });
    if (!key) {
      return res.status(422).json({ error: 'No frame could be taken from the video at that point' });
    }
    // The poster it replaced was dropped inside the rebuild (ensureThumbnail
    // with posterOffsetSeconds), unless another row still names it.
    await logActivity('photo_poster_updated', {
      photo_id: photo.id, offset_seconds: offset,
    }, photo.event_id, { type: 'admin', id: req.admin.id, name: req.admin.username });
    const updated = await livePhotos(db).where(fence).first();
    res.json({
      poster_offset_seconds: offset,
      thumbnail_url: adminThumbnailUrl(req.params.eventId, updated || { ...photo, poster_offset_seconds: offset }),
      thumb_hash: updated?.thumb_hash || null,
      processing_error: updated?.processing_error || null,
    });
  } catch (error) {
    if (answerVanished(res, error, 'Video file not found')) return;
    errorResponse(res, error, 500, 'Failed to update the preview image');
  }
});

// Download a photo
router.get('/:eventId/photos/:photoId/download', adminAuth, requirePermission('photos.download'), requireEventOwnership, async (req, res) => {
  try {
    const { eventId, photoId } = req.params;
    
    const photo = await livePhotos(db)
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
      // HEAD (issue 2304): the app probes before a direct video download, so
      // a refusal or a missing file shows in the app. Answered from the stat,
      // without opening the object.
      if (req.method === 'HEAD') {
        res.set({
          'Content-Type': resolvePhotoContentType(photo),
          'Content-Length': stat.size,
          'Content-Disposition': contentDisposition,
        });
        return res.end();
      }
      // Opened before the headers (issue 2129): a file removed since the
      // stat makes S3's get() reject here, and the lazy local stream fails
      // in pipeStreamToResponse, both as a 404.
      const stream = await storage.get(storageKey);
      res.set({
        'Content-Type': resolvePhotoContentType(photo),
        'Content-Length': stat.size,
        'Content-Disposition': contentDisposition,
      });
      pipeStreamToResponse(stream, res, { context: `download of photo ${photo.id}` });
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
    if (req.method === 'HEAD') return res.end();
    res.sendFile(filePath);
  } catch (error) {
    if (answerVanished(res, error, 'Photo file not found')) return;
    errorResponse(res, error, 500, 'Failed to download photo');
  }
});

// Get all photos for an event
router.get('/:eventId/photos', adminAuth, requirePermission('photos.view'), requireEventOwnership, async (req, res) => {
  try {
    const { eventId } = req.params;
    const { category_id, type, media_type, search, sort = 'date', has_likes, has_favorites, has_comments, min_rating, color_label, credit } = req.query;
    const { visibility } = req.query;
    if (visibility !== undefined && (typeof visibility !== 'string' || !['all', 'visible', 'hidden'].includes(visibility))) {
      return res.status(400).json({
        error: 'visibility must be one of: all, visible, hidden',
        code: 'INVALID_VISIBILITY_FILTER',
      });
    }
    const order = ['asc', 'desc'].includes(req.query.order) ? req.query.order : 'desc';
    const logic = req.query.logic === 'OR' ? 'OR' : 'AND';

    let query = livePhotos(db)
      .where({ 'photos.event_id': eventId })
      .leftJoin('photo_categories', 'photos.category_id', 'photo_categories.id')
      // The account that uploaded it (issue 743), shown on photos under review.
      .leftJoin('admin_users as uploader', 'photos.uploaded_by_admin_id', 'uploader.id')
      .select('photos.*', 'photo_categories.name as pc_name', 'photo_categories.slug as pc_slug',
        'uploader.username as uploader_username');

    // Review of team members' uploads (issue 743): the photos waiting for
    // the owner, or the ones the owner turned down.
    if (MODERATION_STATUSES.includes(req.query.moderation)) {
      query = query.where('photos.moderation_status', req.query.moderation);
    }

    // Photos whose file is gone from the external share (issue 2121), for
    // the admin to delete or wait for.
    if (req.query.unavailable === 'true') {
      query = query.whereNotNull('photos.unavailable_reason');
    }

    // Match the gallery's visibility semantics: legacy NULL rows are visible.
    // This only narrows the admin list; it never changes access permissions.
    if (visibility === 'hidden') {
      // Pending/rejected uploads are hidden for moderation, not by a client.
      // Keep them in their review workflow, out of "select hidden and delete".
      query = query.where('photos.visibility', 'hidden').whereNull('photos.moderation_status');
    } else if (visibility === 'visible') {
      query = query.where(function () {
        this.where('photos.visibility', 'visible').orWhereNull('photos.visibility');
      });
    }

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

    // Folder (issue 1786): `root` = photos in no folder, a number = the
    // photos directly in that folder (the admin browses one level at a time,
    // like the guest), `pending` = photos waiting for a folder request.
    const folderParam = req.query.folder_id;
    if (folderParam === 'root') {
      query = query.whereNull('photos.folder_id');
    } else if (folderParam === 'pending') {
      query = query.whereNotNull('photos.pending_folder_request_id');
    } else if (folderParam !== undefined && folderParam !== '') {
      const numericFolderId = parseInt(folderParam, 10);
      if (numericFolderId > 0) query = query.where('photos.folder_id', numericFolderId);
    }

    // Media type filter. The admin grid has sent media_type=photo|video since
    // the filter was added, and this route never read it, so the select
    // changed nothing. Any other value means "both".
    if (media_type === 'video') {
      query = query.whereRaw(IS_VIDEO_SQL);
    } else if (media_type === 'photo') {
      query = query.whereRaw(IS_PHOTO_SQL);
    }

    // Credit filter (#1561): an exact name, or CREDIT_NONE for the photos
    // that carry none. Exact, not LIKE: the value comes from the names list
    // below, and "Anna" must not also match "Annabel".
    if (typeof credit === 'string' && credit !== '') {
      if (credit === CREDIT_NONE) {
        query = query.whereNull('photos.credit_name');
      } else {
        query = query.where('photos.credit_name', credit);
      }
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
    // Approve / reject (issue 744): approved, rejected and/or undecided,
    // comma-separated — the same condition the export filter applies.
    const requestedDecisions = normalizeDecisionFilter(req.query.decision);
    if (requestedDecisions.length > 0) {
      feedbackConditions.push(qb => whereDecision(qb, requestedDecisions));
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

    // Sorting. Every branch ends on photos.id: a bulk import writes hundreds
    // of rows inside the same second, and without a tiebreaker the order
    // inside a tie is whatever the engine returns, which moves rows under a
    // shift-click range from one load to the next.
    if (sort === 'capture_date') {
      query = query.orderByRaw(`${captureDateOrderSql(db.client.config.client)} ${order}`);
    } else if (sort === 'size') {
      query = query.orderBy('photos.size_bytes', order);
    } else if (sort === 'rating') {
      // The filter bar has always offered this and the route never read it.
      query = query.orderByRaw(`COALESCE(photos.average_rating, 0) ${order}`);
    } else if (sort === 'likes') {
      query = query.orderByRaw(`COALESCE(photos.like_count, 0) ${order}`);
    } else if (sort === 'favorites') {
      query = query.orderByRaw(`COALESCE(photos.favorite_count, 0) ${order}`);
    } else if (sort === 'downloads') {
      query = query.orderByRaw(`COALESCE(photos.download_count, 0) ${order}`);
    } else if (sort !== 'name') {
      query = query.orderBy('photos.uploaded_at', order);
    }
    const photos = await query.orderBy('photos.id', order);

    // By name means natural order (issue 1739): IMG_2 before IMG_10, the way
    // a file manager lists them. ORDER BY filename compares character by
    // character, so 1, 10, 100, 2 — and a shift-click range over "1 to 20"
    // picked up the wrong files. Sorted here rather than in SQL: the list is
    // not paginated, and neither engine has a natural collation to ask for.
    if (sort === 'name') {
      // The generated `filename` is the storage name (timestamp/uuid prefix), so
      // ordering by it gives upload order. The name the photographer sees and
      // searches by is original_filename (issue 2073).
      const displayNameOf = (p) => p.original_filename || p.filename || '';
      const direction = order === 'asc' ? 1 : -1;
      photos.sort((a, b) => direction
        * (NATURAL_NAME_ORDER.compare(displayNameOf(a), displayNameOf(b)) || a.id - b.id));
    }
    
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
    
    // Legacy video rows can carry media_type null/'image' (issue 1739 review).
    const isVideoRow = (photo) => photo.media_type === 'video'
      || isVideoMimeType(photo.mime_type) || photo.type === 'video';

    res.json({
      photos: photos.map(photo => ({
        id: photo.id,
        filename: photo.filename,
        original_filename: photo.original_filename || null,
        // Use the correct admin photos router base for serving images.
        // RAW and HEIC originals go to the generated JPEG preview instead:
        // this URL is only ever an <img>/<video> src admin-side (downloads use
        // the /download route), and a browser cannot decode the original, so
        // the admin viewer showed nothing but a broken frame for those.
        url: originalNeedsPreview(photo)
          ? `/admin/photos/${eventId}/preview/${photo.id}`
          : `/admin/photos/${eventId}/photo/${photo.id}`,
        // Always expose a thumbnail URL; backend will generate on demand if
        // missing. Versioned by adminThumbnailUrl, see there.
        thumbnail_url: adminThumbnailUrl(eventId, photo),
        // The frame picked as the video's preview image (issue 2263, item
        // 4); null: the default frame.
        poster_offset_seconds: photo.poster_offset_seconds ?? null,
        type: photo.type,
        // Guest visibility (#172). This explicit mapper never included it,
        // so the admin grid's "Hidden" badge could never render and a photo
        // hidden from clients looked identical to a visible one (QA warning).
        visibility: photo.visibility === 'hidden' ? 'hidden' : 'visible',
        // Same omission: the grid's "Processing…" and "Failed"/Retry
        // placeholders read this, so neither could ever render either.
        processing_status: photo.processing_status || 'complete',
        // Set on a complete video that shows the placeholder tile (issue
        // 1430, item 6); the grid shows the note and offers Retry.
        processing_error: photo.processing_error || null,
        // Why no gallery viewer sees the photo right now (issue 2121):
        // 'source_missing' when its file is gone from the share.
        unavailable_reason: photo.unavailable_reason || null,
        category_id: photo.category_id || photo.type,
        // Only a real category has a name here. The fallback used to be the
        // English "Individual Photos" / "Collages", which no locale could
        // translate and which labelled a video a photo; the grid now derives
        // the default label from category_slug and the media type.
        category_name: photo.pc_name || null,
        category_slug: photo.pc_slug || photo.type,
        // Folder (issue 1786) and first-look flag (issue 1562).
        folder_id: photo.folder_id || null,
        pending_folder_request_id: photo.pending_folder_request_id || null,
        first_look: parseBooleanInput(photo.first_look, false),
        media_type: photo.media_type || 'image',
        mime_type: photo.mime_type || null,
        // Browser-playable copy (issue 1430, item 8): null until the setting
        // has queued the video. The grid shows a failed copy; the original
        // keeps playing (or not) as before.
        web_status: photo.web_status || null,
        web_error: photo.web_error || null,
        width: photo.width || null,
        height: photo.height || null,
        // Blurred tile placeholder (issue 1733): a base64 ThumbHash, or null.
        thumb_hash: photo.thumb_hash || null,
        duration: photo.duration || null,
        size: photo.size_bytes,
        uploaded_at: photo.uploaded_at,
        // The camera clock, zone-less, for the list's Captured column
        // (issue 1739). Formatted here, in the zone exifr read the EXIF time
        // in, so the browser shows it without shifting it to its own zone.
        // A video's time is a real instant instead (videoCaptureDate keeps
        // the recording's offset or reads a UTC creation_time), so it goes
        // out as one and the browser shows it in its own zone.
        // The camera clock as the EXIF wrote it wins when it was read (issue
        // 2305): the server-zone formatting moves a time in that zone's
        // spring-forward gap and every time after a TZ change.
        captured_at_local: isVideoRow(photo) ? null : (cameraWallClock(photo.captured_at_wall) || toServerWallClock(photo.captured_at)),
        captured_at: isVideoRow(photo) ? toIso(photo.captured_at) : null,
        // Feedback data
        has_feedback: (commentMap[photo.id] > 0 || photo.average_rating > 0 || photo.like_count > 0),
        average_rating: photo.average_rating || 0,
        comment_count: commentMap[photo.id] || 0,
        like_count: photo.like_count || 0,
        favorite_count: photo.favorite_count || 0,
        color_label_count: photo.color_label_count || 0,
        // Approve / reject tallies across guests (issue 744).
        approved_count: photo.approved_count || 0,
        rejected_count: photo.rejected_count || 0,
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
        download_count: photo.download_count || 0,
        // Photo credit (#1561). The admin always sees it, whatever the
        // event's show-to-guests switch says.
        credit_name: photo.credit_name || null,
        credit_source: photo.credit_source || null,
        uploaded_by: photo.uploaded_by === 'guest' ? 'guest' : 'admin',
        // Camera details (issue 1733, D1); null when none were read.
        exif: parseStoredExif(photo.exif_json),
        // Review of team members' uploads (issue 743): null, 'pending' or
        // 'rejected', and the admin account that ran the upload.
        moderation_status: photo.moderation_status || null,
        uploaded_by_admin: photo.uploaded_by_admin_id
          ? { id: photo.uploaded_by_admin_id, username: photo.uploader_username || null }
          : null,
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

    const photo = await livePhotos(db)
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
    const stageFileHeaders = () => {
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    };

    if (storageKey) {
      const storage = getStorage();
      const stat = await storage.stat(storageKey);
      if (!stat) {
        return res.status(404).json({ error: 'Photo file not found' });
      }
      // Opened before the headers (issue 2129): a file removed since the
      // stat makes S3's get() reject here, and the lazy local stream fails
      // in pipeStreamToResponse, both as a 404.
      const stream = await storage.get(storageKey);
      stageFileHeaders();
      res.setHeader('Content-Length', stat.size);
      pipeStreamToResponse(stream, res, { context: `photo ${photo.id}` });
      return;
    }

    // External-mode photos still live on local disk.
    const filePath = resolvePhotoFilePath(event, photo);
    try {
      await fs.access(filePath);
    } catch (error) {
      return res.status(404).json({ error: 'Photo file not found' });
    }
    stageFileHeaders();
    res.sendFile(path.resolve(filePath));
  } catch (error) {
    if (answerVanished(res, error, 'Photo file not found')) return;
    errorResponse(res, error, 500, 'Failed to serve photo');
  }
});

// Serve thumbnail with admin authentication
router.get('/:eventId/thumbnail/:photoId', adminAuth, requirePermission('photos.view'), requireEventOwnership, async (req, res) => {
  try {
    const { eventId, photoId } = req.params;
    
    const photo = await livePhotos(db)
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

    const storage = getStorage();
    const stat = await storage.stat(thumbnailPath);
    if (!stat) {
      return res.status(404).json({ error: 'Thumbnail not found' });
    }
    // Opened before the headers: a thumbnail removed since the stat, by a
    // regeneration (issue 2129), makes S3's get() reject here, and the lazy
    // local stream fails in pipeStreamToResponse, both as a 404.
    const stream = await storage.get(thumbnailPath);
    res.setHeader('Content-Type', 'image/jpeg'); // Thumbnails are always JPEG
    // A URL naming another version than the row's (a tab with an older list)
    // gets the current image uncached: cached under that URL it would show
    // when the version comes back, say on picking the earlier frame again.
    const versionAsked = typeof req.query.v === 'string' ? req.query.v : '';
    res.setHeader('Cache-Control', versionAsked === adminThumbnailVersion(photo) ? 'private, max-age=3600' : 'no-store');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Content-Length', stat.size);
    pipeStreamToResponse(stream, res, { context: `admin thumbnail for photo ${photoId}` });
  } catch (error) {
    if (answerVanished(res, error, 'Thumbnail not found')) return;
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

    const photo = await livePhotos(db).where({ id: photoId, event_id: eventId }).first();
    if (!photo) return res.status(404).json({ error: 'Photo not found' });

    if (photo.processing_status === 'pending' || photo.processing_status === 'processing') {
      res.setHeader('Retry-After', '2');
      return res.status(503).json({ error: 'Preview not ready', status: photo.processing_status });
    }

    // A video has no preview tier (issue 2286): its picture is the poster
    // frame the thumbnail route serves, under the same version the admin
    // lists name it by. Never the generator, which would fetch the whole
    // clip from remote storage only for Sharp to fail on it.
    if (photo.media_type === 'video' || isVideoMimeType(photo.mime_type) || photo.type === 'video') {
      const version = adminThumbnailVersion(photo);
      return res.redirect(`${req.baseUrl}/${eventId}/thumbnail/${photo.id}${version ? `?v=${version}` : ''}`);
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
    // Opened before the headers: a preview removed since the stat (issue
    // 2129) makes S3's get() reject here, and the lazy local stream fails
    // in pipeStreamToResponse, both as a 404.
    const stream = await storage.get(previewPath);

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Content-Length', stat.size);
    pipeStreamToResponse(stream, res, { context: `admin preview for photo ${photoId}` });
  } catch (error) {
    if (answerVanished(res, error, 'Preview not found')) return;
    logger.error('Error serving admin preview:', error);
    errorResponse(res, error, 500, 'Failed to serve preview');
  }
});

// Debug endpoint to check photo existence
router.get('/:eventId/debug', adminAuth, requirePermission('photos.view'), requireEventOwnership, async (req, res) => {
  try {
    const { eventId } = req.params;
    
    const eventRow = await db('events').where({ id: eventId }).first();
    const photoCount = await livePhotos(db).where({ event_id: eventId }).count('id as count').first();
    const photos = await livePhotos(db).where({ event_id: eventId }).limit(5);
    // Never hand out the hashes or the recoverable copies (#1271) — this is
    // a photos.view surface, not an events.edit one.
    let event = eventRow;
    if (eventRow) {
      event = { ...eventRow };
      for (const column of ['password_hash', 'client_password_hash', ...RECOVERABLE_PASSWORD_COLUMNS]) delete event[column];
    }
    
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
const canonicalChunkEvent = (req, res, next) => {
  const id = Number(req.params.eventId);
  if (!/^\d+$/.test(req.params.eventId) || !Number.isSafeInteger(id) || id < 1) {
    if (!req.readableEnded) res.set('Connection', 'close');
    return res.status(404).json({ error: 'Event not found' });
  }
  req.params.eventId = String(id);
  next();
};
router.post('/:eventId/chunked-upload/init', adminAuth, requirePermission('photos.upload'), canonicalChunkEvent, requireEventOwnership, async (req, res) => {
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
    const maxSize = isVideoMimeType(mimeType) ? await getMaxVideoSizeBytes() : await getMaxFileSizeBytes();
    if (Number(fileSize) > maxSize) {
      return res.status(400).json({
        error: `File too large. Maximum size is ${Math.floor(maxSize / (1024 * 1024))} MB per file.`
      });
    }

    const result = await chunkedUpload.initializeUpload({
      filename,
      fileSize,
      mimeType,
      eventId: event.id,
      adminId: req.admin.id,
      totalChunks,
      // The declared fileSize check above is client-controlled; the service
      // enforces this cap on the bytes it actually receives and merges.
      maxFileSizeBytes: maxSize,
      admission: true
    });

    res.json(result);
  } catch (error) {
    // A declared size and chunk count that do not fit together is the
    // client's mistake, and carries its own status.
    uploadQuota.forAdmin(error);
    if (error.statusCode || error.status) {
      return res.status(error.statusCode || error.status).json({ error: error.message, code: error.code });
    }
    errorResponse(res, error, 500, 'Failed to initialize upload');
  }
});

// Upload a chunk
// Every operation below names the upload by its opaque id. requireEventOwnership
// only proves access to the :eventId in the URL, so the service is told which
// event and admin the call is for and answers 404 unless the upload was
// initialised by that admin for that event — a leaked id must not let a scoped
// admin touch another event's upload.
const uploadOwner = (req) => ({ eventId: Number(req.params.eventId), adminId: req.admin.id });

router.post('/:eventId/chunked-upload/:uploadId/chunk/:chunkIndex', adminAuth, requirePermission('photos.upload'), canonicalChunkEvent, requireEventOwnership, async (req, res) => {
  try {
    const { uploadId, chunkIndex } = req.params;

    // The request stream is handed over unread (#1403). Every check — unknown
    // upload id, bad index, the per-file cap against Content-Length — runs
    // inside uploadChunk before a byte is consumed, and the body is then
    // streamed to the chunk file under a hard cap rather than concatenated in
    // memory. Buffering it first meant a rejected 300MB request still cost
    // 300MB of heap.
    const declaredBytes = Number(req.headers['content-length']);
    const index = /^\d+$/.test(chunkIndex) ? Number(chunkIndex) : NaN;
    const result = await chunkedUpload.uploadChunk(uploadId, index, req, {
      declaredBytes: Number.isFinite(declaredBytes) ? declaredBytes : undefined,
      owner: uploadOwner(req),
    });

    res.json(result);
  } catch (error) {
    // Client-caused states (unknown/finished/expired upload, bad index, too
    // large) carry their own status. Only a genuinely unexpected error should
    // reach the 500 below and the error log with it.
    uploadQuota.forAdmin(error);
    if (error.statusCode || error.status) {
      // Refusing the body early is the point — but it leaves unread bytes in
      // flight on a connection this response still advertises as keep-alive.
      // Node does not drain them, so the NEXT request on that socket hangs
      // until it times out. Retire the connection instead.
      if (!req.readableEnded) {
        res.set('Connection', 'close');
      }
      return res.status(error.statusCode || error.status).json({ error: error.message, code: error.code });
    }
    logger.error('Error uploading chunk:', error);
    res.status(500).json({ error: 'Failed to upload chunk' });
  }
});

// Complete chunked upload and process the file
router.post('/:eventId/chunked-upload/:uploadId/complete', adminAuth, requirePermission('photos.upload'), canonicalChunkEvent, requireEventOwnership, async (req, res) => {
  let mergedFile;
  const cancel = () => {
    if (req.aborted || !res.writableEnded) chunkedUpload.abortUpload(req.params.uploadId, { owner: uploadOwner(req) })
      .catch(err => logger.warn('Disconnected chunk upload cleanup unavailable', { error: err.message }));
  };
  req.once('aborted', cancel);
  res.once('close', cancel);
  try {
    const { eventId, uploadId } = req.params;
    const { category_id, detect_duplicates } = req.body;

    // Same rules as the batch upload route: the photo cap and the category
    // scope. Checked before the merge, so a refused upload writes nothing.
    const event = await db('events').where({ id: eventId }).first();
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    const { placement, error: placementError } = await resolveUploadPlacement(event.id, req.body);
    if (placementError) {
      await chunkedUpload.abortUpload(uploadId, { owner: uploadOwner(req) }).catch(() => {});
      return res.status(400).json(placementError);
    }
    const detectDuplicates = detect_duplicates === true || detect_duplicates === 'true';
    const photoCap = photoCapOf(event);
    let capRefusal = null;
    if (photoCap) {
      const currentCount = await countEventPhotos(event.id);
      if (currentCount + 1 > photoCap) {
        capRefusal = {
          error: `Photo cap exceeded. This event allows a maximum of ${photoCap} photos. Currently ${currentCount} photos exist, and you are trying to upload 1 more.`
        };
      }
    }
    // With detect_duplicates a full gallery still merges first: a duplicate
    // would not have been stored, so it is reported as one, and only another
    // file is refused for the cap (below).
    if (capRefusal && !detectDuplicates) {
      await chunkedUpload.abortUpload(uploadId, { owner: uploadOwner(req) }).catch(() => {});
      return res.status(400).json(capRefusal);
    }

    // Complete the chunked upload (merge chunks)
    mergedFile = await chunkedUpload.completeUpload(uploadId, { owner: uploadOwner(req) });

    // Same opt-in duplicate rule as the batch route (issue 1733, C2). The
    // merged file is the first moment the whole content exists here, so this
    // is the earliest a large file can be recognised.
    const contentSha256 = await sha256File(mergedFile.path);
    const existing = detectDuplicates ? await findDuplicate(mergedFile.eventId, contentSha256) : null;
    if (existing) {
      await fs.rm(mergedFile.tempDir, { recursive: true, force: true }).catch(() => {});
      return res.status(409).json({
        error: 'This gallery already has a photo with the same content.',
        code: 'DUPLICATE_PHOTO',
        duplicate_of: duplicateName(existing),
      });
    }
    if (capRefusal) {
      await fs.rm(mergedFile.tempDir, { recursive: true, force: true }).catch(() => {});
      return res.status(400).json(capRefusal);
    }

    // The same content check the multipart upload applies: the bytes must
    // match the declared type, and an image must decode. The merged file is
    // the first moment the whole content exists here.
    const resolvedMimeType = normalizeUploadMimeType(mergedFile.filename, mergedFile.mimeType);
    const contentFiles = [{ originalname: mergedFile.filename, path: mergedFile.path, mimetype: resolvedMimeType }];
    let contentError = null;
    if (!(await validateFileContent(mergedFile.path, resolvedMimeType))) {
      contentError = `File content does not match declared type: ${mergedFile.filename}`;
    } else {
      const checked = { files: contentFiles };
      await validateUploadedFiles(checked, res, () => {});
      if (checked.files.length === 0) {
        const [rejected] = checked.invalidFiles || [];
        contentError = rejected?.code === require('../services/imageResourcePolicy').LIBRARY_UNAVAILABLE ? rejected.error : `Invalid image file: ${mergedFile.filename}`;
      }
    }
    if (contentError) {
      await fs.rm(mergedFile.tempDir, { recursive: true, force: true }).catch(() => {});
      return res.status(400).json({ error: contentError });
    }

    // Process the merged file as a regular upload
    const fileObj = {
      originalname: mergedFile.filename,
      mimetype: mergedFile.mimeType,
      size: mergedFile.size,
      path: mergedFile.path,
      contentSha256
    };

    // The event the upload was initialised for. The owner check above makes
    // it the URL's event too; the stored one is authoritative regardless.
    const uploadedPhotos = await processUploadedPhotos(
      [fileObj],
      mergedFile.eventId,
      'admin',
      category_id || null,
      // Same uploader + review columns as the batch route (issue 743).
      { ...placementColumns(placement), ...(await adminUploadColumns(req.admin, event)) },
      mergedFile.uploadReservation
    );
    await afterUploadPlacement(mergedFile.eventId, placement, uploadedPhotos.length,
      { type: 'admin', id: req.admin.id, name: req.admin.username });
    if (uploadedPhotos.length) acceptedUpload(res, {
      video: isVideoMimeType(fileObj.mimetype),
      raw: isRawUploadFilename(fileObj.originalname),
      s3: process.env.STORAGE_BACKEND === 's3'
    });

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
    // Same rule as the chunk route: a tagged status is a client-caused state
    // (unknown/expired upload, missing chunks), not a server fault.
    uploadQuota.forAdmin(error);
    if (error.statusCode || error.status) {
      return res.status(error.statusCode || error.status).json({ error: error.message, code: error.code });
    }
    logger.error('Error completing chunked upload:', error);
    res.status(500).json({ error: 'Failed to complete upload' });
  } finally {
    req.removeListener('aborted', cancel);
    res.removeListener('close', cancel);
    if (mergedFile?.uploadReservation) {
      await chunkedUpload.finishUpload(req.params.uploadId, { owner: uploadOwner(req) })
        .catch(err => logger.warn('Chunk upload cleanup unavailable; admission retained', { error: err.message }));
    }
  }
});

// Get upload status
router.get('/:eventId/chunked-upload/:uploadId/status', adminAuth, requirePermission('photos.view'), canonicalChunkEvent, requireEventOwnership, async (req, res) => {
  try {
    const { uploadId } = req.params;

    const status = chunkedUpload.getUploadStatus(uploadId, { owner: uploadOwner(req) });

    if (!status) {
      return res.status(404).json({ error: 'Upload not found or expired' });
    }

    res.json(status);
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to get upload status');
  }
});

// Abort chunked upload
// This removes only the caller's uncommitted upload staging, never a photo
// row. Upload-only principals must be able to cancel their own admission.
router.delete('/:eventId/chunked-upload/:uploadId', adminAuth, requirePermission(['photos.upload', 'photos.delete']), canonicalChunkEvent, requireEventOwnership, async (req, res) => {
  try {
    const { uploadId } = req.params;

    const aborted = await chunkedUpload.abortUpload(uploadId, { owner: uploadOwner(req) });
    if (!aborted) {
      return res.status(404).json({ error: 'Upload not found or expired' });
    }

    res.json({ success: true, message: 'Upload aborted' });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to abort upload');
  }
});

module.exports = router;
