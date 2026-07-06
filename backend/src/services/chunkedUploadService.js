const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const logger = require('../utils/logger');

// Get storage path from environment or default
const getStoragePath = () => process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');
const getChunksPath = () => path.join(getStoragePath(), 'chunks');

// In-memory store for active uploads (in production, consider Redis)
const activeUploads = new Map();

// Chunk size: 10MB
const CHUNK_SIZE = 10 * 1024 * 1024;

// Upload expiration: 24 hours
const UPLOAD_EXPIRATION_MS = 24 * 60 * 60 * 1000;

/**
 * Initialize a new chunked upload
 * @param {Object} options - Upload options
 * @returns {Promise<Object>} - Upload metadata
 */
async function initializeUpload(options) {
  const {
    filename,
    fileSize,
    mimeType,
    eventId,
    totalChunks
  } = options;

  // Generate unique upload ID
  const uploadId = crypto.randomUUID();

  // Create chunks directory for this upload
  const uploadDir = path.join(getChunksPath(), uploadId);
  await fs.mkdir(uploadDir, { recursive: true });

  // Calculate expected chunks
  const expectedChunks = totalChunks || Math.ceil(fileSize / CHUNK_SIZE);

  // Store upload metadata
  const uploadMeta = {
    uploadId,
    filename,
    fileSize,
    mimeType,
    eventId,
    expectedChunks,
    receivedChunks: new Set(),
    uploadDir,
    createdAt: Date.now(),
    expiresAt: Date.now() + UPLOAD_EXPIRATION_MS,
    status: 'in_progress'
  };

  activeUploads.set(uploadId, uploadMeta);

  logger.info('Initialized chunked upload', {
    uploadId,
    filename,
    fileSize,
    expectedChunks,
    eventId
  });

  return {
    uploadId,
    chunkSize: CHUNK_SIZE,
    expectedChunks,
    expiresAt: uploadMeta.expiresAt
  };
}

/**
 * Upload a single chunk
 * @param {string} uploadId - Upload ID
 * @param {number} chunkIndex - Chunk index (0-based)
 * @param {Buffer} chunkData - Chunk data
 * @returns {Promise<Object>} - Chunk upload result
 */
async function uploadChunk(uploadId, chunkIndex, chunkData) {
  const uploadMeta = activeUploads.get(uploadId);

  if (!uploadMeta) {
    throw new Error('Upload not found or expired');
  }

  if (uploadMeta.status !== 'in_progress') {
    throw new Error(`Upload is ${uploadMeta.status}`);
  }

  // Check expiration
  if (Date.now() > uploadMeta.expiresAt) {
    await abortUpload(uploadId);
    throw new Error('Upload expired');
  }

  // Write chunk to disk
  const chunkPath = path.join(uploadMeta.uploadDir, `chunk_${String(chunkIndex).padStart(6, '0')}`);
  await fs.writeFile(chunkPath, chunkData);

  // Mark chunk as received
  uploadMeta.receivedChunks.add(chunkIndex);

  const progress = (uploadMeta.receivedChunks.size / uploadMeta.expectedChunks) * 100;

  logger.debug('Chunk uploaded', {
    uploadId,
    chunkIndex,
    receivedChunks: uploadMeta.receivedChunks.size,
    expectedChunks: uploadMeta.expectedChunks,
    progress: progress.toFixed(1)
  });

  return {
    chunkIndex,
    received: uploadMeta.receivedChunks.size,
    expected: uploadMeta.expectedChunks,
    progress,
    complete: uploadMeta.receivedChunks.size === uploadMeta.expectedChunks
  };
}

/**
 * Complete the upload by merging all chunks
 * @param {string} uploadId - Upload ID
 * @returns {Promise<Object>} - Merged file info
 */
