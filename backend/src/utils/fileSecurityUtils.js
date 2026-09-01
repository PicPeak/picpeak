const path = require('path');
const fs = require('fs').promises;
const logger = require('./logger');

/**
 * Secure file security utilities to prevent path traversal and validate file types
 */

/**
 * Safely join paths and prevent directory traversal attacks
 * @param {string} basePath - The base directory path
 * @param {string} userPath - The user-provided path to join
 * @returns {string} - Safe joined path
 * @throws {Error} - If path traversal is detected
 */
function safePathJoin(basePath, userPath) {
  // Normalize the base path
  const normalizedBase = path.resolve(basePath);
  
  // Join and resolve the full path
  const joinedPath = path.join(normalizedBase, userPath);
  const resolvedPath = path.resolve(joinedPath);
  
  // Ensure the resolved path starts with the base path
  if (!resolvedPath.startsWith(normalizedBase + path.sep) && resolvedPath !== normalizedBase) {
    throw new Error('Path traversal attempt detected');
  }
  
  return resolvedPath;
}

/**
 * Validate file path to prevent directory traversal
 * @param {string} filePath - The file path to validate
 * @returns {boolean} - True if path is safe
 */
function isPathSafe(filePath) {
  // Check for common path traversal patterns
  const dangerousPatterns = [
    /\.\.[/\\]/,  // ../ or ..\
    /^[A-Za-z]:/,  // Windows drive letters
    // eslint-disable-next-line no-control-regex -- intentional: detects control chars in paths
    /[\x00-\x1f]/  // Control characters
  ];
  
  return !dangerousPatterns.some(pattern => pattern.test(filePath));
}

/**
 * Enhanced MIME type validation for images and videos
 */
const ALLOWED_IMAGE_TYPES = {
  'image/jpeg': {
    extensions: ['.jpg', '.jpeg'],
    magicNumbers: [
      { offset: 0, bytes: [0xFF, 0xD8, 0xFF] } // JPEG
    ]
  },
  'image/png': {
    extensions: ['.png'],
    magicNumbers: [
      { offset: 0, bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] } // PNG
    ]
  },
  'image/webp': {
    extensions: ['.webp'],
    magicNumbers: [
      { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF
      { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }  // WEBP
    ]
  },
  'image/gif': {
    extensions: ['.gif'],
    magicNumbers: [
      { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] }, // GIF87a
      { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] }  // GIF89a
    ]
  },
  'image/svg+xml': {
    extensions: ['.svg'],
    // SVG files are XML-based text files, so we skip magic number validation
    magicNumbers: null
  },
  // HEIC/HEIF (iPhone). ISO-BMFF container: bytes 4-7 are the "ftyp" box marker,
  // present in every HEIF/HEIC file (single entry — the magic check is `.every`,
  // so alternatives can't be listed as separate entries). Sharp's libvips
  // decodes these; extension + MIME are already gated by validateFileType.
  'image/heic': {
    extensions: ['.heic'],
    magicNumbers: [
      { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] } // "ftyp"
    ]
  },
  'image/heif': {
    extensions: ['.heif'],
    magicNumbers: [
      { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] } // "ftyp"
    ]
  },
  // Camera RAW / Apple ProRAW (#821). DNG is a TIFF container, so it carries the
  // TIFF magic (little-endian "II*\0" or big-endian "MM\0*"). The pipeline can't
  // sharp-decode it directly — it extracts the embedded JPEG preview (exiftool)
  // for thumbnails/display while storing the original for download. Only reached
  // when an admin adds `dng` to the allowed types AND the browser reports the
  // DNG MIME (Chrome does; browsers that send an empty type won't get this far).
  'image/x-adobe-dng': {
    extensions: ['.dng'],
    // Single entry: the magic check is `.every`, so listing both endianness
    // variants would require BOTH to match (impossible). DNG is TIFF; Apple
    // ProRAW and virtually all camera DNGs are little-endian ("II*\0"). A rare
    // big-endian DNG would fail this check and be rejected — acceptable, since
    // the embedded-preview extraction validates the real content downstream.
    magicNumbers: [
      { offset: 0, bytes: [0x49, 0x49, 0x2A, 0x00] } // little-endian TIFF (II*\0)
    ]
  }
};

const ALLOWED_VIDEO_TYPES = {
  'video/mp4': {
    extensions: ['.mp4', '.m4v'],
    magicNumbers: [
      { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] } // 'ftyp' signature for MP4
    ]
  },
  'video/webm': {
    extensions: ['.webm'],
    magicNumbers: [
      { offset: 0, bytes: [0x1A, 0x45, 0xDF, 0xA3] } // EBML header for WebM/MKV
    ]
  },
  'video/quicktime': {
    extensions: ['.mov'],
    magicNumbers: [
      { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70, 0x71, 0x74] } // 'ftypqt' signature for QuickTime
    ]
  },
  'video/x-msvideo': {
    extensions: ['.avi'],
    magicNumbers: [
      { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF
      { offset: 8, bytes: [0x41, 0x56, 0x49, 0x20] }  // 'AVI '
    ]
  }
};

