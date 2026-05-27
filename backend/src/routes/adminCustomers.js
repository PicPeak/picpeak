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
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const customerAccountsService = require('../services/customerAccountsService');

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
    preferredLanguage: c.preferred_language,
    notes: c.notes,
    isActive: c.is_active,
    // Per-customer feature flags (#354 follow-up). Coerce to bool so the
    // frontend doesn't have to deal with SQLite's 0/1 values.
    featureCalendar: c.feature_calendar === true || c.feature_calendar === 1,
    featureQuotes:   c.feature_quotes   === true || c.feature_quotes   === 1,
    featureBills:    c.feature_bills    === true || c.feature_bills    === 1,
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
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
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
  body('prefill.country_code').optional({ nullable: true }).isString().isLength({ max: 2 }),
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
  if (process.env.NODE_ENV !== 'production') {
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
  requirePermission('customers.create'),
  param('id').isInt({ min: 1 }),
  body('email').optional().isEmail().normalizeEmail(),
  body('salutation').optional().isString().isLength({ max: 32 }),
  body('first_name').optional().isString().isLength({ max: 80 }),
  body('last_name').optional().isString().isLength({ max: 80 }),
  body('display_name').optional().isString().isLength({ max: 120 }),
  body('phone').optional().isString().isLength({ max: 40 }),
  body('company_name').optional().isString().isLength({ max: 120 }),
  body('billing_email').optional({ nullable: true }).isString(),
  body('vat_id').optional({ nullable: true }).isString().isLength({ max: 40 }),
  body('address_line1').optional({ nullable: true }).isString().isLength({ max: 255 }),
  body('address_line2').optional({ nullable: true }).isString().isLength({ max: 255 }),
  body('postal_code').optional({ nullable: true }).isString().isLength({ max: 20 }),
  body('city').optional({ nullable: true }).isString().isLength({ max: 120 }),
  body('state').optional({ nullable: true }).isString().isLength({ max: 120 }),
  body('country_code').optional({ nullable: true }).isString().isLength({ max: 2 }),
  body('preferred_language').optional().isString().isLength({ max: 8 }),
  body('notes').optional({ nullable: true }).isString(),
  body('is_active').optional().isBoolean(),
  body('feature_calendar').optional().isBoolean(),
  body('feature_quotes').optional().isBoolean(),
  body('feature_bills').optional().isBoolean(),
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
  requirePermission('customers.create'),
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

module.exports = router;
