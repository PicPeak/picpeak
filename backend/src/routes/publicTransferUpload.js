/**
 * Public → Transfer upload routes (PicTransfer client uploads, #997).
 *
 * Mounted at /api/public/transfer-upload. NO authentication — a short (10-char)
 * upload token in the link is the only secret. This lets a photographer send a
 * client "here's a code, upload your logo / files here". Because the token is
 * low-entropy, brute force is mitigated by a tight per-route rate limiter plus
 * the shared per-IP bad-attempt lockout, and the guard runs BEFORE multer so a
 * bad token never costs a disk write.
 *
 * Surface:
 *   GET  /:token   metadata (transfer title, allowed types, size limit)
 *   POST /:token   multipart upload (field name: files)
 *   POST /:token/chunked-upload/...   one large file in chunks (see below)
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { rateLimitKey } = require('../utils/rateLimitKey');
const { param } = require('express-validator');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const { requireFeatureFlag } = require('../middleware/requireFeatureFlag');
const { clientIpForAudit } = require('../utils/clientIp');
const { validateFileType } = require('../utils/fileSecurityUtils');
const { sanitizeFilename } = require('../utils/filenameSanitizer');
const { getAppSetting } = require('../utils/appSettings');
const { getStorage } = require('../services/storage');
const transferService = require('../services/transferService');
const { _internal: tokenLock } = require('../utils/publicTokenGuards');
const logger = require('../utils/logger');
const { withPublicUpload } = require('../middleware/publicUploadStream');
const uploadQuota = require('../services/publicUploadQuota');
const chunkedUpload = require('../services/chunkedUploadService');
const { deferredReply } = require('../utils/deferredReply');
const { refundRateLimit } = require('../services/rateLimitService');

const router = express.Router();

// Fail closed when PicTransfer is off — no client upload accepted (or even
// probed) once an admin disables the feature under Settings → Features.
router.use(requireFeatureFlag('transfers'));

const MAX_FILES_PER_UPLOAD = 25;
const DEFAULT_ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/tiff', 'application/pdf', 'application/zip'];

const infoLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKey });
// The page splits one selection (up to MAX_FILES_PER_UPLOAD files) into
// requests that each fit the per-request byte budget; bytes are bounded by
// the upload quota, this only bounds the request count.
const uploadLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKey });

// Upload tokens are drawn from an unambiguous alphabet (see transferService).
// Legacy shorter codes are rotated by migration 241 and rejected afterward.
const TOKEN_RE = /^[A-Za-z0-9]{10,16}$/;

async function loadUploadTransfer(req, res, { requireOpen = true } = {}) {
  // Keyed like the limiters above: an IPv6 /64 counts as one client, so a
  // guesser rotating addresses inside one allocation does not reset the
  // count. The audit log keeps the full address (clientIpForAudit).
  const ip = rateLimitKey(req);
  const token = req.params.token;
  if (!token || !TOKEN_RE.test(token)) {
    res.status(400).json({ error: 'Invalid token format', code: 'BAD_TOKEN' });
    return null;
  }
  // Short upload codes retain their pre-lookup lockout, isolated from the
  // high-entropy document links so one surface cannot disable the other.
  if (tokenLock.isIpLocked(ip, 'transfer_uploads')) {
    res.status(429).json({ error: 'Too many invalid attempts. Try again later.', code: 'TOKEN_LOOKUP_LOCKED' });
    return null;
  }
  const transfer = await transferService.getTransferByUploadToken(token);
  if (!transfer) {
    tokenLock.recordBadAttempt(ip, 'transfer_uploads');
    res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
    return null;
  }
  // Releasing one's own unfinished chunked upload needs the transfer, not an
  // open link: a link that closed mid-file must still let go of it.
  const gate = requireOpen ? transferService.assertUploadable(transfer) : { ok: true };
  if (!gate.ok) {
    res.status(gate.status).json({ error: 'This upload link is no longer available', code: gate.code });
    return null;
  }
  return transfer;
}

// Metadata for the upload page.
router.get('/:token', infoLimiter, [param('token').matches(TOKEN_RE)], handleAsync(async (req, res) => {
  validateRequest(req);
  const transfer = await loadUploadTransfer(req, res);
  if (!transfer) return;
  const maxSizeMb = Number(await getAppSetting('transfer_max_upload_size_mb', 50)) || 50;
  const allowed = await getAppSetting('transfer_upload_allowed_mime', DEFAULT_ALLOWED);
  return successResponse(res, {
    transfer: {
      title: transfer.title || 'Upload',
      message: transfer.message || null,
      expires_at: transfer.upload_expires_at || transfer.expires_at,
      max_size_mb: maxSizeMb,
      max_files: MAX_FILES_PER_UPLOAD,
      // Raw body budget of one request; the page batches a selection to fit.
      max_request_bytes: await uploadQuota.requestBudget(maxSizeMb * 1024 * 1024),
      allowed_mime: Array.isArray(allowed) ? allowed : DEFAULT_ALLOWED,
    },
  });
}));

// The row as it is NOW. preUploadGuard decided before the body arrived; a slow
// or large upload can cross the transfer's upload expiry, or an admin's disable
// or delete, while the bytes are still coming in. Lookup by token, which
// filters to live rows, then the same eligibility predicate.
async function reloadUploadTransfer(token) {
  const transfer = await transferService.getTransferByUploadToken(token);
  const gate = transferService.assertUploadable(transfer);
  return gate.ok ? { transfer } : { gate };
}

// Pre-multer guard: validates the token + upload eligibility BEFORE any bytes
// touch disk, and stashes the transfer for the destination/handler.
async function preUploadGuard(req, res, next) {
  try {
    const transfer = await loadUploadTransfer(req, res);
    if (!transfer) return; // response already sent
    req.transferRow = transfer;
    next();
  } catch (err) {
    logger.error('preUploadGuard error', { error: err.message });
    if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
  }
}

/**
 * Store staged files as the transfer's client uploads: charged against the
 * admission they arrived under, written to the storage backend, recorded as
 * rows. Every temp copy is removed whatever happens. Shared by the multipart
 * route and the chunked complete, so both accept a file in the same way.
 */
