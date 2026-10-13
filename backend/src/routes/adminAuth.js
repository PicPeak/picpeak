const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body } = require('express-validator');
const { db, logActivity } = require('../database/db');
const { adminAuth } = require('../middleware/auth');
const { endSession } = require('../middleware/sessionTimeout');
const { validatePasswordStrength } = require('../utils/passwordGenerator');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const { NotFoundError, ConflictError, ValidationError } = require('../utils/errors');
const { setAdminAuthCookie, clearAdminAuthCookie } = require('../utils/tokenUtils');
const { IDENTITY_PRESERVING_NORMALIZE_EMAIL } = require('../utils/emailNormalization');
const { formatBoolean } = require('../utils/dbCompat');
const { hasColumnCached } = require('../utils/schemaCache');
const mfaService = require('../services/mfaService');
const passkeyService = require('../services/passkeyService');
const { accountCreditName } = require('../services/photoCredit');
const router = express.Router();

// Get admin profile
router.get('/profile', adminAuth, handleAsync(async (req, res) => {
  const columns = ['id', 'username', 'email', 'last_login', 'last_login_ip', 'created_at', 'updated_at', 'must_change_password as mustChangePassword'];
  // Photo credit for this account's uploads (issue 743, migration 269).
  if (await hasColumnCached('admin_users', 'credit_name')) columns.push('credit_name as creditName');
  const admin = await db('admin_users')
    .where('id', req.admin.id)
    .select(columns)
    .first();

  if (!admin) {
    throw new NotFoundError('Admin user');
  }

  res.json(admin);
}));

// Update admin profile
router.put('/profile', [
  adminAuth,
  body('username')
    .trim()
    .isLength({ min: 3, max: 50 })
    .withMessage('Username must be between 3 and 50 characters'),
  body('email')
    .trim()
    .isEmail()
    .withMessage('A valid email address is required')
    .normalizeEmail(IDENTITY_PRESERVING_NORMALIZE_EMAIL)
], handleAsync(async (req, res) => {
  validateRequest(req);

  const username = req.body.username.trim();
  const email = req.body.email.trim().toLowerCase();
  const adminId = req.admin.id;

  // Check for username conflict
  const existingUsername = await db('admin_users')
    .where('username', username)
    .whereNot('id', adminId)
    .first();

  if (existingUsername) {
    throw new ConflictError('Username is already in use', 'username');
  }

  // Check for email conflict, without case — a rule that only holds on the
  // user-management route is not a rule, and two rows differing only in case
  // would both answer to one lowercased IdP claim.
  const existingEmail = await db('admin_users')
    .whereRaw('LOWER(email) = ?', [String(email).toLowerCase()])
    .whereNot('id', adminId)
    .first();

  if (existingEmail) {
    throw new ConflictError('Email address is already in use', 'email');
  }

  const updates = { username, email, updated_at: new Date() };
  // The name this account's uploads are credited with when a file carries no
  // EXIF name (issue 743). Optional; absent leaves it as it is.
  if (Object.prototype.hasOwnProperty.call(req.body, 'credit_name')
    && await hasColumnCached('admin_users', 'credit_name')) {
    const credit = accountCreditName(req.body.credit_name);
    if (credit.error) throw new ValidationError(credit.error);
    updates.credit_name = credit.value;
  }
  // A self-typed email is not proof of owning the address, so it must not let
  // a later SSO login link to this account by email (oidcService,
  // migration 227). A super_admin's own change stays trusted.
  const current = await db('admin_users').where('id', adminId).select('email').first();
  if (current && String(current.email || '').toLowerCase() !== email && req.admin.roleName !== 'super_admin'
      && await hasColumnCached('admin_users', 'email_link_eligible')) {
    updates.email_link_eligible = formatBoolean(false);
  }

  await db('admin_users')
    .where('id', adminId)
    .update(updates);

  await logActivity('admin_profile_updated',
    { username, email },
    null,
    { type: 'admin', id: adminId, name: req.admin.username }
  );

  const updatedColumns = ['id', 'username', 'email', 'must_change_password as mustChangePassword'];
  if (await hasColumnCached('admin_users', 'credit_name')) updatedColumns.push('credit_name as creditName');
  const updatedAdmin = await db('admin_users')
    .where('id', adminId)
    .select(updatedColumns)
    .first();

  successResponse(res, {
    message: 'Admin profile updated successfully',
    user: updatedAdmin
  });
}));

