/**
 * Public → Transfer upload routes (PicTransfer client uploads, #997).
 *
 * Mounted at /api/public/transfer-upload. NO authentication — the token in the
 * link is the only secret. Since #1544 a file request is a first-class thing
 * (kind='request', migration 257) and its PRIMARY link carries the 64-hex
 * token, the same entropy as a recipient download link. The short read-aloud
 * code stays as an optional alternative for "here's a code, type it in".
 *
 * Both are accepted here, and they are guarded differently on purpose: the
 * short code keeps the per-network bad-attempt lockout that its ~50 bits of
 * alphabet-limited entropy needs, while a 64-hex miss is not worth locking a
 * whole /64 out over. Either way the guard runs BEFORE multer, so a bad token
 * never costs a disk write.
 *
 * Only kind='request' rows resolve here — a send's download token is a 404, so
 * the split cannot leak one flow into the other.
 *
 * Surface:
 *   GET  /:token   metadata (title, allowed types, size limit)
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
const { sanitizeFilename } = require('../utils/filenameSanitizer');
const { getStorage } = require('../services/storage');
const {
  getTransferUploadPolicy,
  validateTransferFileType,
  allowedMimeList,
  allowedExtensionList,
} = require('../services/transferUploadPolicy');
const transferService = require('../services/transferService');
const { _internal: tokenLock } = require('../utils/publicTokenGuards');
const logger = require('../utils/logger');

const router = express.Router();

// Fail closed when PicTransfer is off — no client upload accepted (or even
// probed) once an admin disables the feature under Settings → Features.
router.use(requireFeatureFlag('transfers'));

const { getStoragePath } = require('../config/storage');
const MAX_FILES_PER_UPLOAD = 25;

// S3 parity with the download routes: an object written for a transfer says it
// is opaque and should be saved, so a presigned URL — or a bucket someone makes
// public — behaves exactly like fetching it through PicPeak (#1544).
const TRANSFER_OBJECT_OPTIONS = {
  contentType: 'application/octet-stream',
  contentDisposition: 'attachment',
};

const infoLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKey });
const uploadLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKey });

// Two token shapes reach this route (see the header):
//   SHORT_TOKEN_RE  the read-aloud code, drawn from an unambiguous alphabet
//                   (see transferService). A range of lengths so codes issued
//                   by older releases still validate.
//   LONG_TOKEN_RE   the request's primary 64-hex token.
// TOKEN_RE is the union, used by the express-validator param check.
const SHORT_TOKEN_RE = /^[A-Za-z0-9]{4,16}$/;
const LONG_TOKEN_RE = /^[a-f0-9]{64}$/;
const TOKEN_RE = /^([A-Za-z0-9]{4,16}|[a-f0-9]{64})$/;

async function loadUploadTransfer(req, res) {
  // Keyed like the limiters above: an IPv6 /64 counts as one client, so a
  // guesser rotating addresses inside one allocation does not reset the
  // count. The audit log keeps the full address (clientIpForAudit).
  const ip = rateLimitKey(req);
  const token = req.params.token;
  if (!token || !TOKEN_RE.test(token)) {
    res.status(400).json({ error: 'Invalid token format', code: 'BAD_TOKEN' });
    return null;
  }
  // A 64-hex request token is as strong as the recipient download links and
  // needs no lockout; the short read-aloud code keeps the pre-lookup lockout
  // its smaller keyspace requires, isolated from the high-entropy document
  // links so one surface cannot disable the other.
  const isShortCode = !LONG_TOKEN_RE.test(token) && SHORT_TOKEN_RE.test(token);
  if (isShortCode && tokenLock.isIpLocked(ip, 'transfer_uploads')) {
    res.status(429).json({ error: 'Too many invalid attempts. Try again later.', code: 'TOKEN_LOOKUP_LOCKED' });
    return null;
  }
  // Both lookups filter on kind='request', so a send's download token 404s.
  const transfer = isShortCode
    ? await transferService.getTransferByUploadToken(token)
    : await transferService.getRequestByToken(token);
  if (!transfer) {
    if (isShortCode) tokenLock.recordBadAttempt(ip, 'transfer_uploads');
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
  const policy = await getTransferUploadPolicy();
  return successResponse(res, {
    transfer: {
      title: transfer.title || 'Upload',
      message: transfer.message || null,
      expires_at: transfer.upload_expires_at || transfer.expires_at,
      max_size_mb: policy.maxSizeMb,
      max_files: MAX_FILES_PER_UPLOAD,
      // The page filters on these before uploading, so an unsupported file is
      // named and dropped client-side instead of failing the whole batch.
      accept_all: policy.acceptAll,
      allowed_mime: allowedMimeList(policy),
      allowed_extensions: allowedExtensionList(policy),
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

function buildUploader(maxSizeBytes, policy) {
  return multer({
    storage: tempStorage,
    // CVE-2026-82333: files arrive as repeated `files` parts via .array(),
    // not bracket-indexed field names like `files[0]`, and this route is
    // unauthenticated (token-only) — no legitimate field name uses
    // array-index syntax at all. Reject any that do.
    // This route reads no text fields at all, so a handful is plenty. Without
    // fields/parts caps busboy accepts an unbounded number of ~1 MiB text
    // parts and multer keeps every one in memory before the handler ever
    // runs (Codex security audit 2026-09-30).
    limits: {
      fileSize: maxSizeBytes, files: MAX_FILES_PER_UPLOAD, fieldArrayIndexLimit: 0,
      fields: 5, fieldSize: 1024, parts: MAX_FILES_PER_UPLOAD + 5,
    },
    fileFilter: (req, file, cb) => {
      // The transfer policy, not the media registry — these bytes are stored
      // and handed back untouched, never decoded. See transferUploadPolicy.
      if (validateTransferFileType(file.originalname, file.mimetype, policy)) return cb(null, true);
      // Skip rather than throw: one unsupported file in a batch must not
      // reject the good ones with it. The names come back in the response so
      // the page can say exactly what was dropped.
      req.rejectedFiles = req.rejectedFiles || [];
      req.rejectedFiles.push(file.originalname);
      return cb(null, false);
    },
  }).array('files', MAX_FILES_PER_UPLOAD);
}

router.post('/:token', uploadLimiter, [param('token').matches(TOKEN_RE)], preUploadGuard, handleAsync(async (req, res) => {
  const transfer = req.transferRow;
  const policy = await getTransferUploadPolicy();
  const maxSizeMb = policy.maxSizeMb;
  const uploader = buildUploader(maxSizeMb * 1024 * 1024, policy);

  try {
    await new Promise((resolve, reject) => {
      uploader(req, res, (err) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    // Translate multer errors to a clean 4xx.
    // Multer's own message is not echoed: a filesystem failure inside the
    // temp-file destination carries the server path (EACCES /app/storage/...),
    // and this route is unauthenticated. The size case is the only one worth
    // naming, because it tells the client something actionable.
    const msg = err && err.code === 'LIMIT_FILE_SIZE'
      ? `Each file must be ${maxSizeMb} MB or smaller`
      : 'Upload failed';
    if (err && err.code !== 'LIMIT_FILE_SIZE') {
      logger.warn('transfer upload rejected', { code: err.code, error: err.message });
    }
    if (!res.headersSent) res.status(400).json({ error: msg, code: 'UPLOAD_REJECTED' });
    return;
  }

  const rejected = req.rejectedFiles || [];
  if (!req.files || !req.files.length) {
    // Every file was dropped by the type filter: say which, rather than the
    // generic "this file type is not allowed" that used to end the request.
    if (rejected.length) {
      return res.status(400).json({
        error: `Not an allowed file type: ${rejected.join(', ')}`,
        code: 'TYPE_REJECTED',
        rejected_files: rejected,
      });
    }
    return res.status(400).json({ error: 'No files uploaded', code: 'NO_FILES' });
  }

  const storage = getStorage();
  const ip = clientIpForAudit(req);
  const saved = [];
  // A file whose bytes or row fail to land is NOT a success. Without this the
  // client sees "Uploaded 3 files" for a batch of 5 and has no reason to try
  // again, while the admin's list quietly shows three.
  const failed = [];
  for (const file of req.files) {
    // Opaque key — the client's extension is deliberately dropped so no stored
    // object can end in .html/.svg/.js/.php on disk or in S3. The real name is
    // kept on the row and is what the admin downloads it as.
    const key = transferService.newUploadFileKey(transfer.id);
    try {
      await storage.putFromFile(key, file.path, TRANSFER_OBJECT_OPTIONS);
      await transferService.addUpload(transfer.id, {
        originalFilename: file.originalname,
        storedPath: key,
        sizeBytes: file.size,
        mimeType: file.mimetype,
        ip,
      });
      saved.push({ filename: file.originalname, size_bytes: file.size });
    } catch (err) {
      failed.push(file.originalname);
      logger.error('transfer upload: failed to store file', {
        transferId: transfer.id, filename: file.originalname, error: err.message,
      });
    } finally {
      // Remove the temp copy regardless of outcome.
      try { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); } catch (_) { /* noop */ }
    }
  }

  if (!saved.length) {
    return res.status(500).json({ error: 'Could not store the uploaded files', code: 'STORE_FAILED' });
  }

  // Tell the admin their files arrived. Deliberately not awaited into the
  // response path and it swallows its own errors: the client's upload has
  // already succeeded and must not be failed by an SMTP problem.
  transferService.notifyFilesReceived(transfer.id, saved.length).catch(() => { /* logged inside */ });

  const notes = [];
  if (rejected.length) notes.push(`${rejected.length} were not an allowed type`);
  if (failed.length) notes.push(`${failed.length} could not be stored — please try those again`);

  return successResponse(
    res,
    {
      uploaded: saved.length,
      files: saved,
      rejected_files: rejected,
      failed_files: failed,
    },
    201,
    notes.length ? `Uploaded ${saved.length} file(s); ${notes.join('; ')}` : 'Files uploaded',
  );
}));

module.exports = router;