async function storeTransferUploads(transfer, files, uploadReservation, ip) {
  const storage = getStorage();
  const saved = [];
  const failed = [];
  for (const file of files) {
    const safeName = sanitizeFilename(path.basename(file.originalname), 120) || 'file';
    const key = path.posix.join(transferService.uploadDirKey(transfer.id), `${Date.now()}-${saved.length}-${safeName}`);
    let charge;
    let settled = false;
    try {
      charge = await uploadQuota.prepareObject(uploadReservation, key, file.size);
      await storage.putFromFile(key, file.path);
      settled = true;
      await uploadQuota.commitObject(charge, 'transfer', conn => transferService.addUpload(transfer.id, {
        originalFilename: file.originalname,
        storedPath: key,
        sizeBytes: file.size,
        mimeType: file.mimetype,
        ip,
      }, conn));
      saved.push({ filename: file.originalname, size_bytes: file.size });
    } catch (err) {
      if (charge) await uploadQuota.failedObject(charge, { storage, settled }).catch(cleanupError => {
        logger.warn('Transfer object cleanup failed; quota remains charged', { error: cleanupError.message });
      });
      failed.push(file.originalname);
      logger.error('transfer upload: failed to store file', {
        transferId: transfer.id, filename: file.originalname, error: err.message,
      });
    } finally {
      // Remove the temp copy regardless of outcome.
      try { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); } catch (_) { /* noop */ }
    }
  }
  return { saved, failed };
}

function buildUploader(maxSizeBytes, allowed, { storage, streamHandler, maxFiles, rejectBody }) {
  return multer({
    storage,
    streamHandler,
    // CVE-2026-82333: files arrive as repeated `files` parts via .array(),
    // not bracket-indexed field names like `files[0]`, and this route is
    // unauthenticated (token-only) — no legitimate field name uses
    // array-index syntax at all. Reject any that do.
    // This route reads no text fields at all, so a handful is plenty. Without
    // fields/parts caps busboy accepts an unbounded number of ~1 MiB text
    // parts and multer keeps every one in memory before the handler ever
    // runs (Codex security audit 2026-09-30).
    limits: {
      fileSize: maxSizeBytes, files: maxFiles, fieldArrayIndexLimit: 0,
      fields: 5, fieldSize: 1024, parts: maxFiles + 5,
    },
    fileFilter: (req, file, cb) => {
      if (validateFileType(file.originalname, file.mimetype, allowed)) return cb(null, true);
      const error = Object.assign(new Error('This file type is not allowed'), { expose: true });
      rejectBody(error); return cb(error);
    },
  }).array('files', maxFiles);
}

