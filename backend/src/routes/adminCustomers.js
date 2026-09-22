/**
 * Admin → Customers Routes
 *
 * Endpoint mounted at /api/admin/customers (see app.js wiring).
 * Mirrors adminUsers.js for the invitation lifecycle but operates on
 * customer_accounts. Customer-side login routes live in customerAuth.js.
 */

const express = require('express');
const { capabilityEvidence } = require('../usage/capabilityEvidence');
const { body, param, query } = require('express-validator');
const { adminAuth } = require('../middleware/auth');
const { requirePermission, userHasAnyPermission } = require('../middleware/permissions');
const { requireFeatureFlag, isFeatureEnabled } = require('../middleware/requireFeatureFlag');
const { filterOwnedEventIds } = require('../middleware/ownership');
const { db, logActivity } = require('../database/db');

// Hour-entry routes are gated by the hoursLogging master so a direct API hit
// can't read/edit/delete/bill logged hours while the feature is off (the
// frontend already hides the surface). Per-customer enforcement stays in
// customerHoursService.createEntry.
const requireHoursLogging = requireFeatureFlag('hoursLogging', 'HOURS_LOGGING_DISABLED');
// Combined hours+re-bills billing (#866) is introduced by the re-bill feature;
// gate it behind incoming-invoices (no re-bills to combine when it's off).
const requireIncoming = requireFeatureFlag('incomingInvoices', 'INCOMING_INVOICES_DISABLED');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const customerAccountsService = require('../services/customerAccountsService');
const accountingHistory = require('../services/accountingHistory');
const customerHoursService = require('../services/customerHoursService');
const combinedBillingService = require('../services/combinedBillingService');
const invoiceService = require('../services/invoiceService');
const { IDENTITY_PRESERVING_NORMALIZE_EMAIL } = require('../utils/emailNormalization');
const { NotFoundError, AppError } = require('../utils/errors');
const customerDocumentsService = require('../services/customerDocumentsService');
const customerGroupsService = require('../services/customerGroupsService');
const { receivePdfUpload, discardTempFile, sendPdfAttachment } = require('../middleware/customerDocumentUpload');

const router = express.Router();

/**
 * Snake_case (DB) → camelCase (API). Kept narrow on purpose: only fields
 * the frontend actually needs land in the response so the surface area
 * doesn't accidentally grow when new columns get added later.
 */
function transformCustomer(c) {
  return {
    id: c.id,
    email: c.email,
    salutation: c.salutation,
    firstName: c.first_name,
    lastName: c.last_name,
    displayName: c.display_name,
    phone: c.phone,
    companyName: c.company_name,
    billingEmail: c.billing_email,
    vatId: c.vat_id,
    addressLine1: c.address_line1,
    addressLine2: c.address_line2,
    postalCode: c.postal_code,
    city: c.city,
    state: c.state,
    countryCode: c.country_code,
    countryName: c.country_name,
    preferredLanguage: c.preferred_language,
    // CRM billing cadence override (migration 102). Drives whether the
    // invoice scheduler honours the quote's installment plan or snaps
    // every bill to the customer's monthly/quarterly cycle day.
    billingCadence: c.billing_cadence || 'per_event',
    billingCycleDay: c.billing_cycle_day == null ? 1 : Number(c.billing_cycle_day),
    notes: c.notes,
    isActive: c.is_active,
    // Newsletter consent (migration 199, #1264). Opt-OUT: false means the
    // customer still receives campaigns. Transactional mail is unaffected.
    marketingOptOut: c.marketing_opt_out === true || c.marketing_opt_out === 1
      || c.marketing_opt_out === '1',
    marketingOptOutAt: c.marketing_opt_out_at || null,
    // Passive customers (admin-only, no portal access) are identified
    // by a null password_hash. We never expose the hash itself —
    // this boolean is the only thing the frontend ever sees, and it
    // drives the "Passive — admin only" badge + the "Send portal
    // invitation" button on the detail page.
    isPassive: c.password_hash == null,
    // Per-customer feature flags (#354 follow-up). Coerce to bool so the
    // frontend doesn't have to deal with SQLite's 0/1 values.
    featureCalendar: c.feature_calendar === true || c.feature_calendar === 1,
    featureQuotes:   c.feature_quotes   === true || c.feature_quotes   === 1,
    featureBills:    c.feature_bills    === true || c.feature_bills    === 1,
    // Hours logging (migration 129) — fourth per-customer flag.
    // Default hourly rate (in minor units) is null when admin hasn't
    // set one; the editor surfaces it as an empty input and forces a
    // per-entry override on every logged block.
    featureHoursLogging: c.feature_hours_logging === true || c.feature_hours_logging === 1,
    // Contracts override (migration 131). Opt-out: absent column (older row /
    // un-selected) reads as ON so existing customers keep the Contracts tab.
    featureContracts: c.feature_contracts === undefined ? true : (c.feature_contracts === true || c.feature_contracts === 1),
    // Documents override (migration 225). Same opt-out reading as contracts.
    featureDocuments: c.feature_documents === undefined ? true : (c.feature_documents === true || c.feature_documents === 1),
    hourlyRateMinor: c.hourly_rate_minor != null ? Number(c.hourly_rate_minor) : null,
    // Migration 220 — the customer's own day rate for per-day quote lines.
    dayRateMinor: c.day_rate_minor != null ? Number(c.day_rate_minor) : null,
    // Per-customer Skonto opt-out (migration 112). When true, none of
    // this customer's invoices qualify for an early-payment discount,
    // regardless of template / global defaults.
    skontoDisabled: c.skonto_disabled === true || c.skonto_disabled === 1,
    // Per-customer re-bill proof-attachment override (migration 169, #866).
    // Tri-state: null = inherit the global default, true = always attach,
    // false = never attach the supplier proof to the client-invoice email.
    rebillAttachProof: c.rebill_attach_proof == null ? null : (c.rebill_attach_proof === true || c.rebill_attach_proof === 1),
    lastLogin: c.last_login,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    eventCount: c.event_count != null ? Number(c.event_count) : undefined,
    // Customer groups (#1443, migration 226). Attached by the list and detail
    // routes; `undefined` where a response was never meant to carry them, so
    // an existing consumer sees no change.
    groups: Array.isArray(c.groups) ? c.groups : undefined,
    events: Array.isArray(c.events)
      ? c.events.map((e) => ({
        id: e.id,
        slug: e.slug,
        eventName: e.event_name,
        eventDate: e.event_date,
        expiresAt: e.expires_at,
        isArchived: e.is_archived,
        assignedAt: e.assigned_at,
      }))
      : undefined,
  };
}

