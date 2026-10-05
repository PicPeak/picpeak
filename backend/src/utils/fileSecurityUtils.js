const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
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

function isCanonicallyUnder(canonicalBase, canonicalTarget) {
  return canonicalTarget === canonicalBase || canonicalTarget.startsWith(canonicalBase + path.sep);
}

function realpathEscapeError() {
  const err = new Error('Path traversal attempt detected');
  err.code = 'PATH_OUTSIDE_BASE';
  return err;
}

/**
 * safePathJoin's check on the filesystem rather than on the string.
 *
 * path.resolve() normalises text, it does not follow symlinks: `base/link/x`
 * passes the lexical check even when `link` points anywhere the process can
 * read. This canonicalises both sides with realpath and requires the target
 * to land under the base. Callers keep using the lexical path they resolved;
 * only the containment is asserted here.
 *
 * A target that does not exist (ENOENT, or a file where a directory was
 * expected) cannot be opened through any link either, so it passes and the
 * caller's own missing-path handling applies. Every other filesystem error
 * is thrown as is.
 *
 * @param {string} basePath - The base directory
 * @param {string} targetPath - A path lexically under it (from safePathJoin)
 * @throws {Error} - 'Path traversal attempt detected' (code PATH_OUTSIDE_BASE)
 *   when the canonical target is outside the canonical base
 */
async function assertRealpathUnder(basePath, targetPath) {
  let canonicalBase;
  let canonicalTarget;
  try {
    canonicalBase = await fs.realpath(path.resolve(basePath));
    canonicalTarget = await fs.realpath(targetPath);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return;
    throw err;
  }
  if (!isCanonicallyUnder(canonicalBase, canonicalTarget)) {
    throw realpathEscapeError();
  }
}

/** Synchronous assertRealpathUnder, for the resolvers that have no async callers. */
function assertRealpathUnderSync(basePath, targetPath) {
  let canonicalBase;
  let canonicalTarget;
  try {
    canonicalBase = fsSync.realpathSync(path.resolve(basePath));
    canonicalTarget = fsSync.realpathSync(targetPath);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return;
    throw err;
  }
  if (!isCanonicallyUnder(canonicalBase, canonicalTarget)) {
    throw realpathEscapeError();
  }
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
// TIFF byte-order marks. Every RAW format below is a TIFF container, and the
// vendors disagree on byte order - Nikon and Pentax ship big-endian files - so
// each RAW type lists both as alternatives rather than picking one and
// rejecting half the cameras that produce it.
const TIFF_LITTLE_ENDIAN = [{ offset: 0, bytes: [0x49, 0x49, 0x2A, 0x00] }]; // "II*\0"
const TIFF_BIG_ENDIAN = [{ offset: 0, bytes: [0x4D, 0x4D, 0x00, 0x2A] }];    // "MM\0*"
const TIFF_EITHER_BYTE_ORDER = [TIFF_LITTLE_ENDIAN, TIFF_BIG_ENDIAN];

// Olympus stamps its own marker where the TIFF magic would be: "IIRO" on most
// bodies, "IIRS" on a few, "MMOR" on the big-endian E-series.
const ORF_SIGNATURES = [
  [{ offset: 0, bytes: [0x49, 0x49, 0x52, 0x4F] }], // "IIRO"
  [{ offset: 0, bytes: [0x49, 0x49, 0x52, 0x53] }], // "IIRS"
  [{ offset: 0, bytes: [0x4D, 0x4D, 0x4F, 0x52] }]  // "MMOR"
];

// One RAW entry. `raw: true` is what makes normalizeUploadMimeType willing to
// name this type from the extension alone.
const rawImageType = (extension, magicNumberAlternatives = TIFF_EITHER_BYTE_ORDER) => ({
  extensions: [extension],
  raw: true,
  magicNumberAlternatives
});

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
  // Camera RAW, including Apple ProRAW (#821). None of these is in
  // DEFAULT_ALLOWED_FILE_TYPES: an admin opts in per install by adding the
  // extension to general_allowed_file_types.
  //
  // Two things set RAW apart from every format above.
  //
  // The browser tells us nothing useful. macOS and Windows register no MIME
  // for .arw, .cr2 or .nef, so file.type arrives empty, and some Linux
  // desktops send application/octet-stream. Browsers that do type a DNG
  // disagree about how (image/dng, image/x-dng, image/tiff).
  // normalizeUploadMimeType names the type from the extension for this set,
  // which is what the `raw: true` marker selects; it did the same for DNG
  // alone before the rest of the set arrived.
  //
  // The signature is generic. These are TIFF containers, so the leading bytes
  // prove only "this is a TIFF" - a renamed .tif satisfies them too. That is
  // the guarantee DNG has shipped with since #833 and it is deliberate: the
  // real content check is downstream, where extractRawPreview either finds an
  // embedded JPEG preview or the photo fails processing. Sharp cannot decode
  // any of them directly, so the pipeline works from that preview and keeps
  // the original for download.
  'image/x-adobe-dng': rawImageType('.dng'),
  'image/x-sony-arw': rawImageType('.arw'),
  'image/x-sony-sr2': rawImageType('.sr2'),
  'image/x-sony-srf': rawImageType('.srf'),
  'image/x-canon-cr2': rawImageType('.cr2'),
  'image/x-nikon-nef': rawImageType('.nef'),
  'image/x-nikon-nrw': rawImageType('.nrw'),
  'image/x-pentax-pef': rawImageType('.pef'),
  'image/x-samsung-srw': rawImageType('.srw'),
  'image/x-olympus-orf': rawImageType('.orf', ORF_SIGNATURES)
  // Canon CR3, Fuji RAF and Panasonic RW2 are not TIFF and need their own
  // signatures. Left out until someone asks for them.

};

