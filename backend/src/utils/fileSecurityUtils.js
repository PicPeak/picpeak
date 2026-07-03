const path = require('path');
const fs = require('fs').promises;

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
    /\.\.[\/\\]/,  // ../ or ..\
    /^[A-Za-z]:/,  // Windows drive letters
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
    console.error('Error validating file content:', error);
    return false;
  }
}

/**
 * Get safe filename for storage
 * @param {string} originalFilename - Original filename
 * @returns {string} - Safe filename
 */
function getSafeFilename(originalFilename) {
  const timestamp = Date.now();
  const randomString = Math.random().toString(36).substring(2, 15);
  const ext = path.extname(originalFilename).toLowerCase();

  // Validate extension - including both image and video extensions
  const validExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg', '.ico', '.mp4', '.m4v', '.webm', '.mov', '.avi'];
  if (!validExtensions.includes(ext)) {
    throw new Error('Invalid file extension');
  }

  return `upload_${timestamp}_${randomString}${ext}`;
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
    validateContent = true
  } = options;
  
  return async (req, res, next) => {
    try {
      if (!req.files || req.files.length === 0) {
        return next();
      }
      
      for (const file of req.files) {
        // Validate file type
        if (!validateFileType(file.originalname, file.mimetype, allowedTypes)) {
          return res.status(400).json({ 
            error: `Invalid file type: ${file.originalname}. Allowed types: ${allowedTypes.join(', ')}` 
          });
        }
        
        // Validate file size
        if (file.size > maxFileSize) {
          return res.status(400).json({ 
            error: `File too large: ${file.originalname}. Maximum size: ${maxFileSize / 1024 / 1024}MB` 
          });
        }
        
        // Validate file content if enabled
        if (validateContent && file.path) {
          const isValidContent = await validateFileContent(file.path, file.mimetype);
          if (!isValidContent) {
            // Remove the file if content doesn't match
            try {
              await fs.unlink(file.path);
            } catch (err) {
              console.error('Error removing invalid file:', err);
            }
            return res.status(400).json({ 
              error: `File content does not match declared type: ${file.originalname}` 
            });
          }
        }
      }
      
      next();
    } catch (error) {
      console.error('File validation error:', error);
      res.status(500).json({ error: 'File validation failed' });
    }
  };
}

module.exports = {
  safePathJoin,
  isPathSafe,
  validateFileType,
  validateFileContent,
  getSafeFilename,
  createFileUploadValidator,
  ALLOWED_IMAGE_TYPES,
  ALLOWED_VIDEO_TYPES,
  ALLOWED_MEDIA_TYPES
};