function transformInvitation(inv) {
  return {
    id: inv.id,
    email: inv.email,
    expiresAt: inv.expires_at,
    createdAt: inv.created_at,
    invitedBy: inv.invited_by,
  };
}

// Far more groups than a catalogue holds, and well under what an IN list or
// a reorder loop should be handed from a request. The same number bounds how
// many groups one customer carries, so the detail editor can always save.
const MAX_GROUP_IDS = customerGroupsService.MAX_GROUPS_PER_CUSTOMER;
const MAX_REORDER_IDS = 500;
// One bulk change covers at most this many customers.
const MAX_BULK_CUSTOMERS = 500;

/**
 * `?groupIds=1,2` or `?groupIds=1&groupIds=2` → [1, 2]. Anything that isn't a
 * positive integer is dropped rather than refused, so a stale bookmark shows
 * the unfiltered list instead of an error. More than MAX_GROUP_IDS groups is
 * refused: cutting the list short would quietly answer a different filter
 * ("all of them" over the first 100 is not "all of them").
 */
function parseGroupIds(value) {
  if (value === undefined || value === null || value === '') return [];
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const ids = [...new Set(raw
    .map((id) => Number(String(id).trim()))
    .filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length > MAX_GROUP_IDS) {
    const err = new AppError(`Filter by at most ${MAX_GROUP_IDS} groups at once`, 400, 'GROUP_FILTER_TOO_MANY');
    err.details = { limit: MAX_GROUP_IDS };
    throw err;
  }
  return ids;
}

// ---- customer groups (#1443) --------------------------------------------
// Mounted before /:id so "groups" is never read as a customer id. Reading the
// catalogue needs customers.view (it is part of the overview); changing it
// needs customers.groups.manage (migration 226).

const requireGroupManage = requirePermission('customers.groups.manage');

router.get('/groups', [
  adminAuth,
  requirePermission('customers.view'),
  query('includeArchived').optional().isBoolean(),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const includeArchived = req.query.includeArchived === 'true' || req.query.includeArchived === '1';
  return successResponse(res, {
    groups: await customerGroupsService.list({ includeArchived }),
    ungroupedCount: await customerGroupsService.countUngrouped(),
  });
}));

router.post('/groups', [
  adminAuth,
  requireGroupManage,
  body('name').isString().trim().isLength({ min: 1, max: 80 }),
  body('description').optional({ nullable: true }).isString().trim().isLength({ max: 500 }),
  body('color').optional({ nullable: true }).isString(),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const group = await customerGroupsService.create(req.body, req.admin);
  return successResponse(res, { group }, 201);
}));

// Before /groups/:groupId, or "reorder" is read as an id.
router.post('/groups/reorder', [
  adminAuth,
  requireGroupManage,
  body('orderedIds').isArray({ min: 1, max: MAX_REORDER_IDS }),
  body('orderedIds.*').isInt({ min: 1 }).toInt(),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const groups = await customerGroupsService.reorder(req.body.orderedIds, req.admin);
  return successResponse(res, { groups });
}));

// All or nothing, before /groups/:groupId like reorder. `dryRun` answers the
// same numbers without writing — the preview the admin confirms.
router.post('/groups/bulk-assign', [
  adminAuth,
  requireGroupManage,
  body('customerIds').isArray({ min: 1, max: MAX_BULK_CUSTOMERS }),
  body('customerIds.*').isInt({ min: 1 }).toInt(),
  body('addGroupIds').optional().isArray({ max: MAX_GROUP_IDS }),
  body('addGroupIds.*').isInt({ min: 1 }).toInt(),
  body('removeGroupIds').optional().isArray({ max: MAX_GROUP_IDS }),
  body('removeGroupIds.*').isInt({ min: 1 }).toInt(),
  body('dryRun').optional().isBoolean().toBoolean(),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const result = await customerGroupsService.bulkAssign({
    customerIds: req.body.customerIds,
    addGroupIds: req.body.addGroupIds,
    removeGroupIds: req.body.removeGroupIds,
    dryRun: req.body.dryRun === true,
  }, req.admin);
  return successResponse(res, result);
}));

router.put('/groups/:groupId', [
  adminAuth,
  requireGroupManage,
  param('groupId').isInt({ min: 1 }),
  body('name').optional().isString().trim().isLength({ min: 1, max: 80 }),
  body('description').optional({ nullable: true }).isString().trim().isLength({ max: 500 }),
  body('color').optional({ nullable: true }).isString(),
  body('isArchived').optional().isBoolean(),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const group = await customerGroupsService.update(parseInt(req.params.groupId, 10), req.body, req.admin);
  return successResponse(res, { group });
}));

router.delete('/groups/:groupId', [
  adminAuth,
  requireGroupManage,
  param('groupId').isInt({ min: 1 }),
], handleAsync(async (req, res) => {
  validateRequest(req);
  return successResponse(res, await customerGroupsService.remove(parseInt(req.params.groupId, 10), req.admin));
}));

router.put('/:id/groups', [
  adminAuth,
  requireGroupManage,
  param('id').isInt({ min: 1 }),
  body('groupIds').isArray({ max: MAX_GROUP_IDS }),
  body('groupIds.*').isInt({ min: 1 }).toInt(),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const groups = await customerGroupsService.setCustomerGroups(
    parseInt(req.params.id, 10), req.body.groupIds, req.admin,
  );
  return successResponse(res, { groups });
}));

// ---- list / search ------------------------------------------------------

