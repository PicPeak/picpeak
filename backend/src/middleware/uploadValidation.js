const fs = require('fs').promises;
const path = require('path');
const sharp = require('../services/isolatedSharp');
const logger = require('../utils/logger');
const { LIBRARY_UNAVAILABLE } = require('../services/imageResourcePolicy');

// Whether Sharp reads the file as an image with dimensions. A busy image
// worker says nothing about the file, so it passes; a resource limit is
// thrown, as the decode check below throws one.
async function readsAsImage(filePath, options = {}, { passBusy = true } = {}) {
  try {
    const meta = await sharp(filePath, options).metadata();
    return Boolean(meta && meta.width && meta.height);
  } catch (error) {
    // A server that cannot load the image library says nothing about the file.
    if (error.code === LIBRARY_UNAVAILABLE) throw error;
    const policy = require('../services/imageResourcePolicy');
    if (policy.isTransient(error)) {
      if (!passBusy) throw error;
      return true;
    }
    // A host error (ENOSPC, EIO, ...) says nothing about the file either; a
    // caller that can check again later hears it rather than "unreadable".
    if (!passBusy && /^E[A-Z0-9]+$/.test(error.code || '')) throw error;
    if (policy.isResourceError(error)) throw error;
    return false;
  }
}

/**
 * Validate uploaded file is complete and not corrupted. A busy image worker
 * passes a HEIF file, as an upload waiting on it would otherwise fail;
 * `passBusy: false` throws the worker's error instead, and a host error the
 * HEIF check met, for a caller that can check again later.
 */
async function validateUploadedFile(filePath, extension, queueing = {}, { passBusy = true } = {}) {
  try {
    // Check file exists and has size
    const stats = await fs.stat(filePath);
    if (stats.size === 0) {
      throw new Error('File is empty');
    }
    
    // For image files, verify they can be read by Sharp
    // A public upload is staged under an extension-less name; the caller
    // passes the extension of the original filename then.
    const ext = (extension || path.extname(filePath)).toLowerCase();
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    
    if (imageExtensions.includes(ext)) {
      // Try to read metadata - this will fail if image is corrupted
      let metadata;
      try {
        metadata = await sharp(filePath, {
          failOn: 'none', // Don't fail on recoverable errors
          limitInputPixels: 268402689, // ~16k x 16k max
          ...queueing
        }).metadata();
      } catch (metadataError) {
        // A server that cannot load the image library says nothing about the file.
        if (metadataError.code === LIBRARY_UNAVAILABLE) throw metadataError;
        // An image over the server's limits is not a broken file: its own message names the limit.
        if (require('../services/imageResourcePolicy').isResourceError(metadataError)) throw metadataError;
        // If metadata reading fails, the file is likely incomplete
        throw Object.assign(new Error(`Invalid image file: ${metadataError.message}`), { code: metadataError.code, imageLimit: metadataError.imageLimit, imageMax: metadataError.imageMax });
      }
      
      if (!metadata || !metadata.width || !metadata.height) {
        throw new Error('Invalid image dimensions - file may be incomplete');
      }
      
      // Check for reasonable dimensions
      if (metadata.width < 10 || metadata.height < 10) {
        throw new Error('Image dimensions too small');
      }
      
      // Additional check: verify we can actually decode a small portion of the image
      try {
        await sharp(filePath, {
          failOn: 'none',
          limitInputPixels: 268402689,
          ...queueing
        })
          .resize(10, 10) // Try to resize to very small size
          .toBuffer();
      } catch (decodeError) {
        if (require('../services/imageResourcePolicy').isResourceError(decodeError)) throw decodeError;
        throw Object.assign(new Error(`Image decode failed - file may be corrupted: ${decodeError.message}`), { code: decodeError.code, imageLimit: decodeError.imageLimit, imageMax: decodeError.imageMax });
      }
      
      return true;
    }

    // The HEIF signature is only a container's `ftyp`, which says nothing about
    // an image in it, so a HEIF name has to read as one as well. A HEVC HEIC
    // only decodes through ffmpeg later; its header is enough here.
    if ((ext === '.heic' || ext === '.heif') && !(await readsAsImage(filePath, queueing, { passBusy }))) {
      throw new Error('Invalid image file: no readable HEIF image');
    }
    
    return true;
  } catch (error) {
    logger.error(`File validation failed for ${filePath}:`, error.message);
    throw error;
  }
}

/**
 * Middleware to validate uploaded files after multer processing
 */
async function validateUploadedFiles(req, res, next) {
  if (!req.files || req.files.length === 0) {
    return next();
  }
  
  const validFiles = [];
  const invalidFiles = [];
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
  // The declared type decides when the name carries no image extension: the
  // v1 upload takes any image/* type under any filename.
  const DECODABLE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' };
  const extOf = (file) => {
    const ext = (path.extname(file.path) || path.extname(file.originalname || '')).toLowerCase();
    return imageExtensions.includes(ext) ? ext : (DECODABLE_TYPES[file.mimetype] || ext);
  };
  // A dropped upload stops its decode. Not interactive: a full queue would
  // answer "busy", which keeps the file unchecked (see below), so flooding
  // the queue would skip the check. The check waits for a worker instead.
  const queueing = { signal: req.publicUploadReservation?.signal };
  const entries = req.files.filter(file => imageExtensions.includes(extOf(file))).map(file => file.path);
  let validated = null;
  if (entries.length >= 8) {
    try { validated = new Map((await sharp.metadataBatch(entries, { validate: true, ...queueing })).map(result => [result.input, result])); }
    catch (error) { validated = null; } // Each file is then checked on its own, below.
  }
  
  // Validate each file
  for (const file of req.files) {
    try {
      const cached = validated?.get(file.path);
      if (cached?.error) throw Object.assign(new Error(cached.error.message), cached.error);
      const stat = cached && await fs.stat(file.path);
      if (!cached || !Object.entries(cached.fingerprint).every(([key, value]) => stat[key] === value)) await validateUploadedFile(file.path, extOf(file), queueing);
      validFiles.push(file);
    } catch (error) {
      // A busy or unavailable image worker says nothing about the file: it is
      // kept, and background processing decides.
      if (require('../services/imageResourcePolicy').isTransient(error)) { validFiles.push(file); continue; }
      logger.warn(`Removing invalid upload ${file.originalname}: ${error.message}`);
      invalidFiles.push({
        filename: file.originalname,
        error: error.message,
        ...require('../services/imageResourcePolicy').describe(error)
      });
      
      // Delete the invalid file
      try {
        await fs.unlink(file.path);
      } catch (unlinkErr) {
        logger.error(`Failed to delete invalid file ${file.path}:`, unlinkErr.message);
      }
    }
  }
  
  // Update req.files to only include valid files
  req.files = validFiles;
  
  // Store invalid files info for response
  if (invalidFiles.length > 0) {
    req.invalidFiles = invalidFiles;
  }
  
  next();
}

module.exports = {
  readsAsImage,
  validateUploadedFile,
  validateUploadedFiles
};
