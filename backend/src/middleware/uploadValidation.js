const fs = require('fs').promises;
const path = require('path');
const sharp = require('../services/isolatedSharp');
const logger = require('../utils/logger');

/**
 * Validate uploaded file is complete and not corrupted
 */
async function validateUploadedFile(filePath) {
  try {
    // Check file exists and has size
    const stats = await fs.stat(filePath);
    if (stats.size === 0) {
      throw new Error('File is empty');
    }
    
    // For image files, verify they can be read by Sharp
    const ext = path.extname(filePath).toLowerCase();
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    
    if (imageExtensions.includes(ext)) {
      // Try to read metadata - this will fail if image is corrupted
      let metadata;
      try {
        metadata = await sharp(filePath, {
          failOn: 'none', // Don't fail on recoverable errors
          limitInputPixels: 268402689 // ~16k x 16k max
        }).metadata();
      } catch (metadataError) {
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
          limitInputPixels: 268402689
        })
          .resize(10, 10) // Try to resize to very small size
          .toBuffer();
      } catch (decodeError) {
        throw Object.assign(new Error(`Image decode failed - file may be corrupted: ${decodeError.message}`), { code: decodeError.code, imageLimit: decodeError.imageLimit, imageMax: decodeError.imageMax });
      }
      
      return true;
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
  const entries = req.files.filter(file => imageExtensions.includes(path.extname(file.path).toLowerCase())).map(file => file.path);
  let validated = null;
  if (entries.length >= 8) {
    try { validated = new Map((await sharp.metadataBatch(entries, { validate: true, signal: req.publicUploadReservation?.signal })).map(result => [result.input, result])); }
    catch (error) { validated = null; } // Each file is then checked on its own, below.
  }
  
  // Validate each file
  for (const file of req.files) {
    try {
      const cached = validated?.get(file.path);
      if (cached?.error) throw Object.assign(new Error(cached.error.message), cached.error);
      const stat = cached && await fs.stat(file.path);
      if (!cached || !Object.entries(cached.fingerprint).every(([key, value]) => stat[key] === value)) await validateUploadedFile(file.path);
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
  validateUploadedFile,
  validateUploadedFiles
};