router.get('/', [
  adminAuth,
  requirePermission('customers.view'),
  query('search').optional().isString(),
  // Repeatable (?groupIds=1&groupIds=2) or comma-separated (?groupIds=1,2).
  query('groupIds').optional(),
  query('groupMatch').optional().isIn(['any', 'all']),
  query('ungrouped').optional().isBoolean(),
  query('status').optional().isIn(['active', 'inactive', 'all']),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const customers = await customerAccountsService.listCustomers({
    search: req.query.search,
    groupIds: parseGroupIds(req.query.groupIds),
    groupMatch: req.query.groupMatch || 'any',
    ungrouped: req.query.ungrouped === 'true' || req.query.ungrouped === '1',
    status: req.query.status || 'all',
  });
  const groupsByCustomer = await customerGroupsService.groupsForCustomers(customers.map((c) => c.id));
  res.json({
    customers: customers.map((c) => transformCustomer({ ...c, groups: groupsByCustomer.get(Number(c.id)) || [] })),
  });
}));

/**
 * GET /search?email=…
 *
 * Autocomplete used by the event-form CustomerAccountPicker. Returns
 * up to 10 matches against email/name/company prefixes. Permission is
 * customers.view because exposing emails to anyone with users.view but
 * not customers.view would leak the customer roster.
 */
router.get('/search', [
  adminAuth,
  requirePermission('customers.view'),
  query('email').optional().isString(),
  query('q').optional().isString(),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const term = req.query.email || req.query.q || '';
  const results = await customerAccountsService.searchCustomers(term);
  // Groups (#1443), so a picker shows the segment without opening the record.
  const groupsByCustomer = await customerGroupsService.groupsForCustomers(results.map((c) => c.id));
  res.json({
    customers: results.map((c) => transformCustomer({ ...c, groups: groupsByCustomer.get(Number(c.id)) || [] })),
  });
}));

// ---- invitations --------------------------------------------------------

router.get('/invitations', [
  adminAuth,
  requirePermission('customers.view'),
], handleAsync(async (req, res) => {
  const invitations = await customerAccountsService.getPendingInvitations();
  res.json({ invitations: invitations.map(transformInvitation) });
}));

router.post('/invite', [
  adminAuth,
  requirePermission('customers.create'),
  body('email').isEmail().normalizeEmail(IDENTITY_PRESERVING_NORMALIZE_EMAIL).withMessage('Valid email is required'),
  // Optional prefill — admin can stash any subset of customer profile fields
  // on the invitation. The customer sees them pre-populated on the accept
  // form and can edit before submitting. Validators are deliberately lax:
  // any field can be omitted, and only length is enforced (sanitisation
  // happens server-side in the service).
  body('prefill').optional().isObject(),
  body('prefill.salutation').optional({ nullable: true }).isString().isLength({ max: 32 }),
  body('prefill.first_name').optional({ nullable: true }).isString().isLength({ max: 80 }),
  body('prefill.last_name').optional({ nullable: true }).isString().isLength({ max: 80 }),
  body('prefill.display_name').optional({ nullable: true }).isString().isLength({ max: 120 }),
  body('prefill.phone').optional({ nullable: true }).isString().isLength({ max: 40 }),
  body('prefill.company_name').optional({ nullable: true }).isString().isLength({ max: 120 }),
  body('prefill.vat_id').optional({ nullable: true }).isString().isLength({ max: 40 }),
  body('prefill.address_line1').optional({ nullable: true }).isString().isLength({ max: 255 }),
  body('prefill.address_line2').optional({ nullable: true }).isString().isLength({ max: 255 }),
  body('prefill.postal_code').optional({ nullable: true }).isString().isLength({ max: 20 }),
  body('prefill.city').optional({ nullable: true }).isString().isLength({ max: 120 }),
  body('prefill.state').optional({ nullable: true }).isString().isLength({ max: 120 }),
  body('prefill.country_code').optional({ values: 'falsy' }).isLength({ min: 2, max: 2 }).isAlpha().withMessage('country_code must be a 2-letter ISO code').customSanitizer((v) => (v || '').toUpperCase()),
  // Per-customer preferred language. Drives portal UI + quote/invoice
  // PDF locale. Defaults at insert time to the business profile's
  // default_locale when the admin doesn't supply one (see
  // customerAccountsService.acceptInvitation).
  body('prefill.preferred_language').optional({ nullable: true }).isString().isLength({ min: 2, max: 8 }),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const invitation = await customerAccountsService.createInvitation({
    email: req.body.email,
    invitedById: req.admin.id,
    prefill: req.body.prefill,
  });
  // Echo the token in the response ONLY in non-production. This lets
  // local dev + Playwright e2e specs skip the email round-trip
  // (queueing → SMTP → mailbox → parse) and accept the invitation
  // straight away. In production the token stays email-channel-only:
  // anyone with API access plus the response body would otherwise be
  // able to take over a freshly-invited customer account before the
  // legitimate user clicks the link.
  const payload = {
    invitation: {
      id: invitation.id,
      email: invitation.email,
      expiresAt: invitation.expiresAt,
    },
  };
  // C.7 — hardened token echo. The previous shape gated on
  // `NODE_ENV !== 'production'`, which is true in dev AND when the
  // variable is unset entirely (some hosting setups never set
  // NODE_ENV in their entrypoint). That meant the raw invitation
  // token could leak in production-shaped deployments where the env
  // happened to be unset. Now requires an EXPLICIT opt-in
  // (`PICPEAK_ECHO_INVITE_TOKEN=1`) so a misconfigured production
  // host fails closed instead of open.
  if (process.env.PICPEAK_ECHO_INVITE_TOKEN === '1') {
    payload.invitation.token = invitation.token;
  }
  successResponse(res, payload, 201);
}));

router.delete('/invitations/:id', [
  adminAuth,
  requirePermission('customers.create'),
  param('id').isInt({ min: 1 }),
], handleAsync(async (req, res) => {
  validateRequest(req);
  await customerAccountsService.cancelInvitation(
    parseInt(req.params.id, 10),
    req.admin.id
  );
  successResponse(res, { message: 'Invitation cancelled' });
}));