// Extension -> MIME for the RAW set only, derived from the table above so the
// two cannot drift apart.
const RAW_EXTENSION_TO_MIME = Object.entries(ALLOWED_IMAGE_TYPES)
  .filter(([, config]) => config.raw)
  .reduce((map, [mimeType, config]) => {
    config.extensions.forEach((extension) => { map[extension] = mimeType; });
    return map;
  }, {});

// The same set again without the leading dots, for comparing against
// general_allowed_file_types, which stores extensions bare.
const RAW_UPLOAD_EXTENSIONS = new Set(
  Object.keys(RAW_EXTENSION_TO_MIME).map((extension) => extension.slice(1))
);

/**
 * Whether a filename names a camera RAW this build knows, judged by extension.
 *
 * For callers that report what an upload was, or what an install is configured
 * for. They used to test `ext === '.dng'`, which was right while DNG was the
 * only RAW in the table and silently wrong the moment the rest arrived.
 *
 * This answers "is it RAW", not "may it be uploaded". Admission also needs the
 * extension to be in general_allowed_file_types, and none of this set is on by
 * default.
 *
 * @param {string} filename - The filename, read for its extension
 * @returns {boolean}
 */
function isRawUploadFilename(filename) {
  const ext = path.extname(String(filename == null ? '' : filename)).toLowerCase();
  return Boolean(RAW_EXTENSION_TO_MIME[ext]);
}

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

// Document types, kept out of ALLOWED_MEDIA_TYPES: the archive restore reads
// that map as "what counts as media". validateFileType only reaches this
// table for a caller whose own list names the type, so a photo upload still
// refuses a PDF.
const ALLOWED_DOCUMENT_TYPES = {
  'application/pdf': {
    extensions: ['.pdf'],
    magicNumbers: [
      { offset: 0, bytes: [0x25, 0x50, 0x44, 0x46, 0x2D] } // "%PDF-"
    ]
  }
};

// What a browser reports for a RAW file when it reports anything at all. The
// OS type table decides, so it varies (image/dng, image/tiff), and a machine
// with no RAW codec reports nothing, which multer delivers as an empty string
// or application/octet-stream. Not one of these names a vendor format, so not
// one of them can be taken at its word.
const GENERIC_RAW_MIMES = new Set(['', 'application/octet-stream', 'image/dng', 'image/x-dng', 'image/tiff']);

/**
 * The MIME type an upload should be validated and stored as.
 *
 * Normally that is whatever the browser said. The exception is camera RAW,
 * which browsers either do not type at all - a .arw picked on macOS or
 * Windows arrives with an empty type - or type generically, as image/tiff or
 * application/octet-stream. None of those answers tells a Sony original apart
 * from a random binary, so for RAW extensions the extension decides instead.
 *
 * A reported MIME is a name, not evidence, so this admits nothing new: the
 * extension still has to be allowed and routes that inspect content still
 * check the TIFF signature. It is narrow in two further ways. It rescues
 * nothing outside the RAW set, so an untyped .exe is left exactly as it
 * arrived. And the type it returns is still tested against the caller's own
 * allow-list, so a route that does not permit image/x-sony-arw does not
 * quietly start taking .arw files. That second point is load-bearing:
 * publicTransferUpload.js is unauthenticated and shares this code.
 *
 * @param {string} filename - The uploaded filename, read for its extension
 * @param {string} mimetype - What the client reported, possibly nothing
 * @returns {string} - The MIME to validate against, or `mimetype` unchanged
 */
