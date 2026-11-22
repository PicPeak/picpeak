/**
 * Public v1 API — PicTransfer sends (issue 2586).
 *
 * Lets an integration that already holds an API token hand a client a bundle
 * of files (RAW originals, videos, audio, ZIPs) without admin credentials:
 * create a send, upload its files (one multipart request or the chunked path
 * for large files), then mail the download link once everything is there.
 *
 * Every route applies what the admin transfer routes apply for the token's
 * owner: the `transfers` feature flag, `events.view` / `events.edit`, the
 * ownership guard (a non-super_admin reaches only the transfers they created,
 * foreign and missing ids both 404) and the `uploads.new` capability. The
 * upload plumbing itself is middleware/transferDeliverables, the same code the
 * admin UI's upload runs, so the type policy, the size cap, the upload
 * admission and the storage write cannot drift between the two surfaces.
 *
 * Only sends are created here. A file request (kind 'request') made in the
 * admin UI is readable through GET, but this surface neither uploads into it
 * nor mails it.
 */

const express = require('express');
const { body, query, validationResult } = require('express-validator');
const { apiTokenAuth, requireApiScope } = require('../../middleware/apiTokenAuth');
const { requirePermission } = require('../../middleware/permissions');
const { requireFeatureFlag } = require('../../middleware/requireFeatureFlag');
const { requireCapability } = require('../../middleware/requireCapability');
const { safeValidationErrors, handleAsync } = require('../../utils/routeHelpers');
const transferService = require('../../services/transferService');
const {
  requireTransferOwnership,
  uploadDeliverableFiles,
  initChunkedDeliverable,
  uploadDeliverableChunk,
  completeChunkedDeliverable,
  abortChunkedDeliverable,
} = require('../../middleware/transferDeliverables');
const logger = require('../../utils/logger');

const router = express.Router();

// The token is checked before the flag, so an anonymous caller cannot read
// whether PicTransfer is switched on from a 403.
const authenticated = [apiTokenAuth, requireFeatureFlag('transfers')];
const canRead = [...authenticated, requireApiScope('read'), requirePermission('events.view')];
const canWrite = [...authenticated, requireApiScope('write'), requirePermission('events.edit')];
const ownedRead = [...canRead, requireTransferOwnership];
const ownedWrite = [...canWrite, requireTransferOwnership];

function invalid(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  res.status(400).json({ errors: safeValidationErrors(errors) });
  return true;
}

/** The detail view plus the absolute download link a client is sent. */
async function withShareUrl(transfer) {
  if (!transfer) return transfer;
  const base = await transferService.getFrontendUrl();
  return {
    ...transfer,
    share_url: transfer.download_url ? `${base}${transfer.download_url}` : null,
  };
}

/**
 * @openapi
 * components:
 *   schemas:
 *     Transfer:
 *       type: object
 *       description: "A PicTransfer send: the operator's files behind one token-protected download link."
 *       properties:
 *         id: { type: integer }
 *         kind: { type: string, enum: [send, request], description: "Only sends are created through the API. A file request made in the admin UI is readable but not writable here." }
 *         title: { type: string }
 *         message: { type: string, nullable: true }
 *         status: { type: string, description: "active, expired, exhausted, disabled or deleted" }
 *         expires_at: { type: string, format: date-time }
 *         max_downloads: { type: integer, nullable: true }
 *         download_count: { type: integer }
 *         downloads_remaining: { type: integer, nullable: true }
 *         grace_days: { type: integer }
 *         is_active: { type: boolean }
 *         delivery_method: { type: string, enum: [link, email] }
 *         download_url: { type: string, nullable: true, description: "Path of the download page, relative to the frontend." }
 *         share_url: { type: string, format: uri, nullable: true, description: "Absolute download link to hand to the client. Not on upload responses; read it with GET /transfers/{id}." }
 *         file_count: { type: integer }
 *         extra_files:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               id: { type: integer }
 *               filename: { type: string }
 *               size_bytes: { type: integer, nullable: true }
 *               mime_type: { type: string, nullable: true }
 *         recipients:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               id: { type: integer }
 *               email: { type: string }
 *               last_sent_at: { type: string, format: date-time, nullable: true }
 *               held: { type: boolean, description: "true while the ready mail has not gone out to this address." }
 *         created_at: { type: string, format: date-time }
 */

/**
 * @openapi
 * /transfers:
 *   get:
 *     tags: [Transfers]
 *     summary: List transfers
 *     description: "Transfers the token owner can see in the admin UI: every transfer for a super_admin, otherwise the ones the owner created. Summary rows carry no link or token; read one with GET /transfers/{id}. Requires the PicTransfer feature and events.view."
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: q
 *         schema: { type: string, maxLength: 255 }
 *         description: Title search
 *     responses:
 *       200:
 *         description: Transfers, newest first
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 transfers:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Transfer' }
 *       401: { description: Missing/invalid token }
 *       403: { description: "PicTransfer is off, the token lacks read scope, or its owner lacks events.view" }
 */
