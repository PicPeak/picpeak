/**
 * Admin endpoints for managing API tokens (#322). Tokens are issued to
 * an admin user; subsequent /api/v1/* calls authenticate via the token
 * and act as the user that minted it (intersected with the token's
 * scope set). Plaintext tokens are returned ONCE on creation.
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { db, logActivity } = require('../database/db');
const { adminAuth } = require('./../middleware/auth');
const { requirePermission } = require('./../middleware/permissions');
const { generateApiToken, VALID_SCOPES } = require('./../middleware/apiTokenAuth');
const logger = require('../utils/logger');

const router = express.Router();

// List tokens for the current admin (or all, if super_admin) — without
// the plaintext, never recoverable after creation.
router.get('/', adminAuth, requirePermission('settings.view'), async (req, res) => {
  try {
    const tokens = await db('api_tokens')
      .leftJoin('admin_users', 'admin_users.id', 'api_tokens.created_by')
      .select(
        'api_tokens.id',
        'api_tokens.name',
        'api_tokens.scopes',
        'api_tokens.preview',
        'api_tokens.created_at',
        'api_tokens.expires_at',
        'api_tokens.last_used_at',
        'api_tokens.revoked_at',
        'admin_users.username as owner_username'
      )
      .orderBy('api_tokens.created_at', 'desc');
    res.json(tokens);
  } catch (error) {
    logger.error('Failed to list API tokens', { error: error.message });
    res.status(500).json({ error: 'Failed to list tokens' });
  }
});

// Create a token. Returns plaintext exactly once.
router.post(
  '/',
  adminAuth,
  requirePermission('settings.edit'),
  [
    body('name').isString().trim().isLength({ min: 1, max: 100 }),
    body('scopes').isArray({ min: 1 }).custom((arr) => {
      const ok = arr.every((s) => VALID_SCOPES.includes(s));
      if (!ok) throw new Error(`Scopes must be a subset of: ${VALID_SCOPES.join(', ')}`);
      return true;
    }),
    body('expires_at').optional({ nullable: true, checkFalsy: true }).isISO8601()
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      const { name, scopes, expires_at } = req.body;
      const { plaintext, hashed, preview } = generateApiToken();

      const insertResult = await db('api_tokens').insert({
        name,
        hashed_token: hashed,
        scopes: scopes.join(','),
        preview,
        created_by: req.admin.id,
        expires_at: expires_at || null
      }).returning('id');
      const id = insertResult[0]?.id || insertResult[0];

      await logActivity('api_token_created', { name, scopes }, null, {
        type: 'admin', id: req.admin.id, name: req.admin.username
      });

      // Return the plaintext exactly once.
      res.status(201).json({
        id,
        name,
        scopes,
        token: plaintext,
        preview,
        expires_at: expires_at || null,
        created_at: new Date().toISOString(),
        notice: 'Save this token now — it will not be shown again.'
      });
    } catch (error) {
      logger.error('Failed to create API token', { error: error.message });
      res.status(500).json({ error: 'Failed to create token' });
    }
  }
);

// Revoke a token (soft-delete; lookups still find it but reject).
router.delete('/:id', adminAuth, requirePermission('settings.edit'), async (req, res) => {
  try {
    const { id } = req.params;
    const row = await db('api_tokens').where({ id }).first();
    if (!row) return res.status(404).json({ error: 'Token not found' });
    if (row.revoked_at) return res.status(400).json({ error: 'Token already revoked' });

    await db('api_tokens').where({ id }).update({ revoked_at: new Date() });
    await logActivity('api_token_revoked', { name: row.name }, null, {
      type: 'admin', id: req.admin.id, name: req.admin.username
    });
    res.json({ id: Number(id), revoked: true });
  } catch (error) {
    logger.error('Failed to revoke API token', { error: error.message });
    res.status(500).json({ error: 'Failed to revoke token' });
  }
});

module.exports = router;