router.post('/:token', uploadLimiter, [param('token').matches(TOKEN_RE)], preUploadGuard, handleAsync(async (req, res) => {
  const maxSizeMb = Number(await getAppSetting('transfer_max_upload_size_mb', 50)) || 50;
  const allowedSetting = await getAppSetting('transfer_upload_allowed_mime', DEFAULT_ALLOWED);
  const allowed = Array.isArray(allowedSetting) ? allowedSetting : DEFAULT_ALLOWED;
  await withPublicUpload(req, res, {
    transferId: req.transferRow.id, maxFiles: MAX_FILES_PER_UPLOAD, maxFileBytes: maxSizeMb * 1024 * 1024, fileField: 'files',
    fileLimitMessage: `Each file must be ${maxSizeMb} MB or smaller`,
  }, options => buildUploader(maxSizeMb * 1024 * 1024, allowed, options), async (uploadReservation, res) => {

    if (!req.files || !req.files.length) {
      return res.status(400).json({ error: 'No files uploaded', code: 'NO_FILES' });
    }

    // Nothing becomes permanent on the strength of the pre-body check. The
    // body is on disk already, so a refusal — or a database error while
    // re-reading the row — removes it; otherwise every request during an
    // outage leaves its temporary files behind.
    const dropTempFiles = () => {
      for (const file of req.files) {
        try { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); } catch (_) { /* noop */ }
      }
    };
    let current;
    try {
      current = await reloadUploadTransfer(req.params.token);
    } catch (error) {
      dropTempFiles();
      throw error;
    }
    if (!current.transfer) {
      dropTempFiles();
      return res.status(current.gate.status).json({ error: 'This upload link is no longer available', code: current.gate.code });
    }
    const transfer = current.transfer;

    const { saved } = await storeTransferUploads(transfer, req.files, uploadReservation, clientIpForAudit(req));

    if (!saved.length) {
      return res.status(500).json({ error: 'Could not store the uploaded files', code: 'STORE_FAILED' });
    }
    return successResponse(res, { uploaded: saved.length, files: saved }, 201, 'Files uploaded');
  });
}));

// ============================================
// CHUNKED UPLOAD
// One file larger than a proxy lets through in one request (Cloudflare
// Free/Pro: 100 MB per body) goes up in 10 MB chunks. The session holds one
// public admission, charged to this transfer like a multipart upload of one
// file, from init until the file is stored. Every call re-checks the link
// (expiry, disable, delete) as the multipart route does, and the upload is
// bound to the link it was started on: an upload id is a 404 from any other.
// ============================================

const chunkOwner = (req) => ({
  transferId: req.transferRow.id,
  uploadKey: crypto.createHash('sha256').update(String(req.params.token)).digest('hex'),
});

// The token check for a chunk route. A refusal leaves the chunk's body unread,
// which would hang the next request on a keep-alive socket: retire it.
function chunkGuard(options) {
  return async (req, res, next) => {
    try {
      if (!req.readableEnded) res.set('Connection', 'close');
      const transfer = await loadUploadTransfer(req, res, options);
      if (!transfer) return;
      res.removeHeader('Connection');
      req.transferRow = transfer;
      next();
    } catch (err) {
      logger.error('transfer chunk guard error', { error: err.message });
      if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    }
  };
}

// A tagged status is the client's or the quota's answer, not a server fault.
function chunkRefusal(req, res, error, fallback) {
  if ((error.statusCode || error.status) && error.code) {
    if (!req.readableEnded) res.set('Connection', 'close');
    return res.status(error.statusCode || error.status).json({ error: error.message, code: error.code });
  }
  logger.error(`${fallback}:`, { error: error.message });
  return res.status(500).json({ error: fallback });
}

async function uploadRules() {
  const maxSizeMb = Number(await getAppSetting('transfer_max_upload_size_mb', 50)) || 50;
  const allowedSetting = await getAppSetting('transfer_upload_allowed_mime', DEFAULT_ALLOWED);
  return { maxSizeMb, allowed: Array.isArray(allowedSetting) ? allowedSetting : DEFAULT_ALLOWED };
}

router.post('/:token/chunked-upload/init', uploadLimiter, chunkGuard(), handleAsync(async (req, res) => {
  try {
    const { filename, fileSize, totalChunks, mimeType } = req.body || {};
    if (!filename || !fileSize) {
      return res.status(400).json({ error: 'Missing required fields: filename, fileSize', code: 'BAD_REQUEST' });
    }
    const name = String(filename);
    // What multer records for a multipart part: the browser's type, or
    // octet-stream when it has none. Checked like a multipart file.
    const mime = typeof mimeType === 'string' && mimeType.trim() ? mimeType.trim().slice(0, 255) : 'application/octet-stream';
    const { maxSizeMb, allowed } = await uploadRules();
    if (!validateFileType(name, mime, allowed)) {
      return res.status(400).json({ error: 'This file type is not allowed', code: 'UPLOAD_REJECTED' });
    }
    const result = await chunkedUpload.initializeUpload({
      filename: name,
      fileSize,
      totalChunks,
      mimeType: mime,
      ...chunkOwner(req),
      // Enforced again on the bytes received and merged.
      maxFileSizeBytes: maxSizeMb * 1024 * 1024,
      // The same transfer, account and deployment allowances as the
      // multipart route, with the declared size as the body.
      admission: { clientKey: rateLimitKey(req) },
      opaque: true,
    });
    return res.json(result);
  } catch (error) {
    return chunkRefusal(req, res, error, 'Failed to initialize upload');
  }
}));