router.get('/transfers', ...canRead, [query('q').optional().isString().isLength({ max: 255 })], handleAsync(async (req, res) => {
  if (invalid(req, res)) return;
  const transfers = await transferService.listTransfers({ search: req.query.q || '', admin: req.admin });
  return res.json({ transfers });
}));

/**
 * @openapi
 * /transfers:
 *   post:
 *     tags: [Transfers]
 *     summary: Create a transfer (send)
 *     description: "Creates an empty send to fill with POST /transfers/{id}/files (or the chunked upload) and then hand over with POST /transfers/{id}/deliver. Recipients given here are recorded but not mailed until deliver is called. If deliver is never called, the hold lapses after 24 hours and the mail goes out on the next file added, as in the admin UI. Requires the PicTransfer feature and events.edit."
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title: { type: string, maxLength: 255 }
 *               message: { type: string, maxLength: 5000, nullable: true, description: "Shown on the download page and in the ready mail." }
 *               expires_in_days: { type: integer, minimum: 1, maximum: 3650, description: "Defaults to the transfer_default_expiry_days setting (14)." }
 *               max_downloads: { type: integer, minimum: 0, maximum: 1000000, description: "0 or omitted = the transfer_default_max_downloads setting (unlimited by default)." }
 *               grace_days: { type: integer, minimum: 0, maximum: 365, description: "Days the files are kept after expiry. Defaults to the transfer_default_grace_days setting (7)." }
 *               recipient_emails:
 *                 type: array
 *                 maxItems: 100
 *                 items: { type: string, format: email }
 *               photo_ids:
 *                 type: array
 *                 maxItems: 5000
 *                 items: { type: integer }
 *                 description: "Gallery photos to include as originals. Photos of events the token owner cannot reach are skipped."
 *     responses:
 *       201:
 *         description: Transfer created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 transfer: { $ref: '#/components/schemas/Transfer' }
 *       400: { description: Validation error }
 *       401: { description: Missing/invalid token }
 *       403: { description: "PicTransfer is off, the token lacks write scope, or its owner lacks events.edit" }
 */
router.post(
  '/transfers',
  ...canWrite,
  [
    body('title').optional({ nullable: true }).isString().isLength({ max: 255 }),
    body('message').optional({ nullable: true }).isString().isLength({ max: 5000 }),
    body('expires_in_days').optional({ nullable: true }).isInt({ min: 1, max: 3650 }).toInt(),
    body('max_downloads').optional({ nullable: true }).isInt({ min: 0, max: 1000000 }).toInt(),
    body('grace_days').optional({ nullable: true }).isInt({ min: 0, max: 365 }).toInt(),
    body('recipient_emails').optional().isArray({ max: 100 }),
    body('recipient_emails.*').isEmail().withMessage('Not a valid email address'),
    body('photo_ids').optional().isArray({ max: 5000 }),
    body('photo_ids.*').isInt({ min: 1, max: 2147483647 }),
  ],
  handleAsync(async (req, res) => {
    if (invalid(req, res)) return;
    const b = req.body || {};
    const recipientEmails = (b.recipient_emails || []).map((e) => String(e).trim());
    const transfer = await transferService.createTransfer({
      kind: transferService.KIND_SEND,
      title: b.title,
      message: b.message,
      expiresInDays: b.expires_in_days,
      maxDownloads: b.max_downloads,
      graceDays: b.grace_days,
      photoIds: (b.photo_ids || []).map(Number),
      deliveryMethod: recipientEmails.length ? 'email' : 'link',
    }, req.admin);
    // The files follow in further requests, so the ready mail is held, as
    // the admin page holds it while it is still uploading (pendingFiles).
    if (recipientEmails.length) await transferService.holdTransferRecipients(transfer.id, recipientEmails);
    const fresh = (await transferService.getTransfer(transfer.id)) || transfer;
    return res.status(201).json({ transfer: await withShareUrl(fresh) });
  }),
);

/**
 * @openapi
 * /transfers/{id}:
 *   get:
 *     tags: [Transfers]
 *     summary: Read a transfer's status, files and share link
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200:
 *         description: The transfer
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 transfer: { $ref: '#/components/schemas/Transfer' }
 *       401: { description: Missing/invalid token }
 *       403: { description: "PicTransfer is off, the token lacks read scope, or its owner lacks events.view" }
 *       404: { description: "No such transfer, or one the token owner did not create" }
 */
