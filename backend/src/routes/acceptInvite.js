/**
 * Accept Invitation Routes (Public)
 * Handles invitation token validation and account creation
 */

const express = require('express');
const { body, param } = require('express-validator');
const { handleAsync, validateRequest, successResponse } = require('../utils/routeHelpers');
const { validatePasswordStrength } = require('../utils/passwordGenerator');
const userManagementService = require('../services/userManagementService');
const router = express.Router();

/**
 * GET /:token
 * Validate invitation token
 * Public endpoint - no auth required
 */
router.get('/:token', [
  param('token').isLength({ min: 64, max: 64 }).withMessage('Invalid invitation token')
], handleAsync(async (req, res) => {
  validateRequest(req);

  const invitation = await userManagementService.validateInvitationToken(req.params.token);

  if (!invitation) {
    return res.status(404).json({ error: 'Invalid or expired invitation' });
  }

  res.json({
    valid: true,
    email: invitation.email,
    role: invitation.role_name,
    expiresAt: invitation.expires_at
  });
}));

/**
 * POST /:token
 * Accept invitation and create account
 * Public endpoint - no auth required
 */
router.post('/:token', [
  param('token').isLength({ min: 64, max: 64 }).withMessage('Invalid invitation token'),
  body('username')
    .trim()
    .isLength({ min: 3, max: 50 })
    .withMessage('Username must be 3-50 characters')
    .matches(/^[a-zA-Z0-9_-]+$/)
    .withMessage('Username can only contain letters, numbers, underscores, and hyphens'),
  body('password')
    .isLength({ min: 12 })
    .withMessage('Password must be at least 12 characters')
    .custom((value) => {
      const validation = validatePasswordStrength(value);
      if (!validation.isValid) {
        throw new Error(validation.messages.join(', '));
      }
      return true;
    })
], handleAsync(async (req, res) => {
  validateRequest(req);

  const result = await userManagementService.acceptInvitation({
    token: req.params.token,
    username: req.body.username,
    password: req.body.password
  });

  successResponse(res, {
    message: 'Account created successfully. You can now log in.',
    email: result.email
  }, 201);
}));

module.exports = router;
