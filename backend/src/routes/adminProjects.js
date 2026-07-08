/**
 * Admin → Projects routes (the admin-only Project Overview cockpit, Model A).
 *
 * Mounted at /api/admin/projects. Projects group events; the overview rolls
 * up the per-event/per-customer documents. Read = `events.view`, write =
 * `events.manage` (projects are fundamentally an events-grouping concept).
 * The overview additionally gates each money-doc type on the admin's own
 * bills/quotes/contracts view permission.
 */

const express = require('express');
const { body, param } = require('express-validator');
const { adminAuth } = require('../middleware/auth');
const { requirePermission, userHasAnyPermission } = require('../middleware/permissions');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const projectService = require('../services/projectService');
const { db } = require('../database/db');

const router = express.Router();
router.use(adminAuth);

// Projects is feature-flagged like bills/quotes — when off, the whole cockpit
// (and the "book to project" hours control) is hidden, and the API 403s.
async function requireProjectsFlag(req, res, next) {
  try {
    const row = await db('feature_flags').where({ key: 'projects' }).first();
    const enabled = row && (row.value === true || row.value === 1 || row.value === '1');
    if (!enabled) return res.status(403).json({ error: 'Projects feature is disabled', code: 'PROJECTS_DISABLED' });
    next();
  } catch (err) { next(err); }
}
router.use(requireProjectsFlag);

// List
router.get('/', requirePermission('events.view'), handleAsync(async (req, res) => {
  // Value rollup mirrors the cockpit's per-doc gating so the list never
  // shows figures the admin lacks permission to see. Only invoices + quotes
  // carry monetary totals; contracts contribute none, so (unlike the detail
  // route, which gates the contracts *section*) the list needs no contracts
  // permission.
  const perms = {
    bills: await userHasAnyPermission(req.admin.id, ['bills.view']),
    quotes: await userHasAnyPermission(req.admin.id, ['quotes.view']),
  };
  const projects = await projectService.listProjects({
    search: req.query.q || '',
    status: req.query.status || null,
    perms,
  });
  return successResponse(res, { projects });
}));

// Create
router.post('/',
  requirePermission('events.edit'),
  [body('name').isString().trim().isLength({ min: 1, max: 255 }), body('customerAccountId').optional({ values: 'falsy' }).isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const project = await projectService.createProject(
      { name: req.body.name, customerAccountId: req.body.customerAccountId || null },
      req.admin.id,
    );
    return successResponse(res, { project }, 201, 'Project created');
  }),
);

// Detail
router.get('/:id', requirePermission('events.view'), [param('id').isInt({ min: 1 })], handleAsync(async (req, res) => {
  validateRequest(req);
  const project = await projectService.getProjectById(parseInt(req.params.id, 10));
  if (!project) return res.status(404).json({ error: 'Project not found' });
  return successResponse(res, { project });
}));

// Update
router.put('/:id',
  requirePermission('events.edit'),
  [
    param('id').isInt({ min: 1 }),
    body('name').optional().isString().trim().isLength({ min: 1, max: 255 }),
    // nullable:true → accept JSON `null` (clear the customer); isInt otherwise.
    body('customerAccountId').optional({ nullable: true }).isInt({ min: 1 }),
    body('status').optional().isString().isLength({ max: 24 }),
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const project = await projectService.updateProject(parseInt(req.params.id, 10), {
      name: req.body.name,
      customerAccountId: req.body.customerAccountId,
      status: req.body.status,
    });
    return successResponse(res, { project }, 200, 'Project updated');
  }),
);

// Attach an event to the project
router.post('/:id/events',
  requirePermission('events.edit'),
  [param('id').isInt({ min: 1 }), body('eventId').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const result = await projectService.assignEvent(parseInt(req.params.id, 10), parseInt(req.body.eventId, 10));
    return successResponse(res, result, 200, 'Event attached to project');
  }),
);

// Attach a quote to the project (quotes carry no event_id — migration 121).
router.post('/:id/quotes',
  requirePermission('events.edit'),
  [param('id').isInt({ min: 1 }), body('quoteId').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const result = await projectService.assignQuote(parseInt(req.params.id, 10), parseInt(req.body.quoteId, 10));
    return successResponse(res, result, 200, 'Quote attached to project');
  }),
);

// Attach a contract to the project.
router.post('/:id/contracts',
  requirePermission('events.edit'),
  [param('id').isInt({ min: 1 }), body('contractId').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const result = await projectService.assignContract(parseInt(req.params.id, 10), parseInt(req.body.contractId, 10));
    return successResponse(res, result, 200, 'Contract attached to project');
  }),
);

// The cockpit aggregation — doc types gated on the admin's own permissions
router.get('/:id/overview', requirePermission('events.view'), [param('id').isInt({ min: 1 })], handleAsync(async (req, res) => {
  validateRequest(req);
  const perms = {
    bills: await userHasAnyPermission(req.admin.id, ['bills.view']),
    quotes: await userHasAnyPermission(req.admin.id, ['quotes.view']),
    contracts: await userHasAnyPermission(req.admin.id, ['contracts.view']),
  };
  const overview = await projectService.getProjectOverview(parseInt(req.params.id, 10), perms);
  return successResponse(res, overview);
}));

// Email preview — the ACTUAL sent HTML (or null for pre-rendered_html rows)
router.get('/email/:emailId/preview', requirePermission('events.view'), [param('emailId').isInt({ min: 1 })], handleAsync(async (req, res) => {
  validateRequest(req);
  const preview = await projectService.getEmailPreview(parseInt(req.params.emailId, 10));
  return successResponse(res, preview);
}));

// Email actions from the feed (need email.send). Resend (sent→fresh copy),
// Cancel (pending→cancelled), Retry (failed→pending), Send now (flush this one).
const emailAction = (fn) => handleAsync(async (req, res) => {
  validateRequest(req);
  const result = await projectService[fn](parseInt(req.params.emailId, 10), req.admin.id);
  return successResponse(res, result);
});
router.post('/email/:emailId/resend',   requirePermission('email.send'), [param('emailId').isInt({ min: 1 })], emailAction('resendEmail'));
router.post('/email/:emailId/cancel',    requirePermission('email.send'), [param('emailId').isInt({ min: 1 })], emailAction('cancelEmail'));
router.post('/email/:emailId/retry',     requirePermission('email.send'), [param('emailId').isInt({ min: 1 })], emailAction('retryEmail'));
router.post('/email/:emailId/send-now',  requirePermission('email.send'), [param('emailId').isInt({ min: 1 })], emailAction('sendEmailNow'));

module.exports = router;
