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
const { body, param, query } = require('express-validator');
const { adminAuth } = require('../middleware/auth');
const { requirePermission, userHasAnyPermission } = require('../middleware/permissions');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const projectService = require('../services/projectService');
const customerGroupsService = require('../services/customerGroupsService');
const { db } = require('../database/db');
const { ownedProjectsSubquery, requireProjectOwnership, filterOwnedEventIds } = require('../middleware/ownership');
const { requireOwnedQueuedEmail: requireOwnedQueuedEmailParam } = require('../middleware/emailQueueOwnership');
const { ForbiddenError } = require('../utils/errors');
const { hasColumnCached } = require('../utils/schemaCache');
const { withTrustedCrmAccess } = require('../database/crmAccess');

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

// A project's customer is customers.view data: the roster (ids, emails) is
// guarded by that permission everywhere else (adminCustomers /search). Linking
// a customer therefore needs it too — otherwise the FK write is an existence
// oracle and the reloaded project returns the address — and project payloads
// drop the customer fields for a caller without it.
async function mayViewCustomers(req) {
  return userHasAnyPermission(req.admin.id, ['customers.view']);
}

async function assertMayLinkCustomer(req) {
  if (req.body.customerAccountId && !(await mayViewCustomers(req))) {
    throw new ForbiddenError('The customers.view permission is required to link a customer to a project');
  }
}

function withoutCustomer(project) {
  if (!project) return project;
  const copy = { ...project };
  delete copy.customerAccountId;
  delete copy.customerEmail;
  delete copy.customerBillingCadence;
  return copy;
}

async function projectForCaller(req, project) {
  return (await mayViewCustomers(req)) ? project : withoutCustomer(project);
}

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

// Where an inquiry came from. Keys only; the UI translates them.
const INQUIRY_SOURCES = ['referral', 'website', 'social', 'returning', 'fair', 'other'];

// The inquiry fields (migration 315). null clears a field and skips the check;
// any other value, false and '' included, has to pass it. Arrays are refused:
// express-validator would check each item, and the joined value is stored.
const optionalField = (name) => body(name).optional({ values: 'null' }).not().isArray();
const inquiryValidators = [
  optionalField('eventType').isString().trim().isLength({ max: 50 }),
  optionalField('eventDate').isISO8601({ strict: true }),
  optionalField('eventEndDate').isISO8601({ strict: true }).custom((end, { req }) => {
    if (req.body.eventDate && String(end) < String(req.body.eventDate)) {
      throw new Error('The end date is before the start date');
    }
    return true;
  }),
  optionalField('location').isString().trim().isLength({ max: 255 }),
  optionalField('guestCount').isInt({ min: 0, max: 100000 }),
  optionalField('budgetMinor').isInt({ min: 0, max: 100000000000 }),
  optionalField('currency').isString().trim().isLength({ min: 3, max: 3 }).isAlpha(),
  optionalField('source').isIn(INQUIRY_SOURCES),
  optionalField('notes').isString().isLength({ max: 10000 }),
  optionalField('flow').isIn(Object.keys(projectService.PROJECT_FLOWS)),
  body('skippedStages').optional({ values: 'null' }).isArray({ max: projectService.SKIPPABLE_STAGES.length }),
  body('skippedStages.*').isIn(projectService.SKIPPABLE_STAGES),
  // `reopen` (PUT only): the server picks inquiry or active, because it sees
  // documents the caller's overview may not show.
  body('status').optional().not().isArray().isIn([...projectService.PROJECT_STATUSES, 'reopen']),
];

const INQUIRY_KEYS = ['flow', 'skippedStages', 'eventType', 'eventDate', 'eventEndDate', 'location', 'guestCount',
  'budgetMinor', 'currency', 'source', 'notes'];
const inquiryFields = (reqBody) => Object.fromEntries(
  INQUIRY_KEYS.filter((k) => reqBody[k] !== undefined).map((k) => [k, reqBody[k]]),
);