router.post('/:token/chunked-upload/:uploadId/chunk/:chunkIndex', chunkGuard(), handleAsync(async (req, res) => {
  try {
    const declaredBytes = Number(req.headers['content-length']);
    const index = /^\d+$/.test(req.params.chunkIndex) ? Number(req.params.chunkIndex) : NaN;
    const result = await chunkedUpload.uploadChunk(req.params.uploadId, index, req, {
      declaredBytes: Number.isFinite(declaredBytes) ? declaredBytes : undefined,
      owner: chunkOwner(req),
    });
    // One of many requests of a single upload, held to the session's
    // admission: not charged to the address's API budget (as guest chunks).
    refundRateLimit(req);
    return res.json(result);
  } catch (error) {
    return chunkRefusal(req, res, error, 'Failed to upload chunk');
  }
}));

router.post('/:token/chunked-upload/:uploadId/complete', chunkGuard(), handleAsync(async (req, res) => {
  const owner = chunkOwner(req);
  const { uploadId } = req.params;
  let merged;
  const cancel = () => {
    if (req.aborted || !res.writableEnded) chunkedUpload.abortUpload(uploadId, { owner })
      .catch(err => logger.warn('Disconnected transfer chunk upload cleanup unavailable', { error: err.message }));
  };
  req.once('aborted', cancel);
  res.once('close', cancel);
  // Answered once the admission has settled, as the multipart route is.
  const reply = deferredReply(res);
  try {
    merged = await chunkedUpload.completeUpload(uploadId, { owner });
    const file = { originalname: merged.filename, path: merged.path, size: merged.size, mimetype: merged.mimeType };
    const dropMerged = () => fs.promises.rm(merged.tempDir, { recursive: true, force: true }).catch(() => {});
    // The rules as they are now, after the merge.
    const { maxSizeMb, allowed } = await uploadRules();
    if (!validateFileType(file.originalname, file.mimetype, allowed)) {
      await dropMerged();
      return reply.status(400).json({ error: 'This file type is not allowed', code: 'UPLOAD_REJECTED' });
    }
    if (file.size > maxSizeMb * 1024 * 1024) {
      await dropMerged();
      return reply.status(413).json({ error: `Each file must be ${maxSizeMb} MB or smaller`, code: 'FILE_TOO_LARGE' });
    }
    // Nothing becomes permanent on the strength of the check at the start of
    // this request: re-read the row, as the multipart route does.
    let current;
    try {
      current = await reloadUploadTransfer(req.params.token);
    } catch (error) {
      await dropMerged();
      throw error;
    }
    if (!current.transfer) {
      await dropMerged();
      return reply.status(current.gate.status).json({ error: 'This upload link is no longer available', code: current.gate.code });
    }
    const { saved } = await storeTransferUploads(current.transfer, [file], merged.uploadReservation, clientIpForAudit(req));
    await dropMerged();
    if (!saved.length) {
      return reply.status(500).json({ error: 'Could not store the uploaded files', code: 'STORE_FAILED' });
    }
    return successResponse(reply, { uploaded: saved.length, files: saved }, 201, 'Files uploaded');
  } catch (error) {
    return chunkRefusal(req, reply, error, 'Failed to complete upload');
  } finally {
    req.removeListener('aborted', cancel);
    res.removeListener('close', cancel);
    if (merged?.uploadReservation) {
      await chunkedUpload.finishUpload(uploadId, { owner })
        .catch(err => logger.warn('Transfer chunk upload cleanup unavailable; admission retained', { error: err.message }));
    }
    reply.flush();
  }
}));

// Releases the caller's own unfinished upload: its staging and its admission.
// Works on a link that has closed meanwhile, so a client can always let go.
router.delete('/:token/chunked-upload/:uploadId', chunkGuard({ requireOpen: false }), handleAsync(async (req, res) => {
  const aborted = await chunkedUpload.abortUpload(req.params.uploadId, { owner: chunkOwner(req) });
  if (!aborted) return res.status(404).json({ error: 'Upload not found or expired', code: 'NOT_FOUND' });
  refundRateLimit(req);
  return successResponse(res, { aborted: true }, 200, 'Upload aborted');
}));

module.exports = router;