router.get('/transfers/:id', ...ownedRead, handleAsync(async (req, res) => {
  const transfer = await transferService.getTransfer(Number(req.params.id));
  if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
  return res.json({ transfer: await withShareUrl(transfer) });
}));

/**
 * @openapi
 * /transfers/{id}/files:
 *   post:
 *     tags: [Transfers]
 *     summary: Upload files into a transfer
 *     description: "multipart/form-data with one or more `files` parts (up to 50 per request). Any file type the PicTransfer upload policy allows, including RAW, audio and ZIP. A part whose type is not allowed is skipped and named in rejected_files. For a file larger than a proxy's request limit use the chunked upload instead. Does not send the ready mail while the transfer is held for delivery."
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               files:
 *                 type: array
 *                 items: { type: string, format: binary }
 *     responses:
 *       200:
 *         description: "Files stored. transfer is the updated transfer (null if it could not be re-read)."
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 transfer: { $ref: '#/components/schemas/Transfer' }
 *                 rejected_files: { type: array, items: { type: string } }
 *                 failed_files: { type: array, items: { type: string } }
 *       400: { description: "No files, no allowed file type (TYPE_REJECTED), a file over the size cap (UPLOAD_REJECTED), or the transfer is a file request (NOT_A_SEND)" }
 *       401: { description: Missing/invalid token }
 *       403: { description: "PicTransfer is off, the token lacks write scope, or its owner lacks events.edit" }
 *       404: { description: "No such transfer, or one the token owner did not create" }
 *       413: { description: "The request is larger than the server admits in one upload" }
 *       429: { description: "Too many uploads in progress for this account" }
 *       503: { description: "Uploads are paused on this server" }
 */
router.post('/transfers/:id/files',
  ...ownedWrite,
  requireCapability('uploads.new'),
  handleAsync(uploadDeliverableFiles),
);

/**
 * @openapi
 * /transfers/{id}/chunked-upload/init:
 *   post:
 *     tags: [Transfers]
 *     summary: Start a chunked upload of one large file
 *     description: "Answers uploadId, chunkSize and expectedChunks. Send each chunk with POST .../chunk/{index}, then POST .../complete. The same type and size rules as POST /transfers/{id}/files."
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [filename, fileSize]
 *             properties:
 *               filename: { type: string }
 *               fileSize: { type: integer }
 *               mimeType: { type: string }
 *               totalChunks: { type: integer }
 *     responses:
 *       200: { description: "uploadId, chunkSize, expectedChunks" }
 *       400: { description: "Missing fields, a type that is not allowed (TYPE_REJECTED) or a file request (NOT_A_SEND)" }
 *       404: { description: "No such transfer, or one the token owner did not create" }
 *       413: { description: "The file is larger than the transfer size cap" }
 *       503: { description: "Uploads are paused on this server" }
 */
router.post('/transfers/:id/chunked-upload/init',
  ...ownedWrite,
  requireCapability('uploads.new'),
  handleAsync(initChunkedDeliverable),
);

/**
 * @openapi
 * /transfers/{id}/chunked-upload/{uploadId}/chunk/{chunkIndex}:
 *   post:
 *     tags: [Transfers]
 *     summary: Send one chunk
 *     description: "The raw chunk bytes as application/octet-stream. Chunk indexes start at 0."
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *       - { in: path, name: uploadId, required: true, schema: { type: string } }
 *       - { in: path, name: chunkIndex, required: true, schema: { type: integer } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/octet-stream:
 *           schema: { type: string, format: binary }
 *     responses:
 *       200: { description: Chunk stored }
 *       404: { description: "Unknown upload, or one started on another transfer or by another account" }
 *       415: { description: "Not sent as application/octet-stream" }
 */
// Not capability-guarded: an upload admitted while healthy may finish.
router.post('/transfers/:id/chunked-upload/:uploadId/chunk/:chunkIndex',
  ...ownedWrite,
  handleAsync(uploadDeliverableChunk),
);

/**
 * @openapi
 * /transfers/{id}/chunked-upload/{uploadId}/complete:
 *   post:
 *     tags: [Transfers]
 *     summary: Finish a chunked upload
 *     description: "Merges the chunks and stores the file, checked again against the type and size rules in force now."
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *       - { in: path, name: uploadId, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: File stored
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 transfer: { $ref: '#/components/schemas/Transfer' }
 *       400: { description: "Missing chunks, or a type that is no longer allowed" }
 *       404: { description: "Unknown upload, or no such transfer" }
 *       413: { description: "The merged file is over the size cap" }
 */
router.post('/transfers/:id/chunked-upload/:uploadId/complete',
  ...ownedWrite,
  handleAsync(completeChunkedDeliverable),
);

