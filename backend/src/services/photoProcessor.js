const path = require('path');
const fs = require('fs').promises;
const { db } = require('../database/db');
const { generateThumbnail, extractCaptureDate, withLocalCopy } = require('./imageProcessor');
const { generatePhotoFilename } = require('../utils/filenameSanitizer');
const { processUploadedVideo, isVideoMimeType } = require('./videoProcessor');
const { getStorage } = require('./storage');
const { resolvePhotoStorageKey } = require('./photoResolver');
const logger = require('../utils/logger');

function normalizeFiles(files) {
  // Handle null, undefined, or falsy values
  if (!files) {
    logger.info('[normalizeFiles] No files provided');
    return [];
  }

  // Handle arrays
  if (Array.isArray(files)) {
    const validFiles = files.filter(Boolean);
    logger.info(`[normalizeFiles] Normalized ${validFiles.length} files from array`);
    return validFiles;
  }

  // Handle iterable objects (some multer configurations)
  try {
    if (typeof files === 'object' && typeof files[Symbol.iterator] === 'function') {
      const validFiles = Array.from(files).filter(Boolean);
      logger.info(`[normalizeFiles] Normalized ${validFiles.length} files from iterable`);
      return validFiles;
    }
  } catch (err) {
    logger.warn('[normalizeFiles] Failed to iterate files object:', err.message);
  }

  // Handle plain objects (multer fieldname mapping)
  if (typeof files === 'object') {
    try {
      const validFiles = Object.values(files)
        .flatMap((value) => (Array.isArray(value) ? value : [value]))
        .filter(Boolean);
      logger.info(`[normalizeFiles] Normalized ${validFiles.length} files from object`);
      return validFiles;
    } catch (err) {
      logger.warn('[normalizeFiles] Failed to process files object:', err.message);
      return [];
    }
  }

  // Unexpected type
  logger.warn('[normalizeFiles] Unexpected files type:', typeof files);
  return [];
}

