const sharp = require('sharp');
const exifr = require('exifr');
const path = require('path');
const fsp = require('fs').promises;
const os = require('os');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { db } = require('../database/db');
const { getStorage } = require('./storage');

// Configure sharp for better memory management with large batches
sharp.cache(false); // Disable cache to prevent memory buildup
sharp.concurrency(2); // Limit concurrent operations

// Default thumbnail settings
const DEFAULT_THUMBNAIL_WIDTH = 300;
const DEFAULT_THUMBNAIL_HEIGHT = 300;
// 'inside' preserves the source aspect ratio (output ≤ width × height).
// This is the right default for masonry / mosaic / justified layouts —
// the gallery sizes each card from photo.width/height and renders the
// thumbnail with object-cover, so a thumb that already matches the
// source aspect doesn't get re-cropped (#447). Admins who want
// uniform 1:1 grid tiles can switch to 'cover' in the thumbnail settings.
const DEFAULT_THUMBNAIL_FIT = 'inside';
const DEFAULT_THUMBNAIL_QUALITY = 85;
const DEFAULT_THUMBNAIL_FORMAT = 'jpeg';

// Hero image settings - optimized for large displays
const DEFAULT_HERO_WIDTH = 1920;
const DEFAULT_HERO_HEIGHT = 1080;
const DEFAULT_HERO_QUALITY = 85;

// Preview tier (#492). Aspect-preserved downscale for the lightbox so
// guests don't pay the full 5–12 MB original on every photo open.
// Same long edge as the hero (admins are already sizing for it) and
// quality 85 — JPEG artefacts at this size are imperceptible to clients
// browsing on phones / Retina laptops, and storage cost stays modest
// (~200–500 KB per photo vs originals at multi-MB).
const DEFAULT_PREVIEW_LONG_EDGE = 1920;
const DEFAULT_PREVIEW_QUALITY = 85;

// Helper to parse setting value (handles both JSON-encoded and plain values)
function parseSettingValue(value) {
  if (value === null || value === undefined) {
    return null;
  }
  // Try to parse as JSON first (in case it's a JSON-encoded string like '"cover"')
  try {
    return JSON.parse(value);
  } catch (e) {
    // If it's not valid JSON, return the raw value
    return value;
  }
}

// Validate that fit value is valid for Sharp
function validateFitValue(fit) {
  const validFitValues = ['cover', 'contain', 'fill', 'inside', 'outside'];
  if (fit && validFitValues.includes(fit)) {
    return fit;
  }
  return DEFAULT_THUMBNAIL_FIT;
}

// Get thumbnail settings from database
async function getThumbnailSettings() {
  try {
    const settings = await db('app_settings')
      .whereIn('setting_key', [
        'thumbnail_width',
        'thumbnail_height',
        'thumbnail_fit',
        'thumbnail_quality',
        'thumbnail_format'
      ])
      .select('setting_key', 'setting_value');

    const settingsMap = {};
    settings.forEach(s => {
      settingsMap[s.setting_key] = parseSettingValue(s.setting_value);
    });

    // Parse and validate fit value
    const fitValue = validateFitValue(settingsMap.thumbnail_fit);

    return {
      width: parseInt(settingsMap.thumbnail_width) || DEFAULT_THUMBNAIL_WIDTH,
      height: parseInt(settingsMap.thumbnail_height) || DEFAULT_THUMBNAIL_HEIGHT,
      fit: fitValue,
      quality: parseInt(settingsMap.thumbnail_quality) || DEFAULT_THUMBNAIL_QUALITY,
      format: settingsMap.thumbnail_format || DEFAULT_THUMBNAIL_FORMAT
    };
  } catch (error) {
    // If database is not ready or settings don't exist, use defaults
    logger.warn('Could not fetch thumbnail settings, using defaults:', error.message);
    return {
      width: DEFAULT_THUMBNAIL_WIDTH,
      height: DEFAULT_THUMBNAIL_HEIGHT,
      fit: DEFAULT_THUMBNAIL_FIT,
      quality: DEFAULT_THUMBNAIL_QUALITY,
      format: DEFAULT_THUMBNAIL_FORMAT
    };
  }
}

const contentTypeFor = (format) => {
  if (format === 'png') return 'image/png';
  if (format === 'webp') return 'image/webp';
  return 'image/jpeg';
};