// List
router.get('/', requirePermission('events.view'), [
  // A comma list (`inquiry,active`) for the dashboard, or one status.
  query('status').optional().isString().isLength({ max: 200 }),
  query('withStages').optional().isIn(['0', '1', 'true', 'false']),
], handleAsync(async (req, res) => {
  validateRequest(req);
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
  const asked = String(req.query.status || '').split(',').map((x) => x.trim()).filter(Boolean);
  const statuses = asked.filter((x) => projectService.PROJECT_STATUSES.includes(x));
  // A filter asked for with no status that exists matches no project, as an
  // unknown value did before; it is not "no filter".
  if (asked.length && !statuses.length) return successResponse(res, { projects: [] });
  const withStages = req.query.withStages === '1' || req.query.withStages === 'true';
  if (withStages) perms.contracts = await userHasAnyPermission(req.admin.id, ['contracts.view']);
  const projects = await projectService.listProjects({
    search: req.query.q || '',
    status: statuses.length > 1 ? statuses : (statuses[0] || null),
    perms,
    projectIds,
    withStages,
  });
  const visible = (await mayViewCustomers(req)) ? projects : projects.map(withoutCustomer);
  return successResponse(res, { projects: visible });
}));

// Create
router.post('/',
  requirePermission('events.edit'),
  [
    body('name').isString().trim().isLength({ min: 1, max: 255 }),
    body('customerAccountId').optional({ values: 'falsy' }).isInt({ min: 1 }),
    ...inquiryValidators,
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    await assertMayLinkCustomer(req);
    const project = await projectService.createProject(
      {
        name: req.body.name,
        customerAccountId: req.body.customerAccountId || null,
        status: req.body.status || 'active',
        ...inquiryFields(req.body),
      },
      req.admin.id,
    );
    return successResponse(res, { project: await projectForCaller(req, project) }, 201, 'Project created');
  }),
);

