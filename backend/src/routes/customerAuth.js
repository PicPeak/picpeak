/**
 * Customer-side auth routes
 *
 * Mounted at /api/customer/auth (see server.js wiring). Strictly separate
 * from /api/auth/* (admin) and /api/auth/gallery/* (per-event guests).
 *
 * Endpoints:
 *   POST   /login          email + password → customer_token cookie
 *   POST   /logout         revoke + clear cookie
 *   GET    /session        echo current customer for frontend boot
 *   GET    /invite/:token  public, returns invite metadata
 *   POST   /accept-invite  public, completes the invitation
 */

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, param, validationResult } = require('express-validator');
const { safeValidationErrors } = require('../utils/routeHelpers');
const { MAX_PASSWORD_LENGTH } = require('../utils/passwordValidation');
const DUMMY_BCRYPT_HASH = '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234';
const { db, logActivity } = require('../database/db');
const { verifyRecaptcha } = require('../services/recaptcha');
const {
  trackFailedAttempt,
  trackSuccessfulLogin,
  checkAccountLockout,
  getGenericAuthError,
} = require('../utils/authSecurity');
const { revokeToken } = require('../utils/tokenRevocation');
const logger = require('../utils/logger');
const {
  setCustomerAuthCookie,
  clearCustomerAuthCookie,
  getCustomerTokenFromRequest,
} = require('../utils/tokenUtils');
const { getClientIp } = require('../utils/requestIp');
// NOTE: customers intentionally do NOT go through validatePasswordInContext
// (the admin-grade policy that can require special chars, dictionary checks,
// breach lists, etc.). Customers are end-users picking a one-off password —
// the friction of the admin policy turned them away. We enforce a simple,
// human-readable rule below: minimum length, at least one uppercase letter,
// at least one digit. No special-character or breach-list requirement.
const customerAccountsService = require('../services/customerAccountsService');
const customerContactsService = require('../services/customerContactsService');
const { customerAuth } = require('../middleware/customerAuth');
const { IDENTITY_PRESERVING_NORMALIZE_EMAIL } = require('../utils/emailNormalization');
const { auditedUpdate } = require('../services/accountingHistory');

const router = express.Router();

const TOKEN_TTL_SECONDS = 24 * 60 * 60; // mirrors admin tokens

// ---- login -------------------------------------------------------------

function signSession({ customer, contact }, ipAddress) {
  return jwt.sign({
    customerId: customer.id,
    email: (contact || customer).email,
    type: 'customer',
    ip: ipAddress,
    loginTime: Date.now(),
    // One customer has several logins, which the iat-based revocation key
    // cannot tell apart: a contact's session is revoked by its own jti.
    ...(contact ? { contactId: contact.id, jti: crypto.randomUUID() } : {}),
  }, process.env.JWT_SECRET, {
    expiresIn: TOKEN_TTL_SECONDS,
    issuer: 'picpeak-auth',
  });
}

// Resolve effective features + branding right here so a login response carries
// the same shape as /session. Without this, the first render after login would
// use the context's DEFAULT_FEATURES (all false).
async function sessionPayload({ customer, contact }) {
  const person = contact || customer;
  const rights = contact ? customerContactsService.rightsOf(contact) : customerContactsService.HOLDER_RIGHTS;
  let features = { calendar: false, quotes: false, bills: false, hoursLogging: false, contracts: false, documents: false };
  let branding = { showLogo: true, showCompanyName: true };
  let companies = [];
  try {
    companies = await customerContactsService.companiesFor(person.email);
    features = await customerAccountsService.getEffectiveFeaturesForCustomer(customer);
    if (contact) features = customerContactsService.applyRights(features, rights);
    const globals = await customerAccountsService.getCustomerSurfaceGlobals();
    branding = { showLogo: globals.showLogo, showCompanyName: globals.showCompanyName };
  } catch (e) {
    logger.warn('Customer session: failed to resolve features/branding, using defaults', { error: e?.message });
  }
  return {
    customer: {
      id: customer.id,
      contactId: contact?.id ?? null,
      rights,
      companies,
      email: person.email,
      displayName: person.display_name,
      firstName: person.first_name,
      lastName: person.last_name,
      preferredLanguage: person.preferred_language || customer.preferred_language || 'en',
    },
    features,
    branding,
  };
}

