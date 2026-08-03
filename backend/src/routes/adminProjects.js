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
const { ownedProjectsSubquery, requireProjectOwnership, filterOwnedEventIds } = require('../middleware/ownership');
const { ForbiddenError } = require('../utils/errors');

const router = express.Router();

// A deal that spans both quotes and contracts cascades a project link across
// BOTH tables (projectService.linkDealToProject). So attaching one document
// must also require manage permission on the OTHER domain the cascade will
// touch — otherwise quotes.manage alone could re-point a linked contract, and
// vice versa (GHSA-v4vw / codex review). No-op when the deal touches only the
// one domain, or on older instances without the deal_uuid column.
async function assertCascadePermitted(req, docTable, docId, otherTable, otherPerm) {
  let doc;
  try {
    doc = await db(docTable).where({ id: docId }).first('deal_uuid');
  } catch { return; }
  if (!doc || !doc.deal_uuid) return;
  let linked;
  try {
    linked = await db(otherTable).where({ deal_uuid: doc.deal_uuid }).first('id');
  } catch { return; }
  if (!linked) return;
  if (!(await userHasAnyPermission(req.admin.id, [otherPerm]))) {
    throw new ForbiddenError(`This deal also links a ${otherTable.replace(/s$/, '')}; the ${otherPerm} permission is required`);
  }
}
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
  // Only the caller's projects (GHSA-wrg5). Passed as a SUBQUERY so a large
  // project count can't hit the driver's bind-parameter limit; null means
  // unrestricted.
  const projectIds = ownedProjectsSubquery(req.admin);
  const projects = await projectService.listProjects({
    search: req.query.q || '',
    status: req.query.status || null,
    perms,
    projectIds,
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
router.get('/:id', requirePermission('events.view'), requireProjectOwnership, [param('id').isInt({ min: 1 })], handleAsync(async (req, res) => {
  validateRequest(req);
  const project = await projectService.getProjectById(parseInt(req.params.id, 10));
  if (!project) return res.status(404).json({ error: 'Project not found' });
  return successResponse(res, { project });
}));

// Update
router.put('/:id',
  requirePermission('events.edit'),
  requireProjectOwnership,
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
  requireProjectOwnership,
  [param('id').isInt({ min: 1 }), body('eventId').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const eventId = parseInt(req.body.eventId, 10);
    // Both sides must be the caller's (GHSA-wrg5): requireProjectOwnership
    // covers the project, this covers the INCOMING event. Otherwise an editor
    // could pull a foreign event into a project they own and then read that
    // event's rolled-up documents through /:id/overview.
    const { denied } = await filterOwnedEventIds(req.admin, [eventId]);
    if (denied.length) {
      return res.status(403).json({ error: 'That event is not yours to attach' });
    }
    const result = await projectService.assignEvent(parseInt(req.params.id, 10), eventId);
    return successResponse(res, result, 200, 'Event attached to project');
  }),
);

// Attach a quote to the project (quotes carry no event_id — migration 121).
// Requires quotes.manage in addition to events.edit — attaching a quote
// mutates a separately-permissioned document domain (GHSA-v4vw).
router.post('/:id/quotes',
  requirePermission(['events.edit', 'quotes.manage'], { requireAll: true }),
  requireProjectOwnership,
  [param('id').isInt({ min: 1 }), body('quoteId').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const quoteId = parseInt(req.body.quoteId, 10);
    await assertCascadePermitted(req, 'quotes', quoteId, 'contracts', 'contracts.manage');
    const result = await projectService.assignQuote(parseInt(req.params.id, 10), quoteId, req.admin);
    return successResponse(res, result, 200, 'Quote attached to project');
  }),
);

// Attach a contract to the project. Requires contracts.manage in addition
// to events.edit (GHSA-v4vw).
router.post('/:id/contracts',
  requirePermission(['events.edit', 'contracts.manage'], { requireAll: true }),
  requireProjectOwnership,
  [param('id').isInt({ min: 1 }), body('contractId').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const contractId = parseInt(req.body.contractId, 10);
    await assertCascadePermitted(req, 'contracts', contractId, 'quotes', 'quotes.manage');
    const result = await projectService.assignContract(parseInt(req.params.id, 10), contractId, req.admin);
    return successResponse(res, result, 200, 'Contract attached to project');
  }),
);

// The cockpit aggregation — doc types gated on the admin's own permissions
router.get('/:id/overview', requirePermission('events.view'), requireProjectOwnership, [param('id').isInt({ min: 1 })], handleAsync(async (req, res) => {
  validateRequest(req);
  const perms = {
    bills: await userHasAnyPermission(req.admin.id, ['bills.view']),
    quotes: await userHasAnyPermission(req.admin.id, ['quotes.view']),
    contracts: await userHasAnyPermission(req.admin.id, ['contracts.view']),
  };
  const overview = await projectService.getProjectOverview(parseInt(req.params.id, 10), perms, req.admin);
  return successResponse(res, overview);
}));

/**
 * These routes key on an `email_queue` id alone (GHSA-93x4) — nothing tied the
 * row to a project or event the caller can see, so any admin holding
 * `events.view` / `email.send` could preview, resend, cancel or retry ANY
 * queued mail on the instance by walking ids.
 *
 * Scoped via `email_queue.event_id` → the caller's owned events. `event_id` is
 * NULL for CRM document mail (quote/contract/invoice sends carry no event), and
 * those rows have no ownable parent here, so a scoped caller is denied them
 * rather than guessed into access. 404, not 403, so this isn't an id oracle.
 */
async function requireOwnedQueuedEmail(req, res, next) {
  try {
    if (req.admin?.roleName === 'super_admin') return next();
    const emailId = parseInt(req.params.emailId, 10);
    const row = await db('email_queue').where({ id: emailId }).first('event_id');
    if (!row || !row.event_id) {
      return res.status(404).json({ error: 'Email not found' });
    }
    const { denied } = await filterOwnedEventIds(req.admin, [row.event_id]);
    if (denied.length) {
      return res.status(404).json({ error: 'Email not found' });
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

// Email preview — the ACTUAL sent HTML (or null for pre-rendered_html rows)
router.get('/email/:emailId/preview', requirePermission('events.view'), [param('emailId').isInt({ min: 1 })], requireOwnedQueuedEmail, handleAsync(async (req, res) => {
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
router.post('/email/:emailId/resend',   requirePermission('email.send'), [param('emailId').isInt({ min: 1 })], requireOwnedQueuedEmail, emailAction('resendEmail'));
router.post('/email/:emailId/cancel',    requirePermission('email.send'), [param('emailId').isInt({ min: 1 })], requireOwnedQueuedEmail, emailAction('cancelEmail'));
router.post('/email/:emailId/retry',     requirePermission('email.send'), [param('emailId').isInt({ min: 1 })], requireOwnedQueuedEmail, emailAction('retryEmail'));
router.post('/email/:emailId/send-now',  requirePermission('email.send'), [param('emailId').isInt({ min: 1 })], requireOwnedQueuedEmail, emailAction('sendEmailNow'));

module.exports = router;
