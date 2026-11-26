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
const { requireCapability } = require('../middleware/requireCapability');
const { body, param } = require('express-validator');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { requireFeatureFlag } = require('../middleware/requireFeatureFlag');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const { getStorage } = require('../services/storage');
const transferService = require('../services/transferService');
const {
  getTransferUploadPolicy,
  setAttachmentHeaders,
  normalizeMaxFiles,
  MAX_FILES_CEILING,
} = require('../services/transferUploadPolicy');
const { streamingArchiveAdmission } = require('../utils/archiveStreamGuard');
const { pipeStreamToResponse } = require('../utils/streamResponse');
const fs = require('fs');
// The deliverable upload plumbing (multer, admission, storage write, chunked
// path) and the ownership guard live in middleware/transferDeliverables,
// shared with the API v1 transfer routes so both surfaces enforce the same
// limits and the same ownership rule.
const {
  CREATE_FIELD_LIMITS,
  runAdminUpload,
  withUploadAdmission,
  storeExtraFiles,
  refreshAfterWrite,
  requireTransferOwnership,
  uploadDeliverableFiles,
  initChunkedDeliverable,
  uploadDeliverableChunk,
  completeChunkedDeliverable,
  abortChunkedDeliverable,
} = require('../middleware/transferDeliverables');

const router = express.Router();

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
  handleAsync(withUploadAdmission(async (req, res) => {
    // Only with files: sending gallery photos or a file request stores nothing.
    const up = await runAdminUpload(req, res, CREATE_FIELD_LIMITS, { capability: 'uploads.new' });
    if (!up.ok) return; // 4xx or 503 already sent

    const b = req.body || {};
    const kind = transferService.normalizeKind(b.kind);
    const isRequest = kind === transferService.KIND_REQUEST;
    const photoIds = parseJsonArrayField(b.photoIds)
      .map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= 2147483647).slice(0, 5000);
    const recipientEmails = parseJsonArrayField(b.recipientEmails)
      .map((e) => String(e || '').trim()).filter(Boolean).slice(0, 100);
    const deliveryMethod = b.deliveryMethod === 'email' ? 'email' : 'link';
    // Multer's temp copies of the uploaded files, for the paths that refuse
    // the request before storeExtraFiles takes them over.
    const dropTempFiles = () => {
      for (const file of req.files || []) {
        try { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); } catch (_) { /* noop */ }
      }
    };
    // How many of the admin's own files the page is still going to upload
    // into this send, in chunks or further requests, because they do not fit
    // this one request (a proxy's body limit, e.g. Cloudflare's 100 MB). The
    // send is not empty for want of them, and its ready mail waits for them.
    const pendingFiles = isRequest ? 0 : Math.min(Math.max(parseInt(b.pendingFiles, 10) || 0, 0), 10000);

    // Empty means "use the global default"; anything else has to be a usable
    // number, or the request would be created with a limit the admin did not
    // ask for (issue 1914). Multipart text, so it arrives as a string.
    const ownLimitGiven = isRequest && b.maxFilesPerUpload != null && String(b.maxFilesPerUpload).trim() !== '';
    if (ownLimitGiven && !normalizeMaxFiles(b.maxFilesPerUpload)) {
      dropTempFiles();
      return res.status(400).json({
        error: `Maximum files per upload must be a whole number between 1 and ${MAX_FILES_CEILING}`,
        code: 'BAD_FILE_COUNT',
      });
    }

    // A send has to be sending something. Before #1544 the file filter threw,
    // so a create whose files were all rejected was a 400; now the filter skips
    // them, and without this the row is created empty and — on
    // deliveryMethod 'email' — a "your files are ready" mail goes out for a
    // transfer holding nothing.
    // Picks that name no photo this admin may send (another event's, or
    // none at all) leave a transfer just as empty (issue 2086).
    const usablePhotoIds = !isRequest && photoIds.length
      ? await transferService.filterOwnedPhotoIds(req.admin, photoIds)
      : [];
    if (!isRequest && usablePhotoIds.length === 0 && !(req.files || []).length && pendingFiles === 0) {
      const rejectedNow = req.rejectedFiles || [];
      dropTempFiles();
      return res.status(400).json({
        error: rejectedNow.length
          ? `Nothing to send — no allowed file type among: ${rejectedNow.join(', ')}`
          : photoIds.length
            ? 'None of the selected photos could be found'
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
      maxFilesPerUpload: ownLimitGiven ? b.maxFilesPerUpload : undefined,
    }, req.admin);

    // Likewise: the admin's own deliverable files are outbound content.
    //
    // storeExtraFiles is also what unlinks multer's temp copies, so on the
    // request branch they have to be cleaned up here or they sit in
    // storage/temp/transfer-admin-uploads forever — nothing sweeps that
    // directory. The names are reported back so the drop is not silent.
    const droppedOnRequest = isRequest ? (req.files || []).map((f) => f.originalname) : [];
    // Accepted but not stored (storage or database failure): reported, never
    // counted as part of the transfer.
    let failedToStore = [];
    if (isRequest) {
      dropTempFiles();
    } else {
      ({ failed: failedToStore } = await storeExtraFiles(transfer.id, req.files));
    }

    if (deliveryMethod === 'email' && recipientEmails.length) {
      if (isRequest) {
        await transferService.sendTransferRequestEmails(transfer.id, recipientEmails);
      } else if (pendingFiles > 0) {
        // Recorded as held, not mailed, and held from every automatic path:
        // the page sends it (the resend route) once every file has landed.
        await transferService.holdTransferRecipients(transfer.id, recipientEmails);
      } else {
        await transferService.sendTransferEmails(transfer.id, recipientEmails);
      }
    }

    const fresh = (await refreshAfterWrite(transfer.id)) || transfer;
    const rejected = req.rejectedFiles || [];
    const notes = [];
    if (rejected.length) notes.push(`${rejected.length} file(s) were not an allowed type`);
    if (droppedOnRequest.length) {
      notes.push(`${droppedOnRequest.length} attached file(s) were not kept — a file request only collects files`);
    }
    if (failedToStore.length) notes.push(`${failedToStore.length} file(s) could not be stored`);
    return successResponse(
      res,
      { transfer: fresh, rejected_files: rejected, dropped_files: droppedOnRequest, failed_files: failedToStore },
      201,
      notes.length ? `${isRequest ? 'File request' : 'Transfer'} created — ${notes.join('; ')}` : 'Transfer created',
    );
  })),
);

