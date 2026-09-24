/**
 * Admin → Transfers routes (PicTransfer, #997).
 *
 * Mounted at /api/admin/transfers. A transfer bundles ORIGINAL photos picked
 * from any event into a token-protected download link, and can optionally open
 * a short upload token so the client can send files back.
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
const { validateFileType } = require('../utils/fileSecurityUtils');
const { sanitizeFilename } = require('../utils/filenameSanitizer');
const { getAppSetting } = require('../utils/appSettings');
const { getStorage } = require('../services/storage');
const transferService = require('../services/transferService');
const logger = require('../utils/logger');
const { pipeStreamToResponse } = require('../utils/streamResponse');
const fs = require('fs');

const router = express.Router();

// --- Admin deliverable-file upload (the files dropped into a transfer) --------
// Bytes are written to a temp dir, handed to the storage backend (so S3 works),
// then the temp copy is removed — same shape as the public client-upload route.
const ADMIN_MAX_FILES = 50;
const DEFAULT_ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/tiff', 'application/pdf', 'application/zip'];
const getStoragePath = () => process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');

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

function buildAdminUploader(maxSizeBytes, allowed) {
  return multer({
    storage: tempStorage,
    // CVE-2026-82333: files arrive as repeated `files` parts via .array(),
    // not bracket-indexed field names like `files[0]` — no legitimate
    // field name uses array-index syntax at all. Reject any that do.
    limits: { fileSize: maxSizeBytes, files: ADMIN_MAX_FILES, fieldArrayIndexLimit: 0 },
    fileFilter: (req, file, cb) => {
      if (validateFileType(file.originalname, file.mimetype, allowed)) return cb(null, true);
      return cb(new Error('This file type is not allowed'));
    },
  }).array('files', ADMIN_MAX_FILES);
}

/**
 * Run multer for a transfer request, reading the size/type limits from settings.
 * Resolves { ok:true } or sends a 4xx and resolves { ok:false }.
 */
async function runAdminUpload(req, res) {
  const maxSizeMb = Number(await getAppSetting('transfer_max_upload_size_mb', 50)) || 50;
  const allowedSetting = await getAppSetting('transfer_upload_allowed_mime', DEFAULT_ALLOWED);
  const allowed = Array.isArray(allowedSetting) ? allowedSetting : DEFAULT_ALLOWED;
  const uploader = buildAdminUploader(maxSizeMb * 1024 * 1024, allowed);
  try {
    await new Promise((resolve, reject) => uploader(req, res, (err) => (err ? reject(err) : resolve())));
    return { ok: true };
  } catch (err) {
    const msg = err && err.code === 'LIMIT_FILE_SIZE'
      ? `Each file must be ${maxSizeMb} MB or smaller`
      : (err && err.message) || 'Upload failed';
    if (!res.headersSent) res.status(400).json({ error: msg, code: 'UPLOAD_REJECTED' });
    return { ok: false };
  }
}

/** Persist the uploaded temp files as the transfer's deliverable extra files. */
async function storeExtraFiles(transferId, files) {
  if (!files || !files.length) return;
  const storage = getStorage();
  let i = 0;
  for (const file of files) {
    i += 1;
    const safeName = sanitizeFilename(path.basename(file.originalname), 120) || 'file';
    const key = path.posix.join(transferService.extraFilesDirKey(transferId), `${Date.now()}-${i}-${safeName}`);
    try {
      await storage.putFromFile(key, file.path);
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
    const up = await runAdminUpload(req, res);
    if (!up.ok) return; // 4xx already sent

    const b = req.body || {};
    const photoIds = parseJsonArrayField(b.photoIds)
      .map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 5000);
    const recipientEmails = parseJsonArrayField(b.recipientEmails)
      .map((e) => String(e || '').trim()).filter(Boolean).slice(0, 100);
    const deliveryMethod = b.deliveryMethod === 'email' ? 'email' : 'link';

    const transfer = await transferService.createTransfer({
      title: b.title,
      message: b.message,
      expiresInDays: b.expiresInDays,
      maxDownloads: b.maxDownloads,
      graceDays: b.graceDays,
      allowUploads: b.allowUploads === 'true' || b.allowUploads === true,
      uploadExpiresInDays: b.uploadExpiresInDays,
      photoIds,
      deliveryMethod,
    }, req.admin);

    await storeExtraFiles(transfer.id, req.files);

    if (deliveryMethod === 'email' && recipientEmails.length) {
      await transferService.sendTransferEmails(transfer.id, recipientEmails);
    }

    const fresh = await transferService.getTransfer(transfer.id);
    return successResponse(res, { transfer: fresh }, 201, 'Transfer created');
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

// Add photos (cross-event) to a transfer
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
    const up = await runAdminUpload(req, res);
    if (!up.ok) return;
    if (!req.files || !req.files.length) {
      return res.status(400).json({ error: 'No files uploaded', code: 'NO_FILES' });
    }
    await storeExtraFiles(id, req.files);
    const transfer = await transferService.getTransfer(id);
    return successResponse(res, { transfer }, 200, 'Files added');
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

// Enable / regenerate the client-upload link
router.post('/:id/upload-link',
  requirePermission('events.edit'),
  [param('id').isInt({ min: 1 }), body('uploadExpiresInDays').optional({ nullable: true }).isInt({ min: 1, max: 3650 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const transfer = await transferService.enableUploads(
      parseInt(req.params.id, 10), { uploadExpiresInDays: req.body.uploadExpiresInDays },
    );
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    return successResponse(res, { transfer }, 200, 'Upload link enabled');
  }),
);

// Disable the client-upload link
router.delete('/:id/upload-link',
  requirePermission('events.edit'),
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const transfer = await transferService.disableUploads(parseInt(req.params.id, 10));
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    return successResponse(res, { transfer }, 200, 'Upload link disabled');
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
    res.setHeader('Content-Type', upload.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(upload.original_filename)}"`);
    // Through the helper, never a bare pipe: the local read stream opens
    // lazily and a source 'error' with no listener ends the process.
    pipeStreamToResponse(body, res, { context: `transfer ${upload.transfer_id} upload ${upload.id}` });
  }),
);

module.exports = router;