// The customerPortal feature flag deliberately does NOT gate this route.
// Flipping the master toggle off in Settings → Features hides the
// admin-side Clients section (sidebar entry, /admin/clients pages) but
// must not revoke access for customers who already accepted an
// invitation — that would mean a stray click in the Features tab
// locks every paying customer out at once.
//
// To revoke access at the customer level, use the per-record tools:
//   - "Deactivate" on the customer detail page → sets
//     customer_accounts.is_active = false AND bumps password_changed_at,
//     which customerAuth rejects below + on every protected route.
//   - "Manage galleries" dialog → removes event_customer_assignments
//     rows, which verifyGalleryAccess re-checks on customer-minted
//     gallery JWTs (instant per-gallery revocation).
router.post('/login', [
  body('email').isEmail().normalizeEmail(IDENTITY_PRESERVING_NORMALIZE_EMAIL).withMessage('Valid email is required'),
  body('password').isString().notEmpty().isLength({ max: MAX_PASSWORD_LENGTH }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: safeValidationErrors(errors) });
    }

    const { email, password, recaptchaToken } = req.body;
    const ipAddress = getClientIp(req);
    const userAgent = req.headers['user-agent'] || '';

    // Lockout key includes a `customer:` prefix so admin and customer
    // attempt counters don't share a bucket — an attacker hitting an
    // admin login with the same email should not lock out the customer
    // account or vice versa.
    // Scoped to identifier + source IP like the gallery paths, so failures
    // from one address do not lock the customer out from every other one.
    const lockoutKey = `customer:${email}`;
    const lockoutStatus = await checkAccountLockout(lockoutKey, ipAddress);
    if (lockoutStatus.isLocked) {
      logger.warn('Customer login attempt on locked account', { email, ipAddress });
      return res.status(423).json({
        error: 'Account temporarily locked due to too many failed attempts',
        retryAfter: lockoutStatus.remainingTime,
      });
    }

    const recaptchaValid = await verifyRecaptcha(recaptchaToken);
    if (!recaptchaValid) {
      await trackFailedAttempt(lockoutKey, ipAddress, userAgent);
      return res.status(400).json({ error: 'reCAPTCHA verification failed' });
    }

    const credential = await customerContactsService.credentialFor(email);
    // Generic error to prevent user enumeration — same wording as admin login.
    // One bcrypt compare on every path so an unknown email is not a timing
    // oracle (the dummy hash matches nothing).
    const passwordMatches = credential
      ? await bcrypt.compare(password, credential.password_hash)
      : await bcrypt.compare(password, DUMMY_BCRYPT_HASH).then(() => false);
    if (!passwordMatches) {
      await trackFailedAttempt(lockoutKey, ipAddress, userAgent);
      return res.status(401).json({ error: getGenericAuthError() });
    }
    // A person at several customers starts in the first one. Own customer
    // first, so a customer without contacts logs in exactly as before.
    const [membership] = await customerContactsService.membershipsFor(email);
    if (!membership) {
      await trackFailedAttempt(lockoutKey, ipAddress, userAgent);
      return res.status(401).json({ error: getGenericAuthError() });
    }
    const { customer, contact } = membership;
    const person = contact || customer;

    await trackSuccessfulLogin(lockoutKey, ipAddress, userAgent);
    if (contact) {
      await db('customer_contacts').where('id', contact.id).update({
        last_login: new Date(),
        last_login_ip: ipAddress,
      });
    } else {
      // Not a billing field, so this leaves no history entry.
      await auditedUpdate(db, 'customer_accounts', { id: customer.id }, {
        last_login: new Date(),
        last_login_ip: ipAddress,
      }, { actor: { type: 'customer', id: customer.id }, source: 'customer.login' });
    }

    setCustomerAuthCookie(res, signSession(membership, ipAddress));

    await logActivity('customer_login',
      { customerId: customer.id, email: person.email, ipAddress, ...(contact && { contactId: contact.id }) },
      null,
      { type: 'customer', id: customer.id, name: person.email }
    );

    res.json(await sessionPayload(membership));
  } catch (error) {
    logger.error('Customer login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ---- switch company ----------------------------------------------------

/**
 * POST /switch-company { customerId }
 *
 * A person at several customers works in one at a time. The new session is
 * for the customer named here, and only one this address belongs to right now,
 * read fresh rather than taken from the old token. The old session ends, along
 * with any gallery token minted from it.
 */
router.post('/switch-company', [
  customerAuth,
  body('customerId').isInt({ min: 1 }).toInt(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: safeValidationErrors(errors) });
    const memberships = await customerContactsService.membershipsFor(req.customer.email);
    const membership = memberships.find(({ customer }) => customer.id === req.body.customerId);
    if (!membership) return res.status(404).json({ error: 'Company not found' });

    if (!await revokeToken(req.token, 'company_switch')) throw new Error('Token revocation failed');
    setCustomerAuthCookie(res, signSession(membership, getClientIp(req)));
    await logActivity('customer_company_switch',
      { customerId: membership.customer.id, contactId: membership.contact?.id ?? null },
      null,
      { type: 'customer', id: membership.customer.id, name: req.customer.email });
    res.json(await sessionPayload(membership));
  } catch (error) {
    logger.error('Customer company switch error:', error);
    res.status(500).json({ error: 'Failed to switch company' });
  }
});

