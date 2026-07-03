'use strict';

// Public first-run setup endpoints. UNAUTHENTICATED by design — they exist so a
// fresh instance can create its first admin from the browser (no ADMIN_PASSWORD
// in .env). Both are hard-gated on "no admin exists yet", and POST /admin also
// requires the one-time setup token, so they self-close after setup. The POST is
// rate-limited at the mount point in server.js (authRateLimiter).
const express = require('express');
const { body, validationResult } = require('express-validator');
const setupService = require('../services/setupService');
const { getClientIp } = require('../utils/requestIp');
const { setAdminAuthCookie } = require('../utils/tokenUtils');
const logger = require('../utils/logger');

const router = express.Router();

router.get('/status', async (req, res) => {
  try {
    res.json(await setupService.getSetupStatus());
  } catch (err) {
    logger.error('[setup] status failed', { error: err.message });
    res.status(500).json({ error: 'Failed to read setup status' });
  }
});

// Step-1 pre-flight: validate the setup token without consuming it, so the
// two-step wizard can block "Continue" on a wrong token. Rate-limited at the
// mount point in server.js (authRateLimiter), same as POST /admin.
router.post('/verify-token', [
  body('token').notEmpty().withMessage('Setup token is required'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  try {
    const valid = await setupService.verifySetupToken(req.body.token);
    if (!valid) {
      return res.status(400).json({ error: 'Invalid setup token', field: 'token' });
    }
    return res.json({ valid: true });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message, field: err.details || undefined });
    }
    logger.error('[setup] verifyToken failed', { error: err.message });
    return res.status(500).json({ error: 'Setup failed' });
  }
});

router.post('/admin', [
  body('token').notEmpty().withMessage('Setup token is required'),
  body('email').isEmail().withMessage('A valid email is required'),
  body('password').notEmpty().withMessage('Password is required'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  try {
    const { token, email, password } = req.body;
    const result = await setupService.createInitialAdmin({
      token,
      email,
      password,
      ip: getClientIp(req),
    });
    setAdminAuthCookie(res, result.token);
    // Token delivered via HttpOnly cookie only (mirrors admin login).
    res.status(201).json({ user: result.user });
  } catch (err) {
    if (err.statusCode) {
      // `field` (token/email/password) lets the client show a translated
      // message instead of rendering the raw English error verbatim.
      return res.status(err.statusCode).json({ error: err.message, field: err.details || undefined });
    }
    logger.error('[setup] createInitialAdmin failed', { error: err.message });
    return res.status(500).json({ error: 'Setup failed' });
  }
});

module.exports = router;
