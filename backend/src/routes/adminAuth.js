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
const { setAdminAuthCookie } = require('../utils/tokenUtils');
const { IDENTITY_PRESERVING_NORMALIZE_EMAIL } = require('../utils/emailNormalization');
const router = express.Router();

// Get admin profile
router.get('/profile', adminAuth, handleAsync(async (req, res) => {
  const admin = await db('admin_users')
    .where('id', req.admin.id)
    .select('id', 'username', 'email', 'last_login', 'last_login_ip', 'created_at', 'updated_at', 'must_change_password as mustChangePassword')
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

  // Check for email conflict
  const existingEmail = await db('admin_users')
    .where('email', email)
    .whereNot('id', adminId)
    .first();

  if (existingEmail) {
    throw new ConflictError('Email address is already in use', 'email');
  }

  await db('admin_users')
    .where('id', adminId)
    .update({
      username,
      email,
      updated_at: new Date()
    });

  await logActivity('admin_profile_updated',
    { username, email },
    null,
    { type: 'admin', id: adminId, name: req.admin.username }
  );

  const updatedAdmin = await db('admin_users')
    .where('id', adminId)
    .select('id', 'username', 'email', 'must_change_password as mustChangePassword')
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
    loginTime: Date.now()
  }, process.env.JWT_SECRET, {
    expiresIn: '24h',
    issuer: 'picpeak-auth'
  });

  setAdminAuthCookie(res, newToken);

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
  // Get token from header
  const token = req.headers.authorization?.split(' ')[1];
  if (token) {
    // End the session
    endSession(token);
  }

  // Log activity
  await logActivity('admin_logout',
    { admin_id: req.admin.id },
    null,
    { type: 'admin', id: req.admin.id, name: req.admin.username }
  );

  successResponse(res, { message: 'Logged out successfully' });
}));

module.exports = router;