// ---- logout ------------------------------------------------------------

router.post('/logout', async (req, res) => {
  try {
    const token = getCustomerTokenFromRequest(req);
    if (token) {
      if (!await revokeToken(token, 'user_logout')) {
        throw new Error('Token revocation failed');
      }
    }
    clearCustomerAuthCookie(res);
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    logger.error('Customer logout error:', error);
    // Always clear the cookie even if revocation failed — the client must
    // not stay locked into a half-broken session.
    clearCustomerAuthCookie(res);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// ---- session echo ------------------------------------------------------

router.get('/session', customerAuth, async (req, res) => {
  // Resolve the effective feature set (global toggle AND per-customer flag)
  // and the branding visibility globals so the customer frontend can render
  // the correct sidebar without an extra round-trip on every navigation.
  // Failure here is non-fatal — the customer should still be able to see
  // their galleries even if the settings table is briefly unavailable.
  let features = { calendar: false, quotes: false, bills: false, hoursLogging: false, contracts: false, documents: false };
  let branding = { showLogo: true, showCompanyName: true };
  let companies = [];
  try {
    companies = await customerContactsService.companiesFor(req.customer.email);
    features = await customerAccountsService.getEffectiveFeaturesForSession(req.customer);
    const globals = await customerAccountsService.getCustomerSurfaceGlobals();
    branding = { showLogo: globals.showLogo, showCompanyName: globals.showCompanyName };
  } catch (e) {
    logger.warn('Customer session: failed to resolve features/branding, using defaults', { error: e?.message });
  }
  res.json({ customer: { ...req.customer, companies }, features, branding });
});

// ---- invitation lifecycle (public) -------------------------------------

router.get('/invite/:token', [
  param('token').isLength({ min: 64, max: 64 }).matches(/^[a-f0-9]+$/i),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(404).json({ error: 'Invalid invitation link' });
    }
    const invitation = await customerAccountsService.validateInvitationToken(req.params.token);
    if (!invitation) {
      return res.status(404).json({ error: 'Invalid or expired invitation' });
    }
    res.json({
      invitation: {
        email: invitation.email,
        expiresAt: invitation.expires_at,
        invitedBy: invitation.invited_by_username,
        // Surface admin-supplied prefill so the accept page can populate
        // its profile form. Customer can still edit any field — we just
        // saved them some typing.
        prefill: invitation.prefill || null,
        // A contact joins an existing customer, so the accept page asks only
        // for the person, not for company data.
        forContact: !!invitation.contact_id,
      },
    });
  } catch (error) {
    logger.error('Customer invite lookup error:', error);
    res.status(500).json({ error: 'Failed to load invitation' });
  }
});

/**
 * Customer-specific password policy.
 *
 * Intentionally simpler than validatePasswordInContext (the admin-grade
 * checker). Rules:
 *   - At least 8 characters
 *   - At least one uppercase letter (A–Z)
 *   - At least one digit (0–9)
 *
 * No special-character requirement, no breach-list lookup, no dictionary
 * check — those tripped up real customers picking real passwords (e.g.
 * "PartyTime2026"). Capitals + a number is enough entropy for an
 * account that only views galleries; it's not protecting financial data.
 *
 * Returns null on success, or a string error message on failure.
 */
function validateCustomerPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    return 'Password must be at least 8 characters long.';
  }
  if (!/[A-Z]/.test(password)) {
    return 'Password must contain at least one uppercase letter.';
  }
  if (!/[0-9]/.test(password)) {
    return 'Password must contain at least one number.';
  }
  return null;
}

