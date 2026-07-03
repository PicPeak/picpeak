const { db } = require('../database/db');

const DEFAULT_MAX_FILES_PER_UPLOAD = 500;
const MAX_ALLOWED_FILES_PER_UPLOAD = 2000;
const CACHE_TTL_MS = 60_000;

let cachedValue = DEFAULT_MAX_FILES_PER_UPLOAD;
let cacheExpiresAt = 0;

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
    console.error('Failed to read max files per upload setting:', error.message);
    cachedValue = DEFAULT_MAX_FILES_PER_UPLOAD;
    cacheExpiresAt = Date.now() + CACHE_TTL_MS;
    return DEFAULT_MAX_FILES_PER_UPLOAD;
  }
};

const clearMaxFilesPerUploadCache = () => {
  cacheExpiresAt = 0;
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
    console.error('Failed to read allowed file types setting:', error.message);
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
  getAllowedMimeTypes,
  clearAllowedTypesCache,
  extensionsToMimeTypes,
  EXTENSION_TO_MIME,
  DEFAULT_MAX_FILES_PER_UPLOAD,
  MAX_ALLOWED_FILES_PER_UPLOAD,
  DEFAULT_ALLOWED_FILE_TYPES
};