// Change password
router.post('/change-password', [
  adminAuth,
  body('currentPassword').notEmpty().withMessage('Current password is required'),
  body('newPassword').isLength({ min: 12 }).withMessage('New password must be at least 12 characters')
], handleAsync(async (req, res) => {
  validateRequest(req);

  const { currentPassword, newPassword } = req.body;
  const userId = req.admin.id;
  // The session being replaced was or wasn't a remembered one; the new token
  // has to inherit that (#1186).
  const rememberMe = req.admin.rememberMe === true;

  // Validate new password strength
  const passwordValidation = validatePasswordStrength(newPassword);
  if (!passwordValidation.isValid) {
    throw new ValidationError('Password does not meet security requirements', passwordValidation.messages);
  }

  // Get user from database
  const user = await db('admin_users')
    .where('id', userId)
    .first();

  if (!user) {
    throw new NotFoundError('User');
  }

  // Verify current password
  const validPassword = await bcrypt.compare(currentPassword, user.password_hash);
  if (!validPassword) {
    throw new ValidationError('Current password is incorrect');
  }

  // Hash new password with more rounds
  const newPasswordHash = await bcrypt.hash(newPassword, 12);

  // Update password, set password_changed_at to invalidate existing tokens, and clear must_change_password flag
  const now = new Date();
  await db('admin_users')
    .where('id', userId)
    .update({
      password_hash: newPasswordHash,
      password_changed_at: now,
      must_change_password: false,
      updated_at: now
    });

  // Issue a new token so the session remains valid after password_changed_at invalidated the old one.
  // Set iat to 1 second after password_changed_at to guarantee the token passes the
  // "iat < password_changed_at" check in auth middleware (password_changed_at has ms precision
  // but JWT iat is floored to seconds, which can cause the new token to be rejected).
  const iatAfterPasswordChange = Math.floor(now.getTime() / 1000) + 1;
  const newToken = jwt.sign({
    id: user.id,
    username: user.username,
    type: 'admin',
    role: user.role_name,
    iat: iatAfterPasswordChange,
    loginTime: Date.now(),
    // Must ride along in the payload too, or the reissued session loses its
    // exemption from the idle timeout and dies within the hour.
    rememberMe
  }, process.env.JWT_SECRET, {
    // Carried from the session being replaced (#1186): a password change —
    // which is mandatory for new and reset accounts — would otherwise drop a
    // remembered admin straight back to 24h.
    expiresIn: rememberMe ? '30d' : '24h',
    issuer: 'picpeak-auth'
  });

  setAdminAuthCookie(res, newToken, { rememberMe });

  // Log activity
  await logActivity('password_changed',
    { admin_id: userId },
    null,
    { type: 'admin', id: userId, name: user.username }
  );

  successResponse(res, { message: 'Password changed successfully' });
}));

// Logout
router.post('/logout', adminAuth, handleAsync(async (req, res) => {
  // Use the token adminAuth actually authenticated with (req.token) — it may
  // have come from the admin_token cookie, not the Authorization header. The
  // old header-only read skipped revocation entirely for cookie-based logout,
  // leaving the JWT valid until expiry while reporting a successful logout.
  const token = req.token;
  clearAdminAuthCookie(res);
  if (token) {
    // End the in-memory session AND revoke the JWT (GHSA-cjqh) — the token
    // is otherwise valid until expiry, so photoAuth/adminAuth would keep
    // honouring it after logout. isTokenRevoked() checks this store.
    endSession(token);
    const { revokeToken } = require('../utils/tokenRevocation');
    if (!await revokeToken(token, 'logout')) {
      throw new Error('Token revocation failed');
    }
  }

  // Log activity
  await logActivity('admin_logout',
    { admin_id: req.admin.id },
    null,
    { type: 'admin', id: req.admin.id, name: req.admin.username }
  );

  successResponse(res, { message: 'Logged out successfully' });
}));