async function processUploadedPhotos(files, eventId, uploadedBy = 'admin', categoryId = null) {
  const uploadedPhotos = [];
  const fileList = normalizeFiles(files);

  if (fileList.length === 0) {
    return uploadedPhotos;
  }

  // Get event details
  const event = await db('events').where({ id: eventId }).first();
  if (!event) {
    throw new Error('Event not found');
  }
  
  // Process each file
  for (const file of fileList) {
    const trx = await db.transaction();
    
    try {
      // Count existing photos to generate sequence number
      let counter = 1;
      let photoType = 'individual'; // default type
      
      // If categoryId is provided and matches photo types, use it as type
      if (categoryId === 'collage') {
        photoType = 'collage';
      }
      
      // Count existing photos of the same type for numbering
      const existingCount = await trx('photos')
        .where({ event_id: eventId, type: photoType })
        .count('id as count')
        .first();

      const existingCountValue = Number(existingCount?.count ?? 0);
      counter = existingCountValue + 1;
      
      // Generate new filename
      const extension = path.extname(file.originalname);
      const categoryName = photoType === 'collage' ? 'collages' : 'individual';
      const newFilename = generatePhotoFilename(
        event.event_name,
        categoryName,
        counter,
        extension
      );
      
      const tempPath = file?.path || file?.filepath || file?.tempFilePath;

      if (!tempPath) {
        const fileInfo = JSON.stringify({
          originalname: file?.originalname,
          mimetype: file?.mimetype,
          size: file?.size,
          availableKeys: Object.keys(file || {})
        });
        throw new Error(`Uploaded file is missing a temporary path. File info: ${fileInfo}`);
      }

      // Verify temp file exists before processing
      try {
        await fs.access(tempPath);
      } catch (accessErr) {
        logger.error(`Temp file not accessible: ${tempPath}`, {
          originalname: file?.originalname,
          error: accessErr.message
        });
        throw new Error(`Uploaded file not found at temporary location: ${tempPath}`);
      }

      // Final storage key under events/active/{slug}/{newFilename}.
      const relativePath = path.posix.join(event.slug, newFilename);
      const finalKey = path.posix.join('events/active', relativePath);

      // Determine if this is a video or image
      const isVideo = isVideoMimeType(file.mimetype);
      const mediaType = isVideo ? 'video' : 'image';

      // Generate thumbnail and extract metadata FROM the temp file (still on
      // local disk) before uploading the original.
      let thumbnailPath;
      let videoMetadata = null;
      let imageMetadata = null;

      if (isVideo) {
        const videoThumbnailKey = path.posix.join(
          'thumbnails',
          `thumb_${newFilename.replace(/\.[^.]+$/, '.jpg')}`
        );
        const result = await processUploadedVideo(tempPath, videoThumbnailKey);
        videoMetadata = result.metadata;
        thumbnailPath = result.thumbnailKey;
      } else {
        thumbnailPath = await generateThumbnail(tempPath);
        try {
          const sharp = require('sharp');
          const metadata = await sharp(tempPath).metadata();
          if (metadata.width && metadata.height) {
            imageMetadata = {
              width: metadata.width,
              height: metadata.height
            };
          }
        } catch (metadataError) {
          logger.warn(`Could not extract image dimensions for ${file.originalname}:`, metadataError.message);
        }
      }

      // Now upload the original through the storage backend and remove the
      // local temp copy.
      try {
        await getStorage().putFromFile(finalKey, tempPath, {
          contentType: file.mimetype,
        });
      } catch (uploadErr) {
        logger.error(`Failed to upload ${file.originalname} → ${finalKey}:`, uploadErr);
        throw new Error(`Failed to upload to storage: ${uploadErr.message}`);
      } finally {
        try {
          await fs.unlink(tempPath);
        } catch (unlinkErr) {
          if (unlinkErr?.code !== 'ENOENT') {
            logger.warn(`Failed to clean up temp upload ${tempPath}:`, {
              error: unlinkErr.message,
              code: unlinkErr.code
            });
          }
        }
      }

      const relativeThumbPath = thumbnailPath;

      // Add to database with uploaded_by field and media metadata
      let insertResult;
      const clientName = trx?.client?.config?.client;
      const supportsReturning = ['pg', 'postgres', 'postgresql'].includes(clientName);

      const photoData = {
        event_id: eventId,
        filename: newFilename,
        original_filename: file.originalname,
        path: relativePath,
        thumbnail_path: relativeThumbPath,
        type: photoType,
        size_bytes: file.size,
        uploaded_by: uploadedBy,
        source_origin: 'managed',
        media_type: mediaType,
        mime_type: file.mimetype
      };

      // Add video-specific metadata if applicable
      if (isVideo && videoMetadata) {
        photoData.duration = videoMetadata.duration;
        photoData.video_codec = videoMetadata.videoCodec;
        photoData.audio_codec = videoMetadata.audioCodec;
        photoData.width = videoMetadata.width;
        photoData.height = videoMetadata.height;
      }

      // Add image dimensions if available
      if (!isVideo && imageMetadata) {
        photoData.width = imageMetadata.width;
        photoData.height = imageMetadata.height;
      }

      if (supportsReturning) {
        insertResult = await trx('photos')
          .insert(photoData)
          .returning('id');
      } else {
        insertResult = await trx('photos').insert(photoData);
      }

      const insertedId = Array.isArray(insertResult)
        ? (insertResult[0]?.id ?? insertResult[0])
        : insertResult;

      const photoId = typeof insertedId === 'object' ? insertedId.id : insertedId;

      if (photoId === undefined || photoId === null) {
        throw new Error('Failed to determine inserted photo ID');
      }

      // Commit transaction
      await trx.commit();

      // Webhook (#327) — fires for every entry path that lands in this
      // service: guest upload + auto-import + admin upload via API.
      try {
        const webhookService = require('./webhookService');
        await webhookService.fire('photo.uploaded', {
          event: { id: event.id, slug: event.slug, event_name: event.event_name },
          photo: {
            id: photoId,
            filename: newFilename,
            original_filename: file.originalname,
            size_bytes: file.size,
            uploaded_by: uploadedBy,
          },
        });
      } catch (e) { /* non-fatal */ }

      uploadedPhotos.push({
        id: photoId,
        filename: newFilename,
        size: file.size,
        type: photoType
      });

      logger.info(`Successfully processed file ${file.originalname} (ID: ${photoId})`);
    } catch (error) {
      logger.error(`Error processing file ${file.originalname}:`, {
        error: error.message,
        stack: error.stack,
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
        tempPath: file?.path || file?.filepath || file?.tempFilePath
      });

      if (trx) {
        try {
          await trx.rollback();
        } catch (rollbackErr) {
          logger.error('Failed to rollback transaction:', rollbackErr);
        }
      }

      // Continue with other files
      // Note: Individual file failures don't stop the entire upload batch
    }
  }
  
  return uploadedPhotos;
}