// Combined media types
const ALLOWED_MEDIA_TYPES = {
  ...ALLOWED_IMAGE_TYPES,
  ...ALLOWED_VIDEO_TYPES
};

/**
 * Validate file type by MIME type and extension
 * @param {string} filename - The filename
 * @param {string} mimetype - The MIME type
 * @param {string[]} allowedTypes - Array of allowed MIME types
 * @returns {boolean} - True if file type is valid
 */
function validateFileType(filename, mimetype, allowedTypes) {
  // Check if MIME type is allowed
  if (!allowedTypes.includes(mimetype)) {
    return false;
  }

  // Get file extension
  const ext = path.extname(filename).toLowerCase();

  // Check if extension matches the MIME type
  const typeConfig = ALLOWED_MEDIA_TYPES[mimetype];
  if (!typeConfig || !typeConfig.extensions.includes(ext)) {
    return false;
  }

  return true;
}

/**
 * Validate file content by checking magic numbers (file signatures)
 * @param {string} filePath - Path to the file
 * @param {string} expectedMimeType - Expected MIME type
 * @returns {Promise<boolean>} - True if file content matches expected type
 */
async function validateFileContent(filePath, expectedMimeType) {
  try {
    const typeConfig = ALLOWED_MEDIA_TYPES[expectedMimeType];
    if (!typeConfig) {
      return false;
    }

    // Skip validation for file types without magic numbers (like SVG)
    if (!typeConfig.magicNumbers) {
      return true;
    }

    // Read the first 20 bytes of the file (enough for most magic numbers)
    const buffer = Buffer.alloc(20);
    const fileHandle = await fs.open(filePath, 'r');
    await fileHandle.read(buffer, 0, 20, 0);
    await fileHandle.close();

    // Check magic numbers
    return typeConfig.magicNumbers.every(magic => {
      for (let i = 0; i < magic.bytes.length; i++) {
        if (buffer[magic.offset + i] !== magic.bytes[i]) {
          return false;
        }
      }
      return true;
    });
  } catch (error) {
    logger.error('Error validating file content:', error);
    return false;
  }
}

/**
 * Create a file upload validator middleware
 * @param {Object} options - Validation options
 * @returns {Function} - Express middleware function
 */
function createFileUploadValidator(options = {}) {
  const {
    allowedTypes = ['image/jpeg', 'image/png', 'image/webp'],
    maxFileSize = 50 * 1024 * 1024, // 50MB default
    // Videos carry their own per-file cap (general_max_video_size_mb).
    // Defaults to the photo cap so callers that don't split the two behave
    // exactly as before.
    maxVideoFileSize = maxFileSize,
    validateContent = true
  } = options;

  const isVideoType = (mimetype) => typeof mimetype === 'string' && mimetype.startsWith('video/');

  return async (req, res, next) => {
    // Every exit below rejects the whole request, so nothing downstream will
    // ever read what multer already wrote to disk. Drop those files here or
    // they leak: the routes register their temp-dir cleanup for the success
    // path, which a rejection never reaches.
    const discardUploadedFiles = async () => {
      await Promise.all((req.files || []).map(async (file) => {
        if (!file.path) return;
        try {
          await fs.unlink(file.path);
        } catch (err) {
          if (err.code !== 'ENOENT') {
            logger.error('Error removing rejected upload:', err);
          }
        }
      }));
    };

    try {
      if (!req.files || req.files.length === 0) {
        return next();
      }

      for (const file of req.files) {
        // Validate file type
        if (!validateFileType(file.originalname, file.mimetype, allowedTypes)) {
          await discardUploadedFiles();
          return res.status(400).json({
            error: `Invalid file type: ${file.originalname}. Allowed types: ${allowedTypes.join(', ')}`
          });
        }

        // Validate file size against the cap for this kind of file
        const sizeLimit = isVideoType(file.mimetype) ? maxVideoFileSize : maxFileSize;
        if (file.size > sizeLimit) {
          await discardUploadedFiles();
          return res.status(400).json({
            error: `File too large: ${file.originalname}. Maximum size: ${sizeLimit / 1024 / 1024}MB`
          });
        }

        // Validate file content if enabled
        if (validateContent && file.path) {
          const isValidContent = await validateFileContent(file.path, file.mimetype);
          if (!isValidContent) {
            await discardUploadedFiles();
            return res.status(400).json({
              error: `File content does not match declared type: ${file.originalname}`
            });
          }
        }
      }

      next();
    } catch (error) {
      logger.error('File validation error:', error);
      await discardUploadedFiles();
      res.status(500).json({ error: 'File validation failed' });
    }
  };
}

module.exports = {
  safePathJoin,
  isPathSafe,
  validateFileType,
  validateFileContent,
  createFileUploadValidator,
  ALLOWED_IMAGE_TYPES,
  ALLOWED_VIDEO_TYPES,
  ALLOWED_MEDIA_TYPES
};