function normalizeUploadMimeType(filename, mimetype) {
  const ext = path.extname(String(filename == null ? '' : filename)).toLowerCase();
  const rawMime = RAW_EXTENSION_TO_MIME[ext];
  if (rawMime && GENERIC_RAW_MIMES.has(mimetype || '')) {
    return rawMime;
  }
  return mimetype;
}

/**
 * Validate file type by MIME type and extension
 * @param {string} filename - The filename
 * @param {string} mimetype - The MIME type
 * @param {string[]} allowedTypes - Array of allowed MIME types
 * @returns {boolean} - True if file type is valid
 */
function validateFileType(filename, mimetype, allowedTypes) {
  // RAW arrives untyped from the browser; every other format is taken at its
  // word, exactly as before.
  const effectiveMime = normalizeUploadMimeType(filename, mimetype);

  // Check if MIME type is allowed
  if (!effectiveMime || !allowedTypes.includes(effectiveMime)) {
    return false;
  }

  // Get file extension
  const ext = path.extname(filename).toLowerCase();

  // Check if extension matches the MIME type
  const typeConfig = ALLOWED_MEDIA_TYPES[effectiveMime] || ALLOWED_DOCUMENT_TYPES[effectiveMime];
  if (!typeConfig || !typeConfig.extensions.includes(ext)) {
    return false;
  }

  return true;
}

// Enough for every signature in the tables above; the deepest offset is 8.
const SIGNATURE_READ_BYTES = 64;

/**
 * The signature groups a type can be satisfied by.
 *
 * `magicNumbers` is one AND group: WebP is only WebP when it carries RIFF at 0
 * AND WEBP at 8. `magicNumberAlternatives` is a list of such groups, any one of which
 * is enough. RAW needs the second form because the vendors ship both TIFF byte
 * orders, and rejecting a big-endian NEF would be a bug rather than a defence.
 *
 * @param {Object} typeConfig - An ALLOWED_MEDIA_TYPES entry
 * @returns {Array|null} - Groups to test, or null when the type has no signature
 */
function signatureGroups(typeConfig) {
  if (typeConfig.magicNumberAlternatives) return typeConfig.magicNumberAlternatives;
  if (typeConfig.magicNumbers) return [typeConfig.magicNumbers];
  return null;
}

/**
 * Validate file content by checking magic numbers (file signatures)
 * @param {string} filePath - Path to the file
 * @param {string} expectedMimeType - Expected MIME type
 * @returns {Promise<boolean>} - True if file content matches expected type
 */
async function validateFileContent(filePath, expectedMimeType) {
  try {
    const typeConfig = ALLOWED_MEDIA_TYPES[expectedMimeType] || ALLOWED_DOCUMENT_TYPES[expectedMimeType];
    if (!typeConfig) {
      return false;
    }

    const groups = signatureGroups(typeConfig);
    // Skip validation for file types without magic numbers (like SVG)
    if (!groups) {
      return true;
    }

    const buffer = Buffer.alloc(SIGNATURE_READ_BYTES);
    const fileHandle = await fs.open(filePath, 'r');
    try {
      await fileHandle.read(buffer, 0, SIGNATURE_READ_BYTES, 0);
    } finally {
      // In a finally so a failed read cannot leak the descriptor. A short file
      // is not an error here: the buffer stays zero-filled and simply fails to
      // match, which is the right answer for a 3-byte "JPEG".
      await fileHandle.close();
    }

    // Check magic numbers
    return groups.some(group => group.every(magic => {
      for (let i = 0; i < magic.bytes.length; i++) {
        if (buffer[magic.offset + i] !== magic.bytes[i]) {
          return false;
        }
      }
      return true;
    }));
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
          // The resolved type, not the browser's - for RAW the browser sent
          // nothing, and validateFileContent would find no entry for ''.
          const isValidContent = await validateFileContent(
            file.path,
            normalizeUploadMimeType(file.originalname, file.mimetype)
          );
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
  assertRealpathUnder,
  assertRealpathUnderSync,
  isPathSafe,
  normalizeUploadMimeType,
  isRawUploadFilename,
  validateFileType,
  validateFileContent,
  createFileUploadValidator,
  RAW_UPLOAD_EXTENSIONS,
  ALLOWED_IMAGE_TYPES,
  ALLOWED_VIDEO_TYPES,
  ALLOWED_MEDIA_TYPES
};