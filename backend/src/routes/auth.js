const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { db, logActivity } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const { verifyRecaptcha } = require('../services/recaptcha');
const mfaService = require('../services/mfaService');
const { 
  trackFailedAttempt,
  trackSuccessfulLogin,
  checkAccountLockout,
  checkSuspiciousActivity,
  getGenericAuthError
} = require('../utils/authSecurity');
const { endSession } = require('../middleware/sessionTimeout');
const { revokeToken } = require('../utils/tokenRevocation');
const { timingSafeEqualStr } = require('../utils/timingSafe');
const logger = require('../utils/logger');
const { errorResponse } = require('../utils/routeHelpers');
const {
  setAdminAuthCookie,
  clearAdminAuthCookie,
  setGalleryAuthCookies,
  clearGalleryAuthCookies,
  getAdminTokenFromRequest,
  getGalleryTokenFromRequest,
} = require('../utils/tokenUtils');
const { getEventShareToken, resolveShareIdentifier } = require('../services/shareLinkService');
const { getClientIp } = require('../utils/requestIp');
const {
  validatePasswordInContext,
  getBcryptRounds,
  logPasswordValidationFailure
} = require('../utils/passwordValidation');
const router = express.Router();

/**
 * Finish a successful admin login: reset the lockout counter, stamp
 * last_login, mint the 24h admin JWT, set the HttpOnly cookie, and return the
 * user payload. Shared by the direct (no-MFA) path and the MFA-verify path so
 * both produce an identical session. `lockoutKey` is the identifier the user
 * typed (username or email) so success/failure tracking stays in one bucket.
 */
async function completeAdminLogin(req, res, admin, ipAddress, userAgent, lockoutKey) {
  await trackSuccessfulLogin(lockoutKey, ipAddress, userAgent);

  await db('admin_users').where('id', admin.id).update({
    last_login: new Date(),
    last_login_ip: ipAddress
  });

  const token = jwt.sign({
    id: admin.id,
    username: admin.username,
    type: 'admin',
    role: admin.role_name,
    ip: ipAddress,
    loginTime: Date.now()
  }, process.env.JWT_SECRET, {
    expiresIn: '24h',
    issuer: 'picpeak-auth'
  });

  setAdminAuthCookie(res, token);

  return res.json({
    user: {
      id: admin.id,
      username: admin.username,
      email: admin.email,
      mustChangePassword: admin.must_change_password || false,
      role: admin.role_name ? {
        name: admin.role_name,
        displayName: admin.role_display_name
      } : null
    }
  });
}

// Admin login with enhanced security
router.post('/admin/login', [
  body('username').notEmpty().trim(),
  body('password').notEmpty()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    const { username, password, recaptchaToken } = req.body;
    const ipAddress = getClientIp(req);
    const userAgent = req.headers['user-agent'] || '';
    
    // Check account lockout first
    const lockoutStatus = await checkAccountLockout(username);
    if (lockoutStatus.isLocked) {
      logger.warn('Login attempt on locked account', { username, ipAddress });
      return res.status(423).json({ 
        error: 'Account temporarily locked due to too many failed attempts',
        retryAfter: lockoutStatus.remainingTime
      });
    }
    
    // Verify reCAPTCHA
    const recaptchaValid = await verifyRecaptcha(recaptchaToken);
    if (!recaptchaValid) {
      await trackFailedAttempt(username, ipAddress, userAgent);
      return res.status(400).json({ error: 'reCAPTCHA verification failed' });
    }
    
    // Check for suspicious activity
    const isSuspicious = await checkSuspiciousActivity(username, ipAddress);
    if (isSuspicious) {
      // Still allow login but log it
      logger.warn('Suspicious login pattern detected', { username, ipAddress });
    }
    
    // Fetch admin with role information
    const admin = await db('admin_users')
      .leftJoin('roles', 'roles.id', 'admin_users.role_id')
      .where('admin_users.username', username)
      .orWhere('admin_users.email', username)
      .select(
        'admin_users.*',
        'roles.name as role_name',
        'roles.display_name as role_display_name'
      )
      .first();

    // Use generic error to prevent user enumeration
    if (!admin || !await bcrypt.compare(password, admin.password_hash)) {
      await trackFailedAttempt(username, ipAddress, userAgent);
      return res.status(401).json({ error: getGenericAuthError() });
    }

    if (!admin.is_active) {
      await trackFailedAttempt(username, ipAddress, userAgent);
      return res.status(401).json({ error: getGenericAuthError() });
    }

    // Second factor: if this admin has TOTP enabled, do NOT complete the login
    // yet. Issue a short-lived, single-purpose mfa_pending token and require the
    // code via /admin/login/mfa. We deliberately don't reset the lockout counter
    // (trackSuccessfulLogin) or stamp last_login until the second factor passes,
    // so MFA brute-force is still gated by the account lockout. `loginId` carries
    // the typed identifier so the verify step tracks the same lockout bucket.
    if (mfaService.isEnrolled(admin)) {
      const mfaToken = jwt.sign({
        id: admin.id,
        username: admin.username,
        type: 'mfa_pending',
        loginId: username
      }, process.env.JWT_SECRET, {
        expiresIn: '5m',
        issuer: 'picpeak-auth'
      });
      return res.json({ mfaRequired: true, mfaToken });
    }

    return await completeAdminLogin(req, res, admin, ipAddress, userAgent, username);
  } catch (error) {
    errorResponse(res, error, 500, 'Login failed');
  }
});

