/**
 * PicTransfer deliverable files: the operator's own files dropped into a send.
 *
 * Shared by the admin routes (routes/adminTransfers.js, session JWT) and the
 * public API (routes/v1/transfers.js, API token). Both resolve the caller to
 * `req.admin`, so the ownership guard, the upload admission, the type/size
 * policy, the storage write and the chunked path are one implementation and
 * an API token can never upload more, or into more transfers, than its owner
 * could from the admin UI.
 *
 * Nothing here checks a permission, a feature flag or a capability: each
 * router puts those in front of these handlers itself.
 */

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { capabilityPaused, sendCapabilityRefusal } = require('./requireCapability');
const { successResponse } = require('../utils/routeHelpers');
const { sanitizeFilename } = require('../utils/filenameSanitizer');
const { getStorage } = require('../services/storage');
const transferService = require('../services/transferService');
const chunkedUpload = require('../services/chunkedUploadService');
const { deferredReply } = require('../utils/deferredReply');
const uploadQuota = require('../services/publicUploadQuota');
const { getTransferUploadPolicy, validateTransferFileType } = require('../services/transferUploadPolicy');
const { getStoragePath } = require('../config/storage');
const logger = require('../utils/logger');

// --- Admin deliverable-file upload (the files dropped into a transfer) --------
// Bytes are written to a temp dir, handed to the storage backend (so S3 works),
// then the temp copy is removed — same shape as the public client-upload route.
const ADMIN_MAX_FILES = 50;

// S3 parity with the download routes — see publicTransferUpload for the why.
const TRANSFER_OBJECT_OPTIONS = {
  contentType: 'application/octet-stream',
  contentDisposition: 'attachment',
};

const tempStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(getStoragePath(), 'temp', 'transfer-admin-uploads');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safe = sanitizeFilename(path.basename(file.originalname), 80) || 'file';
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}-${safe}`);
  },
});

// Text-field budgets per route. Busboy buffers every text part in memory
// before the handler runs, so the parser has to be told how many fields the
// handler reads and how large they can be. Create reads eleven named fields;
// `photoIds` is a JSON array of up to 5000 ids, which is what sizes
// `fieldSize`. Adding files to an existing transfer reads no text at all.
const CREATE_FIELD_LIMITS = { fields: 11, fieldSize: 64 * 1024 };
const FILES_ONLY_FIELD_LIMITS = { fields: 0, fieldSize: 1 };

// Thrown from the file filter so the parser stops before it stages a byte.
const CAPABILITY_PAUSED = 'CAPABILITY_PAUSED';

function buildAdminUploader(maxSizeBytes, policy, fieldLimits, { capability } = {}) {
  return multer({
    storage: tempStorage,
    defParamCharset: 'utf8', // multer's latin1 default turns UTF-8 names into mojibake
    // CVE-2026-82333: files arrive as repeated `files` parts via .array(),
    // not bracket-indexed field names like `files[0]` — no legitimate
    // field name uses array-index syntax at all. Reject any that do.
    limits: {
      fileSize: maxSizeBytes,
      files: ADMIN_MAX_FILES,
      fieldArrayIndexLimit: 0,
      fields: fieldLimits.fields,
      fieldSize: fieldLimits.fieldSize,
      parts: ADMIN_MAX_FILES + fieldLimits.fields,
    },
    fileFilter: (req, file, cb) => {
      // Decided once, at the first file part: before anything is written to the
      // storage the pause may be protecting, and kept for the rest of the
      // request, so an upload admitted while healthy can finish. A request
      // without files never asks.
      if (capability) {
        if (req.capabilityPaused === undefined) req.capabilityPaused = capabilityPaused(capability);
        if (req.capabilityPaused) return cb(Object.assign(new Error('Capability paused'), { code: CAPABILITY_PAUSED }));
      }
      // The transfer policy, not the media registry: these bytes are stored and
      // handed back untouched, never decoded, so `validateFileType`'s "can the
      // pipeline read this" rule is the wrong question. See transferUploadPolicy.
      if (validateTransferFileType(file.originalname, file.mimetype, policy)) return cb(null, true);
      // Skip rather than throw, so one unsupported file does not reject the
      // whole batch. The names are collected for the response.
      req.rejectedFiles = req.rejectedFiles || [];
      req.rejectedFiles.push(file.originalname);
      return cb(null, false);
    },
  }).array('files', ADMIN_MAX_FILES);
}

/**
 * Run multer for a transfer request, reading the size/type limits from settings.
 * Resolves { ok:true } or sends a 4xx and resolves { ok:false }.
 */
async function runAdminUpload(req, res, fieldLimits, options) {
  const policy = await getTransferUploadPolicy();
  const uploader = buildAdminUploader(policy.maxSizeMb * 1024 * 1024, policy, fieldLimits, options);
  try {
    await new Promise((resolve, reject) => uploader(req, res, (err) => (err ? reject(err) : resolve())));
    return { ok: true };
  } catch (err) {
    if (err?.code === CAPABILITY_PAUSED) {
      if (!res.headersSent) sendCapabilityRefusal(req, res, options.capability);
      return { ok: false };
    }
    // Multer's own message is not echoed: a filesystem failure inside the
    // temp-file destination carries the server path (EACCES /app/storage/...),
    // and this route is unauthenticated. The size case is the only one worth
    // naming, because it tells the client something actionable.
    const msg = err && err.code === 'LIMIT_FILE_SIZE'
      ? `Each file must be ${policy.maxSizeMb} MB or smaller`
      : 'Upload failed';
    if (err && err.code !== 'LIMIT_FILE_SIZE') {
      logger.warn('transfer upload rejected', { code: err.code, error: err.message });
    }
    if (!res.headersSent) res.status(400).json({ error: msg, code: 'UPLOAD_REJECTED' });
    return { ok: false };
  }
}

/**
 * The authenticated upload admission (a concurrency slot, the staged-bytes
 * bound and the free-disk check) around a handler that runs multer. Held
 * until the handler has stored or dropped its temp files.
 */
function withUploadAdmission(handler) {
  return async (req, res) => {
    const policy = await getTransferUploadPolicy();
    const maxFileBytes = policy.maxSizeMb * 1024 * 1024;
    const length = req.headers['transfer-encoding'] ? NaN : Number(req.headers['content-length']);
    let session;
    try {
      session = await uploadQuota.begin({
        mode: 'admin', accountId: req.admin.id, maxFiles: ADMIN_MAX_FILES,
        requestedBytes: Number.isSafeInteger(length) && length > 0 ? length : ADMIN_MAX_FILES * maxFileBytes,
      });
    } catch (err) {
      if (!err.status || !/^UPLOAD_/.test(err.code || '')) throw err;
      uploadQuota.forAdmin(err);
      // The refused body is unread; do not leave it on a keep-alive socket.
      if (!req.readableEnded) res.set('Connection', 'close');
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    // The answer waits for the admission to be released, as withPublicUpload
    // does: the page sends the next request (more files, a chunked file) on
    // it, and that request needs the slot.
    const send = res.json;
    let body;
    res.json = (value) => { body = value; return res; };
    try {
      return await handler(req, res);
    } finally {
      await uploadQuota.finish(session).catch((err) => {
        logger.warn('transfer upload admission not released', { requestId: session.id, error: err.message });
      });
      res.json = send;
      if (body !== undefined && !res.headersSent && !res.destroyed) res.json(body);
    }
  };
}

/**
 * Persist the uploaded temp files as the transfer's deliverable extra files.
 * Resolves the names that did not land, so a caller that stores one file (the
 * chunked complete) can say so instead of answering success.
 */
async function storeExtraFiles(transferId, files) {
  const failed = [];
  if (!files || !files.length) return { failed };
  const storage = getStorage();
  for (const file of files) {
    // Opaque key — the client's extension is deliberately not kept on disk or
    // in S3. The real name lives on the row and is what the recipient sees.
    const key = transferService.newExtraFileKey(transferId);
    try {
      await storage.putFromFile(key, file.path, TRANSFER_OBJECT_OPTIONS);
      await transferService.addExtraFile(transferId, {
        originalFilename: file.originalname,
        storedPath: key,
        sizeBytes: file.size,
        mimeType: file.mimetype,
      });
    } catch (err) {
      failed.push(file.originalname);
      logger.error('adminTransfers: failed to store deliverable file', { transferId, error: err.message });
    } finally {
      try { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); } catch (_) { /* noop */ }
    }
  }
  return { failed };
}

/**
 * The transfer after a write that has already stored its files or sent its
 * mail. Best effort: a failed read must not answer 500 for a write that
 * landed — the page would report it missing and a retry would store or send
 * it twice. null when it cannot be read; the page refreshes on its own.
 */
async function refreshAfterWrite(id) {
  try {
    return await transferService.getTransfer(id);
  } catch (err) {
    logger.warn('adminTransfers: transfer not re-read after a write', { transferId: id, error: err.message });
    return null;
  }
}

/** A ready mail held back meanwhile (issue 2061), after files landed. Best effort for the same reason. */
async function sendHeldAfterWrite(id) {
  await transferService.sendHeldReadyEmails(id).catch((err) => {
    logger.warn('adminTransfers: held ready mail not sent after a write', { transferId: id, error: err.message });
  });
}

/**
 * Ownership guard for every `/:id` route. A non-super_admin may only touch a
 * transfer they created (or an ownerless legacy row). Foreign AND missing ids
 * both 404 so the endpoint isn't an existence oracle — the same posture
 * filterOwnedEventIds takes. super_admin is unrestricted.
 */
async function requireTransferOwnership(req, res, next) {
  try {
    // One spelling per transfer. parseInt and Number disagree on `800.1e1`
    // (800 / 8001), `8e2` (8 / 800) and `800abc` (800 / NaN), and routes below
    // read the id either way: authorising one transfer and acting on another.
    // Only the canonical decimal form reaches any of them, for every role.
    if (!/^[1-9]\d*$/.test(String(req.params.id)) || !Number.isSafeInteger(Number(req.params.id))) {
      if (!req.readableEnded) res.set('Connection', 'close');
      return res.status(404).json({ error: 'Transfer not found' });
    }
    if (req.admin.roleName === 'super_admin') return next();
    const id = Number(req.params.id);
    const owner = await transferService.getTransferOwner(id);
    if (!owner) return res.status(404).json({ error: 'Transfer not found' });
    if (owner.created_by != null && owner.created_by !== req.admin.id) {
      return res.status(404).json({ error: 'Transfer not found' });
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

// Upload deliverable files into an existing transfer (multipart `files`).
const uploadDeliverableFiles = withUploadAdmission(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });
  const existing = await transferService.getTransfer(id);
  if (!existing) return res.status(404).json({ error: 'Transfer not found' });
  if (existing.kind === transferService.KIND_REQUEST) {
    return res.status(400).json({
      error: 'A file request does not send files out', code: 'NOT_A_SEND',
    });
  }
  const up = await runAdminUpload(req, res, FILES_ONLY_FIELD_LIMITS);
  if (!up.ok) return;
  const rejected = req.rejectedFiles || [];
  if (!req.files || !req.files.length) {
    return res.status(400).json({
      error: rejected.length
        ? `Not an allowed file type: ${rejected.join(', ')}`
        : 'No files uploaded',
      code: rejected.length ? 'TYPE_REJECTED' : 'NO_FILES',
      rejected_files: rejected,
    });
  }
  const { failed } = await storeExtraFiles(id, req.files);
  if (failed.length === req.files.length) {
    // Nothing landed: not a success, whatever the re-read would say.
    return res.status(500).json({ error: 'Could not store the uploaded files', code: 'STORE_FAILED', failed_files: failed });
  }
  // A ready mail held back while nothing was downloadable (issue 2061).
  await sendHeldAfterWrite(id);
  const transfer = await refreshAfterWrite(id);
  return successResponse(
    res,
    { transfer, rejected_files: rejected, failed_files: failed },
    200,
    rejected.length || failed.length
      ? `Files added — ${rejected.length} were not an allowed type, ${failed.length} could not be stored` : 'Files added',
  );
});

// --- Chunked deliverable upload ---------------------------------------------
// A file above a proxy's per-request body limit (Cloudflare Free/Pro: 100 MB)
// never arrives as one multipart request. It goes up in 10 MB chunks through
// the shared chunk service, bound to this transfer and this admin, and the
// complete step stores it exactly as upload-files stores a multipart file:
// the same type and size rules, the same storage write and row.
const transferChunkOwner = (req) => ({ transferId: Number(req.params.id), adminId: req.admin.id });

// A tagged status is the client's or the admission's answer, not a fault.
function chunkRefusal(req, res, error, fallback) {
  uploadQuota.forAdmin(error);
  if (error.statusCode || error.status) {
    // Unread body bytes would hang the next request on a keep-alive socket.
    if (!req.readableEnded) res.set('Connection', 'close');
    return res.status(error.statusCode || error.status).json({ error: error.message, code: error.code });
  }
  logger.error(`${fallback}:`, { error: error.message });
  return res.status(500).json({ error: fallback });
}

/** The live send behind `:id`, or a 4xx already sent. */
async function loadChunkTarget(req, res) {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    res.status(400).json({ error: 'Invalid id' });
    return null;
  }
  const existing = await transferService.getTransfer(id);
  if (!existing || existing.deleted_at) {
    res.status(404).json({ error: 'Transfer not found' });
    return null;
  }
  if (existing.kind === transferService.KIND_REQUEST) {
    res.status(400).json({ error: 'A file request does not send files out', code: 'NOT_A_SEND' });
    return null;
  }
  return existing;
}

async function initChunkedDeliverable(req, res) {
  try {
    const existing = await loadChunkTarget(req, res);
    if (!existing) return;
    const { filename, fileSize, totalChunks, mimeType } = req.body || {};
    if (!filename || !fileSize) {
      return res.status(400).json({ error: 'Missing required fields: filename, fileSize' });
    }
    const name = String(filename);
    // What multer records for a multipart part: the browser's type, or
    // octet-stream when it has none. Checked by the transfer policy only.
    const mime = typeof mimeType === 'string' && mimeType.trim() ? mimeType.trim().slice(0, 255) : 'application/octet-stream';
    const policy = await getTransferUploadPolicy();
    if (!validateTransferFileType(name, mime, policy)) {
      return res.status(400).json({
        error: `Not an allowed file type: ${name}`, code: 'TYPE_REJECTED', rejected_files: [name],
      });
    }
    const result = await chunkedUpload.initializeUpload({
      filename: name,
      fileSize,
      totalChunks,
      mimeType: mime,
      transferId: existing.id,
      adminId: req.admin.id,
      // Enforced again on the bytes received and merged.
      maxFileSizeBytes: policy.maxSizeMb * 1024 * 1024,
      admission: true,
      opaque: true,
    });
    return res.json(result);
  } catch (error) {
    return chunkRefusal(req, res, error, 'Failed to initialize upload');
  }
}

async function uploadDeliverableChunk(req, res) {
  try {
    // Streamed to the chunk file under a hard cap, never buffered; every
    // check runs before a byte of the body is read (see adminPhotos).
    const declaredBytes = Number(req.headers['content-length']);
    const index = /^\d+$/.test(req.params.chunkIndex) ? Number(req.params.chunkIndex) : NaN;
    const result = await chunkedUpload.uploadChunk(req.params.uploadId, index, req, {
      declaredBytes: Number.isFinite(declaredBytes) ? declaredBytes : undefined,
      owner: transferChunkOwner(req),
    });
    return res.json(result);
  } catch (error) {
    return chunkRefusal(req, res, error, 'Failed to upload chunk');
  }
}

async function completeChunkedDeliverable(req, res) {
  const owner = transferChunkOwner(req);
  const { uploadId } = req.params;
  let merged;
  const cancel = () => {
    if (req.aborted || !res.writableEnded) chunkedUpload.abortUpload(uploadId, { owner })
      .catch((err) => logger.warn('Disconnected transfer chunk upload cleanup unavailable', { error: err.message }));
  };
  req.once('aborted', cancel);
  res.once('close', cancel);
  // Answered once the admission has settled, as a multipart upload is: the
  // page starts the next file on this answer, and that file needs the slot.
  const reply = deferredReply(res);
  try {
    const existing = await loadChunkTarget(req, reply);
    if (!existing) {
      await chunkedUpload.abortUpload(uploadId, { owner }).catch(() => {});
      return;
    }
    merged = await chunkedUpload.completeUpload(uploadId, { owner });
    const dropMerged = () => fs.promises.rm(merged.tempDir, { recursive: true, force: true }).catch(() => {});
    // The policy as it is now: settings may have changed since init.
    const policy = await getTransferUploadPolicy();
    if (!validateTransferFileType(merged.filename, merged.mimeType, policy)) {
      await dropMerged();
      return reply.status(400).json({
        error: `Not an allowed file type: ${merged.filename}`, code: 'TYPE_REJECTED', rejected_files: [merged.filename],
      });
    }
    if (merged.size > policy.maxSizeMb * 1024 * 1024) {
      await dropMerged();
      return reply.status(413).json({ error: `Each file must be ${policy.maxSizeMb} MB or smaller`, code: 'FILE_TOO_LARGE' });
    }
    const { failed } = await storeExtraFiles(existing.id, [{
      originalname: merged.filename, path: merged.path, size: merged.size, mimetype: merged.mimeType,
    }]);
    await dropMerged();
    if (failed.length) {
      return reply.status(500).json({ error: 'Could not store the uploaded file', code: 'STORE_FAILED', failed_files: failed });
    }
    // Same as upload-files: a ready mail held back while nothing was
    // downloadable (issue 2061). A send still being filled is held there.
    await sendHeldAfterWrite(existing.id);
    const transfer = await refreshAfterWrite(existing.id);
    return successResponse(reply, { transfer, rejected_files: [] }, 200, 'Files added');
  } catch (error) {
    return chunkRefusal(req, reply, error, 'Failed to complete upload');
  } finally {
    req.removeListener('aborted', cancel);
    res.removeListener('close', cancel);
    if (merged?.uploadReservation) {
      await chunkedUpload.finishUpload(uploadId, { owner })
        .catch((err) => logger.warn('Transfer chunk upload cleanup unavailable; admission retained', { error: err.message }));
    }
    reply.flush();
  }
}

// Releases the caller's own unfinished upload: its staging and its admission.
async function abortChunkedDeliverable(req, res) {
  const aborted = await chunkedUpload.abortUpload(req.params.uploadId, { owner: transferChunkOwner(req) });
  if (!aborted) return res.status(404).json({ error: 'Upload not found or expired' });
  return successResponse(res, { aborted: true }, 200, 'Upload aborted');
}

module.exports = {
  CREATE_FIELD_LIMITS,
  FILES_ONLY_FIELD_LIMITS,
  runAdminUpload,
  withUploadAdmission,
  storeExtraFiles,
  refreshAfterWrite,
  sendHeldAfterWrite,
  requireTransferOwnership,
  uploadDeliverableFiles,
  initChunkedDeliverable,
  uploadDeliverableChunk,
  completeChunkedDeliverable,
  abortChunkedDeliverable,
};
