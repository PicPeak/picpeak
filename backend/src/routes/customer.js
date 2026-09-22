const { isGalleryAvailable, isGalleryExpired } = require('../utils/galleryLifecycle');
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
const crypto = require('crypto');
const { body, param, validationResult } = require('express-validator');
const { db, logActivity } = require('../database/db');
const { getBcryptRounds, MAX_PASSWORD_LENGTH } = require('../utils/passwordValidation');
const { assertContractPdfPath } = require('../utils/safePath');
const { buildContentDisposition } = require('../utils/filenameSanitizer');
const logger = require('../utils/logger');
const { errorResponse, safeValidationErrors } = require('../utils/routeHelpers');
const { getClientIp } = require('../utils/requestIp');
const { customerAuth } = require('../middleware/customerAuth');
const { setGalleryAuthCookies } = require('../utils/tokenUtils');
const rateLimit = require('express-rate-limit');
const { receivePdfUpload, discardTempFile, sendPdfAttachment } = require('../middleware/customerDocumentUpload');
const customerAccountsService = require('../services/customerAccountsService');
const customerDocumentsService = require('../services/customerDocumentsService');
const customerDocumentNotifications = require('../services/customerDocumentNotifications');
const customerDocumentAbuse = require('../services/customerDocumentAbuse');
const customerDocumentRequestsService = require('../services/customerDocumentRequestsService');
const customerPortalService = require('../services/customerPortalService');
const publicDocumentViews = require('../services/publicDocumentViews');
const { clientIpForAudit } = require('../utils/clientIp');
const contractSignedPdfUpload = require('../utils/contractSignedPdfUpload');
const { auditedUpdate } = require('../services/accountingHistory');

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
    // Newsletter consent (migration 199, #1264). Read-only here — it is
    // changed through /profile/marketing, which logs the consent change
    // with its own activity entry rather than burying it in a generic
    // profile update.
    marketingOptOut: row.marketing_opt_out === true
      || row.marketing_opt_out === 1
      || row.marketing_opt_out === '1',
  };
}

const router = express.Router();

const GALLERY_TOKEN_TTL_SECONDS = 24 * 60 * 60;

// ---- list assigned events ---------------------------------------------

