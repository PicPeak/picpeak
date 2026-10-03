/**
 * Admin → Transfers routes (PicTransfer, #997).
 *
 * Mounted at /api/admin/transfers. A transfer is one of two things (#1544):
 *   kind 'send'     bundles ORIGINAL photos picked from any event, plus the
 *                   admin's own files, behind a token-protected download link.
 *   kind 'request'  collects files FROM a client behind a token-protected
 *                   upload link. Never serves a download.
 * They are mutually exclusive — see migration 257.
 *
 * Read  = `events.view`; write = `events.edit` (transfers are an
 * events/photos-adjacent admin tool, so they ride the same permissions as the
 * projects cockpit rather than inventing a new permission).
 */

const express = require('express');
const { body, param } = require('express-validator');
const multer = require('multer');
const path = require('path');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { requireFeatureFlag } = require('../middleware/requireFeatureFlag');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const { sanitizeFilename } = require('../utils/filenameSanitizer');
const { getStorage } = require('../services/storage');
const transferService = require('../services/transferService');
const {
  getTransferUploadPolicy,
  validateTransferFileType,
  setAttachmentHeaders,
} = require('../services/transferUploadPolicy');
const logger = require('../utils/logger');
const { pipeStreamToResponse } = require('../utils/streamResponse');
const fs = require('fs');

const router = express.Router();

// --- Admin deliverable-file upload (the files dropped into a transfer) --------
// Bytes are written to a temp dir, handed to the storage backend (so S3 works),
// then the temp copy is removed — same shape as the public client-upload route.
const ADMIN_MAX_FILES = 50;
const { getStoragePath } = require('../config/storage');

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
// handler reads and how large they can be. Create reads nine named fields;
// `photoIds` is a JSON array of up to 5000 ids, which is what sizes
// `fieldSize`. Adding files to an existing transfer reads no text at all.
const CREATE_FIELD_LIMITS = { fields: 10, fieldSize: 64 * 1024 };
const FILES_ONLY_FIELD_LIMITS = { fields: 0, fieldSize: 1 };

