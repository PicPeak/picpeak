const fs = require('fs').promises;
const path = require('path');
const sharp = require('sharp');
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
          failOnError: false, // Don't fail on recoverable errors
          limitInputPixels: 268402689 // ~16k x 16k max
        }).metadata();
      } catch (metadataError) {
        // If metadata reading fails, the file is likely incomplete
        throw new Error(`Invalid image file: ${metadataError.message}`);
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
          failOnError: false,
          limitInputPixels: 268402689
        })
        .resize(10, 10) // Try to resize to very small size
        .toBuffer();
      } catch (decodeError) {
        throw new Error(`Image decode failed - file may be corrupted: ${decodeError.message}`);
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
  
  // Validate each file
  for (const file of req.files) {
    try {
      await validateUploadedFile(file.path);
      validFiles.push(file);
    } catch (error) {
      logger.warn(`Removing invalid upload ${file.originalname}: ${error.message}`);
      invalidFiles.push({
        filename: file.originalname,
        error: error.message
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