router.get('/events', customerAuth, async (req, res) => {
  try {
    const events = await customerAccountsService.listEventsForCustomer(req.customer.id);
    // shapeEvent adds `availability` (active | expired | unavailable), decided
    // server-side so the portal never works out expiry from the browser clock.
    res.json({ events: events.map(customerPortalService.shapeEvent) });
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
      return res.status(400).json({ errors: safeValidationErrors(errors) });
    }

    const { slug } = req.params;
    const event = await db('events').where('slug', slug).first();
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    if (event.is_archived) {
      return res.status(410).json({ error: 'This gallery has been archived' });
    }
    if (isGalleryExpired(event)) {
      return res.status(410).json({ error: 'This gallery has expired' });
    }

    if (!isGalleryAvailable(event)) return res.status(404).json({ error: 'Event not found' });

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
    // customerAuth already verified this token; its iat (and jti, if any) is
    // the portal session's revocation key, so logging out ends this token too.
    const portalSession = jwt.decode(req.token) || {};
    // Never outlive the portal session: its revocation row is cleaned up at
    // its own exp, after which a longer-lived gallery token would work again.
    const portalSecondsLeft = Number.isFinite(portalSession.exp)
      ? portalSession.exp - Math.floor(Date.now() / 1000) : GALLERY_TOKEN_TTL_SECONDS;
    const galleryTtlSeconds = Math.max(1, Math.min(GALLERY_TOKEN_TTL_SECONDS, portalSecondsLeft));
    // Same shape as /api/auth/gallery/verify — keep them in sync so the
    // gallery middleware (verifyGalleryAccess) doesn't need a code change.
    const token = jwt.sign({
      parentIat: portalSession.iat,
      ...(portalSession.jti && { parentJti: portalSession.jti }),
      eventId: event.id,
      eventSlug: event.slug,
      type: 'gallery',
      // Unique per token: the revocation key falls back to eventId+iat otherwise,
      // so one guest's logout would revoke every same-second login (#1357).
      jti: crypto.randomUUID(),
      ip: ipAddress,
      loginTime: Date.now(),
      // Rechecked on each gallery/media request, including account status.
      via: 'customer',
      customerId: req.customer.id,
    }, process.env.JWT_SECRET, {
      expiresIn: galleryTtlSeconds,
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
      return res.status(400).json({ errors: safeValidationErrors(errors) });
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

    await auditedUpdate(db, 'customer_accounts', { id: req.customer.id }, updates, {
      actor: { type: 'customer', id: req.customer.id, name: req.customer.displayName || null },
      source: 'customer.portal.profile',
    });

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
 * GET /profile/marketing
 *
 * Newsletter consent, on its own endpoint (migration 199, #1264).
 *
 * Not folded into PUT /profile because a consent change is an auditable
 * event: it needs its own `customer_marketing_opt_out` activity entry with
 * the source recorded, and burying it in a 14-field profile update would
 * lose that. Transactional mail is unaffected either way, which the response
 * says explicitly so the UI never has to guess.
 */
router.get('/profile/marketing', customerAuth, async (req, res) => {
  try {
    const row = await db('customer_accounts')
      .where('id', req.customer.id)
      .select('marketing_opt_out', 'marketing_opt_out_at')
      .first();
    if (!row) return res.status(404).json({ error: 'Profile not found' });
    res.json({
      marketingOptOut: row.marketing_opt_out === true
        || row.marketing_opt_out === 1
        || row.marketing_opt_out === '1',
      marketingOptOutAt: row.marketing_opt_out_at || null,
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to load marketing preferences');
  }
});

/**
 * PUT /profile/marketing  { optOut: boolean }
 */
router.put('/profile/marketing', [
  customerAuth,
  body('optOut').isBoolean(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: safeValidationErrors(errors) });
    }
    const newsletterService = require('../services/newsletterService');
    await newsletterService.setMarketingOptOut(
      req.customer.id,
      Boolean(req.body.optOut),
      'portal',
      { type: 'customer', id: req.customer.id, name: req.customer.email }
    );
    res.json({ marketingOptOut: Boolean(req.body.optOut) });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to update marketing preferences');
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
  body('currentPassword').isString().isLength({ min: 1, max: MAX_PASSWORD_LENGTH }),
  body('newPassword').isString().isLength({ min: 8, max: MAX_PASSWORD_LENGTH })
    .withMessage('Password must be at least 8 characters'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: safeValidationErrors(errors) });
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
    // Not a billing field, so this leaves no history entry.
    await auditedUpdate(db, 'customer_accounts', { id: req.customer.id }, {
      password_hash: newHash,
      password_changed_at: new Date(),
      updated_at: new Date(),
    }, { actor: { type: 'customer', id: req.customer.id }, source: 'customer.portal.password' });

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
        // What intro / outro {{placeholders}} read (#1451); not returned.
        'language', 'hours', 'days',
        'sent_at', 'responded_at', 'response_locked_at',
        'accepted_at', 'declined_at',
      );

    // Intro / outro keep their {{placeholders}}; resolve them for display
    // (texts without any return as they are, without a lookup).
    const { resolveQuoteTexts } = require('../services/quoteTemplateService');
    const textsByQuote = new Map();
    for (const q of rows) {
      textsByQuote.set(q.id, await resolveQuoteTexts({ ...q, customer_account_id: req.customer.id }));
    }

    // Whether each quote can still be answered. The list used to carry the
    // live accept/decline token so the dashboard could link to the public
    // page, which put a bearer secret — usable with no login and no emailed
    // code — into every portal response. The portal now answers through
    // POST /quotes/:id/respond with the customer's session instead.
    const usableTokens = await publicDocumentViews.usableQuoteTokens(rows.map((r) => r.id));

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
        introText: textsByQuote.get(q.id).introText,
        outroText: textsByQuote.get(q.id).outroText,
        sentAt: q.sent_at,
        respondedAt: q.responded_at,
        responseLockedAt: q.response_locked_at,
        acceptedAt: q.accepted_at,
        declinedAt: q.declined_at,
        canRespond: publicDocumentViews.quoteAcceptsResponse(q) && usableTokens.has(q.id),
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
    // The file the customer was sent, not a re-render from today's data.
    const buf = await quoteService.getQuotePdfBuffer(quote.id);
    const { buildPdfFilename } = require('../utils/pdfFilename');
    const { buildContentDisposition } = require('../utils/filenameSanitizer');
    const customer = await dbi('customer_accounts').where({ id: req.customer.id }).first();
    const filename = buildPdfFilename({
      docNumber: quote.quote_number,
      customer,
      fallback: `quote-${quote.id}`,
    });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', buildContentDisposition(filename, 'inline'));
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
    // The file the customer was sent, not a re-render from today's data.
    const buf = await invoiceService.getInvoicePdfBuffer(invoice.id);
    const { buildPdfFilename } = require('../utils/pdfFilename');
    const { buildContentDisposition } = require('../utils/filenameSanitizer');
    const customer = await dbi('customer_accounts').where({ id: req.customer.id }).first();
    const filename = buildPdfFilename({
      docNumber: invoice.invoice_number,
      customer,
      fallback: `invoice-${invoice.id}`,
    });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', buildContentDisposition(filename, 'inline'));
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
        'pdf_path', 'signed_pdf_path', 'signing_version',
      );

    // Whether each contract can still be signed. The list used to carry the
    // live signing token for the dashboard's "Sign now" link; the portal
    // now signs through POST /contracts/:id/sign with the session, so the
    // token never leaves the server.
    const liveTokens = await publicDocumentViews.liveContractTokens(rows.map((r) => r.id));

    // Which of them have a signing certificate to download (#1446). One
    // grouped read rather than a probe per row, and the button is only
    // offered for a contract that actually has one.
    const certified = new Set();
    if (rows.length && await dbi.schema.hasTable('generated_documents')) {
      const certificates = await dbi('generated_documents')
        .where({ doc_type: 'contract', kind: 'audit' })
        .whereIn('doc_id', rows.map((r) => r.id))
        .distinct('doc_id');
      for (const row of certificates) certified.add(Number(row.doc_id));
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
        hasCertificate: certified.has(Number(c.id)),
        // A signatures-v2 contract signs through a signer session, so it has
        // no action token to look for; one sent before still needs a live one.
        canSign: c.status === 'sent' && (Number(c.signing_version) === 2 || liveTokens.has(c.id)),
      })),
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to load contracts');
  }
});

