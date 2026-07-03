/**
 * Centralized Multer Configuration Factory
 * Provides pre-configured multer instances for different upload scenarios
 *
 * @module config/multerConfig
 */

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { validateFileType } = require('../utils/fileSecurityUtils');

/**
 * Get the storage path from environment or default
 * @returns {string}
 */
const getStoragePath = () => process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');

/**
 * Default allowed MIME types for different upload types
 */
const ALLOWED_TYPES = {
  photos: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  videos: ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm'],
  media: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm'],
  logos: ['image/jpeg', 'image/png', 'image/gif', 'image/svg+xml'],
  favicons: ['image/png', 'image/x-icon', 'image/vnd.microsoft.icon'],
  documents: ['application/pdf', 'text/plain']
};

/**
 * Default file size limits (in bytes)
 */
const SIZE_LIMITS = {
  small: 1 * 1024 * 1024,      // 1MB
  medium: 5 * 1024 * 1024,     // 5MB
  large: 50 * 1024 * 1024,     // 50MB
  xlarge: 500 * 1024 * 1024,   // 500MB
  huge: 10 * 1024 * 1024 * 1024 // 10GB (for large videos)
};

/**
 * Create a disk storage configuration
 *
 * @param {Object} options - Storage options
 * @param {string} options.subdir - Subdirectory within storage path
 * @param {Function} [options.filename] - Custom filename generator
 * @param {boolean} [options.useTemp] - Use temp directory instead
 * @returns {multer.StorageEngine}
 */
const createDiskStorage = (options = {}) => {
  const { subdir, filename, useTemp = false } = options;

  return multer.diskStorage({
    destination: async (req, file, cb) => {
      try {
        let uploadDir;
        if (useTemp) {
          uploadDir = path.join(getStoragePath(), 'temp', `upload_${Date.now()}_${Math.random().toString(36).substring(7)}`);
        } else {
          uploadDir = path.join(getStoragePath(), subdir || 'uploads');
        }
        // Create directory synchronously to prevent race conditions
        fs.mkdirSync(uploadDir, { recursive: true });
        cb(null, uploadDir);
      } catch (error) {
        cb(error);
      }
    },
    filename: filename || ((req, file, cb) => {
      const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const ext = path.extname(file.originalname);
      const baseName = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9-_]/g, '_');
      cb(null, `${baseName}-${uniqueSuffix}${ext}`);
    })
  });
};

/**
 * Create a file filter function
 *
 * @param {string[]} allowedTypes - Array of allowed MIME types
 * @param {Object} [options] - Filter options
 * @param {boolean} [options.validateMagicNumbers] - Whether to validate file magic numbers
 * @param {string[]} [options.skipMagicValidation] - MIME types to skip magic number validation for
 * @returns {Function} Multer file filter function
 */
const createFileFilter = (allowedTypes, options = {}) => {
  const { validateMagicNumbers = true, skipMagicValidation = [] } = options;

  return (req, file, cb) => {
    // Basic MIME type check
    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error(`File type ${file.mimetype} not allowed. Allowed types: ${allowedTypes.join(', ')}`));
    }

    // Validate file type with magic numbers (if enabled and not skipped)
    if (validateMagicNumbers && !skipMagicValidation.includes(file.mimetype)) {
      if (validateFileType && !validateFileType(file.originalname, file.mimetype, allowedTypes)) {
        return cb(new Error('File content does not match file type'));
      }
    }

    cb(null, true);
  };
};

/**
 * Create a multer instance for photo uploads
 *
 * @param {Object} [options] - Override options
 * @returns {multer.Multer}
 */
const createPhotoUploader = (options = {}) => {
  const defaults = {
    storage: createDiskStorage({ useTemp: true }),
    limits: {
      fileSize: options.maxSize || SIZE_LIMITS.huge,
      files: options.maxFiles || 2000,
      fieldSize: 10 * 1024 * 1024,
      parts: 10000,
      headerPairs: 2000
    },
    fileFilter: createFileFilter(ALLOWED_TYPES.media, {
      validateMagicNumbers: true
    })
  };

  return multer({ ...defaults, ...options });
};

/**
 * Create a multer instance for logo uploads
 *
 * @param {Object} [options] - Override options
 * @returns {multer.Multer}
 */
const createLogoUploader = (options = {}) => {
  const defaults = {
    storage: createDiskStorage({
      subdir: 'uploads/logos',
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `logo-${Date.now()}${ext}`);
      }
    }),
    limits: {
      fileSize: options.maxSize || SIZE_LIMITS.medium
    },
    fileFilter: createFileFilter(ALLOWED_TYPES.logos, {
      skipMagicValidation: ['image/svg+xml']
    })
  };

  return multer({ ...defaults, ...options });
};

/**
 * Create a multer instance for favicon uploads
 *
 * @param {Object} [options] - Override options
 * @returns {multer.Multer}
 */
const createFaviconUploader = (options = {}) => {
  const defaults = {
    storage: createDiskStorage({
      subdir: 'uploads/favicons',
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `favicon-${Date.now()}${ext}`);
      }
    }),
    limits: {
      fileSize: options.maxSize || SIZE_LIMITS.small
    },
    fileFilter: createFileFilter(ALLOWED_TYPES.favicons, {
      skipMagicValidation: ['image/x-icon', 'image/vnd.microsoft.icon']
    })
  };

  return multer({ ...defaults, ...options });
};

/**
 * Create a multer instance for gallery user uploads
 *
 * @param {string} destDir - Destination directory
 * @param {Object} [options] - Override options
 * @returns {multer.Multer}
 */
const createGalleryUploader = (destDir, options = {}) => {
  const defaults = {
    dest: destDir,
    limits: {
      fileSize: options.maxSize || SIZE_LIMITS.large,
      files: options.maxFiles || 10
    },
    fileFilter: createFileFilter(ALLOWED_TYPES.photos)
  };

  return multer({ ...defaults, ...options });
};

/**
 * Create a custom multer instance
 *
 * @param {Object} config - Full multer configuration
 * @returns {multer.Multer}
 */
const createCustomUploader = (config) => {
  return multer(config);
};

/**
 * Upload timeout middleware
 *
 * @param {number} [timeout=300000] - Timeout in milliseconds (default 5 minutes)
 * @returns {Function} Express middleware
 */
const uploadTimeoutMiddleware = (timeout = 300000) => {
  return (req, res, next) => {
    req.setTimeout(timeout, () => {
      console.error('Upload request timed out');
      if (!res.headersSent) {
        res.status(408).json({ error: 'Upload request timed out' });
      }
    });

    res.setTimeout(timeout, () => {
      console.error('Upload response timed out');
    });

    next();
  };
};

module.exports = {
  // Pre-configured uploaders
  createPhotoUploader,
  createLogoUploader,
  createFaviconUploader,
  createGalleryUploader,
  createCustomUploader,

  // Building blocks for custom configurations
  createDiskStorage,
  createFileFilter,

  // Middleware
  uploadTimeoutMiddleware,

  // Constants
  ALLOWED_TYPES,
  SIZE_LIMITS
};
