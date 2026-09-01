const { db } = require('../database/db');
const logger = require('../utils/logger');

const DEFAULT_MAX_FILES_PER_UPLOAD = 500;
const MAX_ALLOWED_FILES_PER_UPLOAD = 2000;
const CACHE_TTL_MS = 60_000;

// Per-file upload size limit (general_max_file_size_mb). The admin sets this in
// Settings → General; the default mirrors the frontend's default (50 MB). A
// hard ceiling keeps a fat-fingered value from disabling multer's guard.
const DEFAULT_MAX_FILE_SIZE_MB = 50;
const MAX_ALLOWED_FILE_SIZE_MB = 10 * 1024; // 10 GB — matches the admin path's cap

// Separate per-file cap for videos (general_max_video_size_mb). A single cap
// for both meant a 50 MB photo limit also blocked every normal clip, so an
// admin had to raise the photo limit to upload a video. 500 MB is roughly a
// few minutes of phone footage; the same 10 GB hard ceiling applies.
const DEFAULT_MAX_VIDEO_SIZE_MB = 500;

let cachedValue = DEFAULT_MAX_FILES_PER_UPLOAD;
let cacheExpiresAt = 0;

let cachedFileSizeMb = DEFAULT_MAX_FILE_SIZE_MB;
let fileSizeCacheExpiresAt = 0;

let cachedVideoSizeMb = DEFAULT_MAX_VIDEO_SIZE_MB;
let videoSizeCacheExpiresAt = 0;

// Map of file extension to MIME type(s)
const EXTENSION_TO_MIME = {
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'png': 'image/png',
  'webp': 'image/webp',
  'gif': 'image/gif',
  'mp4': 'video/mp4',
  'm4v': 'video/mp4',
  'webm': 'video/webm',
  'mov': 'video/quicktime',
  'avi': 'video/x-msvideo',
  // HEIC/HEIF (iPhone). Sharp's bundled libvips decodes `heif` input, so
  // thumbnails generate fine. (iOS Safari usually transcodes to JPEG at file
  // selection, but a genuine .heic upload is handled when it does arrive.)
  'heic': 'image/heic',
  'heif': 'image/heif',
  // Camera RAW / Apple ProRAW. Not sharp-decodable directly — the processing
  // pipeline extracts the embedded JPEG preview (exiftool) for thumbnails/
  // display, keeping the original for download. Browsers send DNG as
  // image/x-adobe-dng, image/tiff, or an empty type, so accept the common set.
  'dng': 'image/x-adobe-dng',
};

const DEFAULT_ALLOWED_FILE_TYPES = 'jpg,jpeg,png,webp';

let cachedAllowedTypes = null;
let allowedTypesCacheExpiresAt = 0;

const parseSettingValue = (setting) => {
  if (!setting || setting.setting_value == null) {
    return null;
  }

  let rawValue = setting.setting_value;

  if (typeof rawValue === 'string') {
    try {
      rawValue = JSON.parse(rawValue);
    } catch {
      // keep original string
    }
  }

  if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim();
    if (trimmed === '') {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (typeof rawValue === 'number') {
    return rawValue;
  }

  return null;
};

const normalizeLimit = (value) => {
  if (!Number.isFinite(value)) {
    return DEFAULT_MAX_FILES_PER_UPLOAD;
  }

  const intValue = Math.floor(value);
  if (intValue < 1) {
    return DEFAULT_MAX_FILES_PER_UPLOAD;
  }
  if (intValue > MAX_ALLOWED_FILES_PER_UPLOAD) {
    return MAX_ALLOWED_FILES_PER_UPLOAD;
  }
  return intValue;
};

const getMaxFilesPerUpload = async () => {
  if (Date.now() < cacheExpiresAt) {
    return cachedValue;
  }

  try {
    const setting = await db('app_settings')
      .where({ setting_key: 'general_max_files_per_upload' })
      .first();

    const parsedValue = normalizeLimit(parseSettingValue(setting));
    cachedValue = parsedValue;
    cacheExpiresAt = Date.now() + CACHE_TTL_MS;
    return parsedValue;
  } catch (error) {
    logger.error('Failed to read max files per upload setting:', error.message);
    cachedValue = DEFAULT_MAX_FILES_PER_UPLOAD;
    cacheExpiresAt = Date.now() + CACHE_TTL_MS;
    return DEFAULT_MAX_FILES_PER_UPLOAD;
  }
};

const clearMaxFilesPerUploadCache = () => {
  cacheExpiresAt = 0;
};

const normalizeFileSizeMb = (value, fallbackMb = DEFAULT_MAX_FILE_SIZE_MB) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallbackMb;
  }
  const intValue = Math.floor(value);
  if (intValue < 1) return fallbackMb;
  if (intValue > MAX_ALLOWED_FILE_SIZE_MB) return MAX_ALLOWED_FILE_SIZE_MB;
  return intValue;
};

/**
 * Per-file upload size limit in MB (general_max_file_size_mb). Cached 60s, same
 * as the other upload settings. Falls back to the default on a read error.
 */