/**
 * Queue uploaded files for async processing.
 *
 * Moves each file from its multer temp path to the final storage key
 * and inserts a `photos` row with `processing_status = 'pending'` and
 * a shared `upload_id`. The background worker
 * (services/backgroundProcessor.js) picks up pending rows, generates
 * thumbnails / EXIF / dimensions, then flips status to 'complete'
 * (or 'failed' with the error).
 *
 * Used by both the admin upload route and the gallery (guest) upload
 * route so they share the same fast-return semantics.
 *
 * Options:
 *   - eventId           required
 *   - photoType         'individual' | 'collage' (default 'individual')
 *   - categoryId        numeric category id or null
 *   - uploadId          optional pre-generated upload id (caller can
 *                       provide it for chunked uploads that span
 *                       multiple HTTP requests)
 *
 * Returns: { uploadId, photos: [{id, filename, size, category_id}], errors: [{filename, error}] }
 */
async function queueFilesForProcessing(files, options = {}) {
  const crypto = require('crypto');
  const { eventId, photoType = 'individual', categoryId = null, uploadId: providedUploadId } = options;
  const uploadId = providedUploadId || crypto.randomBytes(16).toString('hex');

  const event = await db('events').where({ id: eventId }).first();
  if (!event) throw new Error(`Event ${eventId} not found`);

  const fileList = normalizeFiles(files);
  const queued = [];
  const errors = [];

  if (fileList.length === 0) return { uploadId, photos: queued, errors };

  // Counter base — same approximation the upload route used pre-async.
  // Strict uniqueness is still enforced by the filename template; on a
  // collision the worker would just fail one photo.
  const existingCount = await db('photos')
    .where({ event_id: eventId, type: photoType })
    .count('id as count')
    .first();
  let counter = (parseInt(existingCount?.count) || 0) + 1;

  const storage = getStorage();
  const finalDestPathRel = path.posix.join('events/active', event.slug);
  const categoryName = photoType === 'collage' ? 'collages' : 'individual';

  for (const file of fileList) {
    const tempPath = file?.path || file?.filepath || file?.tempFilePath;
    try {
      if (!tempPath) {
        throw new Error('Uploaded file is missing a temporary path');
      }
      const tempStats = await fs.stat(tempPath);
      if (tempStats.size === 0) {
        throw new Error('File is empty - upload may have been interrupted');
      }

      const extension = path.extname(file.originalname);
      const newFilename = generatePhotoFilename(event.event_name, categoryName, counter, extension);
      counter += 1;

      const finalKey = path.posix.join(finalDestPathRel, newFilename);
      const relativePath = path.posix.join(event.slug, newFilename);
      const isVideo = isVideoMimeType(file.mimetype);

      // Move to storage first so the file is at its recorded path by the
      // time the worker picks up the row.
      await storage.putFromFile(finalKey, tempPath, { contentType: file.mimetype });
      await fs.unlink(tempPath).catch(() => {});

      const stat = await storage.stat(finalKey);
      if (!stat || stat.size !== tempStats.size) {
        throw new Error(`Size mismatch after upload: expected ${tempStats.size}, got ${stat ? stat.size : 'null'}`);
      }

      const inserted = await db('photos')
        .insert({
          event_id: parseInt(eventId, 10),
          filename: newFilename,
          original_filename: file.originalname,
          path: relativePath,
          thumbnail_path: null,
          type: photoType,
          category_id: categoryId,
          size_bytes: tempStats.size,
          captured_at: null,
          media_type: isVideo ? 'video' : 'image',
          mime_type: file.mimetype,
          processing_status: 'pending',
          upload_id: uploadId,
        })
        .returning('id');
      const photoId = inserted[0]?.id || inserted[0];

      queued.push({
        id: photoId,
        filename: newFilename,
        size: tempStats.size,
        category_id: categoryId,
      });
    } catch (err) {
      errors.push({ filename: file?.originalname || 'unknown', error: err.message });
    }
  }

  return { uploadId, photos: queued, errors };
}

