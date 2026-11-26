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
 *   POST /:token/chunked-upload/...   one large file in chunks (see below)
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { rateLimitKey } = require('../utils/rateLimitKey');
const { param } = require('express-validator');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const { requireFeatureFlag } = require('../middleware/requireFeatureFlag');
const { clientIpForAudit } = require('../utils/clientIp');
const { getStorage } = require('../services/storage');
const {
  getTransferUploadPolicy,
  effectiveMaxFiles,
  validateTransferFileType,
  allowedMimeList,
  allowedExtensionList,
} = require('../services/transferUploadPolicy');
const transferService = require('../services/transferService');
const { _internal: tokenLock } = require('../utils/publicTokenGuards');
const logger = require('../utils/logger');
const { withPublicUpload } = require('../middleware/publicUploadStream');
const uploadQuota = require('../services/publicUploadQuota');
const { requireCapability } = require('../middleware/requireCapability');
const chunkedUpload = require('../services/chunkedUploadService');
const { deferredReply } = require('../utils/deferredReply');
const { refundRateLimit } = require('../services/rateLimitService');

const router = express.Router();

// Fail closed when PicTransfer is off — no client upload accepted (or even
// probed) once an admin disables the feature under Settings → Features.
router.use(requireFeatureFlag('transfers'));

// S3 parity with the download routes: an object written for a transfer says it
// is opaque and should be saved, so a presigned URL — or a bucket someone makes
// public — behaves exactly like fetching it through PicPeak (#1544).
const TRANSFER_OBJECT_OPTIONS = {
  contentType: 'application/octet-stream',
  contentDisposition: 'attachment',
};

const infoLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKey });
// The page splits one selection (up to the request's files-per-upload limit) into
// requests that each fit the per-request byte budget; bytes are bounded by
// the upload quota, this only bounds the request count.
const uploadLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKey });

// Two token shapes reach this route (see the header):
//   SHORT_TOKEN_RE  the read-aloud code, drawn from an unambiguous alphabet
//                   (see transferService). Legacy shorter codes are rotated by
//                   migration 272 and are no longer accepted.
//   LONG_TOKEN_RE   the request's primary 64-hex token.
// TOKEN_RE is the union, used by the express-validator param check.
const SHORT_TOKEN_RE = /^[A-Za-z0-9]{10,16}$/;
const LONG_TOKEN_RE = /^[a-f0-9]{64}$/;
const TOKEN_RE = /^([A-Za-z0-9]{10,16}|[a-f0-9]{64})$/;

const isShortUploadCode = (token) => !LONG_TOKEN_RE.test(token) && SHORT_TOKEN_RE.test(token);

/**
 * The request behind a short upload code or a long request token. Both
 * lookups filter on kind='request', so a send's download token finds nothing.
 */
async function findRequestByAnyToken(token, isShortCode = isShortUploadCode(token)) {
  return isShortCode
    ? transferService.getTransferByUploadToken(token)
    : transferService.getRequestByToken(token);
}

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
  // A 64-hex request token is as strong as the recipient download links and
  // needs no lockout; the short read-aloud code keeps the pre-lookup lockout
  // its smaller keyspace requires, isolated from the high-entropy document
  // links so one surface cannot disable the other.
  const isShortCode = isShortUploadCode(token);
  if (isShortCode && tokenLock.isIpLocked(ip, 'transfer_uploads')) {
    res.status(429).json({ error: 'Too many invalid attempts. Try again later.', code: 'TOKEN_LOOKUP_LOCKED' });
    return null;
  }
  const transfer = await findRequestByAnyToken(token, isShortCode);
  if (!transfer) {
    if (isShortCode) tokenLock.recordBadAttempt(ip, 'transfer_uploads');
    res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
    return null;
  }
  // Releasing one's own unfinished chunked upload needs the request, not an
  // open one: a link that closed mid-file must still let go of it.
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
  const policy = await getTransferUploadPolicy();
  return successResponse(res, {
    transfer: {
      title: transfer.title || 'Upload',
      message: transfer.message || null,
      expires_at: transfer.expires_at,
      max_size_mb: policy.maxSizeMb,
      // This request's own limit, or the global default (issue 1914).
      max_files: effectiveMaxFiles(transfer, policy),
      // Raw body budget of one request; the page batches a selection to fit.
      max_request_bytes: await uploadQuota.requestBudget(policy.maxSizeMb * 1024 * 1024),
      // The page filters on these before uploading, so an unsupported file is
      // named and dropped client-side instead of failing the whole batch.
      accept_all: policy.acceptAll,
      allowed_mime: allowedMimeList(policy),
      allowed_extensions: allowedExtensionList(policy),
    },
  });
}));