// The global files-per-upload default, for the create dialog's "use the
// default (N)" hint (issue 1914). An admin who creates requests need not hold
// settings.view, so it is answered here. Above the `/:id` routes, which would
// otherwise take the word for an id.
router.get('/upload-defaults', requirePermission('events.view'), handleAsync(async (req, res) => {
  const policy = await getTransferUploadPolicy();
  return successResponse(res, { max_files_per_upload: policy.maxFiles, max_files_ceiling: MAX_FILES_CEILING });
}));

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
    // null clears a request's own limit (back to the global default).
    body('maxFilesPerUpload').optional({ nullable: true }).isInt({ min: 1, max: MAX_FILES_CEILING }),
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
      maxFilesPerUpload: req.body.maxFilesPerUpload,
    });
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    // Re-activated or extended: a ready mail held back meanwhile (issue 2061).
    await transferService.sendHeldReadyEmails(transfer.id);
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
    let transfer = await transferService.addFiles(parseInt(req.params.id, 10), req.body.photoIds, req.admin);
    // A ready mail held back while nothing was downloadable (issue 2061).
    if ((await transferService.sendHeldReadyEmails(transfer.id)).sent) {
      transfer = await transferService.getTransfer(transfer.id);
    }
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
  requireCapability('uploads.new'),
  handleAsync(uploadDeliverableFiles),
);

// --- Chunked deliverable upload ---------------------------------------------
// See middleware/transferDeliverables for the init / chunk / complete flow.
router.post('/:id/chunked-upload/init',
  requirePermission('events.edit'),
  requireCapability('uploads.new'),
  handleAsync(initChunkedDeliverable),
);

// Not capability-guarded: an upload admitted while healthy may finish.
router.post('/:id/chunked-upload/:uploadId/chunk/:chunkIndex',
  requirePermission('events.edit'),
  handleAsync(uploadDeliverableChunk),
);

router.post('/:id/chunked-upload/:uploadId/complete',
  requirePermission('events.edit'),
  handleAsync(completeChunkedDeliverable),
);

// Releases the caller's own unfinished upload: its staging and its admission.
router.delete('/:id/chunked-upload/:uploadId',
  requirePermission('events.edit'),
  handleAsync(abortChunkedDeliverable),
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
      res, { transfer: await refreshAfterWrite(id), sent: result.sent, held: !!result.held }, 200,
      result.held ? 'Nothing is ready to download yet; the email goes out once a photo finishes processing' : 'Email sent',
    );
  }),
);

// Admin download of the whole transfer (ZIP of originals). No expiry/limit
// gate — this is the operator retrieving their own bundle.
router.get('/:id/download',
  requirePermission('photos.download'),
  [param('id').isInt({ min: 1 })],
  requireCapability('downloads.archive'),
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

// Admin download of everything a client sent through a file request, as one
// ZIP (issue 1914). The same permission as the outgoing bundle above.
router.get('/:id/uploads/download',
  requirePermission('photos.download'),
  [param('id').isInt({ min: 1 })],
  requireCapability('downloads.archive'),
  handleAsync(async (req, res) => {
    validateRequest(req);
    const transfer = await transferService.getTransfer(parseInt(req.params.id, 10));
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    if (transfer.kind !== transferService.KIND_REQUEST) {
      return res.status(400).json({ error: 'Only a file request receives files', code: 'NOT_A_REQUEST' });
    }
    // Before the attachment headers go on, or the browser saves this answer
    // as the ZIP.
    if (!transfer.uploads || transfer.uploads.length === 0) {
      return res.status(404).json({ error: 'No files received yet', code: 'NO_UPLOADS' });
    }
    // The process-wide limit on archives being streamed at once, shared with
    // the gallery ZIP routes: each holds storage reads for as long as its
    // download takes.
    const release = await streamingArchiveAdmission.acquire();
    if (!release) {
      res.set('Retry-After', '10');
      return res.status(429).json({
        error: 'Too many downloads are being prepared right now. Please try again shortly.', code: 'ARCHIVES_BUSY',
      });
    }
    // Left while waiting for the slot: 'close' has fired and will not again.
    if (res.destroyed || res.closed) return release();
    res.once('close', release);
    await transferService.streamUploadsArchive(transfer, res);
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