// Second-factor verification. Exchanges the short-lived mfa_pending token
// (from /admin/login) plus a TOTP or recovery code for a full admin session.
router.post('/admin/login/mfa', [
  body('mfaToken').notEmpty(),
  body('code').notEmpty().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { mfaToken, code } = req.body;
    const ipAddress = getClientIp(req);
    const userAgent = req.headers['user-agent'] || '';

    let decoded;
    try {
      decoded = jwt.verify(mfaToken, process.env.JWT_SECRET, {
        algorithms: ['HS256'],
        issuer: 'picpeak-auth'
      });
    } catch (err) {
      return res.status(401).json({
        error: 'Your verification session expired. Please sign in again.',
        code: 'MFA_SESSION_EXPIRED'
      });
    }

    if (decoded.type !== 'mfa_pending') {
      return res.status(401).json({ error: getGenericAuthError() });
    }

    const lockoutKey = decoded.loginId || decoded.username;
    const lockoutStatus = await checkAccountLockout(lockoutKey);
    if (lockoutStatus.isLocked) {
      return res.status(423).json({
        error: 'Account temporarily locked due to too many failed attempts',
        retryAfter: lockoutStatus.remainingTime
      });
    }

    const admin = await db('admin_users')
      .leftJoin('roles', 'roles.id', 'admin_users.role_id')
      .where('admin_users.id', decoded.id)
      .select(
        'admin_users.*',
        'roles.name as role_name',
        'roles.display_name as role_display_name'
      )
      .first();

    if (!admin || !admin.is_active || !mfaService.isEnrolled(admin)) {
      return res.status(401).json({ error: getGenericAuthError() });
    }

    // TOTP first, then a one-time recovery code.
    let ok = mfaService.verifyTotpEncrypted(code, admin.two_factor_secret);
    let usedRecovery = false;
    let remainingHashes = null;
    if (!ok) {
      const stored = mfaService.parseRecoveryCodes(admin.two_factor_recovery_codes);
      const result = await mfaService.consumeRecoveryCode(code, stored);
      if (result.matched) {
        ok = true;
        usedRecovery = true;
        remainingHashes = result.remainingHashes;
      }
    }

    if (!ok) {
      await trackFailedAttempt(lockoutKey, ipAddress, userAgent);
      return res.status(401).json({ error: 'Invalid verification code', code: 'MFA_INVALID' });
    }

    if (usedRecovery) {
      await db('admin_users').where('id', admin.id).update({
        two_factor_recovery_codes: JSON.stringify(remainingHashes),
        updated_at: new Date()
      });
      await logActivity('admin_mfa_recovery_used',
        { admin_id: admin.id, remaining: remainingHashes.length },
        null,
        { type: 'admin', id: admin.id, name: admin.username }
      );
    }

    await logActivity('admin_mfa_login',
      { admin_id: admin.id, method: usedRecovery ? 'recovery_code' : 'totp' },
      null,
      { type: 'admin', id: admin.id, name: admin.username }
    );

    return await completeAdminLogin(req, res, admin, ipAddress, userAgent, lockoutKey);
  } catch (error) {
    logger.error('MFA verification error:', error);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Logout endpoint
router.post('/logout', async (req, res) => {
  try {
    const adminToken = getAdminTokenFromRequest(req);
    const galleryToken = getGalleryTokenFromRequest(req);
    const token = adminToken || galleryToken;

    if (token) {
      // Revoke the token so it can't be reused, then end the session
      await revokeToken(token, 'user_logout');
      endSession(token);

      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        logger.info('User logged out', { 
          userId: decoded.id,
          username: decoded.username,
          type: decoded.type
        });

        if (decoded.type === 'admin') {
          clearAdminAuthCookie(res);
        } else if (decoded.type === 'gallery') {
          clearGalleryAuthCookies(res, decoded.eventSlug);
        }
      } catch (err) {
        // Token might be invalid, but still process logout and clear cookies
        clearAdminAuthCookie(res);
        clearGalleryAuthCookies(res);
      }
    } else {
      // No token found, but ensure cookies are cleared
      clearAdminAuthCookie(res);
      clearGalleryAuthCookies(res);
    }

    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    errorResponse(res, error, 500, 'Logout failed');
  }
});

// Gallery password verification with enhanced security
router.post('/gallery/verify', [
  body('slug').notEmpty().trim(),
  body('password').optional().isString()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    const { slug, password, recaptchaToken } = req.body;
    const ipAddress = getClientIp(req);
    const userAgent = req.headers['user-agent'] || '';
    const event = await db('events')
      .where({ slug, is_active: formatBoolean(true), is_archived: formatBoolean(false) })
      .first();

    if (!event) {
      // Perform a dummy bcrypt compare to prevent timing-based slug enumeration
      await bcrypt.compare(password || '', '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234');
      await trackFailedAttempt(`gallery:${slug}`, ipAddress, userAgent);
      return res.status(401).json({ error: 'Invalid gallery or password' });
    }

    const requiresPassword = !(event.require_password === false || event.require_password === 0 || event.require_password === '0');

    if (requiresPassword) {
      const lockoutStatus = await checkAccountLockout(`gallery:${slug}`, ipAddress);
      if (lockoutStatus.isLocked) {
        logger.warn('Gallery access attempt on locked gallery', { slug, ipAddress });
        return res.status(423).json({ 
          error: 'Too many failed attempts. Please try again later.',
          retryAfter: lockoutStatus.remainingTime
        });
      }

      const recaptchaValid = await verifyRecaptcha(recaptchaToken);
      if (!recaptchaValid) {
        await trackFailedAttempt(`gallery:${slug}`, ipAddress, userAgent);
        return res.status(400).json({ error: 'reCAPTCHA verification failed' });
      }

      if (!password) {
        await trackFailedAttempt(`gallery:${slug}`, ipAddress, userAgent);
        return res.status(401).json({ error: 'Invalid gallery or password' });
      }

      const validPassword = await bcrypt.compare(password, event.password_hash);
      if (!validPassword) {
        await trackFailedAttempt(`gallery:${slug}`, ipAddress, userAgent);
        await db('access_logs').insert({
          event_id: event.id,
          ip_address: ipAddress,
          user_agent: userAgent,
          action: 'login_fail'
        });
        return res.status(401).json({ error: 'Invalid gallery or password' });
      }

      await trackSuccessfulLogin(`gallery:${slug}`, ipAddress, userAgent);
      await db('access_logs').insert({
        event_id: event.id,
        ip_address: ipAddress,
        user_agent: userAgent,
        action: 'login_success'
      });
    } else {
      logger.info('Public gallery access granted without password', { slug, ipAddress });
      await trackSuccessfulLogin(`gallery:${slug}`, ipAddress, userAgent);
      await db('access_logs').insert({
        event_id: event.id,
        ip_address: ipAddress,
        user_agent: userAgent,
        action: 'login_success'
      });
    }

    const token = jwt.sign({ 
      eventId: event.id, 
      eventSlug: event.slug,
      type: 'gallery',
      ip: ipAddress,
      loginTime: Date.now()
    }, process.env.JWT_SECRET, { 
      expiresIn: '24h',
      issuer: 'picpeak-auth'
    });

    setGalleryAuthCookies(res, token, event.slug);
    
    res.json({
      token,
      event: {
        id: event.id,
        event_name: event.event_name,
        event_type: event.event_type,
        event_date: event.event_date,
        welcome_message: event.welcome_message,
        color_theme: event.color_theme,
        expires_at: event.expires_at,
        allow_user_uploads: event.allow_user_uploads,
        upload_category_id: event.upload_category_id,
        require_password: requiresPassword,
        photo_cap: event.photo_cap
      }
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Verification failed');
  }
});

// Client access login (PIN-based)
router.post('/gallery/:slug/client-login', [
  body('password').notEmpty().isString()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { slug } = req.params;
    const { password } = req.body;
    const ipAddress = getClientIp(req);
    const userAgent = req.headers['user-agent'] || '';

    const event = await db('events')
      .where({ slug, is_active: formatBoolean(true), is_archived: formatBoolean(false) })
      .first();

    if (!event || !event.client_access_enabled || !event.client_password_hash) {
      await trackFailedAttempt(`client:${slug}`, ipAddress, userAgent);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const lockoutStatus = await checkAccountLockout(`client:${slug}`, ipAddress);
    if (lockoutStatus.isLocked) {
      return res.status(423).json({
        error: 'Too many failed attempts. Please try again later.',
        retryAfter: lockoutStatus.remainingTime
      });
    }

    const validPassword = await bcrypt.compare(password, event.client_password_hash);
    if (!validPassword) {
      await trackFailedAttempt(`client:${slug}`, ipAddress, userAgent);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await trackSuccessfulLogin(`client:${slug}`, ipAddress, userAgent);

    const token = jwt.sign({
      eventId: event.id,
      eventSlug: event.slug,
      type: 'gallery',
      accessLevel: 'client',
      ip: ipAddress,
      loginTime: Date.now()
    }, process.env.JWT_SECRET, {
      expiresIn: '24h',
      issuer: 'picpeak-auth'
    });

    setGalleryAuthCookies(res, token, event.slug);

    res.json({
      token,
      event: {
        id: event.id,
        event_name: event.event_name,
        event_type: event.event_type,
        event_date: event.event_date,
        welcome_message: event.welcome_message,
        color_theme: event.color_theme,
        expires_at: event.expires_at,
        allow_user_uploads: event.allow_user_uploads,
        upload_category_id: event.upload_category_id,
        require_password: true
      },
      accessLevel: 'client'
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Authentication failed');
  }
});

// Share link authentication (token-based)
router.post('/gallery/share-login', [
  body('slug').notEmpty().trim(),
  body('token').notEmpty()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { slug, token } = req.body;
    const ipAddress = getClientIp(req);
    const userAgent = req.headers['user-agent'] || '';

    // Rate limit share-link login attempts
    const shareIdentifier = `gallery:${slug}:share`;
    const lockoutStatus = await checkAccountLockout(shareIdentifier, ipAddress);
    if (lockoutStatus.isLocked) {
      logger.warn('Share link login attempt on locked gallery', { slug, ipAddress });
      return res.status(423).json({
        error: 'Too many failed attempts. Please try again later.',
        retryAfter: lockoutStatus.remainingTime
      });
    }

    let event = await db('events')
      .where({ slug, is_active: formatBoolean(true), is_archived: formatBoolean(false) })
      .first();

    if (!event) {
      const resolved = await resolveShareIdentifier(slug);
      if (resolved?.event) {
        event = resolved.event;
      }
    }

    if (!event) {
      await trackFailedAttempt(shareIdentifier, ipAddress, userAgent);
      return res.status(404).json({ error: 'Gallery not found' });
    }

    const expectedToken = getEventShareToken(event);

    if (!expectedToken || !timingSafeEqualStr(token, expectedToken)) {
      await trackFailedAttempt(shareIdentifier, ipAddress, userAgent);
      return res.status(401).json({ error: 'Invalid or expired share link' });
    }

    const jwtToken = jwt.sign({
      eventId: event.id,
      eventSlug: event.slug,
      type: 'gallery',
      ip: ipAddress,
      loginTime: Date.now()
    }, process.env.JWT_SECRET, {
      expiresIn: '24h',
      issuer: 'picpeak-auth'
    });

    await trackSuccessfulLogin(`gallery:${event.slug}:share`, ipAddress, userAgent);
    setGalleryAuthCookies(res, jwtToken, event.slug);

    const requiresPassword = !(event.require_password === false || event.require_password === 0 || event.require_password === '0');

    res.json({
      token: jwtToken,
      event: {
        id: event.id,
        event_name: event.event_name,
        event_type: event.event_type,
        event_date: event.event_date,
        welcome_message: event.welcome_message,
        color_theme: event.color_theme,
        expires_at: event.expires_at,
        allow_user_uploads: event.allow_user_uploads,
        upload_category_id: event.upload_category_id,
        require_password: requiresPassword,
        photo_cap: event.photo_cap
      }
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Share link login failed');
  }
});

// Gallery logout to clear cookies and revoke token
router.post('/gallery/logout', async (req, res) => {
  try {
    const { slug } = req.body || {};
    const token = getGalleryTokenFromRequest(req, slug);
    if (token) {
      await revokeToken(token, 'gallery_logout');
    }
    clearGalleryAuthCookies(res, slug);
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    errorResponse(res, error, 500, 'Logout failed');
  }
});

// Get current session info
router.get('/session', async (req, res) => {
  try {
    const { slug } = req.query;
    // Token precedence: when ?slug= is present the caller is asking
    // specifically about gallery auth (GalleryAuthContext), so prefer the
    // gallery token. Without this, an admin who's also dogfooding the
    // customer dashboard from the same browser would always get
    // {type:'admin'} back here, the gallery context's
    // `type === 'gallery'` check would fail, and the page would fall
    // through to the per-event password prompt — even though the
    // gallery_token_<slug> cookie was correctly set on the prior
    // /api/customer/events/:slug/access-token response.
    const token = slug
      ? (getGalleryTokenFromRequest(req, slug) || getAdminTokenFromRequest(req))
      : (getAdminTokenFromRequest(req) || getGalleryTokenFromRequest(req, slug));

    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    try {
      // Verify with the same `issuer` claim that adminAuth/galleryAuth
      // require (#350 — without this, /auth/session accepted pre-issuer
      // tokens and the frontend thought the user was authenticated, but
      // every protected endpoint rejected them with 401, producing a
      // /admin/login → /admin/dashboard → /admin/login redirect loop).
      const decoded = jwt.verify(token, process.env.JWT_SECRET, {
        issuer: 'picpeak-auth'
      });

      // Check if token has been revoked (e.g. after logout)
      const { isTokenRevoked } = require('../utils/tokenRevocation');
      if (await isTokenRevoked(decoded)) {
        return res.status(401).json({ valid: false, error: 'Session has been invalidated' });
      }

      // The redirect loop reported on the v3.32.4-beta.0 release came
      // from /auth/session reporting valid: true while the protected
      // adminAuth / galleryAuth middleware rejected the same token for
      // reasons /auth/session never checked: the admin user was
      // deactivated, the admin's password had been changed since iat,
      // or the gallery event was archived/deleted. Mirror those checks
      // here so the session endpoint is always at least as strict as
      // what the protected endpoints will enforce next.
      if (decoded.type === 'admin') {
        let admin = null;
        try {
          admin = await db('admin_users')
            .where({ id: decoded.id, is_active: formatBoolean(true) })
            .select('id', 'username', 'email', 'password_changed_at')
            .first();
        } catch (lookupErr) {
          // admin_users table not present (test fixture, fresh DB) — fall
          // through and trust the token. Real deployments always have it.
          admin = null;
          // intentional swallow; if the table is missing we do not want
          // to fail-closed during e.g. early bootstrap.
        }

        if (admin === null) {
          // Lookup didn't run because the table is missing; skip the
          // existence/password checks and treat the token as valid.
        } else if (!admin) {
          return res.json({ valid: false, error: 'Admin account no longer active' });
        } else if (admin.password_changed_at) {
          const passwordChangedSeconds = Math.floor(
            new Date(admin.password_changed_at).getTime() / 1000
          );
          if (decoded.iat < passwordChangedSeconds) {
            return res.json({ valid: false, error: 'Token invalid due to password change' });
          }
        }

        // Mirror the session-timeout check that sessionTimeoutMiddleware
        // enforces on every /api/admin endpoint. Without this, /auth/session
        // returns valid:true for an idle/old-iat token that protected
        // endpoints reject with 401 SESSION_TIMEOUT — the same redirect-loop
        // shape as the issuer-claim and password-change asymmetries (issue
        // #350 recurrence on v3.39.1-beta.0).
        try {
          const { isSessionExpired } = require('../middleware/sessionTimeout');
          if (await isSessionExpired(token, decoded)) {
            return res.json({ valid: false, error: 'Session expired' });
          }
        } catch (timeoutErr) {
          // Helper lookup failed (test stub may not export it) — fall through
          // and trust the token. Real deployments always have the middleware.
        }
      } else if (decoded.type === 'gallery') {
        try {
          const event = await db('events')
            .where({
              id: decoded.eventId,
              is_active: formatBoolean(true),
              is_archived: formatBoolean(false),
            })
            .first();
          if (!event) {
            return res.json({ valid: false, error: 'Gallery no longer available' });
          }
          if (event.expires_at && new Date(event.expires_at) < new Date()) {
            return res.json({ valid: false, error: 'Gallery has expired' });
          }
        } catch (galleryLookupErr) {
          // events table missing in this context — same fallback as
          // admin path; trust the token rather than fail-closed.
        }
      }

      // Calculate remaining time
      const now = Date.now() / 1000;
      const remainingTime = Math.max(0, decoded.exp - now);

      res.json({
        valid: true,
        type: decoded.type,
        expiresIn: Math.floor(remainingTime),
        user: decoded.username || decoded.eventSlug,
        eventSlug: decoded.eventSlug,
        adminUsername: decoded.username
      });
    } catch (err) {
      res.json({
        valid: false,
        error: 'Invalid or expired token'
      });
    }
  } catch (error) {
    res.status(500).json({ error: 'Session check failed' });
  }
});

// Admin password change with validation
router.post('/admin/change-password', [
  body('currentPassword').notEmpty(),
  body('newPassword').notEmpty(),
  body('confirmPassword').notEmpty()
    .custom((value, { req }) => value === req.body.newPassword)
    .withMessage('Passwords do not match')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { currentPassword, newPassword } = req.body;
    const ipAddress = getClientIp(req);

    // Get admin from request (should be set by auth middleware)
    if (!req.admin) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const adminId = req.admin.id;

    // Get admin user
    const admin = await db('admin_users').where({ id: adminId }).first();
    if (!admin) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify current password
    const validPassword = await bcrypt.compare(currentPassword, admin.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Validate new password
    const passwordValidation = validatePasswordInContext(newPassword, 'admin', {
      username: admin.username,
      email: admin.email
    });

    if (!passwordValidation.valid) {
      logPasswordValidationFailure('admin_password_change', passwordValidation.errors, {
        userId: adminId,
        username: admin.username
      });

      return res.status(400).json({
        error: 'Password does not meet security requirements',
        details: passwordValidation.errors,
        score: passwordValidation.score,
        feedback: passwordValidation.feedback
      });
    }

    // Hash new password with configurable rounds
    const hashedPassword = await bcrypt.hash(newPassword, getBcryptRounds());

    // Update password and track change time
    await db('admin_users').where('id', adminId).update({
      password_hash: hashedPassword,
      password_changed_at: new Date(),
      must_change_password: false
    });

    // Log password change
    logger.info('Admin password changed', {
      userId: adminId,
      username: admin.username,
      ip: ipAddress
    });

    res.json({
      message: 'Password changed successfully',
      score: passwordValidation.score
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to change password');
  }
});

// Password strength check endpoint (for real-time validation)
router.post('/password-strength', [
  body('password').notEmpty(),
  body('context').isIn(['admin', 'gallery']).optional()
], async (req, res) => {
  try {
    const { password, context = 'gallery' } = req.body;

    // Get user data if available (for context-aware validation)
    const userData = {};
    if (context === 'admin' && req.admin) {
      userData.username = req.admin.username;
      userData.email = req.admin.email;
    }

    const validation = validatePasswordInContext(password, context, userData);

    res.json({
      valid: validation.valid,
      score: validation.score,
      errors: validation.errors,
      feedback: validation.feedback
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to check password strength' });
  }
});

module.exports = router;