/**
 * Generate a thumbnail from a local source image path. The output is written
 * to the storage backend (local fs or S3) under `thumbnails/thumb_<filename>`
 * and the relative storage key is returned for DB persistence.
 *
 * Callers must ensure the source is on the local filesystem. For S3 mode
 * regeneration flows, fetch via `withLocalCopy(storage, sourceKey, fn)` first.
 *
 * options.outputBasename — override the basename portion of the thumbnail
 * filename (default: basename of imagePath). Used for external/reference
 * photos where the source basename can collide across events (#423) — the
 * import path passes a per-photo unique basename so two events both
 * referencing `IMG_0001.jpg` don't clobber each other's thumbnail.
 */
async function generateThumbnail(imagePath, options = {}) {
  const sourceBasename = path.basename(imagePath);
  const outputBasename = options.outputBasename || sourceBasename;
  const thumbnailFilename = `thumb_${outputBasename}`;
  const thumbnailRelKey = path.posix.join('thumbnails', thumbnailFilename);
  const storage = getStorage();

  // Get thumbnail settings
  const settings = await getThumbnailSettings();

  // Force regeneration: drop the existing object before writing the new one
  if (options.regenerate) {
    await storage.delete(thumbnailRelKey).catch(() => {});
  }

  try {
    // First, verify the source image is complete and valid
    const metadata = await sharp(imagePath).metadata();

    if (!metadata.width || !metadata.height) {
      throw new Error('Invalid image metadata - file may be incomplete');
    }

    let sharpInstance = sharp(imagePath, {
      limitInputPixels: 268402689, // ~16k x 16k max
      sequentialRead: true,
      failOnError: false
    });

    // Strip EXIF/metadata from thumbnails (privacy: prevent GPS leak etc.)
    sharpInstance = sharpInstance.withMetadata(false);

    sharpInstance = sharpInstance.resize(settings.width, settings.height, {
      withoutEnlargement: true,
      fit: settings.fit,
      position: 'center'
    });

    if (settings.format === 'jpeg') {
      sharpInstance = sharpInstance.jpeg({
        quality: settings.quality,
        progressive: true,
        mozjpeg: true
      });
    } else if (settings.format === 'png') {
      sharpInstance = sharpInstance.png({
        quality: settings.quality,
        compressionLevel: 9,
        progressive: true
      });
    } else if (settings.format === 'webp') {
      sharpInstance = sharpInstance.webp({
        quality: settings.quality,
        effort: 4
      });
    }

    const buffer = await sharpInstance.toBuffer();
    if (!buffer || buffer.length === 0) {
      throw new Error('Generated thumbnail is empty');
    }

    await storage.put(thumbnailRelKey, buffer, { contentType: contentTypeFor(settings.format) });

    return thumbnailRelKey;
  } catch (error) {
    const msg = (error && error.message) ? error.message : String(error);
    logger.error(`Failed to generate thumbnail for ${sourceBasename}: ${msg}`);

    // Clean up any partially uploaded object
    await storage.delete(thumbnailRelKey).catch(() => {});

    return null;
  }
}

/**
 * Check if a thumbnail exists and is valid. For local-fs storage we open the
 * file with sharp to confirm it parses; for S3 we trust the byte-integrity
 * checks built into the protocol and only verify size > 0.
 */
