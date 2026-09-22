'use strict';

/**
 * Admin → contract templates (#1445). Mounted at /api/admin/contract-templates.
 *
 *   GET    /                               every template, with draft and default flags
 *   GET    /placeholders                   the placeholders contract texts may use, with labels and samples
 *   POST   /                               create (an empty draft)
 *   GET    /:id                            template, draft, published version, history
 *   GET    /:id/versions/:version          one version with its clauses
 *   PUT    /:id/draft                      save the draft (needs lockVersion)
 *   POST   /:id/publish-check              the pre-publication check of the draft, with a dry-run render
 *   POST   /:id/publish                    publish the draft (needs lockVersion; refused on any check error)
 *   POST   /:id/versions/:version/draft    a new draft from an earlier version (needs lockVersion)
 *   POST   /:id/duplicate                  copy into a new template
 *   POST   /:id/archive, /:id/restore
 *   POST   /:id/default                    new contracts start from this template
 *   GET    /:id/preview-content             the draft (or ?version=) as the signing page shows it, sample data
 *   POST   /:id/preview                    a sample PDF of the draft or a version (sample data, or a
 *                                           real customer with previewCustomerId + customers.view)
 *
 * adminAuth → the `contracts` feature flag → contracts.view to read and
 * preview, contracts.templates.manage for everything that changes a
 * template. Templates are install-wide, like the clause library, so there
 * is no per-admin ownership to check.
 */

const express = require('express');
const { body, param, query } = require('express-validator');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { requireFeatureFlag } = require('../middleware/requireFeatureFlag');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const { AppError } = require('../utils/errors');
const { userHasAnyPermission } = require('../middleware/permissions');
const { CONTRACT_PLACEHOLDER_REGISTRY } = require('../utils/placeholders');
const { buildContentDisposition } = require('../utils/filenameSanitizer');
const templates = require('../services/contract/templates');

const router = express.Router();
router.use(adminAuth);
router.use(requireFeatureFlag('contracts', 'CONTRACTS_DISABLED'));

const VIEW = requirePermission('contracts.view');
const MANAGE = requirePermission('contracts.templates.manage');
const idParam = param('id').isInt({ min: 1 }).toInt();
const versionParam = param('version').isInt({ min: 1 }).toInt();
const lockBody = body('lockVersion').isInt({ min: 1 }).toInt();
const metaBody = [
  body('description').optional({ nullable: true }).isString().isLength({ max: 2000 }),
  body('useCase').optional({ nullable: true }).isString().isLength({ max: 64 }),
];

router.get('/', VIEW, handleAsync(async (req, res) => (
  successResponse(res, { templates: await templates.listTemplates() })
)));

// Before `/:id`, which would read "placeholders" as an id.
router.get('/placeholders', VIEW, handleAsync(async (req, res) => (
  successResponse(res, { placeholders: CONTRACT_PLACEHOLDER_REGISTRY })
)));

router.post(
  '/',
  MANAGE,
  [body('name').isString().trim().isLength({ min: 1, max: 128 }), ...metaBody],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const id = await templates.createTemplate(req.body, req.admin?.id);
    return successResponse(res, await templates.getTemplate(id), 201);
  })
);

router.get('/:id', VIEW, [idParam], handleAsync(async (req, res) => {
  validateRequest(req);
  return successResponse(res, await templates.getTemplate(req.params.id));
}));

router.get('/:id/versions/:version', VIEW, [idParam, versionParam], handleAsync(async (req, res) => {
  validateRequest(req);
  return successResponse(res, { version: await templates.getVersion(req.params.id, req.params.version) });
}));