async function completeUpload(uploadId) {
  const uploadMeta = activeUploads.get(uploadId);

  if (!uploadMeta) {
    throw new Error('Upload not found or expired');
  }

  // Verify all chunks received
  if (uploadMeta.receivedChunks.size !== uploadMeta.expectedChunks) {
    throw new Error(`Missing chunks: received ${uploadMeta.receivedChunks.size} of ${uploadMeta.expectedChunks}`);
  }

  uploadMeta.status = 'merging';

  // Create temp file for merged result
  const tempDir = path.join(getStoragePath(), 'temp', `merge_${Date.now()}_${Math.random().toString(36).substring(7)}`);
  await fs.mkdir(tempDir, { recursive: true });

  const mergedFilePath = path.join(tempDir, uploadMeta.filename);
  const writeStream = require('fs').createWriteStream(mergedFilePath);

  try {
    // Merge chunks in order
    for (let i = 0; i < uploadMeta.expectedChunks; i++) {
      const chunkPath = path.join(uploadMeta.uploadDir, `chunk_${String(i).padStart(6, '0')}`);
      const chunkData = await fs.readFile(chunkPath);

      await new Promise((resolve, reject) => {
        writeStream.write(chunkData, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }

    await new Promise((resolve) => writeStream.end(resolve));

    // Verify file size
    const stats = await fs.stat(mergedFilePath);
    if (stats.size !== uploadMeta.fileSize) {
      logger.warn('Merged file size mismatch', {
        expected: uploadMeta.fileSize,
        actual: stats.size
      });
    }

    // Clean up chunks
    await fs.rm(uploadMeta.uploadDir, { recursive: true, force: true });

    uploadMeta.status = 'completed';
    activeUploads.delete(uploadId);

    logger.info('Chunked upload completed', {
      uploadId,
      filename: uploadMeta.filename,
      fileSize: stats.size,
      eventId: uploadMeta.eventId
    });

    return {
      path: mergedFilePath,
      filename: uploadMeta.filename,
      size: stats.size,
      mimeType: uploadMeta.mimeType,
      eventId: uploadMeta.eventId,
      tempDir
    };
  } catch (error) {
    writeStream.destroy();
    uploadMeta.status = 'failed';
    throw error;
  }
}

/**
 * Abort and clean up an upload
 * @param {string} uploadId - Upload ID
 */
async function abortUpload(uploadId) {
  const uploadMeta = activeUploads.get(uploadId);

  if (uploadMeta) {
    try {
      await fs.rm(uploadMeta.uploadDir, { recursive: true, force: true });
    } catch (err) {
      logger.warn('Failed to clean up upload directory', { uploadId, error: err.message });
    }

    activeUploads.delete(uploadId);

    logger.info('Chunked upload aborted', { uploadId });
  }
}

/**
 * Get upload status
 * @param {string} uploadId - Upload ID
 * @returns {Object|null} - Upload status or null if not found
 */
function getUploadStatus(uploadId) {
  const uploadMeta = activeUploads.get(uploadId);

  if (!uploadMeta) {
    return null;
  }

  return {
    uploadId,
    filename: uploadMeta.filename,
    fileSize: uploadMeta.fileSize,
    receivedChunks: uploadMeta.receivedChunks.size,
    expectedChunks: uploadMeta.expectedChunks,
    progress: (uploadMeta.receivedChunks.size / uploadMeta.expectedChunks) * 100,
    status: uploadMeta.status,
    createdAt: uploadMeta.createdAt,
    expiresAt: uploadMeta.expiresAt
  };
}

/**
 * Clean up expired uploads
 */
async function cleanupExpiredUploads() {
  const now = Date.now();
  const expiredIds = [];

  for (const [uploadId, meta] of activeUploads.entries()) {
    if (now > meta.expiresAt) {
      expiredIds.push(uploadId);
    }
  }

  for (const uploadId of expiredIds) {
    await abortUpload(uploadId);
  }

  if (expiredIds.length > 0) {
    logger.info(`Cleaned up ${expiredIds.length} expired uploads`);
  }

  return expiredIds.length;
}

// Run cleanup every hour
setInterval(cleanupExpiredUploads, 60 * 60 * 1000);

module.exports = {
  initializeUpload,
  uploadChunk,
  completeUpload,
  abortUpload,
  getUploadStatus,
  cleanupExpiredUploads,
  CHUNK_SIZE
};
