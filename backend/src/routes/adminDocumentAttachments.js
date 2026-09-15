'use strict';

/**
 * Admin → document attachments (#1445). Mounted at /api/admin/document-attachments.
 *
 *   GET  /                 the library, archived entries included
 *   POST /                 upload a PDF (multipart: `file`, `name`, `description`)
 *   GET  /:id/download     the stored file
 *   POST /:id/archive, /:id/restore
 *
 * adminAuth → the `contracts` feature flag → contracts.view to read and
 * download, contracts.templates.manage to upload or archive. The library is
 * install-wide, like the clause library. An upload is held in memory (20 MB
 * cap) and checked by content (utils/pdfValidation) before anything is
 * stored.
 */

const express = require('express');
const multer = require('multer');
const { body, param } = require('express-validator');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { requireFeatureFlag } = require('../middleware/requireFeatureFlag');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const { buildContentDisposition } = require('../utils/filenameSanitizer');
const { validateFileType } = require('../utils/fileSecurityUtils');
const { AppError } = require('../utils/errors');
const attachments = require('../services/contract/attachments');

const router = express.Router();
router.use(adminAuth);
router.use(requireFeatureFlag('contracts', 'CONTRACTS_DISABLED'));

const VIEW = requirePermission('contracts.view');
const MANAGE = requirePermission('contracts.templates.manage');
const idParam = param('id').isInt({ min: 1 }).toInt();

const upload = multer({
  storage: multer.memoryStorage(),
  // A single `file` field; no bracket-indexed field names.
  limits: { fileSize: attachments.MAX_BYTES, files: 1, fieldArrayIndexLimit: 0 },
  fileFilter: (req, file, cb) => {
    if (validateFileType(file.originalname, file.mimetype, ['application/pdf'])) return cb(null, true);
    return cb(new AppError('Only PDF files can be attached', 400, 'PDF_NOT_A_PDF'));
  },
});

router.get('/', VIEW, handleAsync(async (req, res) => (
  successResponse(res, { attachments: await attachments.listAttachments() })
)));

router.post(
  '/',
  MANAGE,
  upload.single('file'),
  [
    body('name').optional().isString().isLength({ max: 255 }),
    body('description').optional().isString().isLength({ max: 2000 }),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    if (!req.file) throw new AppError('Choose a PDF to upload', 400, 'PDF_NOT_A_PDF');
    const result = await attachments.storeAttachment(req.file.buffer, {
      name: req.body.name,
      description: req.body.description,
      originalName: req.file.originalname,
    }, req.admin?.id);
    return successResponse(res, result, result.existing ? 200 : 201);
  })
);

router.get('/:id/download', VIEW, [idParam], handleAsync(async (req, res) => {
  validateRequest(req);
  const file = await attachments.openLibraryAttachment(req.params.id);
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', buildContentDisposition(attachments.downloadName(file.name), 'attachment'));
  return res.send(file.buffer);
}));

router.post('/:id/archive', MANAGE, [idParam], handleAsync(async (req, res) => {
  validateRequest(req);
  return successResponse(res, { attachment: await attachments.archiveAttachment(req.params.id, req.admin?.id) });
}));

router.post('/:id/restore', MANAGE, [idParam], handleAsync(async (req, res) => {
  validateRequest(req);
  return successResponse(res, { attachment: await attachments.restoreAttachment(req.params.id, req.admin?.id) });
}));

module.exports = router;