// ---------------------------------------------------------------------------
// Multi-factor authentication (TOTP) — issue #738.
//
// All endpoints operate on the AUTHENTICATED admin's own account
// (req.admin.id) — enrollment is per-user and works for every role,
// super_admin included (closes #735). The TOTP secret is stored encrypted
// at rest and recovery codes are hashed; see services/mfaService.js.
// ---------------------------------------------------------------------------

const isMfaEnabled = mfaService.isEnrolled;

// Current MFA state for the logged-in admin.
router.get('/mfa/status', adminAuth, handleAsync(async (req, res) => {
  const admin = await db('admin_users').where('id', req.admin.id).first();
  if (!admin) throw new NotFoundError('Admin user');
  const enabled = isMfaEnabled(admin);
  res.json({
    enabled,
    enrolledAt: enabled ? admin.two_factor_enrolled_at || null : null,
    recoveryCodesRemaining: enabled
      ? mfaService.parseRecoveryCodes(admin.two_factor_recovery_codes).length
      : 0
  });
}));

// Begin enrollment: mint a provisional secret, store it encrypted (NOT yet
// enabled), and return the otpauth URI + QR for the authenticator app. Calling
// this again before /enable simply regenerates the provisional secret.
router.post('/mfa/setup', adminAuth, handleAsync(async (req, res) => {
  const admin = await db('admin_users').where('id', req.admin.id).first();
  if (!admin) throw new NotFoundError('Admin user');
  if (isMfaEnabled(admin)) {
    throw new ConflictError('Two-factor authentication is already enabled');
  }

  const secret = mfaService.generateSecret();
  await db('admin_users').where('id', admin.id).update({
    two_factor_secret: mfaService.encryptSecret(secret),
    two_factor_enabled: false,
    two_factor_recovery_codes: null,
    two_factor_enrolled_at: null,
    updated_at: new Date()
  });

  const accountName = admin.email || admin.username;
  const otpauthUri = mfaService.buildOtpauthUri(accountName, secret);
  const qr = await mfaService.buildQrDataUrl(otpauthUri);

  res.json({
    // `secret` is returned for manual entry when a QR can't be scanned.
    secret,
    otpauthUri,
    qr,
    issuer: mfaService.ISSUER,
    account: accountName
  });
}));

// Complete enrollment: verify a code against the provisional secret, enable
// MFA, and return one-time recovery codes (shown exactly once).
//
// No replay tracking here: this confirms an already-authenticated session
// still holds the authenticator (no new session is granted), and starting
// the last-used-step counter here would reject the very next login if it
// lands in the same 30s TOTP step as this call.
router.post('/mfa/enable', [
  adminAuth,
  body('code').notEmpty().withMessage('Verification code is required')
], handleAsync(async (req, res) => {
  validateRequest(req);
  const admin = await db('admin_users').where('id', req.admin.id).first();
  if (!admin) throw new NotFoundError('Admin user');
  if (isMfaEnabled(admin)) {
    throw new ConflictError('Two-factor authentication is already enabled');
  }
  if (!admin.two_factor_secret) {
    throw new ValidationError('Start setup before enabling two-factor authentication');
  }
  if (!mfaService.verifyTotpEncrypted(req.body.code, admin.two_factor_secret)) {
    throw new ValidationError('Invalid verification code');
  }

  const { plain, hashed } = await mfaService.generateRecoveryCodes();
  await db('admin_users').where('id', admin.id).update({
    two_factor_enabled: true,
    two_factor_enrolled_at: new Date(),
    two_factor_recovery_codes: JSON.stringify(hashed),
    updated_at: new Date()
  });

  await logActivity('admin_mfa_enabled',
    { admin_id: admin.id },
    null,
    { type: 'admin', id: admin.id, name: admin.username }
  );

  successResponse(res, {
    message: 'Two-factor authentication enabled',
    recoveryCodes: plain
  });
}));

