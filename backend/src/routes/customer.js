/**
 * Customer dashboard routes
 *
 * Mounted at /api/customer (see server.js). Every endpoint here requires
 * a valid 'customer' JWT — see middleware/customerAuth.js.
 *
 * Endpoints:
 *   GET  /events                       list assigned events for dashboard
 *   GET  /events/:slug/access-token    mint a gallery JWT so the customer
 *                                      can browse the event without going
 *                                      through the per-event password gate
 */

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, param, validationResult } = require('express-validator');
const { db, logActivity } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const { getBcryptRounds } = require('../utils/passwordValidation');
const logger = require('../utils/logger');
const { errorResponse } = require('../utils/routeHelpers');
const { getClientIp } = require('../utils/requestIp');
const { customerAuth } = require('../middleware/customerAuth');
const { setGalleryAuthCookies } = require('../utils/tokenUtils');
const customerAccountsService = require('../services/customerAccountsService');

// Gate a customer-facing route on BOTH the global master flag AND the
// per-customer override — getEffectiveFeaturesForCustomer combines them, so an
// admin disabling e.g. Bills globally is honoured even when feature_bills=true
// on the row. Sends the 403 and returns false on denial; true if allowed.
async function customerFeatureAllowed(req, res, featureKey, label) {
  const eff = await customerAccountsService.getEffectiveFeaturesForCustomer(req.customer.id);
  if (!eff || !eff[featureKey]) {
    res.status(403).json({ error: `${label} are disabled for this account`, code: 'CUSTOMER_FEATURE_DISABLED' });
    return false;
  }
  return true;
}

/**
 * Customer-side password policy mirrors the one in customerAuth.js — kept
 * deliberately simple (8 chars, one uppercase, one digit) since a customer
 * account only sees galleries, never financial or admin surfaces.
 */
function validateCustomerPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    return 'Password must be at least 8 characters long.';
  }
  if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter.';
  if (!/[0-9]/.test(password)) return 'Password must contain at least one number.';
  return null;
}

/**
 * Camel→snake mapping used by the self-service profile PUT. Same field set
 * as the admin update endpoint minus is_active (admin-only) and
 * preferred_language / notes (admin-only metadata, not customer-facing).
 */
const PROFILE_FIELD_MAP = {
  salutation: 'salutation',
  firstName: 'first_name',
  lastName: 'last_name',
  displayName: 'display_name',
  phone: 'phone',
  companyName: 'company_name',
  vatId: 'vat_id',
  addressLine1: 'address_line1',
  addressLine2: 'address_line2',
  postalCode: 'postal_code',
  city: 'city',
  state: 'state',
  countryCode: 'country_code',
  preferredLanguage: 'preferred_language',
};

function shapeProfile(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    salutation: row.salutation,
    firstName: row.first_name,
    lastName: row.last_name,
    displayName: row.display_name,
    phone: row.phone,
    companyName: row.company_name,
    vatId: row.vat_id,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    postalCode: row.postal_code,
    city: row.city,
    state: row.state,
    countryCode: row.country_code,
    preferredLanguage: row.preferred_language || 'en',
  };
}

const router = express.Router();

const GALLERY_TOKEN_TTL_SECONDS = 24 * 60 * 60;

// ---- list assigned events ---------------------------------------------