// ---- create passive customer (no invitation, admin-only) ----------------
//
// Counterpart to POST /invite: instead of creating an invitation row +
// email, this endpoint inserts the customer directly with
// password_hash=null (passive). The admin uses this when they have all
// the customer's info on hand and just need an identity to attach a
// quote / invoice / gallery to — no portal access required.
//
// Same per-field validators as /invite's prefill block, plus `email`
// required at the top level. Permission: customers.create.
router.post('/', [
  adminAuth,
  requirePermission('customers.create'),
  body('email').isEmail().normalizeEmail(IDENTITY_PRESERVING_NORMALIZE_EMAIL).withMessage('Valid email is required'),
  body('prefill').optional().isObject(),
  body('prefill.salutation').optional({ nullable: true }).isString().isLength({ max: 32 }),
  body('prefill.first_name').optional({ nullable: true }).isString().isLength({ max: 80 }),
  body('prefill.last_name').optional({ nullable: true }).isString().isLength({ max: 80 }),
  body('prefill.display_name').optional({ nullable: true }).isString().isLength({ max: 120 }),
  body('prefill.phone').optional({ nullable: true }).isString().isLength({ max: 40 }),
  body('prefill.company_name').optional({ nullable: true }).isString().isLength({ max: 120 }),
  body('prefill.vat_id').optional({ nullable: true }).isString().isLength({ max: 40 }),
  body('prefill.address_line1').optional({ nullable: true }).isString().isLength({ max: 255 }),
  body('prefill.address_line2').optional({ nullable: true }).isString().isLength({ max: 255 }),
  body('prefill.postal_code').optional({ nullable: true }).isString().isLength({ max: 20 }),
  body('prefill.city').optional({ nullable: true }).isString().isLength({ max: 120 }),
  body('prefill.state').optional({ nullable: true }).isString().isLength({ max: 120 }),
  body('prefill.country_code').optional({ values: 'falsy' }).isLength({ min: 2, max: 2 }).isAlpha().withMessage('country_code must be a 2-letter ISO code').customSanitizer((v) => (v || '').toUpperCase()),
  body('prefill.country_name').optional({ nullable: true }).isString().isLength({ max: 120 }),
  body('prefill.preferred_language').optional({ nullable: true }).isString().isLength({ min: 2, max: 8 }),
  // At least one human-readable identifier so the record isn't a
  // nameless row that's impossible to recognise in lists later.
  body('prefill').custom((prefill) => {
    const p = prefill || {};
    const hasName = ['company_name', 'display_name', 'first_name', 'last_name']
      .some((k) => typeof p[k] === 'string' && p[k].trim());
    if (!hasName) {
      throw new Error('At least a company name or a contact name is required');
    }
    return true;
  }),
  // Groups for the new customer (#1443). Placing a customer in a group is
  // customers.groups.manage, checked in the handler because the field is
  // optional on a route guarded by customers.create.
  body('groupIds').optional().isArray({ max: MAX_GROUP_IDS }),
  body('groupIds.*').isInt({ min: 1 }).toInt(),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const groupIds = [...new Set(req.body.groupIds || [])];
  // The permission is checked before anything is written. The friendly group
  // check runs first too, but what holds is the transaction below: the
  // customer and its memberships are inserted together, so a group archived
  // or deleted in between refuses both and leaves no customer behind — a
  // retry doesn't then trip over "email exists".
  if (groupIds.length > 0) {
    if (!await userHasAnyPermission(req.admin.id, ['customers.groups.manage'])) {
      throw new AppError('Placing a customer in a group needs the customers.groups.manage permission', 403, 'GROUPS_PERMISSION_REQUIRED');
    }
    await customerGroupsService.assertAssignable(groupIds);
  }
  // createDirect emits customer.created after its transaction commits, with
  // the memberships already in place.
  let change = null;
  const { id } = await customerAccountsService.createDirect({
    email: req.body.email,
    prefill: req.body.prefill,
    createdByAdminId: req.admin.id,
    withinTransaction: groupIds.length > 0
      ? async (trx, customerId) => { change = await customerGroupsService.replaceCustomerGroups(trx, customerId, groupIds); }
      : null,
  });
  if (change) await customerGroupsService.logCustomerGroupsAssigned(id, change, req.admin);
  const groups = groupIds.length > 0 ? await customerGroupsService.groupsForCustomer(id) : [];
  const customer = await customerAccountsService.getCustomerById(id);
  successResponse(res, { customer: transformCustomer({ ...customer, groups }) }, 201);
}));

// ---- promote a passive customer to active (send portal invitation) ------
//
// Fires the standard customer-invitation email flow at a customer who
// currently has no password_hash. The customer clicks the link, lands
// on the accept page (pre-populated with their existing profile),
// chooses a password, and is now active. The customer's id stays the
// same — all their invoices/quotes/gallery assignments survive.
//
// 409 with code CUSTOMER_ALREADY_ACTIVE when the customer already has
// a password set, so the button on the detail page can render an
// appropriate error toast.
router.post('/:id/send-invite', [
  adminAuth,
  requirePermission('customers.create'),
  param('id').isInt({ min: 1 }),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const customerId = parseInt(req.params.id, 10);
  const customer = await customerAccountsService.getCustomerById(customerId);
  if (customer.password_hash) {
    return res.status(409).json({
      error: 'Customer already has portal access — no invitation needed.',
      code: 'CUSTOMER_ALREADY_ACTIVE',
    });
  }
  // Derive the invitation prefill from the customer's existing
  // profile so the accept page is pre-populated with what the admin
  // already entered for them (saves the customer typing it again).
  // Only the whitelisted fields go through.
  const prefill = {
    salutation:     customer.salutation,
    first_name:     customer.first_name,
    last_name:      customer.last_name,
    display_name:   customer.display_name,
    phone:          customer.phone,
    company_name:   customer.company_name,
    vat_id:         customer.vat_id,
    address_line1:  customer.address_line1,
    address_line2:  customer.address_line2,
    postal_code:    customer.postal_code,
    city:           customer.city,
    state:          customer.state,
    country_code:   customer.country_code,
    country_name:   customer.country_name,
    preferred_language: customer.preferred_language,
  };
  const invitation = await customerAccountsService.createInvitation({
    email: customer.email,
    invitedById: req.admin.id,
    prefill,
  });
  const payload = {
    invitation: {
      id: invitation.id,
      email: invitation.email,
      expiresAt: invitation.expiresAt,
    },
  };
  // C.7 — see the matching gate on POST /invite. Explicit opt-in
  // (`PICPEAK_ECHO_INVITE_TOKEN=1`) fails closed when NODE_ENV is
  // unset in a production-shaped deployment.
  if (process.env.PICPEAK_ECHO_INVITE_TOKEN === '1') {
    payload.invitation.token = invitation.token;
  }
  successResponse(res, payload, 201);
}));