function buildAdminUploader(maxSizeBytes, policy, fieldLimits) {
  return multer({
    storage: tempStorage,
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
async function runAdminUpload(req, res, fieldLimits) {
  const policy = await getTransferUploadPolicy();
  const uploader = buildAdminUploader(policy.maxSizeMb * 1024 * 1024, policy, fieldLimits);
  try {
    await new Promise((resolve, reject) => uploader(req, res, (err) => (err ? reject(err) : resolve())));
    return { ok: true };
  } catch (err) {
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

/** Persist the uploaded temp files as the transfer's deliverable extra files. */
async function storeExtraFiles(transferId, files) {
  if (!files || !files.length) return;
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
      logger.error('adminTransfers: failed to store deliverable file', { transferId, error: err.message });
    } finally {
      try { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); } catch (_) { /* noop */ }
    }
  }
}

/** Parse a multipart field that carries a JSON array (photoIds, recipientEmails). */
function parseJsonArrayField(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    // Fallback: comma-separated (e.g. a raw "a@x.com, b@y.com" email field).
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }
}

router.use(adminAuth);
// PicTransfer is a strictly opt-in module — refuse every admin transfer route
// when the `transfers` feature flag is off, so a disabled feature is never
// actable even by a direct API hit (the sidebar already hides the surface).
router.use(requireFeatureFlag('transfers'));

/**
 * Ownership guard for every `/:id` route. A non-super_admin may only touch a
 * transfer they created (or an ownerless legacy row). Foreign AND missing ids
 * both 404 so the endpoint isn't an existence oracle — the same posture
 * filterOwnedEventIds takes. super_admin is unrestricted.
 */
async function requireTransferOwnership(req, res, next) {
  try {
    if (req.admin.roleName === 'super_admin') return next();
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id' });
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

// List
router.get('/', requirePermission('events.view'), handleAsync(async (req, res) => {
  const transfers = await transferService.listTransfers({ search: req.query.q || '', admin: req.admin });
  return successResponse(res, { transfers });
}));

// Create. multipart/form-data: text fields + optional `files` (the operator's
// own deliverable files) + `photoIds`/`recipientEmails` as JSON-array fields.
// Uploaded files land as transfer_extra_files; delivery_method='email' emails
// the recipients the download link.
router.post('/',
  requirePermission('events.edit'),
  handleAsync(async (req, res) => {
    const up = await runAdminUpload(req, res, CREATE_FIELD_LIMITS);
    if (!up.ok) return; // 4xx already sent

    const b = req.body || {};
    const kind = transferService.normalizeKind(b.kind);
    const isRequest = kind === transferService.KIND_REQUEST;
    const photoIds = parseJsonArrayField(b.photoIds)
      .map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 5000);
    const recipientEmails = parseJsonArrayField(b.recipientEmails)
      .map((e) => String(e || '').trim()).filter(Boolean).slice(0, 100);
    const deliveryMethod = b.deliveryMethod === 'email' ? 'email' : 'link';

    // A send has to be sending something. Before #1544 the file filter threw,
    // so a create whose files were all rejected was a 400; now the filter skips
    // them, and without this the row is created empty and — on
    // deliveryMethod 'email' — a "your files are ready" mail goes out for a
    // transfer holding nothing.
    if (!isRequest && photoIds.length === 0 && !(req.files || []).length) {
      const rejectedNow = req.rejectedFiles || [];
      for (const file of req.files || []) {
        try { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); } catch (_) { /* noop */ }
      }
      return res.status(400).json({
        error: rejectedNow.length
          ? `Nothing to send — no allowed file type among: ${rejectedNow.join(', ')}`
          : 'Add at least one photo or file to send',
        code: rejectedNow.length ? 'TYPE_REJECTED' : 'NOTHING_TO_SEND',
        rejected_files: rejectedNow,
      });
    }

    const transfer = await transferService.createTransfer({
      kind,
      title: b.title,
      message: b.message,
      expiresInDays: b.expiresInDays,
      maxDownloads: b.maxDownloads,
      graceDays: b.graceDays,
      // A request carries no outbound photos; createTransfer ignores them, but
      // don't hand them over either — a scoped admin's picks are still checked
      // against ownership there, and silently dropping them here is clearer.
      photoIds: isRequest ? [] : photoIds,
      deliveryMethod,
    }, req.admin);

    // Likewise: the admin's own deliverable files are outbound content.
    //
    // storeExtraFiles is also what unlinks multer's temp copies, so on the
    // request branch they have to be cleaned up here or they sit in
    // storage/temp/transfer-admin-uploads forever — nothing sweeps that
    // directory. The names are reported back so the drop is not silent.
    const droppedOnRequest = isRequest ? (req.files || []).map((f) => f.originalname) : [];
    if (isRequest) {
      for (const file of req.files || []) {
        try { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); } catch (_) { /* noop */ }
      }
    } else {
      await storeExtraFiles(transfer.id, req.files);
    }

    if (deliveryMethod === 'email' && recipientEmails.length) {
      if (isRequest) {
        await transferService.sendTransferRequestEmails(transfer.id, recipientEmails);
      } else {
        await transferService.sendTransferEmails(transfer.id, recipientEmails);
      }
    }

    const fresh = await transferService.getTransfer(transfer.id);
    const rejected = req.rejectedFiles || [];
    const notes = [];
    if (rejected.length) notes.push(`${rejected.length} file(s) were not an allowed type`);
    if (droppedOnRequest.length) {
      notes.push(`${droppedOnRequest.length} attached file(s) were not kept — a file request only collects files`);
    }
    return successResponse(
      res,
      { transfer: fresh, rejected_files: rejected, dropped_files: droppedOnRequest },
      201,
      notes.length ? `${isRequest ? 'File request' : 'Transfer'} created — ${notes.join('; ')}` : 'Transfer created',
    );
  }),
);

// Ownership guard for every `/:id`, `/:id/files`, `/:id/download`, … route.
// One mount covers them all — the POST `/` create + GET `/` list above are not
// matched (no :id), and each route keeps its own requirePermission.
router.use('/:id', requireTransferOwnership);

// Detail
router.get('/:id',
  requirePermission('events.view'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const transfer = await transferService.getTransfer(parseInt(req.params.id, 10));
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    return successResponse(res, { transfer });
  }),
);