/**
 * Worker-mode processing for a single already-stored photo.
 *
 * Called by the background processor after a row has been claimed
 * (`processing_status` == 'processing'). The photo file already exists
 * at its final storage key — this function reads it back, generates a
 * thumbnail, extracts EXIF + dimensions (or video metadata), then
 * updates the photo row to `complete` and fires the queued side
 * effects (watermark, webhook).
 *
 * Throwing causes the background processor to mark the row as
 * 'failed' with the error message; partial successes (e.g. thumbnail
 * fails but dimensions succeed) are persisted up to the failure point.
 */
async function processPhoto(photoId) {
  const photo = await db('photos').where({ id: photoId }).first();
  if (!photo) throw new Error(`Photo ${photoId} not found`);

  const event = await db('events').where({ id: photo.event_id }).first();
  if (!event) throw new Error(`Event ${photo.event_id} not found for photo ${photoId}`);

  const sourceKey = resolvePhotoStorageKey(event, photo);
  const isVideo =
    photo.media_type === 'video' ||
    (typeof photo.mime_type === 'string' && photo.mime_type.startsWith('video/'));

  const updateData = {};

  // withLocalCopy materialises the original from the storage backend so
  // sharp/ffmpeg can read it. For local storage this is a free O(1) path
  // resolution; for S3 it downloads to a tmpdir that's auto-cleaned.
  await withLocalCopy(sourceKey, async (localPath) => {
    if (!photo.captured_at && !isVideo) {
      try {
        const captured = await extractCaptureDate(localPath);
        if (captured) updateData.captured_at = captured;
      } catch (e) {
        logger.warn(`processPhoto: EXIF extraction failed for ${photoId}`, { error: e.message });
      }
    }

    if (isVideo) {
      const videoThumbnailKey = path.posix.join(
        'thumbnails',
        `thumb_${photo.filename.replace(/\.[^.]+$/, '.jpg')}`
      );
      const result = await processUploadedVideo(localPath, videoThumbnailKey);
      updateData.thumbnail_path = result.thumbnailKey;
      if (result.metadata) {
        if (result.metadata.duration != null) updateData.duration = result.metadata.duration;
        if (result.metadata.videoCodec) updateData.video_codec = result.metadata.videoCodec;
        if (result.metadata.audioCodec) updateData.audio_codec = result.metadata.audioCodec;
        if (result.metadata.width) updateData.width = result.metadata.width;
        if (result.metadata.height) updateData.height = result.metadata.height;
      }
    } else {
      try {
        const thumbnailPath = await generateThumbnail(localPath);
        if (thumbnailPath) updateData.thumbnail_path = thumbnailPath;
      } catch (e) {
        logger.warn(`processPhoto: thumbnail generation failed for ${photoId}`, { error: e.message });
      }
      try {
        const sharp = require('sharp');
        const metadata = await sharp(localPath).metadata();
        if (metadata.width && metadata.height) {
          updateData.width = metadata.width;
          updateData.height = metadata.height;
        }
      } catch (e) {
        logger.warn(`processPhoto: dimensions extraction failed for ${photoId}`, { error: e.message });
      }
    }
  });

  // Mark complete
  updateData.processing_status = 'complete';
  updateData.processing_error = null;
  await db('photos').where({ id: photoId }).update(updateData);

  // Side effects (best-effort, never fail the photo if these break)
  if (!isVideo) {
    const watermarkGeneratorService = require('./watermarkGeneratorService');
    watermarkGeneratorService
      .generateForPhoto(photoId)
      .catch((err) => logger.warn(`processPhoto: watermark queue failed for ${photoId}`, { error: err.message }));
  }

  try {
    const webhookService = require('./webhookService');
    await webhookService.fire('photo.uploaded', {
      event: { id: event.id, slug: event.slug, event_name: event.event_name },
      photo: {
        id: photo.id,
        filename: photo.filename,
        original_filename: photo.original_filename,
        size_bytes: photo.size_bytes,
      },
    });
  } catch (e) {
    logger.warn(`processPhoto: webhook fire failed for ${photoId}`, { error: e.message });
  }

  return updateData;
}

module.exports = {
  processUploadedPhotos,
  queueFilesForProcessing,
  processPhoto
};