// ---- customer record ----------------------------------------------------

// Change history (migration 219) of the customer's billing fields and hour
// entries, oldest first. Personal values are blanked once a customer is erased.
router.get('/:id/history', [
  adminAuth,
  requirePermission('customers.view'),
  param('id').isInt({ min: 1 }),
], handleAsync(async (req, res) => {
  validateRequest(req);
  let entries = await accountingHistory.listHistory('customer', parseInt(req.params.id, 10));
  // Hour entries stay behind the same gate as /:id/hour-entries.
  if (!(await isFeatureEnabled('hoursLogging'))) {
    entries = entries.filter((entry) => entry.entity_type !== 'hour_entry');
  }
  return successResponse(res, { entries });
}));

router.get('/:id', [
  adminAuth,
  requirePermission('customers.view'),
  param('id').isInt({ min: 1 }),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const id = parseInt(req.params.id, 10);
  const customer = await customerAccountsService.getCustomerById(id);
  const groups = await customerGroupsService.groupsForCustomer(id);
  res.json({ customer: transformCustomer({ ...customer, groups }) });
}));

router.put('/:id', [
  adminAuth,
  // Migration 134 — record-edit scope split out of customers.create.
  // Roles that previously held customers.create were granted
  // customers.edit on upgrade so behavior is preserved.
  requirePermission('customers.edit'),
  param('id').isInt({ min: 1 }),
  body('email').optional().isEmail().normalizeEmail(IDENTITY_PRESERVING_NORMALIZE_EMAIL),
  // `{ nullable: true }` so a passive customer who has no salutation /
  // phone / company in their record can still save the page — the
  // form sends `null` for those empty fields, and plain `.optional()`
  // (which only skips `undefined`) would reject null at the
  // subsequent `.isString()` step. Mirrors the existing pattern on
  // billing_email / vat_id / address_* below.
  body('salutation').optional({ nullable: true }).isString().isLength({ max: 32 }),
  body('first_name').optional({ nullable: true }).isString().isLength({ max: 80 }),
  body('last_name').optional({ nullable: true }).isString().isLength({ max: 80 }),
  body('display_name').optional({ nullable: true }).isString().isLength({ max: 120 }),
  body('phone').optional({ nullable: true }).isString().isLength({ max: 40 }),
  body('company_name').optional({ nullable: true }).isString().isLength({ max: 120 }),
  body('billing_email').optional({ nullable: true }).isString(),
  body('vat_id').optional({ nullable: true }).isString().isLength({ max: 40 }),
  body('address_line1').optional({ nullable: true }).isString().isLength({ max: 255 }),
  body('address_line2').optional({ nullable: true }).isString().isLength({ max: 255 }),
  body('postal_code').optional({ nullable: true }).isString().isLength({ max: 20 }),
  body('city').optional({ nullable: true }).isString().isLength({ max: 120 }),
  body('state').optional({ nullable: true }).isString().isLength({ max: 120 }),
  body('country_code').optional({ values: 'falsy' }).isLength({ min: 2, max: 2 }).isAlpha().withMessage('country_code must be a 2-letter ISO code').customSanitizer((v) => (v || '').toUpperCase()),
  body('country_name').optional({ nullable: true }).isString().isLength({ max: 120 }),
  body('preferred_language').optional({ nullable: true }).isString().isLength({ max: 8 }),
  body('notes').optional({ nullable: true }).isString(),
  body('is_active').optional().isBoolean(),
  // Newsletter consent (migration 199, #1264).
  body('marketing_opt_out').optional().isBoolean(),
  body('feature_calendar').optional().isBoolean(),
  body('feature_quotes').optional().isBoolean(),
  body('feature_bills').optional().isBoolean(),
  body('feature_contracts').optional().isBoolean(),
  // Customer documents (migration 225).
  body('feature_documents').optional().isBoolean(),
  // Hours logging (migration 129).
  body('feature_hours_logging').optional().isBoolean(),
  body('hourly_rate_minor').optional({ nullable: true }).isInt({ min: 0 }),
  body('day_rate_minor').optional({ nullable: true }).isInt({ min: 0 }),
  // CRM billing cadence — see migration 102. `per_event` keeps the
  // existing per-event payment plan; monthly/quarterly snap every
  // generated invoice to billing_cycle_day of the next period.
  // Cycle day spans -15..-1 (days before month end) and 1..28
  // (day of month) per migration 128 + service-layer clamp.
  body('billing_cadence').optional().isIn(['per_event', 'monthly', 'quarterly', 'manual']),
  body('billing_cycle_day').optional().isInt({ min: -15, max: 28 })
    .withMessage('billing_cycle_day must be -15..-1 (days before month end) or 1..28 (day of month)'),
  // Per-customer Skonto opt-out (migration 112).
  body('skonto_disabled').optional().isBoolean(),
  // Per-customer re-bill proof-attachment override (migration 169, #866).
  // Nullable tri-state: null clears the override (inherit global default).
  body('rebill_attach_proof').optional({ nullable: true }).isBoolean(),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const customer = await customerAccountsService.updateCustomer(
    parseInt(req.params.id, 10),
    req.body,
    req.admin.id
  );
  res.json({ customer: transformCustomer(customer) });
}));

router.post('/:id/deactivate', [
  adminAuth,
  requirePermission('customers.delete'),
  param('id').isInt({ min: 1 }),
], handleAsync(async (req, res) => {
  validateRequest(req);
  await customerAccountsService.deactivateCustomer(
    parseInt(req.params.id, 10),
    req.admin.id
  );
  successResponse(res, { message: 'Customer deactivated' });
}));

