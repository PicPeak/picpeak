'use strict';

/**
 * Admin → PDF themes (#1445). Mounted at /api/admin/pdf-themes.
 *
 *   GET  /                 every scope's settings and resolved theme, plus the
 *                          bundled font families
 *   PUT  /:scope           replace a scope's settings (default | quote | invoice | contract)
 *   POST /:scope/preview   a sample PDF rendered with the given, unsaved settings
 *
 * Permissions match the business profile's PDF settings this extends:
 * settings.view or settings.banking to read, settings.banking to change or
 * preview. The theme is install-wide, like the business profile, so there is
 * nothing to scope by owner.
 */

const express = require('express');
const { body, param } = require('express-validator');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const { buildContentDisposition } = require('../utils/filenameSanitizer');
const pdfThemeService = require('../services/pdfThemeService');
const { SCOPES } = require('../services/pdf/theme');

const router = express.Router();
router.use(adminAuth);

router.get(
  '/',
  requirePermission(['settings.view', 'settings.banking']),
  handleAsync(async (req, res) => successResponse(res, await pdfThemeService.listThemes()))
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
