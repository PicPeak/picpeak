/**
 * Admin → project briefs (issue 2678). Mounted at /api/admin/briefs.
 *
 * Behind the `projects` flag, like the project cockpit. Templates are
 * settings (settings.view / settings.edit). A project's brief takes the
 * project's rules (events.view / events.edit and project ownership, as
 * adminProjects.js); a customer's brief the customer's (customers.view /
 * customers.edit). briefService does the work; these routes only gate.
 */

const express = require('express');
const { body, param } = require('express-validator');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { requireFeatureFlag } = require('../middleware/requireFeatureFlag');
const { requireProjectOwnership } = require('../middleware/ownership');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const briefService = require('../services/briefService');

const router = express.Router();
router.use(adminAuth, requireFeatureFlag('projects', 'PROJECTS_DISABLED'));

const idParam = param('id').isInt({ min: 1 });
const briefBody = [
  body('values').optional().isObject(),
  body('sharedArrangements').optional({ values: 'null' }).isString(),
  body('title').optional({ values: 'null' }).isString(),
];

router.get('/templates', requirePermission('settings.view'), handleAsync(async (req, res) => {
  successResponse(res, { templates: await briefService.listTemplates() });
}));

// The fields every brief shows, and an occasion's (an event type's slug, which
// may be any slug, `global` included: the two paths keep them apart).
const saveTemplate = (occasionOf) => handleAsync(async (req, res) => {
  validateRequest(req);
  successResponse(res, { fields: await briefService.saveTemplate(occasionOf(req), req.body.fields) });
});
router.put('/templates/global', requirePermission('settings.edit'), [body('fields').isArray()], saveTemplate(() => null));
router.put('/templates/occasion/:occasion',
  requirePermission('settings.edit'),
  [param('occasion').matches(/^[a-z0-9-]{1,50}$/i), body('fields').isArray()],
  saveTemplate((req) => req.params.occasion));

const project = (req) => ({ kind: 'project', id: Number(req.params.id) });
const customer = (req) => ({ kind: 'customer', id: Number(req.params.id) });

router.get('/projects/:id', requirePermission('events.view'), [idParam], requireProjectOwnership, handleAsync(async (req, res) => {
  validateRequest(req);
  successResponse(res, { brief: await briefService.getBrief(project(req)) });
}));

router.put('/projects/:id', requirePermission('events.edit'), [idParam, ...briefBody], requireProjectOwnership, handleAsync(async (req, res) => {
  validateRequest(req);
  const { values, sharedArrangements, title } = req.body;
  successResponse(res, { brief: await briefService.saveBrief(project(req), { values, sharedArrangements, title }) });
}));

router.post('/projects/:id/notify', requirePermission('events.edit'), [idParam], requireProjectOwnership, handleAsync(async (req, res) => {
  validateRequest(req);
  successResponse(res, await briefService.notify(project(req), req.admin.id));
}));

router.get('/customers/:id', requirePermission('customers.view'), [idParam], handleAsync(async (req, res) => {
  validateRequest(req);
  successResponse(res, { brief: await briefService.getBrief(customer(req)) });
}));

router.put('/customers/:id',
  requirePermission('customers.edit'),
  [idParam, ...briefBody, body('occasion').optional({ values: 'null' }).isString().isLength({ max: 50 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const { values, sharedArrangements, title, occasion } = req.body;
    successResponse(res, { brief: await briefService.saveBrief(customer(req), { values, sharedArrangements, title, occasion }) });
  }));

router.post('/customers/:id/notify', requirePermission('customers.edit'), [idParam], handleAsync(async (req, res) => {
  validateRequest(req);
  successResponse(res, await briefService.notify(customer(req), req.admin.id));
}));

module.exports = router;
