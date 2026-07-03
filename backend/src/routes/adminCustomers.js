/**
 * Admin → Customers Routes
 *
 * Endpoint mounted at /api/admin/customers (see app.js wiring).
 * Mirrors adminUsers.js for the invitation lifecycle but operates on
 * customer_accounts. Customer-side login routes live in customerAuth.js.
 */

const express = require('express');
const { body, param, query } = require('express-validator');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { requireFeatureFlag } = require('../middleware/requireFeatureFlag');

// Hour-entry routes are gated by the hoursLogging master so a direct API hit
// can't read/edit/delete/bill logged hours while the feature is off (the
// frontend already hides the surface). Per-customer enforcement stays in
// customerHoursService.createEntry.
const requireHoursLogging = requireFeatureFlag('hoursLogging', 'HOURS_LOGGING_DISABLED');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const customerAccountsService = require('../services/customerAccountsService');
const customerHoursService = require('../services/customerHoursService');
const invoiceService = require('../services/invoiceService');
const { IDENTITY_PRESERVING_NORMALIZE_EMAIL } = require('../utils/emailNormalization');

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
    hourlyRateMinor: c.hourly_rate_minor != null ? Number(c.hourly_rate_minor) : null,
    // Per-customer Skonto opt-out (migration 112). When true, none of
    // this customer's invoices qualify for an early-payment discount,
    // regardless of template / global defaults.
    skontoDisabled: c.skonto_disabled === true || c.skonto_disabled === 1,
    lastLogin: c.last_login,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    eventCount: c.event_count != null ? Number(c.event_count) : undefined,
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

// ---- list / search ------------------------------------------------------

router.get('/', [
  adminAuth,
  requirePermission('customers.view'),
  query('search').optional().isString(),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const customers = await customerAccountsService.listCustomers({
    search: req.query.search,
  });
  res.json({ customers: customers.map(transformCustomer) });
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
  res.json({ customers: results.map(transformCustomer) });
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
], handleAsync(async (req, res) => {
  validateRequest(req);
  const { id } = await customerAccountsService.createDirect({
    email: req.body.email,
    prefill: req.body.prefill,
    createdByAdminId: req.admin.id,
  });
  const customer = await customerAccountsService.getCustomerById(id);
  successResponse(res, { customer: transformCustomer(customer) }, 201);
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

router.get('/:id', [
  adminAuth,
  requirePermission('customers.view'),
  param('id').isInt({ min: 1 }),
], handleAsync(async (req, res) => {
  validateRequest(req);
  const customer = await customerAccountsService.getCustomerById(
    parseInt(req.params.id, 10)
  );
  res.json({ customer: transformCustomer(customer) });
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
  body('feature_calendar').optional().isBoolean(),
  body('feature_quotes').optional().isBoolean(),
  body('feature_bills').optional().isBoolean(),
  body('feature_contracts').optional().isBoolean(),
  // Hours logging (migration 129).
  body('feature_hours_logging').optional().isBoolean(),
  body('hourly_rate_minor').optional({ nullable: true }).isInt({ min: 0 }),
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
  const result = await customerAccountsService.setAssignmentsForCustomer(
    parseInt(req.params.id, 10),
    req.body.event_ids,
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

module.exports = router;