router.post('/accept-invite', [
  body('token').isLength({ min: 64, max: 64 }).matches(/^[a-f0-9]+$/i),
  body('name').optional({ nullable: true }).isString().trim().isLength({ max: 120 }),
  // Length floor enforced again here for an early reject; the full
  // policy (uppercase + digit) is checked below so we can surface a
  // specific message rather than a generic validator error.
  body('password').isString().isLength({ min: 8, max: MAX_PASSWORD_LENGTH })
    .withMessage('Password must be at least 8 characters'),
  // Optional structured profile from the accept-invite form. Mirrors
  // the admin prefill shape — anything the customer types here wins
  // over the admin prefill stashed on the invitation row.
  body('profile').optional().isObject(),
  body('profile.salutation').optional({ nullable: true }).isString().isLength({ max: 32 }),
  body('profile.first_name').optional({ nullable: true }).isString().isLength({ max: 80 }),
  body('profile.last_name').optional({ nullable: true }).isString().isLength({ max: 80 }),
  body('profile.display_name').optional({ nullable: true }).isString().isLength({ max: 120 }),
  body('profile.phone').optional({ nullable: true }).isString().isLength({ max: 40 }),
  body('profile.preferred_language').optional({ nullable: true }).isString().isLength({ max: 8 }),
  body('profile.company_name').optional({ nullable: true }).isString().isLength({ max: 120 }),
  body('profile.vat_id').optional({ nullable: true }).isString().isLength({ max: 40 }),
  body('profile.address_line1').optional({ nullable: true }).isString().isLength({ max: 255 }),
  body('profile.address_line2').optional({ nullable: true }).isString().isLength({ max: 255 }),
  body('profile.postal_code').optional({ nullable: true }).isString().isLength({ max: 20 }),
  body('profile.city').optional({ nullable: true }).isString().isLength({ max: 120 }),
  body('profile.state').optional({ nullable: true }).isString().isLength({ max: 120 }),
  body('profile.country_code').optional({ nullable: true }).isString().isLength({ max: 2 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: safeValidationErrors(errors) });
    }
    const { token, name, password, profile } = req.body;

    const policyError = validateCustomerPassword(password);
    if (policyError) {
      return res.status(400).json({
        error: 'Password does not meet complexity requirements',
        details: [policyError],
      });
    }

    const result = await customerAccountsService.acceptInvitation({ token, name, password, profile });
    res.json({ message: 'Invitation accepted', email: result.email });
  } catch (error) {
    if (error.code === 'CONFLICT' || error.statusCode === 409) {
      return res.status(409).json({ error: error.message });
    }
    if (error.code === 'VALIDATION' || error.statusCode === 400) {
      return res.status(400).json({ error: error.message });
    }
    logger.error('Customer invite accept error:', error);
    res.status(500).json({ error: 'Failed to accept invitation' });
  }
});

// ---- password reset (public) -------------------------------------------

/**
 * GET /password-reset/:token (#354 follow-up).
 *
 * Validate a reset token without consuming it so the reset page can show
 * "you're resetting the password for {{email}}" before the user submits.
 */
router.get('/password-reset/:token', [
  param('token').isLength({ min: 64, max: 64 }).matches(/^[a-f0-9]+$/i),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(404).json({ error: 'Invalid reset link' });
    const reset = await customerAccountsService.validatePasswordResetToken(req.params.token);
    if (!reset) return res.status(404).json({ error: 'Invalid or expired reset link' });
    res.json({ reset: { email: reset.email, expiresAt: reset.expires_at } });
  } catch (error) {
    logger.error('Customer reset lookup error:', error);
    res.status(500).json({ error: 'Failed to validate reset link' });
  }
});

/**
 * POST /password-reset (#354 follow-up).
 *
 * Apply a reset: token + new password. Same simple password policy as
 * the accept-invite path (8 chars, uppercase, digit). The service marks
 * the reset row as used in the same transaction so a re-submitted token
 * is rejected on the second click.
 */
router.post('/password-reset', [
  body('token').isLength({ min: 64, max: 64 }).matches(/^[a-f0-9]+$/i),
  body('password').isString().isLength({ min: 8, max: MAX_PASSWORD_LENGTH }).withMessage('Password must be at least 8 characters'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: safeValidationErrors(errors) });
    const policyError = validateCustomerPassword(req.body.password);
    if (policyError) {
      return res.status(400).json({
        error: 'Password does not meet complexity requirements',
        details: [policyError],
      });
    }
    const result = await customerAccountsService.applyPasswordReset({
      token: req.body.token,
      password: req.body.password,
    });
    res.json({ message: 'Password updated', email: result.email });
  } catch (error) {
    if (error.code === 'VALIDATION' || error.statusCode === 400) {
      return res.status(400).json({ error: error.message });
    }
    logger.error('Customer reset apply error:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

module.exports = router;