// Disable MFA. Requires a fresh TOTP or recovery code so a hijacked session
// can't silently strip the second factor.
router.post('/mfa/disable', [
  adminAuth,
  body('code').notEmpty().withMessage('A current code is required to disable 2FA')
], handleAsync(async (req, res) => {
  validateRequest(req);
  const admin = await db('admin_users').where('id', req.admin.id).first();
  if (!admin) throw new NotFoundError('Admin user');
  if (!isMfaEnabled(admin)) {
    throw new ValidationError('Two-factor authentication is not enabled');
  }

  // Persist the matched step atomically right here (see mfaService.persistTotpStep):
  // two concurrent requests carrying the same captured code can't both read the
  // same last-used step and both win — only the first writer's UPDATE affects a
  // row, so a losing concurrent request is correctly treated as invalid below.
  const totpStep = mfaService.verifyTotpEncryptedStep(
    req.body.code, admin.two_factor_secret, admin.two_factor_last_used_step
  );
  let totpOk = false;
  if (totpStep !== null) {
    totpOk = await mfaService.persistTotpStep(db, admin.id, totpStep, { updated_at: new Date() });
  }
  let recoveryOk = false;
  if (!totpOk) {
    const stored = mfaService.parseRecoveryCodes(admin.two_factor_recovery_codes);
    recoveryOk = (await mfaService.consumeRecoveryCode(req.body.code, stored)).matched;
  }
  if (!totpOk && !recoveryOk) {
    throw new ValidationError('Invalid verification code');
  }

  await db('admin_users').where('id', admin.id).update({
    two_factor_enabled: false,
    two_factor_secret: null,
    two_factor_recovery_codes: null,
    two_factor_enrolled_at: null,
    two_factor_last_used_step: null,
    updated_at: new Date()
  });

  await logActivity('admin_mfa_disabled',
    { admin_id: admin.id },
    null,
    { type: 'admin', id: admin.id, name: admin.username }
  );

  successResponse(res, { message: 'Two-factor authentication disabled' });
}));

// Regenerate recovery codes (invalidates the old set). Requires a fresh TOTP
// code. Returns the new codes once.
router.post('/mfa/recovery-codes', [
  adminAuth,
  body('code').notEmpty().withMessage('A current authenticator code is required')
], handleAsync(async (req, res) => {
  validateRequest(req);
  const admin = await db('admin_users').where('id', req.admin.id).first();
  if (!admin) throw new NotFoundError('Admin user');
  if (!isMfaEnabled(admin)) {
    throw new ValidationError('Two-factor authentication is not enabled');
  }
  // Persist the matched step atomically right here (see mfaService.persistTotpStep):
  // two concurrent requests carrying the same captured code can't both read the
  // same last-used step and both win — only the first writer's UPDATE affects a
  // row, so a losing concurrent request is correctly treated as invalid below.
  const totpStep = mfaService.verifyTotpEncryptedStep(
    req.body.code, admin.two_factor_secret, admin.two_factor_last_used_step
  );
  const totpOk = totpStep !== null
    && await mfaService.persistTotpStep(db, admin.id, totpStep, { updated_at: new Date() });
  if (!totpOk) {
    throw new ValidationError('Invalid verification code');
  }

  const { plain, hashed } = await mfaService.generateRecoveryCodes();
  await db('admin_users').where('id', admin.id).update({
    two_factor_recovery_codes: JSON.stringify(hashed),
    updated_at: new Date()
  });

  await logActivity('admin_mfa_recovery_regenerated',
    { admin_id: admin.id },
    null,
    { type: 'admin', id: admin.id, name: admin.username }
  );

  successResponse(res, {
    message: 'Recovery codes regenerated',
    recoveryCodes: plain
  });
}));

// ---------------------------------------------------------------------------
// Passkeys (WebAuthn), issue 1733.
//
// Like the MFA routes above, everything here acts on the AUTHENTICATED
// admin's own account. Verification is @simplewebauthn/server's; the
// surrounding rules live in services/passkeyService.js.
//
// A passkey is a full login method (it signs in without the password and
// counts as the second factor), so adding or removing one asks for the
// current password again: a hijacked session must not be able to plant a
// credential of its own or strip the owner's.
// ---------------------------------------------------------------------------

const passkeyFailure = (res, error) => res.status(error.status).json({ error: error.message, code: error.code });