router.get('/events', customerAuth, async (req, res) => {
  try {
    const events = await customerAccountsService.listEventsForCustomer(req.customer.id);
    res.json({
      events: events.map((e) => ({
        id: e.id,
        slug: e.slug,
        eventName: e.event_name,
        eventType: e.event_type,
        eventDate: e.event_date,
        expiresAt: e.expires_at,
        isActive: e.is_active,
        assignedAt: e.assigned_at,
      })),
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to load events');
  }
});

// ---- access-token exchange --------------------------------------------

/**
 * Customer JWT → Gallery JWT exchange.
 *
 * The gallery API and frontend already expect a 'gallery' token in the
 * gallery_token / gallery_token_{slug} cookie. Rather than teach every
 * gallery code path about a third token type, we mint a fresh gallery
 * token here when the customer is assigned to the event. The frontend
 * stores it in the slug-specific cookie via the existing
 * storeGalleryToken() utility, and from that point on the gallery loads
 * exactly as if the per-event password had been entered.
 *
 * Returns 403 if the customer is not assigned, 404 if the event slug is
 * unknown, 410 if the event is archived/expired (so the dashboard can
 * surface a useful "this gallery has expired" message rather than just
 * an opaque 403).
 */
router.get('/events/:slug/access-token', [
  customerAuth,
  param('slug').isString().notEmpty(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { slug } = req.params;
    const event = await db('events').where('slug', slug).first();
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    if (event.is_archived) {
      return res.status(410).json({ error: 'This gallery has been archived' });
    }
    if (event.expires_at && new Date(event.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This gallery has expired' });
    }

    const hasAccess = await customerAccountsService.customerHasAccessToEvent(
      req.customer.id,
      event.id
    );
    if (!hasAccess) {
      logger.warn('Customer attempted to access unassigned event', {
        customerId: req.customer.id,
        eventId: event.id,
        slug,
      });
      return res.status(403).json({ error: 'You do not have access to this gallery' });
    }

    const ipAddress = getClientIp(req);
    // Same shape as /api/auth/gallery/verify — keep them in sync so the
    // gallery middleware (verifyGalleryAccess) doesn't need a code change.
    const token = jwt.sign({
      eventId: event.id,
      eventSlug: event.slug,
      type: 'gallery',
      ip: ipAddress,
      loginTime: Date.now(),
      // Optional bookkeeping claim — surfaces the originating customer in
      // logs when the token is later used. Doesn't affect authorization.
      via: 'customer',
      customerId: req.customer.id,
    }, process.env.JWT_SECRET, {
      expiresIn: GALLERY_TOKEN_TTL_SECONDS,
      issuer: 'picpeak-auth',
    });

    // Mirror the cookie-write that /api/auth/gallery/verify performs on
    // password success. Without this, the freshly-minted token only lives
    // in the dashboard's sessionStorage; GalleryAuthProvider runs
    // cleanupOldGalleryAuth() on mount and sweeps every gallery_token_*
    // sessionStorage key, including the one we just stored. The cookie
    // (which that cleanup helper does NOT touch when it's slug-scoped)
    // is what keeps the customer authenticated after navigation, hard
    // reloads, and tab restores.
    setGalleryAuthCookies(res, token, event.slug);

    await db('access_logs').insert({
      event_id: event.id,
      ip_address: ipAddress,
      user_agent: req.headers['user-agent'] || '',
      action: 'login_success',
    });

    await logActivity('customer_event_access',
      { customerId: req.customer.id, eventId: event.id, slug },
      event.id,
      { type: 'customer', id: req.customer.id, name: req.customer.email }
    );

    res.json({
      token,
      event: {
        id: event.id,
        slug: event.slug,
        eventName: event.event_name,
      },
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to issue access token');
  }
});

// ---- self-service profile ----------------------------------------------

/**
 * GET /profile
 *
 * Returns the full customer profile (everything the customer can edit on
 * their own profile page). The /auth/session endpoint deliberately stays
 * narrow — only the fields the layout needs — to keep the auth payload
 * tight; this endpoint is the canonical "give me everything" read.
 */
router.get('/profile', customerAuth, async (req, res) => {
  try {
    const row = await db('customer_accounts').where('id', req.customer.id).first();
    if (!row) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    res.json({ profile: shapeProfile(row) });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to load profile');
  }
});

/**
 * PUT /profile
 *
 * Self-service edit. Accepts the same field set as the admin endpoint but
 * deliberately excludes:
 *   - email          (would invalidate the login credential silently)
 *   - is_active      (admin-only)
 *   - notes          (admin-only metadata)
 *   - billing_email  (kept admin-managed for now; we'll surface it later
 *                     when the quotes/bills flows actually need a separate
 *                     billing contact)
 *   - password_hash  (separate /profile/password endpoint)
 */
router.put('/profile', [
  customerAuth,
  body('salutation').optional({ nullable: true }).isString().isLength({ max: 32 }),
  body('firstName').optional({ nullable: true }).isString().isLength({ max: 80 }),
  body('lastName').optional({ nullable: true }).isString().isLength({ max: 80 }),
  body('displayName').optional({ nullable: true }).isString().isLength({ max: 120 }),
  body('phone').optional({ nullable: true }).isString().isLength({ max: 40 }),
  body('companyName').optional({ nullable: true }).isString().isLength({ max: 120 }),
  body('vatId').optional({ nullable: true }).isString().isLength({ max: 40 }),
  body('addressLine1').optional({ nullable: true }).isString().isLength({ max: 255 }),
  body('addressLine2').optional({ nullable: true }).isString().isLength({ max: 255 }),
  body('postalCode').optional({ nullable: true }).isString().isLength({ max: 20 }),
  body('city').optional({ nullable: true }).isString().isLength({ max: 120 }),
  body('state').optional({ nullable: true }).isString().isLength({ max: 120 }),
  body('countryCode').optional({ nullable: true }).isString().isLength({ max: 2 }),
  body('preferredLanguage').optional().isString().isLength({ max: 8 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    // Normalise incoming values: trim strings, drop empty → null so the DB
    // doesn't end up with `' '` rows that look populated but render blank.
    const updates = {};
    for (const [camel, snake] of Object.entries(PROFILE_FIELD_MAP)) {
      if (!Object.prototype.hasOwnProperty.call(req.body, camel)) continue;
      let value = req.body[camel];
      if (typeof value === 'string') value = value.trim();
      if (value === '') value = null;
      if (snake === 'country_code' && value) {
        value = String(value).toUpperCase().slice(0, 2);
      }
      updates[snake] = value;
    }
    updates.updated_at = new Date();

    await db('customer_accounts').where('id', req.customer.id).update(updates);

    const row = await db('customer_accounts').where('id', req.customer.id).first();

    await logActivity('customer_self_profile_update',
      { customerId: req.customer.id, fields: Object.keys(updates).filter((k) => k !== 'updated_at') },
      null,
      { type: 'customer', id: req.customer.id, name: req.customer.email }
    );

    res.json({ profile: shapeProfile(row) });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to update profile');
  }
});

/**
 * POST /profile/password
 *
 * Customer changes their own password. Requires the current password as
 * proof of identity (so a stolen session cookie can't pivot to a permanent
 * takeover without also having the old password). Bumps
 * password_changed_at so any other active sessions for this customer get
 * invalidated on next request via the customerAuth middleware check.
 */
router.post('/profile/password', [
  customerAuth,
  body('currentPassword').isString().isLength({ min: 1 }),
  body('newPassword').isString().isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { currentPassword, newPassword } = req.body;

    const policyError = validateCustomerPassword(newPassword);
    if (policyError) {
      return res.status(400).json({
        error: 'Password does not meet complexity requirements',
        details: [policyError],
      });
    }

    const row = await db('customer_accounts').where('id', req.customer.id).first();
    if (!row || !row.password_hash) {
      return res.status(400).json({ error: 'Password change unavailable' });
    }
    const ok = await bcrypt.compare(currentPassword, row.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const newHash = await bcrypt.hash(newPassword, getBcryptRounds());
    await db('customer_accounts').where('id', req.customer.id).update({
      password_hash: newHash,
      password_changed_at: new Date(),
      updated_at: new Date(),
    });

    await logActivity('customer_password_change',
      { customerId: req.customer.id },
      null,
      { type: 'customer', id: req.customer.id, name: req.customer.email }
    );

    res.json({ message: 'Password updated' });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to change password');
  }
});

// ---- quotes (customer-facing read-only) ------------------------------
// Lists quotes belonging to the logged-in customer. Scoped strictly to
// the customer's own customer_account_id so a stale or stolen token can
// never see another customer's quotes. Returns the same shape the admin
// list does, minus fields that are admin-only (internal_notes, pdf_path,
// created_by_admin_id). Disabled when the customer has `feature_quotes`
// off OR the global `quotes` flag is off — the frontend's RequireFeature
// already hides the sidebar entry, but we belt-and-braces it here so a
// direct API hit gets a 403 instead of leaking rows.
router.get('/quotes', customerAuth, async (req, res) => {
  try {
    const { db: dbi } = require('../database/db');
    // Customer-feature gate — master flag AND per-customer override.
    if (!(await customerFeatureAllowed(req, res, 'quotes', 'Quotes'))) return;
    const rows = await dbi('quotes')
      .where({ customer_account_id: req.customer.id })
      // Hide drafts — they're admin scratch work; nothing has been
      // sent to the customer yet. Mirrors the invoice list above
      // which suppresses 'scheduled' + 'cancelled' for the same
      // reason. Customers should only see quotes the admin has
      // actually issued (sent / accepted / declined / expired /
      // converted).
      .whereNotIn('status', ['draft'])
      .orderBy('issue_date', 'desc')
      .orderBy('id', 'desc')
      .select(
        'id', 'quote_number', 'status', 'currency',
        'issue_date', 'valid_until', 'event_name', 'event_date',
        'net_amount_minor', 'vat_rate', 'vat_amount_minor',
        'shipping_amount_minor', 'total_amount_minor',
        'intro_text', 'outro_text',
        'sent_at', 'responded_at', 'response_locked_at',
        'accepted_at', 'declined_at',
      );

    // Look up the active accept/decline token for each non-locked
    // quote so the customer dashboard can deep-link back into the
    // public response page when the admin already sent it. We avoid
    // re-issuing tokens here — the dashboard is for review, not
    // re-sending.
    const tokensByQuote = new Map();
    if (rows.length > 0) {
      const tokens = await dbi('quote_action_tokens')
        .whereIn('quote_id', rows.map((r) => r.id))
        .whereNull('used_at')
        .where('expires_at', '>', new Date())
        .select('quote_id', 'token');
      for (const t of tokens) tokensByQuote.set(t.quote_id, t.token);
    }

    res.json({
      quotes: rows.map((q) => ({
        id: q.id,
        quoteNumber: q.quote_number,
        status: q.status,
        currency: q.currency,
        issueDate: q.issue_date,
        validUntil: q.valid_until,
        eventName: q.event_name,
        eventDate: q.event_date,
        netAmountMinor: q.net_amount_minor,
        vatRate: q.vat_rate == null ? null : Number(q.vat_rate),
        vatAmountMinor: q.vat_amount_minor,
        shippingAmountMinor: q.shipping_amount_minor,
        totalAmountMinor: q.total_amount_minor,
        introText: q.intro_text,
        outroText: q.outro_text,
        sentAt: q.sent_at,
        respondedAt: q.responded_at,
        responseLockedAt: q.response_locked_at,
        acceptedAt: q.accepted_at,
        declinedAt: q.declined_at,
        responseToken: tokensByQuote.get(q.id) || null,
      })),
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to load quotes');
  }
});

// ---- invoices (customer-facing read-only + PDF) ----------------------
// Mirrors /quotes — list owned by the customer with the same feature
// gate. Adds a PDF download endpoint so customers can grab the rendered
// invoice from their dashboard.
router.get('/invoices', customerAuth, async (req, res) => {
  try {
    const { db: dbi } = require('../database/db');
    // Customer-feature gate — master flag AND per-customer override.
    if (!(await customerFeatureAllowed(req, res, 'bills', 'Invoices'))) return;
    // Visibility rules for the customer-facing list:
    //   - Hide `scheduled` always (drafts the admin is still tweaking).
    //   - Show `sent`, `overdue`, `paid` always (the customer's
    //     outstanding + paid history).
    //   - Show `cancelled` ONLY when `cancellation_storno_id IS NOT NULL`,
    //     i.e. the cancellation was made customer-visible via a
    //     Stornorechnung (migration 114). Soft-cancelled drafts stay
    //     hidden — the customer never saw the draft, so a "cancelled"
    //     phantom in their list would just be confusing.
    //   - Show `kind='storno'` rows (status='sent' after sendStorno)
    //     unconditionally — they're the customer's legal proof of
    //     cancellation and the only document with the §14c reversal.
    const rows = await dbi('invoices')
      .leftJoin('invoices as cancels_inv', 'invoices.cancels_invoice_id', 'cancels_inv.id')
      .leftJoin('invoices as cancellation_storno', 'invoices.cancellation_storno_id', 'cancellation_storno.id')
      .where({ 'invoices.customer_account_id': req.customer.id })
      .whereNot('invoices.status', 'scheduled')
      .whereNot('invoices.status', 'skipped')
      .andWhere(function () {
        this.whereNot('invoices.status', 'cancelled').orWhereNotNull('invoices.cancellation_storno_id');
      })
      .orderBy('invoices.issue_date', 'desc')
      .orderBy('invoices.id', 'desc')
      .select(
        'invoices.id', 'invoices.kind', 'invoices.invoice_number', 'invoices.status', 'invoices.currency',
        'invoices.issue_date', 'invoices.due_date',
        // Inline event snapshot (migration 123) — the customer portal
        // shows event_name next to the invoice number, mirroring the
        // quotes list.
        'invoices.event_name', 'invoices.event_date',
        'invoices.installment_index', 'invoices.installment_total', 'invoices.installment_label',
        'invoices.net_amount_minor', 'invoices.vat_rate', 'invoices.vat_amount_minor',
        'invoices.shipping_amount_minor', 'invoices.total_amount_minor',
        'invoices.paid_amount_minor', 'invoices.paid_at',
        'invoices.late_fee_amount_minor', 'invoices.reminder_level', 'invoices.sent_at',
        // Lineage — drives the Storno banner / cancelled-by-Storno
        // indicator on the customer's bills page. Self-join the
        // linked rows so we can surface the human invoice_number,
        // not just the bare DB row id.
        'invoices.cancels_invoice_id', 'invoices.cancellation_storno_id',
        'cancels_inv.invoice_number as cancels_invoice_number',
        'cancellation_storno.invoice_number as cancellation_storno_number',
      );
    res.json({
      invoices: rows.map((i) => ({
        id: i.id,
        kind: i.kind || 'invoice',
        invoiceNumber: i.invoice_number,
        status: i.status,
        currency: i.currency,
        issueDate: i.issue_date,
        dueDate: i.due_date,
        installmentIndex: i.installment_index,
        installmentTotal: i.installment_total,
        installmentLabel: i.installment_label,
        netAmountMinor: i.net_amount_minor,
        vatRate: i.vat_rate == null ? null : Number(i.vat_rate),
        vatAmountMinor: i.vat_amount_minor,
        shippingAmountMinor: i.shipping_amount_minor,
        totalAmountMinor: i.total_amount_minor,
        paidAmountMinor: i.paid_amount_minor,
        paidAt: i.paid_at,
        lateFeeAmountMinor: i.late_fee_amount_minor,
        reminderLevel: i.reminder_level,
        sentAt: i.sent_at,
        cancelsInvoiceId: i.cancels_invoice_id || null,
        cancelsInvoiceNumber: i.cancels_invoice_number || null,
        cancellationStornoId: i.cancellation_storno_id || null,
        cancellationStornoNumber: i.cancellation_storno_number || null,
        eventName: i.event_name || null,
        eventDate: i.event_date || null,
      })),
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to load invoices');
  }
});

/**
 * Customer-side quote PDF — mirrors the invoice PDF endpoint above.
 * The customer can re-download any quote that's been sent to them
 * (the public response page also uses this view). Draft quotes are
 * hidden — they're not yet meant for the customer.
 */
router.get('/quotes/:id/pdf', customerAuth, async (req, res) => {
  try {
    const { db: dbi } = require('../database/db');
    // Feature-gate — master flag AND per-customer override.
    if (!(await customerFeatureAllowed(req, res, 'quotes', 'Quotes'))) return;
    const quote = await dbi('quotes')
      .where({ id: parseInt(req.params.id, 10), customer_account_id: req.customer.id })
      .first();
    if (!quote) return res.status(404).json({ error: 'Quote not found' });
    if (quote.status === 'draft') {
      // Drafts aren't visible to the customer.
      return res.status(404).json({ error: 'Quote not found' });
    }
    const quoteService = require('../services/quoteService');
    const buf = await quoteService.renderQuotePdfBuffer(quote.id);
    const { buildPdfFilename } = require('../utils/pdfFilename');
    const customer = await dbi('customer_accounts').where({ id: req.customer.id }).first();
    const filename = buildPdfFilename({
      docNumber: quote.quote_number,
      customer,
      fallback: `quote-${quote.id}`,
    });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="${filename}"`);
    res.send(buf);
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to render quote PDF');
  }
});

router.get('/invoices/:id/pdf', customerAuth, async (req, res) => {
  try {
    const { db: dbi } = require('../database/db');
    // Feature-gate — master flag AND per-customer override.
    if (!(await customerFeatureAllowed(req, res, 'bills', 'Invoices'))) return;
    const invoice = await dbi('invoices')
      .where({ id: parseInt(req.params.id, 10), customer_account_id: req.customer.id })
      .first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (['scheduled', 'cancelled', 'skipped'].includes(invoice.status)) {
      // Don't expose scheduled drafts, cancelled docs, or
      // skipped empty-monthly placeholders.
      return res.status(404).json({ error: 'Invoice not found' });
    }
    const invoiceService = require('../services/invoiceService');
    const buf = await invoiceService.renderInvoicePdfBuffer(invoice.id);
    const { buildPdfFilename } = require('../utils/pdfFilename');
    const customer = await dbi('customer_accounts').where({ id: req.customer.id }).first();
    const filename = buildPdfFilename({
      docNumber: invoice.invoice_number,
      customer,
      fallback: `invoice-${invoice.id}`,
    });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="${filename}"`);
    res.send(buf);
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to render invoice PDF');
  }
});

// ---- contracts (customer-facing read-only + PDF + signed-PDF) -------
// Same shape as /quotes and /invoices. Drafts are hidden; everything
// from `sent` onwards is visible. Two PDF download endpoints because
// the signed PDF (stamped with signatures OR a wet-signed upload) is
// the authoritative copy customers want after both parties sign.
router.get('/contracts', customerAuth, async (req, res) => {
  try {
    const { db: dbi } = require('../database/db');
    if (!(await dbi.schema.hasTable('contracts'))) {
      // Feature not migrated on this install yet.
      return res.json({ contracts: [] });
    }
    // Contracts gate — master flag AND per-customer override (migration 131).
    if (!(await customerFeatureAllowed(req, res, 'contracts', 'Contracts'))) return;
    const rows = await dbi('contracts')
      .where({ customer_account_id: req.customer.id })
      .whereNotIn('status', ['draft'])
      .orderBy('issue_date', 'desc')
      .orderBy('id', 'desc')
      .select(
        'id', 'contract_number', 'status', 'language',
        'issue_date', 'valid_until', 'title',
        'sent_at', 'signed_by_customer_at', 'signed_by_admin_at',
        'signed_customer_name', 'signed_admin_name',
        'pdf_path', 'signed_pdf_path',
      );

    // Live tokens for the public sign page so customer dashboard can
    // deep-link the "Sign now" button on `sent` contracts.
    const tokensByContract = new Map();
    if (rows.length > 0 && await dbi.schema.hasTable('contract_action_tokens')) {
      const tokens = await dbi('contract_action_tokens')
        .whereIn('contract_id', rows.map((r) => r.id))
        .whereNull('used_at')
        .where('expires_at', '>', new Date())
        .select('contract_id', 'token');
      for (const tk of tokens) tokensByContract.set(tk.contract_id, tk.token);
    }

    res.json({
      contracts: rows.map((c) => ({
        id: c.id,
        contractNumber: c.contract_number,
        status: c.status,
        language: c.language,
        issueDate: c.issue_date,
        validUntil: c.valid_until,
        title: c.title,
        sentAt: c.sent_at,
        signedByCustomerAt: c.signed_by_customer_at,
        signedByAdminAt: c.signed_by_admin_at,
        signedCustomerName: c.signed_customer_name,
        signedAdminName: c.signed_admin_name,
        // Surface flags only — no paths leaked to the customer.
        hasPdf: !!c.pdf_path,
        hasSignedPdf: !!c.signed_pdf_path,
        responseToken: tokensByContract.get(c.id) || null,
      })),
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to load contracts');
  }
});

router.get('/contracts/:id/pdf', customerAuth, async (req, res) => {
  try {
    const { db: dbi } = require('../database/db');
    if (!(await dbi.schema.hasTable('contracts'))) {
      return res.status(404).json({ error: 'Contract not found' });
    }
    // Contracts gate — master flag AND per-customer override.
    if (!(await customerFeatureAllowed(req, res, 'contracts', 'Contracts'))) return;
    const contract = await dbi('contracts')
      .where({ id: parseInt(req.params.id, 10), customer_account_id: req.customer.id })
      .first();
    if (!contract) return res.status(404).json({ error: 'Contract not found' });
    if (contract.status === 'draft') {
      return res.status(404).json({ error: 'Contract not found' });
    }
    // Prefer the wet-signed PDF when present, otherwise the system-
    // generated PDF (signed in-browser, stamped, or unsigned).
    const path = require('path');
    const fs = require('fs');
    const filePath = contract.signed_pdf_path || contract.pdf_path;
    if (!filePath || !fs.existsSync(filePath)) {
      // Render on-demand so customers who hit the link before the
      // first send still get something usable.
      const contractService = require('../services/contractService');
      const buf = await contractService.renderContractPdfBuffer(contract.id);
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `inline; filename="${contract.contract_number}.pdf"`);
      return res.send(buf);
    }
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="${path.basename(filePath)}"`);
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to render contract PDF');
  }
});

module.exports = router;