// Signing from the portal (#1446): a signing session for the signer with
// this customer's email — no code needed, they are signed in — or a
// one-hour link for a contract sent before signatures v2. The list above
// hands out nothing that opens a contract.
router.post('/contracts/:id/signing-access', customerAuth, async (req, res) => {
  try {
    if (!(await customerFeatureAllowed(req, res, 'contracts', 'Contracts'))) return;
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid contract id' });
    const { db: dbi } = require('../database/db');
    const customer = await dbi('customer_accounts').where({ id: req.customer.id }).first();
    if (!customer) return res.status(404).json({ error: 'Contract not found' });
    const result = await require('../services/contract/signingV2').portalSigningAccess(customer, id);
    return res.json(result);
  } catch (error) {
    const status = error.statusCode || error.status;
    if (status) return res.status(status).json({ error: error.message, code: error.code });
    return errorResponse(res, error, 500, 'Failed to open the contract for signing');
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
    // Same containment the admin and public contract routes apply: the DB
    // path is written by the service layer today, but a bad row must not
    // turn this into an arbitrary-file read.
    const safePath = assertContractPdfPath(filePath);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="${path.basename(safePath)}"`);
    fs.createReadStream(safePath).pipe(res);
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to render contract PDF');
  }
});

// The signing certificate (#1446): the evidence record issued when the
// contract was completed. Scoped exactly like the PDF route above — the
// customer's own contract, never a draft.
router.get('/contracts/:id/certificate', customerAuth, async (req, res) => {
  try {
    const { db: dbi } = require('../database/db');
    if (!(await dbi.schema.hasTable('contracts'))) {
      return res.status(404).json({ error: 'Contract not found' });
    }
    if (!(await customerFeatureAllowed(req, res, 'contracts', 'Contracts'))) return;
    const contract = await dbi('contracts')
      .where({ id: parseInt(req.params.id, 10), customer_account_id: req.customer.id })
      .first();
    if (!contract || contract.status === 'draft') return res.status(404).json({ error: 'Contract not found' });
    const { readCertificate } = require('../services/contract/signatureAssets');
    const { fileName, buffer } = await readCertificate(contract.id);
    res.set('Content-Type', 'application/pdf');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Disposition', buildContentDisposition(fileName, 'attachment'));
    return res.send(buffer);
  } catch (error) {
    if (sendServiceRefusal(res, error)) return;
    return errorResponse(res, error, 500, 'Failed to load the signing certificate');
  }
});

// ---- signing and responding from the portal ---------------------------
// A logged-in customer reads, signs and answers here with their session.
// The action token that the public pages use is looked up on the server and
// handed to the same service calls, so the signature evidence and the
// single-use bookkeeping are identical — but the token itself never reaches
// the browser.

// Load a document the customer owns, behind the same feature gate as the
// list. Drafts and other customers' documents are a plain 404.
async function ownedDocument(req, res, { table, featureKey, label, notFound }) {
  if (!(await customerFeatureAllowed(req, res, featureKey, label))) return null;
  const id = Number.parseInt(req.params.id, 10);
  const row = Number.isInteger(id)
    ? await db(table).where({ id, customer_account_id: req.customer.id }).first()
    : null;
  if (!row || row.status === 'draft') {
    res.status(404).json({ error: notFound });
    return null;
  }
  return row;
}

const CONTRACT = { table: 'contracts', featureKey: 'contracts', label: 'Contracts', notFound: 'Contract not found' };
const QUOTE = { table: 'quotes', featureKey: 'quotes', label: 'Quotes', notFound: 'Quote not found' };

// The signed-in customer, as the actor the accounting change history records
// for a portal signature, upload or response.
function portalActor(req) {
  return { type: 'customer', id: req.customer.id, name: req.customer.displayName || null };
}

function sendValidationErrors(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  res.status(400).json({
    error: 'Validation failed',
    code: 'VALIDATION_ERROR',
    details: safeValidationErrors(errors).map((e) => ({ field: e.path || e.param, message: e.msg })),
  });
  return true;
}

// Operational refusals from the services (expired link, already signed,
// ToS not accepted, ...) go back as they are; anything else is a 500.
function sendServiceRefusal(res, err) {
  if (!err || !err.statusCode || err.statusCode >= 500) return false;
  res.status(err.statusCode).json({ error: err.message, code: err.code });
  return true;
}

router.get('/contracts/:id', customerAuth, async (req, res) => {
  try {
    const contract = await ownedDocument(req, res, CONTRACT);
    if (!contract) return;
    const view = await publicDocumentViews.buildContractView(contract.id);
    if (!view) return res.status(404).json({ error: CONTRACT.notFound });
    const liveTokens = await publicDocumentViews.liveContractTokens([contract.id]);
    // Same rule as the list: a signatures-v2 contract signs through a signer
    // session and has no action token to look for.
    res.json({
      contract: view,
      canSign: contract.status === 'sent'
        && (Number(contract.signing_version) === 2 || liveTokens.has(contract.id)),
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to load contract');
  }
});

router.post(
  '/contracts/:id/sign',
  customerAuth,
  [
    body('name').isString().isLength({ min: 1, max: 255 }),
    body('accepted').isBoolean(),
    body('signatureDataUrl').optional({ nullable: true }).isString(),
  ],
  async (req, res) => {
    try {
      if (sendValidationErrors(req, res)) return;
      const contract = await ownedDocument(req, res, CONTRACT);
      if (!contract) return;
      const token = (await publicDocumentViews.liveContractTokens([contract.id])).get(contract.id);
      if (contract.status !== 'sent' || !token) {
        return res.status(409).json({ error: 'This contract cannot be signed right now.', code: 'NOT_SIGNABLE' });
      }
      const contractService = require('../services/contractService');
      const result = await contractService.recordCustomerSignature({
        token: token.token,
        name: req.body.name,
        signatureDataUrl: req.body.signatureDataUrl,
        accepted: req.body.accepted === true,
        // See utils/clientIp.js — the trusted req.ip only.
        ip: clientIpForAudit(req),
        actor: portalActor(req),
      });
      res.json(result);
    } catch (error) {
      if (sendServiceRefusal(res, error)) return;
      errorResponse(res, error, 500, 'Failed to sign contract');
    }
  },
);

router.post(
  '/contracts/:id/upload-signed-pdf',
  customerAuth,
  // Setting, ownership and signability are all checked BEFORE multer, so a
  // refused upload never writes to disk.
  contractSignedPdfUpload.uploadSignedPdfSettingGuard,
  async (req, res, next) => {
    try {
      const contract = await ownedDocument(req, res, CONTRACT);
      if (!contract) return undefined;
      const token = (await publicDocumentViews.liveContractTokens([contract.id])).get(contract.id);
      if (contract.status !== 'sent' || !token) {
        return res.status(409).json({ error: 'This contract cannot be signed right now.', code: 'NOT_SIGNABLE' });
      }
      req.publicTokenRow = token;
      return next();
    } catch (error) {
      return next(error);
    }
  },
  contractSignedPdfUpload.signedPdfUpload.single('file'),
  async (req, res) => {
    try {
      await contractSignedPdfUpload.finishSignedPdfUpload(req, res, { actor: portalActor(req) });
    } catch (error) {
      if (sendServiceRefusal(res, error)) return;
      errorResponse(res, error, 500, 'Failed to upload the signed contract');
    }
  },
);

router.get('/quotes/:id', customerAuth, async (req, res) => {
  try {
    const quote = await ownedDocument(req, res, QUOTE);
    if (!quote) return;
    const view = await publicDocumentViews.buildQuoteView(quote.id);
    if (!view) return res.status(404).json({ error: QUOTE.notFound });
    const usableTokens = await publicDocumentViews.usableQuoteTokens([quote.id]);
    res.json({
      quote: view,
      canRespond: publicDocumentViews.quoteAcceptsResponse(quote) && usableTokens.has(quote.id),
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to load quote');
  }
});

router.post(
  '/quotes/:id/respond',
  customerAuth,
  [
    body('action').isIn(['accept', 'decline']),
    body('tosAccepted').optional().isBoolean(),
    // The total the page showed. A quote offering add-ons is accepted with
    // its stored choice, and the service refuses a stale total.
    body('expectedTotalMinor').optional({ nullable: true }).isInt({ min: 0 }).toInt(),
  ],
  async (req, res) => {
    try {
      if (sendValidationErrors(req, res)) return;
      const quote = await ownedDocument(req, res, QUOTE);
      if (!quote) return;
      const token = (await publicDocumentViews.usableQuoteTokens([quote.id])).get(quote.id);
      if (!publicDocumentViews.quoteAcceptsResponse(quote) || !token) {
        return res.status(409).json({ error: 'This quote cannot be answered right now.', code: 'NOT_RESPONDABLE' });
      }
      const quoteService = require('../services/quoteService');
      const result = await quoteService.recordResponse({
        token: token.token,
        action: req.body.action,
        ip: clientIpForAudit(req),
        tosAccepted: req.body.tosAccepted === true,
        expectedTotalMinor: req.body.expectedTotalMinor,
        actor: portalActor(req),
      });
      res.json({ status: result.status, lockedAt: result.lockedAt });
    } catch (error) {
      if (error && error.code === 'RESPONSE_LOCKED') {
        return res.status(423).json({
          error: error.message,
          code: 'RESPONSE_LOCKED',
          currentStatus: error.currentStatus,
          lockedAt: error.lockedAt,
        });
      }
      if (sendServiceRefusal(res, error)) return;
      errorResponse(res, error, 500, 'Failed to record the response');
    }
  },
);


// ---- dashboard + per-event page (#1444) --------------------------------

/**
 * GET /dashboard
 *
 * What needs the customer's attention (quotes awaiting a response, contracts
 * awaiting their signature, invoices due or overdue) and their galleries,
 * split into active and expired. Each section follows the customer's
 * effective features. customerPortalService builds this and the event page
 * below from the same queries.
 */
router.get('/dashboard', customerAuth, async (req, res) => {
  try {
    res.json(await customerPortalService.getDashboard(req.customer.id));
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to load dashboard');
  }
});

/**
 * GET /events/:slug/overview
 *
 * One event: gallery state, quotes, contracts, invoices and documents.
 * 404 when the event is unknown, archived or not assigned to this customer —
 * the three look the same from outside.
 */
router.get('/events/:slug/overview', [
  customerAuth,
  param('slug').isString().isLength({ min: 1, max: 255 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: safeValidationErrors(errors) });
    }
    const overview = await customerPortalService.getEventOverview(req.customer.id, req.params.slug);
    if (!overview) return res.status(404).json({ error: 'Event not found' });
    res.json(overview);
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to load event');
  }
});

// ---- documents (#1444) ---------------------------------------------------
// PDFs shared by the studio plus the customer's own uploads. Every query in
// customerDocumentsService is scoped to req.customer.id.

// Global `documents` flag AND the per-customer override, like the other
// customer features.
async function requireDocumentsFeature(req, res, next) {
  try {
    if (await customerFeatureAllowed(req, res, 'documents', 'Documents')) next();
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to check document access');
  }
}

// Uploads get their own bucket per customer account. Otherwise customers only
// share the global per-IP limit, which everyone behind one address uses up
// together.
const documentUploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `customer-documents:${req.customer.id}`,
  message: { error: 'Too many uploads. Please wait a few minutes and try again.', code: 'UPLOAD_RATE_LIMITED' },
  // Counted as an abuse signal (per customer per hour), then answered as usual.
  handler: (req, res, _next, options) => {
    customerDocumentAbuse.record(req.customer.id, 'rate_limited')
      .finally(() => res.status(options.statusCode).json(options.message));
  },
});

// A 4xx AppError carries a message written for the customer; anything else is
// logged and answered generically.
function sendDocumentError(res, error, fallback) {
  if (error && error.statusCode && error.statusCode < 500) {
    return res.status(error.statusCode).json({ error: error.message, code: error.code });
  }
  return errorResponse(res, error, 500, fallback);
}

router.get('/documents', customerAuth, requireDocumentsFeature, async (req, res) => {
  try {
    const documents = await customerDocumentsService.listForCustomer(req.customer.id);
    const limits = await customerDocumentsService.getLimits();
    const usedBytes = await customerDocumentsService.getUsageBytes(req.customer.id);
    res.json({ documents, limits: { ...limits, usedBytes } });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to load documents');
  }
});

/**
 * POST /documents  multipart: file (PDF), eventId?, contractId?, requestId?
 *
 * The file stays `pending` — not downloadable — until the studio has
 * reviewed it. Quota is checked before multer (no bytes written when it is
 * already used up) and again with the real size.
 */
router.post('/documents', customerAuth, requireDocumentsFeature, documentUploadLimiter, async (req, res) => {
  let file = null;
  try {
    const limits = await customerDocumentsService.getLimits();
    const usedBytes = await customerDocumentsService.getUsageBytes(req.customer.id);
    if (usedBytes >= limits.quotaBytes) {
      await customerDocumentAbuse.record(req.customer.id, 'quota_exceeded');
      return res.status(413).json({ error: 'Your document storage is full.', code: 'QUOTA_EXCEEDED' });
    }
    file = await receivePdfUpload(req, res, { maxBytes: limits.maxUploadBytes });
    if (!file) return res.status(400).json({ error: 'No file was uploaded.', code: 'NO_FILE' });
    // The quota is counted again where the row is written, in the same
    // transaction: the check above runs before the body arrives, so uploads
    // landing together would otherwise all measure the same "before".
    // requestId answers a document request (slice 10): anything that isn't
    // an open request of this customer is the request's 404.
    let requestId = null;
    if (req.body.requestId !== undefined && req.body.requestId !== '') {
      requestId = /^\d{1,10}$/.test(String(req.body.requestId)) ? Number(req.body.requestId) : -1;
      if (requestId < 1) {
        return res.status(404).json({ error: 'Document request not found', code: 'DOCUMENT_REQUEST_NOT_FOUND' });
      }
    }
    const row = await customerDocumentsService.createDocument({
      customerId: req.customer.id,
      uploaderType: 'customer',
      uploaderId: req.customer.id,
      file,
      requestId,
      links: { eventId: req.body.eventId, contractId: req.body.contractId },
      actor: { type: 'customer', id: req.customer.id, name: req.customer.email },
      quotaBytes: limits.quotaBytes,
      maxUploadBytes: limits.maxUploadBytes,
    });
    // After the row is written; neither can fail the upload.
    await customerDocumentNotifications.notifyUploaded(row);
    await customerDocumentNotifications.emitDocumentWorkflow('document.uploaded', row);
    res.status(201).json({ document: customerDocumentsService.toCustomerDto(row) });
  } catch (error) {
    if (error && error.code === 'QUOTA_EXCEEDED') await customerDocumentAbuse.record(req.customer.id, 'quota_exceeded');
    sendDocumentError(res, error, 'Failed to upload document');
  } finally {
    discardTempFile(file);
  }
});

// One answer per state, shared by the document page and the download. A 410
// is only ever given for a document this customer once saw (see
// getStateForCustomer); everything else — including another customer's id —
// is the same 404 body.
const DOCUMENT_GONE = {
  unshared: { error: 'This document is no longer shared with you.', code: 'DOCUMENT_UNSHARED' },
  removed: { error: 'This document has been removed.', code: 'DOCUMENT_REMOVED' },
};

function documentIdParam(req) {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 && id <= 2147483647 ? id : null;
}

/** The row when visible; otherwise sends the 404/410 and returns null. */
async function loadCustomerDocument(req, res) {
  const id = documentIdParam(req);
  const found = id ? await customerDocumentsService.getStateForCustomer(req.customer.id, id) : null;
  if (found && found.state === 'visible') return found.row;
  if (found) {
    res.status(410).json(DOCUMENT_GONE[found.state]);
  } else {
    // Counted only when the id exists and is someone else's (never for an
    // id that doesn't exist); the answer is the same 404 either way.
    if (id) await customerDocumentAbuse.recordIfForeign(req.customer.id, id);
    res.status(404).json({ error: 'Document not found', code: 'DOCUMENT_NOT_FOUND' });
  }
  return null;
}

/**
 * GET /document-requests — what the studio has asked this customer for and
 * is still waiting on (slice 10).
 */
router.get('/document-requests', customerAuth, requireDocumentsFeature, async (req, res) => {
  try {
    res.json({ requests: await customerDocumentRequestsService.listOpenForCustomer(req.customer.id) });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to load document requests');
  }
});

/**
 * GET /documents/:id — one document's details, for the document page and
 * the deep link in a notification. Pending and rejected own uploads answer
 * 200 with their status (no download); unshared and removed ones a 410 with
 * their own code, so the page can say which.
 */
router.get('/documents/:id', customerAuth, requireDocumentsFeature, async (req, res) => {
  try {
    const row = await loadCustomerDocument(req, res);
    if (!row) return undefined;
    return res.json({ document: customerDocumentsService.toCustomerDto(row) });
  } catch (error) {
    return sendDocumentError(res, error, 'Failed to load document');
  }
});

/**
 * DELETE /documents/:id — the customer deletes their own upload. Only their
 * own uploads (anything else is the portal's usual 404), and not while it is
 * linked to a contract (409 DOCUMENT_CONTRACT_LINKED). Shares the upload
 * rate limit.
 */
router.delete('/documents/:id', customerAuth, requireDocumentsFeature, documentUploadLimiter, async (req, res) => {
  try {
    const id = documentIdParam(req);
    if (!id) return res.status(404).json({ error: 'Document not found', code: 'DOCUMENT_NOT_FOUND' });
    await customerDocumentsService.softDeleteByCustomer(req.customer.id, id,
      { type: 'customer', id: req.customer.id, name: req.customer.email });
    return res.json({ deleted: true });
  } catch (error) {
    if (error && error.code === 'DOCUMENT_NOT_FOUND') {
      await customerDocumentAbuse.recordIfForeign(req.customer.id, documentIdParam(req));
    }
    return sendDocumentError(res, error, 'Failed to delete document');
  }
});

router.get('/documents/:id/download', customerAuth, requireDocumentsFeature, async (req, res) => {
  try {
    const row = await loadCustomerDocument(req, res);
    if (!row) return undefined;
    if (row.status === 'pending') {
      return res.status(409).json({ error: 'This document is still being reviewed.', code: 'DOCUMENT_PENDING_REVIEW' });
    }
    if (row.status !== 'clean') {
      return res.status(409).json({ error: 'This document was rejected and cannot be downloaded.', code: 'DOCUMENT_REJECTED' });
    }
    const stream = await customerDocumentsService.openStream(row);
    await customerDocumentsService.recordView(row.id, 'customer', req.customer.id);
    await logActivity('customer_document_downloaded',
      { documentId: row.id, customerId: req.customer.id },
      row.event_id || null,
      { type: 'customer', id: req.customer.id, name: req.customer.email }
    );
    sendPdfAttachment(res, stream, row.original_name);
  } catch (error) {
    sendDocumentError(res, error, 'Failed to download document');
  }
});

module.exports = router;
