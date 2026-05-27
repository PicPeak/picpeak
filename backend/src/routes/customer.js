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
const { getClientIp } = require('../utils/requestIp');
const { customerAuth } = require('../middleware/customerAuth');
const { setGalleryAuthCookies } = require('../utils/tokenUtils');
const customerAccountsService = require('../services/customerAccountsService');

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
    logger.error('Customer event list error:', error);
    res.status(500).json({ error: 'Failed to load events' });
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
    logger.error('Customer access-token exchange error:', error);
    res.status(500).json({ error: 'Failed to issue access token' });
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
    logger.error('Customer profile read error:', error);
    res.status(500).json({ error: 'Failed to load profile' });
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
    logger.error('Customer profile update error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
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
    logger.error('Customer password change error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

module.exports = router;