// Why this account cannot use passkeys right now, or null when it can.
async function passkeyBlockReason(req, admin) {
  // SSO-only mode refuses every local login, passkeys included, and an
  // account owned by the identity provider never signs in locally at all.
  if (await require('../services/oidcService').isLocalLoginDisabled()) return 'sso_only';
  if (admin.auth_provider === 'oidc') return 'sso_account';
  const rp = await passkeyService.getRelyingParty(req);
  return rp.available ? null : rp.reason;
}

async function assertCurrentPassword(admin, currentPassword) {
  const ok = typeof currentPassword === 'string' && currentPassword.length > 0
    && admin.auth_provider !== 'oidc'
    && await bcrypt.compare(currentPassword, admin.password_hash || '');
  if (!ok) {
    const error = new ValidationError('Current password is incorrect');
    error.code = 'PASSWORD_INCORRECT';
    throw error;
  }
}

// The fresh second factor an account with two-factor authentication owes
// before a passkey is added: what /mfa/disable accepts, a current
// authenticator code or a recovery code. A passkey signs in without the code,
// so without this a stolen session plus the password would be enough to mint
// a way around the second factor. Both are spent here: the TOTP step is
// persisted (persistTotpStep) and a recovery code is removed by
// compare-and-set, as at login, so neither authorizes two requests.
async function assertFreshSecondFactor(admin, code) {
  const fail = (message, errorCode) => {
    const error = new ValidationError(message);
    error.code = errorCode;
    return error;
  };
  if (typeof code !== 'string' || !code.trim()) {
    throw fail('A current authenticator code is required to add a passkey', 'MFA_CODE_REQUIRED');
  }
  const totpStep = mfaService.verifyTotpEncryptedStep(
    code, admin.two_factor_secret, admin.two_factor_last_used_step
  );
  if (totpStep !== null
    && await mfaService.persistTotpStep(db, admin.id, totpStep, { updated_at: new Date() })) {
    return;
  }
  const stored = mfaService.parseRecoveryCodes(admin.two_factor_recovery_codes);
  const result = await mfaService.consumeRecoveryCode(code, stored);
  const consumed = result.matched ? await db('admin_users')
    .where('id', admin.id)
    .where('two_factor_recovery_codes', admin.two_factor_recovery_codes)
    .update({ two_factor_recovery_codes: JSON.stringify(result.remainingHashes), updated_at: new Date() }) : 0;
  if (consumed !== 1) throw fail('Invalid verification code', 'MFA_INVALID');
  await logActivity('admin_mfa_recovery_used',
    { admin_id: admin.id, remaining: result.remainingHashes.length },
    null,
    { type: 'admin', id: admin.id, name: admin.username }
  );
}

router.get('/passkeys', adminAuth, handleAsync(async (req, res) => {
  const admin = await db('admin_users').where('id', req.admin.id).first();
  if (!admin) throw new NotFoundError('Admin user');
  const rp = await passkeyService.getRelyingParty(req);
  const reason = await passkeyBlockReason(req, admin);
  const rows = await passkeyService.listForAdmin(admin.id);
  res.json({
    available: reason === null,
    reason,
    // The address passkeys are bound to, so the card can name it.
    rpId: rp.rpID || null,
    origin: rp.origin || null,
    max: passkeyService.MAX_PASSKEYS_PER_ADMIN,
    // Adding a passkey then asks for an authenticator code as well.
    mfaEnabled: isMfaEnabled(admin),
    passkeys: rows.map(passkeyService.publicView)
  });
}));

router.post('/passkeys/register/options', [
  adminAuth,
  body('currentPassword').isString().notEmpty().withMessage('Current password is required'),
  body('code').optional().isString().isLength({ max: 64 })
], handleAsync(async (req, res) => {
  validateRequest(req);
  const admin = await db('admin_users').where('id', req.admin.id).first();
  if (!admin) throw new NotFoundError('Admin user');
  const reason = await passkeyBlockReason(req, admin);
  if (reason) {
    return res.status(400).json({ error: 'Passkeys are not available', code: 'PASSKEY_UNAVAILABLE', reason });
  }
  await assertCurrentPassword(admin, req.body.currentPassword);
  // The second factor is checked after the password, so a wrong password
  // never spends a code, and as the last step before the challenge is issued,
  // so a request refused for another reason (the cap, no relying party) does
  // not spend one either. No challenge exists without it, and register/verify
  // only accepts a challenge from here.
  const authorize = isMfaEnabled(admin)
    ? () => assertFreshSecondFactor(admin, req.body.code)
    : undefined;
  try {
    res.json({ options: await passkeyService.beginRegistration(req, res, admin, { authorize }) });
  } catch (error) {
    if (error instanceof passkeyService.PasskeyError) return passkeyFailure(res, error);
    throw error;
  }
}));