const getMaxFileSizeMb = async () => {
  if (Date.now() < fileSizeCacheExpiresAt) {
    return cachedFileSizeMb;
  }

  try {
    const setting = await db('app_settings')
      .where({ setting_key: 'general_max_file_size_mb' })
      .first();

    const parsedValue = normalizeFileSizeMb(parseSettingValue(setting));
    cachedFileSizeMb = parsedValue;
    fileSizeCacheExpiresAt = Date.now() + CACHE_TTL_MS;
    return parsedValue;
  } catch (error) {
    logger.error('Failed to read max file size setting:', error.message);
    cachedFileSizeMb = DEFAULT_MAX_FILE_SIZE_MB;
    fileSizeCacheExpiresAt = Date.now() + CACHE_TTL_MS;
    return DEFAULT_MAX_FILE_SIZE_MB;
  }
};

/** Per-file upload size limit in bytes — convenience for multer `limits.fileSize`. */
const getMaxFileSizeBytes = async () => {
  const mb = await getMaxFileSizeMb();
  return mb * 1024 * 1024;
};

const clearMaxFileSizeCache = () => {
  fileSizeCacheExpiresAt = 0;
};

/**
 * Per-file upload size limit for videos in MB (general_max_video_size_mb).
 * Same read/cache/clamp contract as getMaxFileSizeMb(); falls back to the
 * video default (not the photo one) when the setting is absent.
 */
const getMaxVideoSizeMb = async () => {
  if (Date.now() < videoSizeCacheExpiresAt) {
    return cachedVideoSizeMb;
  }

  try {
    const setting = await db('app_settings')
      .where({ setting_key: 'general_max_video_size_mb' })
      .first();

    const parsedValue = normalizeFileSizeMb(parseSettingValue(setting), DEFAULT_MAX_VIDEO_SIZE_MB);
    cachedVideoSizeMb = parsedValue;
    videoSizeCacheExpiresAt = Date.now() + CACHE_TTL_MS;
    return parsedValue;
  } catch (error) {
    logger.error('Failed to read max video size setting:', error.message);
    cachedVideoSizeMb = DEFAULT_MAX_VIDEO_SIZE_MB;
    videoSizeCacheExpiresAt = Date.now() + CACHE_TTL_MS;
    return DEFAULT_MAX_VIDEO_SIZE_MB;
  }
};

/** Per-file video size limit in bytes — convenience for multer `limits.fileSize`. */
const getMaxVideoSizeBytes = async () => {
  const mb = await getMaxVideoSizeMb();
  return mb * 1024 * 1024;
};

const clearMaxVideoSizeCache = () => {
  videoSizeCacheExpiresAt = 0;
};

/**
 * Convert a comma-separated list of file extensions into an array of MIME types.
 * Unknown extensions are silently ignored.
 */
const extensionsToMimeTypes = (extString) => {
  if (!extString || typeof extString !== 'string') {
    return extensionsToMimeTypes(DEFAULT_ALLOWED_FILE_TYPES);
  }

  const mimeSet = new Set();
  extString.split(',').forEach(ext => {
    const cleaned = ext.trim().toLowerCase().replace(/^\./, '');
    const mime = EXTENSION_TO_MIME[cleaned];
    if (mime) {
      mimeSet.add(mime);
    }
  });

  if (mimeSet.size === 0) {
    return extensionsToMimeTypes(DEFAULT_ALLOWED_FILE_TYPES);
  }

  return Array.from(mimeSet);
};

/**
 * Get the allowed MIME types for uploads from the database setting.
 * Returns an array of MIME type strings, e.g. ['image/jpeg', 'image/png', 'video/mp4'].
 */
const getAllowedMimeTypes = async () => {
  if (Date.now() < allowedTypesCacheExpiresAt && cachedAllowedTypes) {
    return cachedAllowedTypes;
  }

  try {
    const setting = await db('app_settings')
      .where({ setting_key: 'general_allowed_file_types' })
      .first();

    let rawValue = setting?.setting_value;
    if (typeof rawValue === 'string') {
      try { rawValue = JSON.parse(rawValue); } catch { /* keep string */ }
    }

    const mimeTypes = extensionsToMimeTypes(rawValue);
    cachedAllowedTypes = mimeTypes;
    allowedTypesCacheExpiresAt = Date.now() + CACHE_TTL_MS;
    return mimeTypes;
  } catch (error) {
    logger.error('Failed to read allowed file types setting:', error.message);
    const fallback = extensionsToMimeTypes(DEFAULT_ALLOWED_FILE_TYPES);
    cachedAllowedTypes = fallback;
    allowedTypesCacheExpiresAt = Date.now() + CACHE_TTL_MS;
    return fallback;
  }
};

const clearAllowedTypesCache = () => {
  allowedTypesCacheExpiresAt = 0;
  cachedAllowedTypes = null;
};

module.exports = {
  getMaxFilesPerUpload,
  clearMaxFilesPerUploadCache,
  getMaxFileSizeMb,
  getMaxFileSizeBytes,
  clearMaxFileSizeCache,
  getMaxVideoSizeMb,
  getMaxVideoSizeBytes,
  clearMaxVideoSizeCache,
  getAllowedMimeTypes,
  clearAllowedTypesCache,
  extensionsToMimeTypes,
  EXTENSION_TO_MIME,
  DEFAULT_MAX_FILES_PER_UPLOAD,
  MAX_ALLOWED_FILES_PER_UPLOAD,
  DEFAULT_MAX_FILE_SIZE_MB,
  DEFAULT_MAX_VIDEO_SIZE_MB,
  MAX_ALLOWED_FILE_SIZE_MB,
  DEFAULT_ALLOWED_FILE_TYPES
};