/**
 * POST /:id/reactivate (#354 follow-up).
 *
 * Restore a previously-deactivated customer. Same permission as
 * deactivate (`customers.delete`) since they're inverse operations and
 * the admin who can disable should be the one who can re-enable.
 */
router.post('/:id/reactivate', [
  adminAuth,
  requirePermission('customers.delete'),
  param('id').isInt({ min: 1 }),
], handleAsync(async (req, res) => {
  validateRequest(req);
  await customerAccountsService.reactivateCustomer(
    parseInt(req.params.id, 10),
    req.admin.id
  );
  successResponse(res, { message: 'Customer reactivated' });
}));

/**
 * POST /:id/erase (#354 follow-up).
 *
 * Anonymize-in-place erasure (GDPR Art. 17 style): nulls every PII
 * column, wipes credentials, drops pending invitations and reset tokens,
 * keeps the row + audit references intact so historical "who had access"
 * queries don't break. See customerAccountsService.eraseCustomer for
 * the full rationale.
 *
 * Hard delete is NOT shipped — `customer_invitations.accepted_customer_id`
 * has no ON DELETE CASCADE, so a real DELETE would FK-block on any
 * customer who ever accepted an invitation.
 */
router.post('/:id/erase', [
  adminAuth,
  requirePermission('customers.delete'),
  param('id').isInt({ min: 1 }),
], handleAsync(async (req, res) => {
  validateRequest(req);
  await customerAccountsService.eraseCustomer(
    parseInt(req.params.id, 10),
    req.admin.id
  );
  successResponse(res, { message: 'Customer erased' });
}));

/**
 * POST /:id/password-reset (#354 follow-up).
 *
 * Generate a 7-day password-reset token and email it to the customer.
 * Reused permission `customers.create` because issuing a reset is the
 * same authority level as issuing an invitation — both put a credential
 * into the customer's mailbox.
 */
router.post('/:id/password-reset', [
  adminAuth,
  requirePermission('customers.create'),
  param('id').isInt({ min: 1 }),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const result = await customerAccountsService.createPasswordReset({
    customerId: parseInt(req.params.id, 10),
    requestedByAdminId: req.admin.id,
  });
  successResponse(res, { email: result.email, expiresAt: result.expiresAt });
}));

/**
 * PUT /api/admin/customers/:id/events — replace the customer's full
 * event assignment list. Backs the "Manage galleries" dialog on the
 * customer detail page. Body is `{ event_ids: number[] }`. Empty
 * array clears every assignment.
 *
 * Access revocation is implicit: gallery middleware checks for a
 * live event_customer_assignments row whenever it decodes a
 * customer-minted gallery JWT, so removing an assignment here
 * immediately blocks the customer's next gallery request without
 * needing to enumerate + revoke any active tokens. Permission tier
 * is customers.create (same as invite + deactivate) — managing
 * which galleries a customer can see is a write-class operation
 * on the customer record.
 */
router.put('/:id/events', [
  adminAuth,
  // Migration 134 — event-assignment scope split out of customers.create.
  // Lets an admin grant a coordinator the ability to re-target a customer
  // between weddings without also unlocking VAT-ID / billing-address
  // edits on every customer they can see.
  requirePermission('customers.events'),
  param('id').isInt({ min: 1 }),
  body('event_ids').isArray(),
  body('event_ids.*').isInt({ min: 1 }),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const customerId = parseInt(req.params.id, 10);
  const submitted = req.body.event_ids.map(Number);

  // The customer's CURRENT assignments. The "Manage galleries" dialog submits
  // the full initial list back — including any events owned by OTHER admins —
  // so we need this to tell "retain an existing foreign assignment" apart from
  // "newly grant a foreign event".
  const existingEventIds = (await db('event_customer_assignments')
    .where('customer_account_id', customerId)
    .pluck('event_id')).map(Number);
  const existingSet = new Set(existingEventIds);

  // Events the caller may act on (GHSA-xr6x). A denied id is only acceptable
  // when the customer ALREADY has that assignment (a foreign event the caller
  // is merely keeping); a denied id that isn't already assigned is a fresh
  // attempt to mint access to a foreign/nonexistent event → reject.
  const { allowed } = await filterOwnedEventIds(req.admin, submitted);
  const allowedSet = new Set(allowed.map(Number));
  const illegalNew = submitted.filter((id) => !allowedSet.has(id) && !existingSet.has(id));
  if (illegalNew.length) {
    return res.status(403).json({ error: 'One or more events are not yours to assign' });
  }

  // setAssignmentsForCustomer replaces the FULL assignment list, deleting any
  // existing row not in the submitted set. A restricted admin must not be able
  // to revoke another admin's customer↔event links that way, so always retain
  // the customer's existing assignments to events the caller does NOT own —
  // regardless of whether the client echoed them back. super_admin owns
  // everything, so nothing is force-preserved for them.
  let finalEventIds = allowed.map(Number);
  if (req.admin.roleName !== 'super_admin' && existingEventIds.length) {
    const { allowed: ownedExisting } = await filterOwnedEventIds(req.admin, existingEventIds);
    const ownedExistingSet = new Set(ownedExisting.map(Number));
    const foreignExisting = existingEventIds.filter((id) => !ownedExistingSet.has(id));
    finalEventIds = [...new Set([...finalEventIds, ...foreignExisting])];
  }
  const result = await customerAccountsService.setAssignmentsForCustomer(
    customerId,
    finalEventIds,
    req.admin.id,
  );
  successResponse(res, result);
}));

// ---------------------------------------------------------------------
// Hour entries (migration 129).
//
// Five endpoints under /api/admin/customers/:id/hour-entries — list,
// create, update, delete, plus the per-event "Bill these hours"
// action. Mounted alongside the /events sub-resource above; permission
// tier is customers.create, same as the rest of the customer-write
// surface.
// ---------------------------------------------------------------------

// Aggregate landing view for /admin/clients/hours — every customer with
// open (unbilled) hours + the open monetary amount. Registered before
// the /:id/hour-entries routes; the literal first segment ("hour-entries")
// can't collide with the int-validated :id pattern.
router.get('/hour-entries/unbilled-summary', [
  adminAuth,
  requireHoursLogging,
  requirePermission('customers.view'),
], handleAsync(async (req, res) => {
  const summary = await customerHoursService.getUnbilledSummaryByCustomer();
  successResponse(res, { summary });
}));

