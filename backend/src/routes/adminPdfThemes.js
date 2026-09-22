'use strict';

/**
 * Admin → PDF themes (#1445). Mounted at /api/admin/pdf-themes.
 *
 *   GET  /                 every scope's settings and resolved theme, plus the
 *                          bundled font families
 *   PUT  /:scope           replace a scope's settings (default | quote | invoice | contract)
 *   POST /:scope/preview   a sample PDF rendered with the given, unsaved settings
 *   GET  /fonts            uploaded fonts, archived ones included
 *   POST /fonts            upload a font (multipart: regular, bold?, italic?,
 *                          name, licenceNote, licenceAcknowledged=true)
 *   POST /fonts/:id/archive
 *
 * Permissions match the business profile's PDF settings this extends:
 * settings.view or settings.banking to read, settings.banking to change or
 * preview. The theme is install-wide, like the business profile, so there is
 * nothing to scope by owner.
 */

const express = require('express');
const multer = require('multer');
const { body, param } = require('express-validator');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const { buildContentDisposition } = require('../utils/filenameSanitizer');
const pdfThemeService = require('../services/pdfThemeService');
const { SCOPES } = require('../services/pdf/theme');
const uploadedFonts = require('../services/pdf/uploadedFonts');
const { MAX_BYTES: FONT_MAX_BYTES } = require('../utils/fontValidation');

// Fonts (#1445) are held in memory, at most 5 MB a face, three faces, and
// checked by content before anything is stored — the file name and the
// declared type decide nothing.
const fontUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: FONT_MAX_BYTES, files: 3, fieldArrayIndexLimit: 0 },
}).fields([{ name: 'regular', maxCount: 1 }, { name: 'bold', maxCount: 1 }, { name: 'italic', maxCount: 1 }]);

const router = express.Router();
router.use(adminAuth);

router.get(
  '/',
  requirePermission(['settings.view', 'settings.banking']),
  handleAsync(async (req, res) => successResponse(res, await pdfThemeService.listThemes()))
);

router.get(
  '/fonts',
  requirePermission(['settings.view', 'settings.banking']),
  handleAsync(async (req, res) => successResponse(res, {
    fonts: await uploadedFonts.listFonts(),
    // Why the font set before uploaded fonts existed could not be moved, if it couldn't.
    legacyMoveFailure: await uploadedFonts.legacyMoveFailure(),
  }))
);

router.post(
  '/fonts',
  requirePermission('settings.banking'),
  (req, res, next) => fontUpload(req, res, (err) => {
    if (!err) return next();
    const tooLarge = err.code === 'LIMIT_FILE_SIZE';
    return res.status(400).json({
      error: tooLarge ? 'A font file may be at most 5 MB' : 'The upload could not be read',
      code: tooLarge ? 'FONT_TOO_LARGE' : 'FONT_INVALID',
    });
  }),
  [
    body('name').isString().trim().isLength({ min: 1, max: 64 }),
    body('licenceNote').isString().trim().isLength({ min: 1, max: 500 }),
    body('licenceAcknowledged').isIn(['true', true]),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const file = (key) => (req.files && req.files[key] && req.files[key][0] ? req.files[key][0].buffer : null);
    const font = await uploadedFonts.storeFont({
      name: req.body.name,
      licenceNote: req.body.licenceNote,
      licenceAcknowledged: String(req.body.licenceAcknowledged) === 'true',
      files: { regular: file('regular'), bold: file('bold'), italic: file('italic') },
    }, req.admin && req.admin.id);
    return successResponse(res, { font }, 201);
  })
);

router.post(
  '/fonts/:id/archive',
  requirePermission('settings.banking'),
  [param('id').isInt({ min: 1 }).toInt()],
  handleAsync(async (req, res) => {
    validateRequest(req);
    return successResponse(res, { font: await uploadedFonts.archiveFont(req.params.id, req.admin && req.admin.id) });
  })
);

router.put(
  '/:scope',
  requirePermission('settings.banking'),
  [param('scope').isIn(SCOPES), body('settings').isObject()],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const result = await pdfThemeService.saveTheme(req.params.scope, req.body.settings, req.admin && req.admin.id);
    return successResponse(res, result);
  })
);

router.post(
  '/:scope/preview',
  requirePermission('settings.banking'),
  [param('scope').isIn(SCOPES), body('settings').optional().isObject()],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const buffer = await pdfThemeService.renderPreview(req.params.scope, req.body.settings);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', buildContentDisposition(`pdf-theme-preview-${req.params.scope}.pdf`, 'inline'));
    return res.send(buffer);
  })
);

module.exports = router;
