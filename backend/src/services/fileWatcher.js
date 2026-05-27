const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs').promises;
const sharp = require('sharp');
const { db } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const { generateThumbnail, generateVideoPlaceholder } = require('./imageProcessor');
const logger = require('../utils/logger');
const { isVideoMimeType } = require('./videoProcessor');
const mime = require('mime-types');
const downloadZipService = require('./downloadZipService');

const getStoragePath = () => process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');
const WATCH_PATH = () => path.join(getStoragePath(), 'events/active');

function startFileWatcher() {
  // Auto-import via filesystem watching only works with the local storage
  // backend. In S3 mode there is no local directory to watch — every photo
  // must enter through the admin upload API. Skip cleanly with a clear log
  // so operators aren't surprised by the missing feature.
  const backend = (process.env.STORAGE_BACKEND || 'local').toLowerCase();
  if (backend !== 'local') {
    logger.warn(`[fileWatcher] auto-import disabled — STORAGE_BACKEND=${backend}. Use the admin upload API instead.`);
    return null;
  }

  const watcher = chokidar.watch(WATCH_PATH(), {
    ignored: /(^|[\/\\])\../, // ignore dotfiles
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 100
    }
  });

  watcher
    .on('add', async (filePath) => {
      try {
        await processNewPhoto(filePath);
      } catch (error) {
        logger.error('Error processing new photo:', error);
      }
    })
    .on('unlink', async (filePath) => {
      try {
        await removePhoto(filePath);
      } catch (error) {
        logger.error('Error removing photo:', error);
      }
    });

  logger.info('File watcher started');
}

async function processNewPhoto(filePath) {
  const relativePath = path.relative(WATCH_PATH(), filePath);
  const pathParts = relativePath.split(path.sep);
  
  if (pathParts.length < 2) return; // Not in correct folder structure
  
  const eventSlug = pathParts[0];
  const photoType = pathParts[1] === 'collages' ? 'collage' : 'individual';
  
  // Check if this is an image or video file
  const ext = path.extname(filePath).toLowerCase();
  const detectedMime = mime.lookup(filePath) || '';
  const isVideo = isVideoMimeType(detectedMime, filePath) || ['.mp4', '.mov', '.webm'].includes(ext);
  if (!isVideo && !['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) return;
  
  // Skip temporary upload files
  const filename = path.basename(filePath);
  if (filename.startsWith('temp_')) {
    logger.debug(`Skipping temporary upload file: ${filename}`);
    return;
  }
  
  // Find the event
  const event = await db('events').where({ slug: eventSlug, is_active: formatBoolean(true) }).first();
  if (!event) return;
  
  // Get file stats
  const stats = await fs.stat(filePath);
  
  // Generate thumbnail or placeholder
  let thumbnailPath = null;
  if (isVideo) {
    thumbnailPath = await generateVideoPlaceholder(filename);
  } else {
    thumbnailPath = await generateThumbnail(filePath);
  }
  
  // Calculate relative thumbnail path
  const relativeThumbPath = thumbnailPath; // thumbnailPath is already relative to storage root
  const mimeType = detectedMime || (isVideo ? 'video/mp4' : 'image/jpeg');

  // Capture image dimensions so aspect-aware layouts (masonry / mosaic /
  // justified) can size each card to the photo's real proportions
  // instead of the 800×600 fallback in MasonryGalleryLayout (#447).
  // Skip videos — those would need ffprobe.
  let dimensions = null;
  if (!isVideo) {
    try {
      const metadata = await sharp(filePath).metadata();
      if (metadata.width && metadata.height) {
        dimensions = { width: metadata.width, height: metadata.height };
      }
    } catch (err) {
      logger.debug(`Could not read image dimensions for ${filename}: ${err.message}`);
    }
  }

  // Check if photo already exists (by filename or path, to handle replacements)
  const existingPhoto = await db('photos')
    .where({ event_id: event.id })
    .where(function() {
      this.where('filename', path.basename(filePath))
        .orWhere('path', relativePath);
    })
    .first();

  if (!existingPhoto) {
    // Add to database
    const insertResult = await db('photos').insert({
      event_id: event.id,
      filename: path.basename(filePath),
      path: relativePath,
      thumbnail_path: relativeThumbPath,
      type: isVideo ? 'video' : photoType,
      size_bytes: stats.size,
      mime_type: mimeType,
      ...(dimensions && { width: dimensions.width, height: dimensions.height })
    }).returning('id');
    const photoId = insertResult[0]?.id || insertResult[0];

    logger.info(`Added new photo: ${relativePath}`);
    downloadZipService.invalidate(event.id);

    // Webhook (#327) — auto-import path. Only fires in local mode since
    // the watcher is disabled in S3 mode.
    try {
      const webhookService = require('./webhookService');
      await webhookService.fire('photo.uploaded', {
        event: { id: event.id, slug: event.slug, event_name: event.event_name },
        photo: { id: photoId, filename: path.basename(filePath), size_bytes: stats.size, source: 'auto-import' },
      });
    } catch (e) { /* non-fatal */ }
  } else {
    logger.debug(`Photo already exists: ${relativePath}`);
  }
}

async function removePhoto(filePath) {
  const relativePath = path.relative(WATCH_PATH(), filePath);

  // Look up event before deleting to invalidate zip cache
  const photo = await db('photos').where({ path: relativePath }).first();

  // Remove from database
  await db('photos').where({ path: relativePath }).delete();

  if (photo) {
    downloadZipService.invalidate(photo.event_id);

    // Webhook (#327) — fire only if the row actually existed.
    try {
      const event = await db('events').where({ id: photo.event_id }).first();
      const webhookService = require('./webhookService');
      await webhookService.fire('photo.deleted', {
        event: { id: photo.event_id, slug: event?.slug, event_name: event?.event_name },
        photo: { id: photo.id, filename: photo.filename, source: 'auto-import' },
      });
    } catch (e) { /* non-fatal */ }
  }

  logger.info(`Removed photo: ${relativePath}`);
}

module.exports = { startFileWatcher };