// Update
router.patch('/:id',
  requirePermission('events.edit'),
  [
    param('id').isInt({ min: 1 }),
    body('title').optional({ nullable: true }).isString().isLength({ max: 255 }),
    body('message').optional({ nullable: true }).isString().isLength({ max: 5000 }),
    body('maxDownloads').optional({ nullable: true }).isInt({ min: 0, max: 1000000 }),
    body('graceDays').optional({ nullable: true }).isInt({ min: 0, max: 365 }),
    body('expiresInDays').optional({ nullable: true }).isInt({ min: 1, max: 3650 }),
    body('expiresAt').optional({ nullable: true }).isISO8601(),
    body('isActive').optional().isBoolean(),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const transfer = await transferService.updateTransfer(parseInt(req.params.id, 10), {
      title: req.body.title,
      message: req.body.message,
      maxDownloads: req.body.maxDownloads,
      graceDays: req.body.graceDays,
      expiresInDays: req.body.expiresInDays,
      expiresAt: req.body.expiresAt,
      isActive: req.body.isActive,
    });
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    return successResponse(res, { transfer }, 200, 'Transfer updated');
  }),
);

// Delete
router.delete('/:id',
  requirePermission('events.edit'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const ok = await transferService.deleteTransfer(parseInt(req.params.id, 10));
    if (!ok) return res.status(404).json({ error: 'Transfer not found' });
    return successResponse(res, { deleted: true }, 200, 'Transfer deleted');
  }),
);

// Add photos (cross-event) to a SEND. A request has no outbound content.
router.post('/:id/files',
  requirePermission('events.edit'),
  [
    param('id').isInt({ min: 1 }),
    body('photoIds').isArray({ min: 1, max: 5000 }),
    body('photoIds.*').isInt({ min: 1 }),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const existing = await transferService.getTransfer(parseInt(req.params.id, 10));
    if (!existing) return res.status(404).json({ error: 'Transfer not found' });
    if (existing.kind === transferService.KIND_REQUEST) {
      return res.status(400).json({
        error: 'A file request does not send files out', code: 'NOT_A_SEND',
      });
    }
    const transfer = await transferService.addFiles(parseInt(req.params.id, 10), req.body.photoIds, req.admin);
    return successResponse(res, { transfer }, 200, 'Files added');
  }),
);

// Remove one file from a transfer
router.delete('/:id/files/:fileId',
  requirePermission('events.edit'),
  [param('id').isInt({ min: 1 }), param('fileId').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const transfer = await transferService.removeFile(
      parseInt(req.params.id, 10), parseInt(req.params.fileId, 10),
    );
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    return successResponse(res, { transfer }, 200, 'File removed');
  }),
);

// Upload deliverable files into an existing transfer (multipart `files`).
router.post('/:id/upload-files',
  requirePermission('events.edit'),
  handleAsync(async (req, res) => {
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
    await storeExtraFiles(id, req.files);
    const transfer = await transferService.getTransfer(id);
    return successResponse(
      res,
      { transfer, rejected_files: rejected },
      200,
      rejected.length ? `Files added — ${rejected.length} were not an allowed type` : 'Files added',
    );
  }),
);

// Remove one admin-uploaded deliverable file from a transfer
router.delete('/:id/extra-files/:extraId',
  requirePermission('events.edit'),
  [param('id').isInt({ min: 1 }), param('extraId').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const transfer = await transferService.removeExtraFile(
      parseInt(req.params.id, 10), parseInt(req.params.extraId, 10),
    );
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    return successResponse(res, { transfer }, 200, 'File removed');
  }),
);

// Admin download of a single admin-uploaded deliverable file
router.get('/:id/extra-files/:extraId/download',
  requirePermission('events.view'),
  [param('id').isInt({ min: 1 }), param('extraId').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const transfer = await transferService.getTransfer(parseInt(req.params.id, 10));
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    const ok = await transferService.streamTransferExtraFile(
      { id: transfer.id }, parseInt(req.params.extraId, 10), res,
    );
    if (!ok && !res.headersSent) return res.status(404).json({ error: 'File not found' });
  }),
);

// Issue or rotate the short read-aloud upload code on a REQUEST.
//
// Pre-#1544 this opened an upload channel on any transfer. A request is born
// with its channel open on the 64-hex token, so this now only manages the
// optional short code; `{ rotate: true }` replaces one that has leaked.
router.post('/:id/upload-code',
  requirePermission('events.edit'),
  [param('id').isInt({ min: 1 }), body('rotate').optional().isBoolean()],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const transfer = await transferService.enableUploadCode(
      parseInt(req.params.id, 10), { rotate: req.body.rotate === true || req.body.rotate === 'true' },
    );
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    if (transfer.error === 'NOT_A_REQUEST') {
      return res.status(400).json({ error: 'Only a file request has an upload code', code: 'NOT_A_REQUEST' });
    }
    return successResponse(res, { transfer }, 200, 'Upload code issued');
  }),
);

