const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const logger = require('../utils/logger');

// Get storage path from environment or default
const { getStoragePath } = require('../config/storage');
const getChunksPath = () => path.join(getStoragePath(), 'chunks');

// In-memory store for active uploads (in production, consider Redis)
const activeUploads = new Map();

// Chunk size: 10MB
const CHUNK_SIZE = 10 * 1024 * 1024;

// Upload expiration: 24 hours
const UPLOAD_EXPIRATION_MS = 24 * 60 * 60 * 1000;

function totalReceivedBytes(uploadMeta) {
  let total = 0;
  for (const size of uploadMeta.chunkSizes.values()) total += size;
  return total;
}

// Tagged errors so the routes can answer 413/400 instead of a blanket 500.
function fileTooLargeError(maxFileSizeBytes) {
  const err = new Error(`File too large. Maximum size is ${Math.floor(maxFileSizeBytes / (1024 * 1024))} MB per file.`);
  err.code = 'FILE_TOO_LARGE';
  err.statusCode = 413;
  return err;
}

function prematureCloseError() {
  const err = new Error('Request body closed before the chunk was fully received');
  err.code = 'CHUNK_PREMATURE_CLOSE';
  err.statusCode = 400;
  return err;
}

function overAllowanceError() {
  return Object.assign(new Error('CHUNK_OVER_ALLOWANCE'), { overAllowance: true });
}

// A client-supplied upload id that is unknown, finished or expired is the
// client's mistake, not the server's. These used to be plain Errors, so the
// routes answered 500 — which reads as a backend fault in monitoring and
// invites the client to retry something that will never succeed.
function uploadStateError(message, statusCode) {
  const err = new Error(message);
  err.code = 'UPLOAD_STATE';
  err.statusCode = statusCode;
  return err;
}