// The row as it is NOW. preUploadGuard decided before the body arrived; a slow
// or large upload can cross the request's expiry, or an admin's disable or
// delete, while the bytes are still coming in. Lookup by token, which both
// getters filter to live request rows, then the same eligibility predicate.
async function reloadUploadTransfer(token) {
  const transfer = await findRequestByAnyToken(token);
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
 * Store staged files as the request's uploads: charged against the admission
 * they arrived under, written to the storage backend, recorded as rows. Every
 * temp copy is removed whatever happens. Shared by the multipart route and the
 * chunked complete, so both accept a file in exactly the same way.
 */
async function storeRequestFiles(transfer, files, uploadReservation, ip) {
  const storage = getStorage();
  const saved = [];
  // A file whose bytes or row fail to land is NOT a success. Without this the
  // client sees "Uploaded 3 files" for a batch of 5 and has no reason to try
  // again, while the admin's list quietly shows three.
  const failed = [];
  for (const file of files) {
    // Opaque key — the client's extension is deliberately dropped so no stored
    // object can end in .html/.svg/.js/.php on disk or in S3. The real name is
    // kept on the row and is what the admin downloads it as.
    const key = transferService.newUploadFileKey(transfer.id);
    let charge;
    let settled = false;
    try {
      charge = await uploadQuota.prepareObject(uploadReservation, key, file.size);
      await storage.putFromFile(key, file.path, TRANSFER_OBJECT_OPTIONS);
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

function buildUploader(maxSizeBytes, policy, { storage, streamHandler, maxFiles }) {
  return multer({
    storage,
    streamHandler,
    defParamCharset: 'utf8', // multer's latin1 default turns UTF-8 names into mojibake
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
  }).array('files', maxFiles);
}

router.post('/:token', uploadLimiter, [param('token').matches(TOKEN_RE)], preUploadGuard, requireCapability('uploads.new'), handleAsync(async (req, res) => {
  const policy = await getTransferUploadPolicy();
  const maxSizeMb = policy.maxSizeMb;
  await withPublicUpload(req, res, {
    transferId: req.transferRow.id, maxFiles: effectiveMaxFiles(req.transferRow, policy), maxFileBytes: maxSizeMb * 1024 * 1024, fileField: 'files',
    fileLimitMessage: `Each file must be ${maxSizeMb} MB or smaller`,
  }, options => buildUploader(maxSizeMb * 1024 * 1024, policy, options), async (uploadReservation, res) => {

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

    const { saved, failed } = await storeRequestFiles(transfer, req.files, uploadReservation, clientIpForAudit(req));

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
  });
}));

// ============================================
// CHUNKED UPLOAD
// One file larger than a proxy lets through in one request (Cloudflare
// Free/Pro: 100 MB per body) goes up in 10 MB chunks. The session holds one
// public admission, charged to this request like a multipart upload of one
// file, from init until the file is stored. Every call re-checks the link —
// expiry, close, delete — exactly as the multipart route does, and the
// upload is bound to the link it was started on: an upload id is a 404 from
// any other request or link.
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

router.post('/:token/chunked-upload/init', uploadLimiter, chunkGuard(), requireCapability('uploads.new'), handleAsync(async (req, res) => {
  try {
    const { filename, fileSize, totalChunks, mimeType } = req.body || {};
    if (!filename || !fileSize) {
      return res.status(400).json({ error: 'Missing required fields: filename, fileSize', code: 'BAD_REQUEST' });
    }
    const name = String(filename);
    // What multer records for a multipart part: the browser's type, or
    // octet-stream when it has none. Only the transfer policy reads it.
    const mime = typeof mimeType === 'string' && mimeType.trim() ? mimeType.trim().slice(0, 255) : 'application/octet-stream';
    const policy = await getTransferUploadPolicy();
    if (!validateTransferFileType(name, mime, policy)) {
      return res.status(400).json({ error: `Not an allowed file type: ${name}`, code: 'TYPE_REJECTED', rejected_files: [name] });
    }
    const result = await chunkedUpload.initializeUpload({
      filename: name,
      fileSize,
      totalChunks,
      mimeType: mime,
      ...chunkOwner(req),
      // Enforced again on the bytes received and merged.
      maxFileSizeBytes: policy.maxSizeMb * 1024 * 1024,
      // The same request, account and deployment allowances as the multipart
      // route, with the declared size as the body.
      admission: { clientKey: rateLimitKey(req) },
      opaque: true,
    });
    return res.json(result);
  } catch (error) {
    return chunkRefusal(req, res, error, 'Failed to initialize upload');
  }
}));

// Not capability-guarded: an upload admitted while healthy may finish.
router.post('/:token/chunked-upload/:uploadId/chunk/:chunkIndex', chunkGuard(), handleAsync(async (req, res) => {
  try {
    const declaredBytes = Number(req.headers['content-length']);
    const index = /^\d+$/.test(req.params.chunkIndex) ? Number(req.params.chunkIndex) : NaN;
    const result = await chunkedUpload.uploadChunk(req.params.uploadId, index, req, {
      declaredBytes: Number.isFinite(declaredBytes) ? declaredBytes : undefined,
      owner: chunkOwner(req),
    });
    // One of many requests of a single upload, held to the session's
    // admission: not charged to the address's API budget, or a large file
    // runs into 429 halfway (as the gallery's guest chunks).
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
    // The rules as they are now, after the merge: settings may have changed
    // since init, and the merge of a large file takes a while.
    const policy = await getTransferUploadPolicy();
    if (!validateTransferFileType(file.originalname, file.mimetype, policy)) {
      await dropMerged();
      return reply.status(400).json({
        error: `Not an allowed file type: ${file.originalname}`, code: 'TYPE_REJECTED', rejected_files: [file.originalname],
      });
    }
    if (file.size > policy.maxSizeMb * 1024 * 1024) {
      await dropMerged();
      return reply.status(413).json({ error: `Each file must be ${policy.maxSizeMb} MB or smaller`, code: 'FILE_TOO_LARGE' });
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
    const transfer = current.transfer;
    const { saved, failed } = await storeRequestFiles(transfer, [file], merged.uploadReservation, clientIpForAudit(req));
    await dropMerged();
    if (!saved.length) {
      return reply.status(500).json({ error: 'Could not store the uploaded files', code: 'STORE_FAILED', failed_files: failed });
    }
    // Coalesced per request inside (one notice per cooldown), so a selection
    // of several large files mails the admin no more often than the same
    // selection sent as several multipart requests.
    transferService.notifyFilesReceived(transfer.id, saved.length).catch(() => { /* logged inside */ });
    return successResponse(reply, { uploaded: saved.length, files: saved, rejected_files: [], failed_files: [] }, 201, 'Files uploaded');
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