// Withdraw the short code. The request stays open on its 64-hex link.
router.delete('/:id/upload-code',
  requirePermission('events.edit'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const transfer = await transferService.disableUploadCode(parseInt(req.params.id, 10));
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    if (transfer.error === 'NOT_A_REQUEST') {
      return res.status(400).json({ error: 'Only a file request has an upload code', code: 'NOT_A_REQUEST' });
    }
    return successResponse(res, { transfer }, 200, 'Upload code withdrawn');
  }),
);

// Re-send this transfer's email: the "please upload your files" ask for a
// request, the "your files are ready" delivery for a send. Both go through the
// ownership mount above, so the addresses can only be attached to a transfer
// this admin owns.
router.post('/:id/resend',
  requirePermission('events.edit'),
  [
    param('id').isInt({ min: 1 }),
    body('recipientEmails').optional().isArray({ max: 100 }),
    // Validate each address here rather than only dropping the bad ones in the
    // service: a typo'd list otherwise answers 200 "Email sent" with sent: 0,
    // and the admin has no reason to look again.
    body('recipientEmails.*').optional().isEmail().withMessage('Not a valid email address'),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const id = parseInt(req.params.id, 10);
    const transfer = await transferService.getTransfer(id);
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });

    // Default to the addresses already on the row so "resend" needs no input.
    const emails = Array.isArray(req.body.recipientEmails) && req.body.recipientEmails.length
      ? req.body.recipientEmails
      : (transfer.recipients || []).map((r) => r.email);
    if (!emails.length) {
      return res.status(400).json({ error: 'No recipients to send to', code: 'NO_RECIPIENTS' });
    }

    const result = transfer.kind === transferService.KIND_REQUEST
      ? await transferService.sendTransferRequestEmails(id, emails)
      : await transferService.sendTransferEmails(id, emails);
    return successResponse(
      res, { transfer: await transferService.getTransfer(id), sent: result.sent }, 200, 'Email sent',
    );
  }),
);

// Admin download of the whole transfer (ZIP of originals). No expiry/limit
// gate — this is the operator retrieving their own bundle.
router.get('/:id/download',
  requirePermission('photos.download'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const transfer = await transferService.getTransfer(parseInt(req.params.id, 10));
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    if (transfer.kind === transferService.KIND_REQUEST) {
      // A request's bytes are the client's uploads, downloaded one at a time
      // below — there is no outbound bundle to zip.
      return res.status(400).json({ error: 'A file request has no outgoing bundle', code: 'NOT_A_SEND' });
    }
    // getTransfer returns the serialized view; streamTransferArchive only needs
    // { id, title }, both present on it.
    await transferService.streamTransferArchive(transfer, res);
  }),
);

// Admin download of a single client-uploaded file
router.get('/:id/uploads/:uploadId/download',
  requirePermission('events.view'),
  [param('id').isInt({ min: 1 }), param('uploadId').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const upload = await transferService.getUpload(
      parseInt(req.params.id, 10), parseInt(req.params.uploadId, 10),
    );
    if (!upload) return res.status(404).json({ error: 'Upload not found' });
    // Open the body BEFORE the attachment headers go on: on S3 `get` awaits
    // GetObject and can reject, and with Content-Disposition already set the
    // error handler would answer JSON that the browser saves as the file.
    let body;
    if (upload.localPath && fs.existsSync(upload.localPath)) {
      body = fs.createReadStream(upload.localPath);
    } else {
      // S3 / non-local backend: stream via the storage abstraction.
      body = await getStorage().get(upload.stored_path);
    }
    setAttachmentHeaders(res, upload.original_filename, upload.mime_type);
    // Through the helper, never a bare pipe: the local read stream opens
    // lazily and a source 'error' with no listener ends the process.
    pipeStreamToResponse(body, res, { context: `transfer ${upload.transfer_id} upload ${upload.id}` });
  }),
);

module.exports = router;