/**
 * @openapi
 * /transfers/{id}/chunked-upload/{uploadId}:
 *   delete:
 *     tags: [Transfers]
 *     summary: Abort an unfinished chunked upload
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *       - { in: path, name: uploadId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Aborted }
 *       404: { description: "Unknown or expired upload" }
 */
router.delete('/transfers/:id/chunked-upload/:uploadId',
  ...ownedWrite,
  handleAsync(abortChunkedDeliverable),
);

/**
 * @openapi
 * /transfers/{id}/deliver:
 *   post:
 *     tags: [Transfers]
 *     summary: Send the ready mail once the uploads are done
 *     description: "Ends the delivery hold and mails the download link to the recipients that have not been mailed yet: the ones given on create plus any in recipient_emails. Safe to retry: an address that was already mailed is skipped (listed in already_sent) unless resend is true. Without any recipient nothing is mailed and the answer carries the share_url to hand over yourself. While no file is downloadable yet the mail stays held (held = true) and goes out when the first file lands."
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               recipient_emails:
 *                 type: array
 *                 maxItems: 100
 *                 items: { type: string, format: email }
 *                 description: "Defaults to the recipients already on the transfer."
 *               resend: { type: boolean, default: false, description: "Mail addresses that were already mailed again." }
 *     responses:
 *       200:
 *         description: Delivered (or nothing left to send)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sent: { type: integer }
 *                 held: { type: boolean }
 *                 already_sent: { type: array, items: { type: string } }
 *                 share_url: { type: string, format: uri }
 *                 transfer: { $ref: '#/components/schemas/Transfer' }
 *       400: { description: "Validation error, or the transfer is a file request (NOT_A_SEND)" }
 *       401: { description: Missing/invalid token }
 *       403: { description: "PicTransfer is off, the token lacks write scope, or its owner lacks events.edit" }
 *       404: { description: "No such transfer, or one the token owner did not create" }
 *       409: { description: "TRANSFER_NOT_ACTIVE: the link is disabled, expired or out of downloads (reason: TRANSFER_DISABLED, TRANSFER_EXPIRED or DOWNLOAD_LIMIT_REACHED). Nothing is mailed." }
 */
router.post(
  '/transfers/:id/deliver',
  ...ownedWrite,
  [
    body('recipient_emails').optional().isArray({ max: 100 }),
    body('recipient_emails.*').isEmail().withMessage('Not a valid email address'),
    body('resend').optional().isBoolean(),
  ],
  handleAsync(async (req, res) => {
    if (invalid(req, res)) return;
    const id = Number(req.params.id);
    const transfer = await transferService.getTransfer(id);
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    if (transfer.kind === transferService.KIND_REQUEST) {
      return res.status(400).json({ error: 'A file request does not send files out', code: 'NOT_A_SEND' });
    }
    // The public download route's own predicate: a disabled, expired or used
    // up link is not mailed out, it would only lead the client to an error.
    const downloadable = transferService.assertDownloadable(transfer);
    if (!downloadable.ok) {
      return res.status(409).json({
        error: 'The transfer link is not active', code: 'TRANSFER_NOT_ACTIVE', reason: downloadable.code,
      });
    }
    const resend = req.body.resend === true || req.body.resend === 'true';
    const given = (req.body.recipient_emails || []).map((e) => String(e).trim());
    const targets = [...new Set(given.length ? given : (transfer.recipients || []).map((r) => r.email))];
    // An address that already got the mail is not mailed again on a retry;
    // the admin "Send again" semantics are opt-in through `resend`.
    const mailed = new Set((transfer.recipients || []).filter((r) => r.last_sent_at != null).map((r) => r.email));
    const alreadySent = resend ? [] : targets.filter((e) => mailed.has(e));
    const pending = resend ? targets : targets.filter((e) => !mailed.has(e));

    let result = { sent: 0, held: false };
    if (pending.length) {
      // Ends the hold set on create and mails, or records them held while
      // nothing is downloadable yet (issue 2061). Held rows are claimed with a
      // guarded update, so concurrent retries mail each address once.
      result = await transferService.sendTransferEmails(id, pending);
    }
    let fresh = transfer;
    try {
      fresh = (await transferService.getTransfer(id)) || transfer;
    } catch (err) {
      // The mail went out; a failed re-read must not answer 500 and invite a retry.
      logger.warn('v1 transfers: transfer not re-read after deliver', { transferId: id, error: err.message });
    }
    const view = await withShareUrl(fresh);
    return res.json({
      sent: result.sent || 0,
      held: !!result.held,
      already_sent: alreadySent,
      share_url: view.share_url,
      transfer: view,
    });
  }),
);

module.exports = router;