router.post('/passkeys/register/verify', [
  adminAuth,
  body('response').isObject().withMessage('A passkey response is required'),
  body('name').optional().isString().isLength({ max: passkeyService.MAX_NAME_LENGTH })
], handleAsync(async (req, res) => {
  validateRequest(req);
  const admin = await db('admin_users').where('id', req.admin.id).first();
  if (!admin) throw new NotFoundError('Admin user');
  const reason = await passkeyBlockReason(req, admin);
  if (reason) {
    return res.status(400).json({ error: 'Passkeys are not available', code: 'PASSKEY_UNAVAILABLE', reason });
  }
  try {
    const passkey = await passkeyService.finishRegistration(req, res, admin, req.body.response, req.body.name);
    await logActivity('admin_passkey_added',
      { admin_id: admin.id, passkey_id: passkey.id, name: passkey.name },
      null,
      { type: 'admin', id: admin.id, name: admin.username }
    );
    successResponse(res, { message: 'Passkey added', passkey });
  } catch (error) {
    if (error instanceof passkeyService.PasskeyError) return passkeyFailure(res, error);
    throw error;
  }
}));

router.patch('/passkeys/:id', [
  adminAuth,
  body('name').isString().trim().isLength({ min: 1, max: passkeyService.MAX_NAME_LENGTH })
    .withMessage(`Name must be 1-${passkeyService.MAX_NAME_LENGTH} characters`)
], handleAsync(async (req, res) => {
  validateRequest(req);
  const id = Number(req.params.id);
  const updated = Number.isInteger(id) ? await db('admin_webauthn_credentials')
    .where({ id, admin_user_id: req.admin.id })
    .update({ name: passkeyService.cleanName(req.body.name) }) : 0;
  if (!updated) throw new NotFoundError('Passkey');
  successResponse(res, { message: 'Passkey renamed' });
}));

// POST rather than DELETE because it carries the current password, and a
// DELETE body does not survive every proxy.
router.post('/passkeys/:id/delete', [
  adminAuth,
  body('currentPassword').optional().isString()
], handleAsync(async (req, res) => {
  validateRequest(req);
  const admin = await db('admin_users').where('id', req.admin.id).first();
  if (!admin) throw new NotFoundError('Admin user');
  const id = Number(req.params.id);
  const passkey = Number.isInteger(id)
    ? await db('admin_webauthn_credentials').where({ id, admin_user_id: admin.id }).first()
    : null;
  if (!passkey) throw new NotFoundError('Passkey');

  // An account the identity provider owns has no local password to ask for,
  // and cannot sign in with a passkey either, so removing one costs nothing.
  const ssoAccount = admin.auth_provider === 'oidc';
  const hasPassword = !ssoAccount && Boolean(admin.password_hash);
  if (hasPassword) await assertCurrentPassword(admin, req.body.currentPassword);

  await db.transaction(async (trx) => {
    // Never remove the last way in: without a password (and without SSO) the
    // last passkey is the only login this account has. The account row is
    // locked first: on PostgreSQL two removals would otherwise both count two.
    await trx('admin_users').where('id', admin.id).forUpdate().first();
    if (!hasPassword && !ssoAccount && await passkeyService.countForAdmin(admin.id, trx) <= 1) {
      throw new ConflictError('This passkey is the only way to sign in to this account. Set a password first.');
    }
    await trx('admin_webauthn_credentials').where({ id: passkey.id, admin_user_id: admin.id }).del();
  });

  await logActivity('admin_passkey_removed',
    { admin_id: admin.id, passkey_id: passkey.id, name: passkey.name },
    null,
    { type: 'admin', id: admin.id, name: admin.username }
  );
  successResponse(res, { message: 'Passkey removed' });
}));

module.exports = router;