router.get('/:id/hour-entries', [
  adminAuth,
  requireHoursLogging,
  requirePermission('customers.view'),
  param('id').isInt({ min: 1 }),
  query('status').optional().isIn(['unbilled', 'billed', 'cancelled']),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const rows = await customerHoursService.listEntries(
    parseInt(req.params.id, 10),
    { status: req.query.status },
  );
  successResponse(res, { entries: rows.map(transformHourEntry) });
}));

router.post('/:id/hour-entries', [
  adminAuth,
  requireHoursLogging,
  // Migration 134 — hour entries are customer-scoped writes; same scope
  // as customer record edits, narrower than invite/create.
  requirePermission('customers.edit'),
  param('id').isInt({ min: 1 }),
  body('entryDate').isISO8601(),
  body('startTime').matches(/^([01]\d|2[0-3]):[0-5]\d$/),
  body('endTime').matches(/^([01]\d|2[0-3]):[0-5]\d$/),
  body('hourlyRateMinorOverride').optional({ nullable: true }).isInt({ min: 0 }),
  body('description').optional({ nullable: true }).isString().isLength({ max: 1000 }),
  body('projectId').optional({ nullable: true }).isInt({ min: 1 }),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const result = await customerHoursService.createEntry(
    parseInt(req.params.id, 10),
    req.body,
    req.admin.id,
  );
  successResponse(res, result, 201);
}));

router.put('/:id/hour-entries/:entryId', [
  adminAuth,
  requireHoursLogging,
  requirePermission('customers.edit'),
  param('id').isInt({ min: 1 }),
  param('entryId').isInt({ min: 1 }),
  body('entryDate').optional().isISO8601(),
  body('startTime').optional().matches(/^([01]\d|2[0-3]):[0-5]\d$/),
  body('endTime').optional().matches(/^([01]\d|2[0-3]):[0-5]\d$/),
  body('hourlyRateMinorOverride').optional({ nullable: true }).isInt({ min: 0 }),
  body('description').optional({ nullable: true }).isString().isLength({ max: 1000 }),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const result = await customerHoursService.updateEntry(
    parseInt(req.params.entryId, 10),
    req.body,
    req.admin.id,
  );
  successResponse(res, result);
}));

router.delete('/:id/hour-entries/:entryId', [
  adminAuth,
  requireHoursLogging,
  requirePermission('customers.edit'),
  param('id').isInt({ min: 1 }),
  param('entryId').isInt({ min: 1 }),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const result = await customerHoursService.deleteEntry(
    parseInt(req.params.entryId, 10),
    req.admin.id,
  );
  successResponse(res, result);
}));

router.post('/:id/hour-entries/bill', [
  adminAuth,
  requireHoursLogging,
  requirePermission('customers.edit'),
  param('id').isInt({ min: 1 }),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const result = await customerHoursService.billUnbilledEntries(
    parseInt(req.params.id, 10),
    req.admin.id,
  );
  successResponse(res, result, 201);
}));

// Combined hours + re-bills → one invoice (#866, Feature 3). Used by the
// cross-add dialog when a per-event customer has open items in both categories.
router.post('/:id/bill-combined', [
  adminAuth,
  requireIncoming,
  requirePermission('customers.edit'),
  param('id').isInt({ min: 1 }),
  body('includeHours').optional().isBoolean(),
  body('includeRebills').optional().isBoolean(),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const result = await combinedBillingService.billCombinedForCustomer(
    parseInt(req.params.id, 10),
    { includeHours: req.body.includeHours !== false, includeRebills: req.body.includeRebills !== false },
    req.admin.id,
  );
  if (result.invoiceId) capabilityEvidence(res, 'crm_combined_billing');
  successResponse(res, result, 201);
}));

function transformHourEntry(h) {
  return {
    id: h.id,
    customerAccountId: h.customer_account_id,
    entryDate: typeof h.entry_date === 'string' ? h.entry_date.slice(0, 10) : h.entry_date,
    startTime: h.start_time,
    endTime: h.end_time,
    durationMinutes: Number(h.duration_minutes),
    hourlyRateMinorOverride: h.hourly_rate_minor_override != null ? Number(h.hourly_rate_minor_override) : null,
    description: h.description,
    status: h.status,
    invoiceId: h.invoice_id,
    invoiceLineItemId: h.invoice_line_item_id,
    invoiceNumber: h.invoice_number || null,
    invoiceStatus: h.invoice_status || null,
    invoiceIsMonthlyDraft: h.invoice_is_monthly_draft === true || h.invoice_is_monthly_draft === 1,
    invoiceScheduledSendAt: h.invoice_scheduled_send_at,
    billedAt: h.billed_at,
    recordedByAdminId: h.recorded_by_admin_id,
    createdAt: h.created_at,
    updatedAt: h.updated_at,
  };
}

// ---------------------------------------------------------------------
// Monthly billing — manual trigger (migration 128 admin override).
//
// Issues the customer's running monthly draft NOW, bypassing the
// scheduler's cadence-day wait. Used when admin wants to bill out-of-
// cycle (e.g. customer requested an early invoice, project completed
// before cadence day). Permission tier is customers.create — same as
// the rest of the customer-write surface and matches the rest of the
// monthly-billing controls.
// ---------------------------------------------------------------------
router.post('/:id/trigger-monthly-bill', [
  adminAuth,
  // Migration 134 — admin-override fire is a customer-scoped write,
  // not a create. Roles holding customers.create were granted
  // customers.edit on upgrade so this still works for existing admins.
  requirePermission('customers.edit'),
  param('id').isInt({ min: 1 }),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const result = await invoiceService.triggerMonthlyBillNow(
    parseInt(req.params.id, 10),
    req.admin.id,
  );
  if (result.invoiceId) capabilityEvidence(res, 'crm_monthly_billing_manual');
  successResponse(res, result, 201);
}));