async function isThumbnailValid(thumbnailPath) {
  const storage = getStorage();
  try {
    const stat = await storage.stat(thumbnailPath);
    if (!stat || stat.size === 0) {
      return false;
    }
    if (storage.kind() === 'local') {
      const localPath = storage.resolveLocalPath(thumbnailPath);
      await sharp(localPath).metadata();
    }
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Wraps a callback that needs the source image as a local file. In local-fs
 * mode the storage path is used directly (no copy); in S3 mode the object is
 * streamed to a tmp file which is removed afterwards.
 */
async function withLocalCopy(sourceKey, fn) {
  const storage = getStorage();
  if (storage.kind() === 'local') {
    return fn(storage.resolveLocalPath(sourceKey));
  }
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'picpeak-src-'));
  const tmpPath = path.join(tmpDir, `${crypto.randomBytes(4).toString('hex')}_${path.basename(sourceKey)}`);
  try {
    await storage.getToFile(sourceKey, tmpPath);
    return await fn(tmpPath);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Regenerate thumbnail if it's broken or missing.
 *
 * Works for both managed photos (stored via the storage backend, possibly
 * S3) and external/reference photos (#423 — sourced from a local mount
 * outside the managed storage tree, e.g. NAS over SMB/NFS). External
 * photos historically had thumbnail_path=null, which forced the gallery
 * to fall back to streaming the full original on every tile — minutes of
 * load time for a 100-photo NAS-mounted gallery.
 */
async function ensureThumbnail(photo) {
  const { resolvePhotoStorageKey, resolvePhotoFilePath } = require('./photoResolver');

  const event = await db('events').where('id', photo.event_id).first();
  if (!event) {
    logger.error(`ensureThumbnail: event ${photo.event_id} not found for photo ${photo.id}`);
    return null;
  }

  // Check if thumbnail exists and is valid (works for any source).
  if (photo.thumbnail_path) {
    const isValid = await isThumbnailValid(photo.thumbnail_path);
    if (isValid) {
      return photo.thumbnail_path;
    }
    logger.warn(`Invalid thumbnail detected for photo ${photo.id}, regenerating...`);
  }

  const isExternal = photo.source_origin === 'external' || photo.source_origin === 'reference';

  let newThumbnailPath;
  if (isExternal) {
    // External: source is on a local mount path. No withLocalCopy needed
    // (storage-backend abstraction doesn't apply — this is a direct fs
    // read). Use a per-photo unique outputBasename so two events both
    // referencing the same NAS basename can't clobber each other's thumb.
    let localPath;
    try {
      localPath = resolvePhotoFilePath(event, photo);
    } catch (e) {
      logger.error(`Failed to resolve external file for thumbnail (photo ${photo.id}): ${e.message}`);
      return null;
    }
    const sourceBasename = path.basename(photo.external_relpath || photo.filename || `photo-${photo.id}`);
    const outputBasename = `ext${photo.id}_${sourceBasename}`;
    logger.info(`Ensuring thumbnail for external photo ${photo.id} from ${localPath}`);
    newThumbnailPath = await generateThumbnail(localPath, { regenerate: true, outputBasename });
  } else {
    let sourceKey;
    try {
      sourceKey = resolvePhotoStorageKey(event, photo);
    } catch (e) {
      logger.error(`Failed to resolve original key for thumbnail (photo ${photo.id}): ${e.message}`);
      return null;
    }
    logger.info(`Ensuring thumbnail for photo ${photo.id} from key: ${sourceKey}`);
    newThumbnailPath = await withLocalCopy(sourceKey, (localPath) =>
      generateThumbnail(localPath, { regenerate: true })
    );
  }

  if (newThumbnailPath) {
    await db('photos')
      .where({ id: photo.id })
      .update({ thumbnail_path: newThumbnailPath });

    logger.info(`Regenerated thumbnail for photo ${photo.id}`);
    return newThumbnailPath;
  }

  return null;
}

async function generateVideoPlaceholder(originalFilename, options = {}) {
  const parsed = path.parse(originalFilename || '');
  const baseName = parsed.name || 'video';
  const thumbnailFilename = `thumb_${baseName}.jpg`;
  const thumbnailRelKey = path.posix.join('thumbnails', thumbnailFilename);
  const storage = getStorage();

  const settings = await getThumbnailSettings();
  const width = settings.width || DEFAULT_THUMBNAIL_WIDTH;
  const height = settings.height || DEFAULT_THUMBNAIL_HEIGHT;

  if (options.regenerate) {
    await storage.delete(thumbnailRelKey).catch(() => {});
  }

  try {
    const svg = `
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#0f172a" stop-opacity="0.9"/>
            <stop offset="100%" stop-color="#1e293b" stop-opacity="0.9"/>
          </linearGradient>
        </defs>
        <rect width="${width}" height="${height}" rx="18" fill="url(#grad)"/>
        <circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) / 6}" fill="rgba(255,255,255,0.85)"/>
        <polygon points="${width / 2 - 10},${height / 2 - 14} ${width / 2 - 10},${height / 2 + 14} ${width / 2 + 16},${height / 2}" fill="#0f172a"/>
        <text x="50%" y="${height - 18}" font-family="Arial, sans-serif" font-size="16" fill="rgba(255,255,255,0.9)" text-anchor="middle">
          VIDEO
        </text>
      </svg>
    `;

    const buffer = await sharp(Buffer.from(svg))
      .resize(width, height, { fit: 'cover' })
      .jpeg({ quality: settings.quality || DEFAULT_THUMBNAIL_QUALITY })
      .toBuffer();

    await storage.put(thumbnailRelKey, buffer, { contentType: 'image/jpeg' });

    return thumbnailRelKey;
  } catch (error) {
    logger.error('Failed to generate video placeholder thumbnail:', error.message);
    return null;
  }
}

/**
 * Generate a hero-optimized image for gallery headers
 * Outputs a 1920x1080 image suitable for full-width hero sections
 */
async function generateHeroImage(imagePath, options = {}) {
  const filename = path.basename(imagePath);
  const heroFilename = `hero_${filename}`;
  const heroRelKey = path.posix.join('heroes', heroFilename);
  const storage = getStorage();

  if (options.regenerate) {
    await storage.delete(heroRelKey).catch(() => {});
  }

  try {
    const metadata = await sharp(imagePath).metadata();

    if (!metadata.width || !metadata.height) {
      throw new Error('Invalid image metadata - file may be incomplete');
    }

    const heroWidth = options.width || DEFAULT_HERO_WIDTH;
    const heroHeight = options.height || DEFAULT_HERO_HEIGHT;
    const quality = options.quality || DEFAULT_HERO_QUALITY;

    let sharpInstance = sharp(imagePath, {
      limitInputPixels: 268402689,
      sequentialRead: true,
      failOnError: false
    });

    // Strip EXIF/metadata from hero images (privacy: prevent GPS leak etc.)
    sharpInstance = sharpInstance.withMetadata(false);

    sharpInstance = sharpInstance.resize(heroWidth, heroHeight, {
      withoutEnlargement: false,
      fit: 'cover',
      position: 'center'
    });

    sharpInstance = sharpInstance.jpeg({
      quality: quality,
      progressive: true,
      mozjpeg: true
    });

    const buffer = await sharpInstance.toBuffer();
    if (!buffer || buffer.length === 0) {
      throw new Error('Generated hero image is empty');
    }

    await storage.put(heroRelKey, buffer, { contentType: 'image/jpeg' });

    logger.info(`Generated hero image for ${filename} → ${heroRelKey}`);
    return heroRelKey;
  } catch (error) {
    const msg = (error && error.message) ? error.message : String(error);
    logger.error(`Failed to generate hero image for ${filename}: ${msg}`);
    await storage.delete(heroRelKey).catch(() => {});
    return null;
  }
}

/**
 * Check if a hero image exists and is valid
 */
async function isHeroValid(heroPath) {
  const storage = getStorage();
  try {
    const stat = await storage.stat(heroPath);
    if (!stat || stat.size === 0) {
      return false;
    }
    if (storage.kind() === 'local') {
      const localPath = storage.resolveLocalPath(heroPath);
      await sharp(localPath).metadata();
    }
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Ensure a hero image exists for a photo, regenerate if needed
 */
async function ensureHeroImage(photo) {
  const { resolvePhotoStorageKey } = require('./photoResolver');

  let sourceKey;
  try {
    const event = await db('events').where('id', photo.event_id).first();
    sourceKey = resolvePhotoStorageKey(event, photo);
    logger.info(`Ensuring hero image for photo ${photo.id} from key: ${sourceKey}`);
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    logger.error(`Failed to resolve original key for hero image (photo ${photo.id}): ${msg}`);
    return null;
  }

  if (photo.hero_path) {
    const isValid = await isHeroValid(photo.hero_path);
    if (isValid) {
      return photo.hero_path;
    }
    logger.warn(`Invalid hero image detected for photo ${photo.id}, regenerating...`);
  }

  const newHeroPath = await withLocalCopy(sourceKey, (localPath) =>
    generateHeroImage(localPath, { regenerate: true })
  );

  if (newHeroPath) {
    await db('photos')
      .where({ id: photo.id })
      .update({ hero_path: newHeroPath });

    logger.info(`Regenerated hero image for photo ${photo.id}`);
    return newHeroPath;
  }

  return null;
}

/**
 * Generate a lightbox preview image (#492).
 *
 * Aspect-preserving downscale (`fit: 'inside'`) capped at
 * DEFAULT_PREVIEW_LONG_EDGE. Distinct from generateHeroImage:
 *   - hero  → 1920x1080 cover-cropped (gallery hero header banner)
 *   - preview → ≤1920px long edge, aspect preserved (lightbox tile)
 *
 * Output to `previews/preview_<filename>` so an admin who flips the
 * setting back off can wipe the folder cleanly without touching
 * thumbnails or heroes.
 */
async function generatePreviewImage(imagePath, options = {}) {
  const filename = path.basename(imagePath);
  const previewFilename = `preview_${filename}`;
  const previewRelKey = path.posix.join('previews', previewFilename);
  const storage = getStorage();

  if (options.regenerate) {
    await storage.delete(previewRelKey).catch(() => {});
  }

  try {
    const metadata = await sharp(imagePath).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error('Invalid image metadata - file may be incomplete');
    }

    const longEdge = options.longEdge || DEFAULT_PREVIEW_LONG_EDGE;
    const quality = options.quality || DEFAULT_PREVIEW_QUALITY;

    let sharpInstance = sharp(imagePath, {
      limitInputPixels: 268402689, // ~16k x 16k max
      sequentialRead: true,
      failOnError: false,
    });

    // Strip EXIF — same privacy reasoning as thumbnails/heroes.
    sharpInstance = sharpInstance.withMetadata(false);

    // fit: 'inside' + withoutEnlargement keeps small originals at
    // their native size (no upscaling artefacts) and shrinks larger
    // ones until both dimensions fit inside longEdge×longEdge.
    sharpInstance = sharpInstance.resize(longEdge, longEdge, {
      withoutEnlargement: true,
      fit: 'inside',
    });

    sharpInstance = sharpInstance.jpeg({
      quality,
      progressive: true,
      mozjpeg: true,
    });

    const buffer = await sharpInstance.toBuffer();
    if (!buffer || buffer.length === 0) {
      throw new Error('Generated preview image is empty');
    }

    await storage.put(previewRelKey, buffer, { contentType: 'image/jpeg' });

    logger.info(`Generated preview image for ${filename} → ${previewRelKey}`);
    return previewRelKey;
  } catch (error) {
    const msg = (error && error.message) ? error.message : String(error);
    logger.error(`Failed to generate preview image for ${filename}: ${msg}`);
    await storage.delete(previewRelKey).catch(() => {});
    return null;
  }
}

/**
 * Validate an existing preview file is non-empty + readable by Sharp.
 * Mirrors isHeroValid / isThumbnailValid.
 */
async function isPreviewValid(previewPath) {
  const storage = getStorage();
  try {
    const stat = await storage.stat(previewPath);
    if (!stat || stat.size === 0) return false;
    if (storage.kind() === 'local') {
      const localPath = storage.resolveLocalPath(previewPath);
      await sharp(localPath).metadata();
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Lazy-generate the preview image for a photo if missing or invalid.
 * Returns the storage key or null on failure (callers fall back to
 * the original URL so the lightbox never shows a broken image).
 */
async function ensurePreviewImage(photo) {
  const { resolvePhotoStorageKey } = require('./photoResolver');

  let sourceKey;
  try {
    const event = await db('events').where('id', photo.event_id).first();
    sourceKey = resolvePhotoStorageKey(event, photo);
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    logger.error(`Failed to resolve original key for preview (photo ${photo.id}): ${msg}`);
    return null;
  }

  if (photo.preview_path) {
    const ok = await isPreviewValid(photo.preview_path);
    if (ok) return photo.preview_path;
    logger.warn(`Invalid preview detected for photo ${photo.id}, regenerating…`);
  }

  const newPreviewPath = await withLocalCopy(sourceKey, (localPath) =>
    generatePreviewImage(localPath, { regenerate: true })
  );

  if (newPreviewPath) {
    await db('photos').where({ id: photo.id }).update({ preview_path: newPreviewPath });
    return newPreviewPath;
  }

  return null;
}

/**
 * Extract capture date from EXIF metadata
 */
async function extractCaptureDate(imagePath) {
  try {
    const exif = await exifr.parse(imagePath, {
      pick: ['DateTimeOriginal', 'CreateDate', 'DateTimeDigitized', 'ModifyDate']
    });

    if (!exif) {
      return null;
    }

    const captureDate = exif.DateTimeOriginal ||
                        exif.CreateDate ||
                        exif.DateTimeDigitized ||
                        exif.ModifyDate;

    if (captureDate) {
      if (captureDate instanceof Date) {
        const now = new Date();
        const minDate = new Date('1990-01-01');
        if (captureDate > minDate && captureDate <= now) {
          return captureDate;
        }
      }
      if (typeof captureDate === 'string') {
        const parsed = new Date(captureDate);
        if (!isNaN(parsed.getTime())) {
          return parsed;
        }
      }
    }

    return null;
  } catch (error) {
    logger.debug(`Could not extract EXIF date from ${path.basename(imagePath)}:`, error.message);
    return null;
  }
}

module.exports = {
  generateThumbnail,
  isThumbnailValid,
  ensureThumbnail,
  generateVideoPlaceholder,
  generateHeroImage,
  isHeroValid,
  ensureHeroImage,
  generatePreviewImage,
  isPreviewValid,
  ensurePreviewImage,
  extractCaptureDate,
  withLocalCopy,
};