router.put(
  '/:id/draft',
  MANAGE,
  [
    idParam,
    lockBody,
    body('name').optional().isString().trim().isLength({ min: 1, max: 128 }),
    ...metaBody,
    body('title').optional({ nullable: true }).isString().isLength({ max: 255 }),
    body('introText').optional({ nullable: true }).isObject(),
    body('outroText').optional({ nullable: true }).isObject(),
    body('items').optional().isArray({ max: 200 }),
    body('items.*.kind').optional().isIn(['block', 'text']),
    body('items.*.blockId').optional({ nullable: true }).isInt({ min: 1 }),
    body('items.*.section').optional({ nullable: true }).isString().isLength({ max: 32 }),
    body('items.*.heading').optional({ nullable: true }).isString().isLength({ max: 255 }),
    body('items.*.body').optional({ nullable: true }).isObject(),
    body('attachments').optional().isArray({ max: 20 }),
    body('attachments.*.attachmentId').optional().isInt({ min: 1 }),
    body('attachments.*.delivery').optional().isIn(['merged', 'separate']),
    body('sourceVersionNumber').optional().isInt({ min: 1 }).toInt(),
    // The declarations a signer confirms (#1446); the service validates keys and wording.
    body('consents').optional().isArray({ max: 8 }),
    body('consents.*.key').optional().isString().isLength({ max: 40 }),
    body('consents.*.required').optional().isBoolean(),
    body('consents.*.text').optional().isObject(),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    return successResponse(res, await templates.saveDraft(req.params.id, req.body, req.admin?.id));
  })
);

router.post('/:id/publish-check', MANAGE, [idParam], handleAsync(async (req, res) => {
  validateRequest(req);
  return successResponse(res, await templates.checkTemplate(req.params.id));
}));

router.post('/:id/publish', MANAGE, [idParam, lockBody], handleAsync(async (req, res) => {
  validateRequest(req);
  const published = await templates.publishTemplate(req.params.id, req.body, req.admin?.id);
  return successResponse(res, { ...published, ...(await templates.getTemplate(req.params.id)) });
}));

router.post('/:id/versions/:version/draft', MANAGE, [idParam, versionParam, lockBody], handleAsync(async (req, res) => {
  validateRequest(req);
  return successResponse(res, await templates.draftFromVersion(req.params.id, req.params.version, req.body, req.admin?.id));
}));

router.post(
  '/:id/duplicate',
  MANAGE,
  [idParam, body('name').optional().isString().trim().isLength({ min: 1, max: 128 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const id = await templates.duplicateTemplate(req.params.id, req.body, req.admin?.id);
    return successResponse(res, await templates.getTemplate(id), 201);
  })
);

router.post('/:id/archive', MANAGE, [idParam], handleAsync(async (req, res) => {
  validateRequest(req);
  return successResponse(res, await templates.archiveTemplate(req.params.id, req.admin?.id));
}));

router.post('/:id/restore', MANAGE, [idParam], handleAsync(async (req, res) => {
  validateRequest(req);
  return successResponse(res, await templates.restoreTemplate(req.params.id, req.admin?.id));
}));

router.post('/:id/default', MANAGE, [idParam], handleAsync(async (req, res) => {
  validateRequest(req);
  return successResponse(res, await templates.setDefaultTemplate(req.params.id, req.admin?.id));
}));

router.get(
  '/:id/preview-content',
  VIEW,
  [idParam, query('version').optional().isInt({ min: 1 }).toInt()],
  handleAsync(async (req, res) => {
    validateRequest(req);
    return successResponse(res, await templates.previewContent(req.params.id, { version: req.query.version || null }));
  })
);

router.post(
  '/:id/preview',
  VIEW,
  [
    idParam,
    body('version').optional({ nullable: true }).isInt({ min: 1 }).toInt(),
    body('previewCustomerId').optional({ nullable: true }).isInt({ min: 1 }).toInt(),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const customerId = req.body.previewCustomerId || null;
    // A real customer's data leaves the server only as the PDF asked for,
    // and only to an admin who may see that customer anyway.
    if (customerId && !(await userHasAnyPermission(req.admin?.id, ['customers.view']))) {
      throw new AppError('You need permission to view customers for a preview with customer data', 403, 'FORBIDDEN');
    }
    const buffer = await templates.renderTemplatePreview(req.params.id, { version: req.body.version || null, customerId });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', buildContentDisposition(`contract-template-${req.params.id}-preview.pdf`, 'inline'));
    return res.send(buffer);
  })
);

module.exports = router;
