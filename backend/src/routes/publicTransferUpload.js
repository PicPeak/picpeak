/**
 * Public → Transfer upload routes (PicTransfer client uploads, #997).
 *
 * Mounted at /api/public/transfer-upload. NO authentication — a short (6-char)
 * upload token in the link is the only secret. This lets a photographer send a
 * client "here's a code, upload your logo / files here". Because the token is
 * low-entropy, brute force is mitigated by a tight per-route rate limiter plus
 * the shared per-IP bad-attempt lockout, and the guard runs BEFORE multer so a
 * bad token never costs a disk write.
 *
 * Surface:
 *   GET  /:token   metadata (transfer title, allowed types, size limit)
 *   POST /:token   multipart upload (field name: files)
 */

const express = require('express');
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

const router = express.Router();

// Fail closed when PicTransfer is off — no client upload accepted (or even
// probed) once an admin disables the feature under Settings → Features.
router.use(requireFeatureFlag('transfers'));

const { getStoragePath } = require('../config/storage');
const MAX_FILES_PER_UPLOAD = 25;
const DEFAULT_ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/tiff', 'application/pdf', 'application/zip'];

const infoLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKey });
const uploadLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKey });

// Upload tokens are drawn from an unambiguous alphabet (see transferService).
// Accept a small range of lengths so a future longer token still validates.
const TOKEN_RE = /^[A-Za-z0-9]{4,16}$/;

async function loadUploadTransfer(req, res) {
  const ip = clientIpForAudit(req);
  // Short upload codes retain their pre-lookup lockout, isolated from the
  // high-entropy document links so one surface cannot disable the other.
  if (tokenLock.isIpLocked(ip, 'transfer_uploads')) {
    res.status(429).json({ error: 'Too many invalid attempts. Try again later.', code: 'TOKEN_LOOKUP_LOCKED' });
    return null;
  }
  const token = req.params.token;
  if (!token || !TOKEN_RE.test(token)) {
    res.status(400).json({ error: 'Invalid token format', code: 'BAD_TOKEN' });
    return null;
  }
  const transfer = await transferService.getTransferByUploadToken(token);
  if (!transfer) {
    tokenLock.recordBadAttempt(ip, 'transfer_uploads');
    res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
    return null;
  }
  const gate = transferService.assertUploadable(transfer);
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
      allowed_mime: Array.isArray(allowed) ? allowed : DEFAULT_ALLOWED,
    },
  });
}));

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

// Multer writes to a per-transfer temp dir; we then hand files to the storage
// backend (so S3 works too) and delete the temp copy.
const tempStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(getStoragePath(), 'temp', 'transfer-uploads');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safe = sanitizeFilename(path.basename(file.originalname), 60) || 'file';
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}-${safe}`);
  },
});

function buildUploader(maxSizeBytes, allowed) {
  return multer({
    storage: tempStorage,
    // CVE-2026-82333: files arrive as repeated `files` parts via .array(),
    // not bracket-indexed field names like `files[0]`, and this route is
    // unauthenticated (token-only) — no legitimate field name uses
    // array-index syntax at all. Reject any that do.
    limits: { fileSize: maxSizeBytes, files: MAX_FILES_PER_UPLOAD, fieldArrayIndexLimit: 0 },
    fileFilter: (req, file, cb) => {
      if (validateFileType(file.originalname, file.mimetype, allowed)) return cb(null, true);
      return cb(new Error('This file type is not allowed'));
    },
  }).array('files', MAX_FILES_PER_UPLOAD);
}

router.post('/:token', uploadLimiter, [param('token').matches(TOKEN_RE)], preUploadGuard, handleAsync(async (req, res) => {
  const transfer = req.transferRow;
  const maxSizeMb = Number(await getAppSetting('transfer_max_upload_size_mb', 50)) || 50;
  const allowedSetting = await getAppSetting('transfer_upload_allowed_mime', DEFAULT_ALLOWED);
  const allowed = Array.isArray(allowedSetting) ? allowedSetting : DEFAULT_ALLOWED;
  const uploader = buildUploader(maxSizeMb * 1024 * 1024, allowed);

  try {
    await new Promise((resolve, reject) => {
      uploader(req, res, (err) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    // Translate multer errors to a clean 4xx.
    const msg = err && err.code === 'LIMIT_FILE_SIZE'
      ? `Each file must be ${maxSizeMb} MB or smaller`
      : (err && err.message) || 'Upload failed';
    if (!res.headersSent) res.status(400).json({ error: msg, code: 'UPLOAD_REJECTED' });
    return;
  }

  if (!req.files || !req.files.length) {
    return res.status(400).json({ error: 'No files uploaded', code: 'NO_FILES' });
  }

  const storage = getStorage();
  const ip = clientIpForAudit(req);
  const saved = [];
  for (const file of req.files) {
    const safeName = sanitizeFilename(path.basename(file.originalname), 120) || 'file';
    const key = path.posix.join(transferService.uploadDirKey(transfer.id), `${Date.now()}-${saved.length}-${safeName}`);
    try {
      await storage.putFromFile(key, file.path);
      await transferService.addUpload(transfer.id, {
        originalFilename: file.originalname,
        storedPath: key,
        sizeBytes: file.size,
        mimeType: file.mimetype,
        ip,
      });
      saved.push({ filename: file.originalname, size_bytes: file.size });
    } catch (err) {
      logger.error('transfer upload: failed to store file', { transferId: transfer.id, error: err.message });
    } finally {
      // Remove the temp copy regardless of outcome.
      try { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); } catch (_) { /* noop */ }
    }
  }

  if (!saved.length) {
    return res.status(500).json({ error: 'Could not store the uploaded files', code: 'STORE_FAILED' });
  }
  return successResponse(res, { uploaded: saved.length, files: saved }, 201, 'Files uploaded');
}));

module.exports = router;