// Preview the customer's open monthly draft (line items + totals) so
// the customer-detail page can show "what will ship on the next cycle
// day". Returns null draft when nothing has been queued yet. Same
// permission scope as the trigger endpoint — both read/operate on
// the same row.
router.get('/:id/monthly-draft', [
  adminAuth,
  // Migration 134 — kept aligned with /trigger-monthly-bill above;
  // the same role that can fire the draft should be able to preview it.
  requirePermission('customers.edit'),
  param('id').isInt({ min: 1 }),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const draft = await invoiceService.getMonthlyDraft(parseInt(req.params.id, 10));
  successResponse(res, { draft });
}));

// ---- customer documents (#1444) ------------------------------------------
// Every route — reads included — sits behind the `documents` flag and
// `customers.documents.manage`: the list carries customer uploads nobody has
// reviewed yet. The service scopes every lookup by the :id customer, so a
// document id from another customer is a 404. Links to an event or project
// are checked against what this admin may access (filterOwnedEventIds /
// ownedProjectIds) inside the service.
const requireDocuments = requireFeatureFlag('documents', 'DOCUMENTS_DISABLED');
const documentGuards = [
  adminAuth,
  requireDocuments,
  requirePermission('customers.documents.manage'),
  param('id').isInt({ min: 1 }),
];
const documentItemGuards = [...documentGuards, param('docId').isInt({ min: 1 })];
const adminActor = (admin) => ({ type: 'admin', id: admin.id, name: admin.username || 'admin' });

async function loadDocumentCustomer(req) {
  validateRequest(req);
  const customerId = parseInt(req.params.id, 10);
  const customer = await db('customer_accounts').where({ id: customerId }).first('id');
  if (!customer) throw new NotFoundError('Customer', customerId);
  return customerId;
}

router.get('/:id/documents', documentGuards, handleAsync(async (req, res) => {
  const customerId = await loadDocumentCustomer(req);
  const documents = await customerDocumentsService.listForAdmin(customerId);
  const limits = await customerDocumentsService.getLimits();
  const usedBytes = await customerDocumentsService.getUsageBytes(customerId);
  successResponse(res, { documents, limits: { ...limits, usedBytes } });
}));

// multipart: file (PDF), share?, eventId?, projectId?, contractId?
// Admin uploads are recorded clean by the uploading admin and don't count
// against the customer's quota; the per-file size cap applies.
router.post('/:id/documents', documentGuards, handleAsync(async (req, res) => {
  const customerId = await loadDocumentCustomer(req);
  const limits = await customerDocumentsService.getLimits();
  let file = null;
  try {
    file = await receivePdfUpload(req, res, { maxBytes: limits.maxUploadBytes });
    if (!file) return res.status(400).json({ error: 'No file was uploaded', code: 'NO_FILE' });
    const share = req.body.share === true || req.body.share === 'true' || req.body.share === '1';
    const row = await customerDocumentsService.createDocument({
      customerId,
      uploaderType: 'admin',
      uploaderId: req.admin.id,
      file,
      links: { eventId: req.body.eventId, projectId: req.body.projectId, contractId: req.body.contractId },
      share,
      admin: req.admin,
      actor: adminActor(req.admin),
      maxUploadBytes: limits.maxUploadBytes,
    });
    return successResponse(res, { document: { id: row.id, status: row.status } }, 201);
  } finally {
    discardTempFile(file);
  }
}));

// Replaces all three links; send null to clear one.
router.patch('/:id/documents/:docId', [
  ...documentItemGuards,
  body('eventId').optional({ nullable: true }).isInt({ min: 1 }),
  body('projectId').optional({ nullable: true }).isInt({ min: 1 }),
  body('contractId').optional({ nullable: true }).isInt({ min: 1 }),
], handleAsync(async (req, res) => {
  const customerId = await loadDocumentCustomer(req);
  await customerDocumentsService.updateLinks(customerId, parseInt(req.params.docId, 10), req.body, req.admin);
  successResponse(res, { updated: true });
}));

router.post('/:id/documents/:docId/share', documentItemGuards, handleAsync(async (req, res) => {
  const customerId = await loadDocumentCustomer(req);
  await customerDocumentsService.setShared(customerId, parseInt(req.params.docId, 10), true, req.admin);
  successResponse(res, { shared: true });
}));

router.post('/:id/documents/:docId/unshare', documentItemGuards, handleAsync(async (req, res) => {
  const customerId = await loadDocumentCustomer(req);
  await customerDocumentsService.setShared(customerId, parseInt(req.params.docId, 10), false, req.admin);
  successResponse(res, { shared: false });
}));

// Mark clean / reject. The note is shown to the customer on a rejected upload.
router.post('/:id/documents/:docId/review', [
  ...documentItemGuards,
  body('status').isIn(['clean', 'rejected']),
  body('note').optional({ nullable: true }).isString().isLength({ max: 500 }),
], handleAsync(async (req, res) => {
  const customerId = await loadDocumentCustomer(req);
  await customerDocumentsService.review(customerId, parseInt(req.params.docId, 10), {
    status: req.body.status,
    note: req.body.note,
  }, req.admin);
  successResponse(res, { status: req.body.status });
}));

// Admins can download any non-deleted document, pending ones included —
// reviewing the file is how it gets marked clean. Always an attachment.
router.get('/:id/documents/:docId/download', documentItemGuards, handleAsync(async (req, res) => {
  const customerId = await loadDocumentCustomer(req);
  const row = await customerDocumentsService.getForAdmin(customerId, parseInt(req.params.docId, 10));
  const stream = await customerDocumentsService.openStream(row);
  await customerDocumentsService.recordView(row.id, 'admin', req.admin.id);
  await logActivity('customer_document_downloaded',
    { documentId: row.id, customerId }, row.event_id || null, adminActor(req.admin));
  sendPdfAttachment(res, stream, row.original_name);
}));

// Soft delete: hidden from the customer and the list at once; the retention
// sweep removes the bytes later.
router.delete('/:id/documents/:docId', documentItemGuards, handleAsync(async (req, res) => {
  const customerId = await loadDocumentCustomer(req);
  await customerDocumentsService.softDelete(customerId, parseInt(req.params.docId, 10), req.admin);
  successResponse(res, { deleted: true });
}));

module.exports = router;