function invalidChunkError(message) {
  const err = new Error(message);
  err.code = 'INVALID_CHUNK';
  err.statusCode = 400;
  return err;
}

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
    totalChunks,
    maxFileSizeBytes
  } = options;

  // Strip any directory components from the client-supplied filename. It is
  // later joined onto the temp merge dir (path.join(tempDir, filename)), and
  // path.join does NOT neutralise `../` — a filename like `../../uploads/
  // logos/evil.svg` would escape the temp dir and overwrite arbitrary files
  // (GHSA-pc72-jf53-w28j). basename() collapses it to the leaf name only.
  const safeFilename = path.basename(String(filename || ''));
  if (!safeFilename || safeFilename === '.' || safeFilename === '..') {
    throw new Error('Invalid filename');
  }

  // Generate unique upload ID
  const uploadId = crypto.randomUUID();

  // Create chunks directory for this upload
  const uploadDir = path.join(getChunksPath(), uploadId);
  await fs.mkdir(uploadDir, { recursive: true });

  // Calculate expected chunks
  const expectedChunks = totalChunks || Math.ceil(fileSize / CHUNK_SIZE);

  // The per-file cap is enforced on the BYTES ACTUALLY RECEIVED, not on the
  // client-declared fileSize the init route checks: a client can declare
  // `fileSize: 1` and then stream whatever it likes through the chunk route.
  // Missing/invalid cap means "no cap" (callers outside the admin routes).
  const cap = Number(maxFileSizeBytes);
  const sizeCap = Number.isFinite(cap) && cap > 0 ? cap : Infinity;

  // Store upload metadata
  const uploadMeta = {
    uploadId,
    filename: safeFilename,
    fileSize,
    mimeType,
    eventId,
    expectedChunks,
    receivedChunks: new Set(),
    // Bytes per chunk index, so a re-sent chunk replaces rather than adds.
    chunkSizes: new Map(),
    maxFileSizeBytes: sizeCap,
    uploadDir,
    createdAt: Date.now(),
    expiresAt: Date.now() + UPLOAD_EXPIRATION_MS,
    status: 'in_progress'
  };

  activeUploads.set(uploadId, uploadMeta);

  logger.info('Initialized chunked upload', {
    uploadId,
    filename: safeFilename,
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
 * Stream `source` into `partPath`, refusing to write more than `allowance`
 * bytes (#1403). The cap is the backstop for a request that lies about its
 * Content-Length or omits it: the moment the running total passes the
 * allowance the read stops and the partial file is removed, so an oversized
 * body costs the allowance rather than its own size.
 */
function writeChunkStream(source, partPath, allowance) {
  const fsSync = require('fs');
  return new Promise((resolve, reject) => {
    // A client that hung up while auth and ownership were awaiting the database
    // hands us an already-dead stream. pipe() would then emit neither `end` nor
    // `error`, leaving this promise pending forever with the write descriptor
    // open. The async-iterator version this replaced rejected that case, so it
    // has to be checked explicitly rather than inferred from an event.
    if (source.destroyed || source.aborted) {
      return reject(prematureCloseError());
    }

    const out = fsSync.createWriteStream(partPath);
    let written = 0;
    let settled = false;

    const settle = (err, value) => {
      if (settled) return;
      settled = true;
      source.unpipe(out);
      if (err) {
        // Wait for the descriptor to actually close before unlinking. destroy()
        // does not await a pending open(), so unlinking straight away races it:
        // the unlink fails with ENOENT and the open then recreates the .part
        // file after cleanup was supposed to be done.
        const removePart = () => fsSync.unlink(partPath, () => reject(err));
        if (out.destroyed) {
          removePart();
        } else {
          out.once('close', removePart);
          out.destroy();
        }
      } else {
        resolve(value);
      }
    };

    source.on('data', (buf) => {
      written += buf.length;
      if (written > allowance) {
        // Deliberately NOT source.destroy(). `source` is the IncomingMessage,
        // and destroying it destroys the socket under it — the 413 the route is
        // about to send would never reach the client, who would see a connection
        // reset instead of the size-limit JSON. Pausing stops the read, which is
        // the whole point of the cap.
        source.pause();
        settle(overAllowanceError());
      }
    });
    source.on('error', settle);
    source.on('aborted', () => settle(prematureCloseError()));
    source.on('close', () => {
      if (!source.readableEnded) settle(prematureCloseError());
    });
    out.on('error', settle);
    out.on('finish', () => settle(null, written));
    source.pipe(out);
  });
}

/**
 * Upload a single chunk
 * @param {string} uploadId - Upload ID
 * @param {number} chunkIndex - Chunk index (0-based)
 * @param {Buffer|import('stream').Readable} source - Chunk bytes, or a stream
 *   of them (the request). A stream is never read until every check below has
 *   passed, so a rejected request costs nothing (#1403).
 * @param {Object} [options]
 * @param {number} [options.declaredBytes] - Content-Length, when the caller
 *   has one. Checked against the remaining allowance before the body is read.
 * @returns {Promise<Object>} - Chunk upload result
 */
async function uploadChunk(uploadId, chunkIndex, source, { declaredBytes } = {}) {
  const uploadMeta = activeUploads.get(uploadId);

  if (!uploadMeta) {
    throw uploadStateError('Upload not found or expired', 404);
  }

  if (uploadMeta.status !== 'in_progress') {
    throw uploadStateError(`Upload is ${uploadMeta.status}`, 409);
  }

  // Check expiration
  if (Date.now() > uploadMeta.expiresAt) {
    await abortUpload(uploadId);
    throw uploadStateError('Upload expired', 410);
  }

  // Only the announced chunk indices are valid — anything else would merge
  // into nothing (a gap) or let more chunks in than the declared file has.
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= uploadMeta.expectedChunks) {
    throw invalidChunkError(`Invalid chunk index ${chunkIndex}: expected 0-${uploadMeta.expectedChunks - 1}`);
  }

  // Enforce the per-file cap on the running byte total. The upload is
  // aborted, not just rejected: the chunks on disk are already over the
  // limit and the client can't complete the file any more.
  //
  // What this chunk may still contribute — everything already banked, minus a
  // re-sent copy of this same index. Computed before the body is touched so a
  // Content-Length that already blows the budget is refused having read zero
  // bytes (#1403).
  const bankedBytes = totalReceivedBytes(uploadMeta) - (uploadMeta.chunkSizes.get(chunkIndex) || 0);
  const allowance = uploadMeta.maxFileSizeBytes - bankedBytes;

  if (Number.isFinite(declaredBytes) && declaredBytes > allowance) {
    await abortUpload(uploadId);
    throw fileTooLargeError(uploadMeta.maxFileSizeBytes);
  }

  const chunkPath = path.join(uploadMeta.uploadDir, `chunk_${String(chunkIndex).padStart(6, '0')}`);
  let chunkLength;

  if (Buffer.isBuffer(source)) {
    if (bankedBytes + source.length > uploadMeta.maxFileSizeBytes) {
      await abortUpload(uploadId);
      throw fileTooLargeError(uploadMeta.maxFileSizeBytes);
    }
    await fs.writeFile(chunkPath, source);
    chunkLength = source.length;
  } else {
    // Staged through a sibling .part file, then renamed. Writing the canonical
    // path directly truncates it the moment the stream opens, so a re-sent
    // chunk that then failed left receivedChunks/chunkSizes still claiming the
    // old copy: status reported 100% and completeUpload died on ENOENT.
    //
    // The suffix is per-attempt, not per-index: two in-flight requests for the
    // same chunk would otherwise share one staging file, and whichever renamed
    // first would publish bytes the other had already truncated.
    const partPath = `${chunkPath}.${crypto.randomBytes(6).toString('hex')}.part`;
    try {
      chunkLength = await writeChunkStream(source, partPath, allowance);
      // Re-check the aggregate before publishing. `allowance` was computed
      // before the body arrived, so a chunk that completed while this one was
      // still streaming is not counted in it — two overlapping 0.75MB chunks
      // under a 1MB cap would otherwise both be accepted. The buffered version
      // got this right for free by checking after the read; streaming has to
      // ask again.
      const bankedNow = totalReceivedBytes(uploadMeta) - (uploadMeta.chunkSizes.get(chunkIndex) || 0);
      if (bankedNow + chunkLength > uploadMeta.maxFileSizeBytes) {
        await fs.rm(partPath, { force: true }).catch(() => {});
        await abortUpload(uploadId);
        throw fileTooLargeError(uploadMeta.maxFileSizeBytes);
      }
      await fs.rename(partPath, chunkPath).catch(async (renameErr) => {
        // A failed publish (ENOSPC, a vanished directory) left the fully
        // written staging file behind. Its name is per-attempt, so a client
        // that retries instead of aborting just accumulates more of them until
        // the upload expires.
        await fs.rm(partPath, { force: true }).catch(() => {});
        throw renameErr;
      });
    } catch (err) {
      if (err.overAllowance) {
        await abortUpload(uploadId);
        throw fileTooLargeError(uploadMeta.maxFileSizeBytes);
      }
      throw err;
    }
  }

  // Mark chunk as received
  uploadMeta.receivedChunks.add(chunkIndex);
  uploadMeta.chunkSizes.set(chunkIndex, chunkLength);

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
    throw uploadStateError('Upload not found or expired', 404);
  }

  // Verify all chunks received
  if (uploadMeta.receivedChunks.size !== uploadMeta.expectedChunks) {
    throw uploadStateError(
      `Missing chunks: received ${uploadMeta.receivedChunks.size} of ${uploadMeta.expectedChunks}`, 400);
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

    // Backstop for the per-chunk running total above: the merged file is
    // the number that matters, so it is the number that is checked last.
    if (stats.size > uploadMeta.maxFileSizeBytes) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      await fs.rm(uploadMeta.uploadDir, { recursive: true, force: true }).catch(() => {});
      activeUploads.delete(uploadId);
      throw fileTooLargeError(uploadMeta.maxFileSizeBytes);
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

const cleanupTask = require('./scheduledTask').scheduledTask(cleanupExpiredUploads, {
  interval: 60 * 60 * 1000
});
cleanupTask.start();

module.exports = {
  stop: () => cleanupTask.stop(),
  initializeUpload,
  uploadChunk,
  completeUpload,
  abortUpload,
  getUploadStatus,
  cleanupExpiredUploads,
  CHUNK_SIZE
};