// Detail
router.get('/:id', requirePermission('events.view'), requireProjectOwnership, [param('id').isInt({ min: 1 })], handleAsync(async (req, res) => {
  validateRequest(req);
  const project = await projectService.getProjectById(parseInt(req.params.id, 10));
  if (!project) return res.status(404).json({ error: 'Project not found' });
  return successResponse(res, { project: await projectForCaller(req, project) });
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
    ...inquiryValidators,
  ],
  handleAsync(async (req, res) => {
    validateRequest(req);
    await assertMayLinkCustomer(req);
    const project = await projectService.updateProject(parseInt(req.params.id, 10), {
      name: req.body.name,
      customerAccountId: req.body.customerAccountId,
      status: req.body.status,
      ...inquiryFields(req.body),
    });
    return successResponse(res, { project: await projectForCaller(req, project) }, 200, 'Project updated');
  }),
);

// Delete. The project's galleries, quotes, contracts, invoices and hours stay;
// they only lose the link (projectService.deleteProject). Clearing a link is a
// write on that record, so it needs what attaching or editing one needs: the
// manage permission of each domain the project holds (as POST /:id/quotes and
// /:id/contracts; hours and customer documents as their own routes), every
// linked document being the caller's, and ownership of every linked gallery
// (as POST /:id/events), which a super admin may have put into this project.
router.delete('/:id',
  requirePermission('events.edit'),
  requireProjectOwnership,
  [param('id').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const id = parseInt(req.params.id, 10);
    // Counted twice: unscoped, to see every linked record, and as the caller,
    // through the CRM access layer (auth.js withCrmActor), to see which of
    // them are theirs. A plain read here only ever sees the caller's own
    // documents, so it would let a delete through that unlinks someone else's.
    const count = async (query) => Number((await query.count('* as c').first())?.c || 0);
    const needs = [];
    let foreign = false;
    // What was checked, so the delete can refuse when something was linked
    // after this census (projectService.deleteProject recounts in its transaction).
    const checked = { ids: {}, eventIds: [] };
    for (const [table, perm] of [
      ['quotes', 'quotes.manage'], ['contracts', 'contracts.manage'], ['invoices', 'bills.manage'],
      ['customer_hour_entries', 'customers.edit'], ['customer_documents', 'customers.documents.manage'],
    ]) {
      if (!(await hasColumnCached(table, 'project_id'))) continue;
      const linkedIds = await withTrustedCrmAccess('project delete: linked-record census',
        () => db(table).where({ project_id: id }).pluck('id'));
      checked.ids[table] = linkedIds;
      const linked = linkedIds.length;
      if (!linked) continue;
      if (!(await userHasAnyPermission(req.admin.id, [perm]))) { needs.push(perm); continue; }
      if (await count(db(table).where({ project_id: id })) < linked) foreign = true;
    }
    if (needs.length) {
      return res.status(403).json({ error: `This project holds records you cannot change; ${needs.join(', ')} is required to delete it`, code: 'PROJECT_DELETE_NEEDS_PERMISSION', permissions: needs });
    }
    if (foreign) {
      return res.status(403).json({ error: 'This project holds documents that are not yours; they have to be moved out before it can be deleted', code: 'PROJECT_DELETE_FOREIGN_DOCUMENTS' });
    }
    const eventIds = (await db('events').where({ project_id: id }).select('id')).map((e) => e.id);
    const { denied } = await filterOwnedEventIds(req.admin, eventIds);
    if (denied.length) {
      return res.status(403).json({ error: 'This project holds galleries that are not yours; they have to be moved out before it can be deleted', code: 'PROJECT_DELETE_FOREIGN_GALLERIES' });
    }
    checked.eventIds = eventIds;
    const result = await projectService.deleteProject(id, req.admin, { checked });
    return successResponse(res, result, 200, 'Project deleted');
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

// Attach an existing invoice to the project (a finished job set up after the
// fact). bills.manage in addition to events.edit, as for quotes and contracts
// (GHSA-v4vw). The invoice is read through the CRM access layer, so another
// admin's answers 404; its gallery, which comes along, must be the caller's.
router.post('/:id/invoices',
  requirePermission(['events.edit', 'bills.manage'], { requireAll: true }),
  requireProjectOwnership,
  [param('id').isInt({ min: 1 }), body('invoiceId').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const invoiceId = parseInt(req.body.invoiceId, 10);
    const inv = await db('invoices').where({ id: invoiceId }).first('event_id');
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    if (inv.event_id) {
      const { denied } = await filterOwnedEventIds(req.admin, [inv.event_id]);
      if (denied.length) return res.status(403).json({ error: 'That invoice’s gallery is not yours to attach' });
    }
    await assertCascadePermitted(req, 'invoices', invoiceId, 'quotes', 'quotes.manage');
    await assertCascadePermitted(req, 'invoices', invoiceId, 'contracts', 'contracts.manage');
    const result = await projectService.assignInvoice(parseInt(req.params.id, 10), invoiceId, req.admin);
    return successResponse(res, result, 200, 'Invoice attached to project');
  }),
);

// Take an invoice back out of the project (it was created in or attached to
// it). The same guards as attaching it.
router.delete('/:id/invoices/:invoiceId',
  requirePermission(['events.edit', 'bills.manage'], { requireAll: true }),
  requireProjectOwnership,
  [param('id').isInt({ min: 1 }), param('invoiceId').isInt({ min: 1 })],
  handleAsync(async (req, res) => {
    validateRequest(req);
    const result = await projectService.unassignInvoice(parseInt(req.params.id, 10), parseInt(req.params.invoiceId, 10), req.admin);
    return successResponse(res, result, 200, 'Invoice taken out of the project');
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
  // The customer's groups (#1443), only for an admin who may read customers:
  // this route is guarded by events.view. Without that permission the
  // project's customer fields leave the payload altogether.
  if (overview?.project) {
    if (await mayViewCustomers(req)) {
      if (overview.project.customerAccountId) {
        overview.project.customerGroups = await customerGroupsService.groupsForCustomer(overview.project.customerAccountId);
      }
    } else {
      overview.project = withoutCustomer(overview.project);
    }
  }
  return successResponse(res, overview);
}));

// These routes key on an `email_queue` id alone; the shared guard ties the
// row to its sender or its gallery (middleware/emailQueueOwnership).
const requireOwnedQueuedEmail = requireOwnedQueuedEmailParam('emailId');

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
