/**
 * Admin endpoints for managing outbound webhooks (#327). Mirrors
 * adminApiTokens.js — same permission gates, same "secret shown once"
 * pattern.
 *
 * Routes mounted under /api/admin/webhooks:
 *   GET    /                                — list
 *   POST   /                                — create (returns plaintext secret once)
 *   GET    /:id                             — detail (no secret)
 *   PUT    /:id                             — update name/url/events/active
 *   DELETE /:id                             — delete (cascades to deliveries)
 *   POST   /:id/test                        — fire a synthetic delivery now
 *   GET    /:id/deliveries                  — list deliveries (paginated, filter)
 *   GET    /:id/deliveries/:deliveryId      — delivery detail (payload+response)
 *   POST   /:id/deliveries/:deliveryId/replay — re-enqueue a delivery
 */

const express = require('express');
const { body, query, validationResult } = require('express-validator');
const { db, logActivity } = require('../database/db');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { validateExternalUrl } = require('../utils/networkValidation');
const webhookService = require('../services/webhookService');
const logger = require('../utils/logger');

const router = express.Router();

const ALLOW_PRIVATE_URLS = process.env.WEBHOOK_ALLOW_PRIVATE_URLS === 'true';

function publicWebhook(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    events: typeof row.events === 'string' ? safeJson(row.events, []) : (row.events || []),
    active: row.active,
    secret_preview: row.secret_preview,
    filter: typeof row.filter === 'string' ? safeJson(row.filter, {}) : (row.filter || {}),
    template: row.template || null,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_success_at: row.last_success_at,
    last_failure_at: row.last_failure_at,
  };
}

function safeJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

// ─── List ────────────────────────────────────────────────────────────────
router.get('/', adminAuth, requirePermission('settings.view'), async (req, res) => {
  try {
    const rows = await db('webhooks')
      .leftJoin('admin_users', 'admin_users.id', 'webhooks.created_by')
      .select(
        'webhooks.*',
        'admin_users.username as owner_username'
      )
      .orderBy('webhooks.created_at', 'desc');
    res.json(rows.map((r) => ({
      ...publicWebhook(r),
      owner_username: r.owner_username,
    })));
  } catch (err) {
    logger.error('webhooks list failed', { error: err.message });
    res.status(500).json({ error: 'Failed to list webhooks' });
  }
});

// ─── Create ──────────────────────────────────────────────────────────────
router.post(
  '/',
  adminAuth,
  requirePermission('settings.edit'),
  [
    body('name').isString().trim().isLength({ min: 1, max: 100 }),
    body('url').isString().isLength({ max: 2048 }).custom((url) => {
      if (ALLOW_PRIVATE_URLS) return true;
      const check = validateExternalUrl(url);
      if (!check.valid) throw new Error(check.error);
      return true;
    }),
    body('events').isArray({ min: 1 }).custom((arr) => {
      const ok = arr.every((e) => webhookService.EVENT_TYPES.includes(e));
      if (!ok) throw new Error(`events must be a subset of: ${webhookService.EVENT_TYPES.join(', ')}`);
      return true;
    }),
    body('active').optional().isBoolean(),
    body('filter').optional().custom((v) => {
      if (v == null) return true;
      if (typeof v !== 'object' || Array.isArray(v)) {
        throw new Error('filter must be an object of dot-path → value pairs');
      }
      return true;
    }),
    body('template').optional({ nullable: true }).custom((v) => {
      const check = webhookService.validateTemplate(v);
      if (!check.valid) throw new Error(check.error);
      return true;
    }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { name, url, events, active = true, filter, template } = req.body;
      const { plaintext, preview } = webhookService.generateSecret();

      const insertResult = await db('webhooks').insert({
        name,
        url,
        secret: plaintext,
        secret_preview: preview,
        events: JSON.stringify(events),
        active,
        filter: JSON.stringify(filter || {}),
        template: template || null,
        created_by: req.admin.id,
      }).returning('id');
      const id = insertResult[0]?.id || insertResult[0];

      await logActivity('webhook_created', { name, events }, null, {
        type: 'admin', id: req.admin.id, name: req.admin.username,
      });

      const row = await db('webhooks').where({ id }).first();
      res.status(201).json({
        ...publicWebhook(row),
        secret: plaintext,
        notice: 'Save this signing secret now — it will not be shown again.',
      });
    } catch (err) {
      logger.error('webhooks create failed', { error: err.message });
      res.status(500).json({ error: 'Failed to create webhook' });
    }
  }
);

// ─── Detail ──────────────────────────────────────────────────────────────
router.get('/:id', adminAuth, requirePermission('settings.view'), async (req, res) => {
  try {
    const row = await db('webhooks').where({ id: req.params.id }).first();
    if (!row) return res.status(404).json({ error: 'Webhook not found' });
    res.json(publicWebhook(row));
  } catch (err) {
    logger.error('webhooks detail failed', { error: err.message });
    res.status(500).json({ error: 'Failed to load webhook' });
  }
});

// ─── Update ──────────────────────────────────────────────────────────────
router.put(
  '/:id',
  adminAuth,
  requirePermission('settings.edit'),
  [
    body('name').optional().isString().trim().isLength({ min: 1, max: 100 }),
    body('url').optional().isString().isLength({ max: 2048 }).custom((url) => {
      if (ALLOW_PRIVATE_URLS) return true;
      const check = validateExternalUrl(url);
      if (!check.valid) throw new Error(check.error);
      return true;
    }),
    body('events').optional().isArray({ min: 1 }).custom((arr) => {
      const ok = arr.every((e) => webhookService.EVENT_TYPES.includes(e));
      if (!ok) throw new Error(`events must be a subset of: ${webhookService.EVENT_TYPES.join(', ')}`);
      return true;
    }),
    body('active').optional().isBoolean(),
    body('filter').optional().custom((v) => {
      if (v == null) return true;
      if (typeof v !== 'object' || Array.isArray(v)) {
        throw new Error('filter must be an object of dot-path → value pairs');
      }
      return true;
    }),
    body('template').optional({ nullable: true }).custom((v) => {
      const check = webhookService.validateTemplate(v);
      if (!check.valid) throw new Error(check.error);
      return true;
    }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const row = await db('webhooks').where({ id: req.params.id }).first();
      if (!row) return res.status(404).json({ error: 'Webhook not found' });

      const updates = { updated_at: new Date() };
      if ('name' in req.body) updates.name = req.body.name;
      if ('url' in req.body) updates.url = req.body.url;
      if ('events' in req.body) updates.events = JSON.stringify(req.body.events);
      if ('active' in req.body) updates.active = req.body.active;
      if ('filter' in req.body) updates.filter = JSON.stringify(req.body.filter || {});
      if ('template' in req.body) updates.template = req.body.template || null;

      await db('webhooks').where({ id: req.params.id }).update(updates);
      const updated = await db('webhooks').where({ id: req.params.id }).first();

      await logActivity('webhook_updated', { changes: Object.keys(updates) }, null, {
        type: 'admin', id: req.admin.id, name: req.admin.username,
      });

      res.json(publicWebhook(updated));
    } catch (err) {
      logger.error('webhooks update failed', { error: err.message });
      res.status(500).json({ error: 'Failed to update webhook' });
    }
  }
);

// ─── Delete ──────────────────────────────────────────────────────────────
router.delete('/:id', adminAuth, requirePermission('settings.edit'), async (req, res) => {
  try {
    const row = await db('webhooks').where({ id: req.params.id }).first();
    if (!row) return res.status(404).json({ error: 'Webhook not found' });
    await db('webhooks').where({ id: req.params.id }).delete();
    await logActivity('webhook_deleted', { name: row.name }, null, {
      type: 'admin', id: req.admin.id, name: req.admin.username,
    });
    res.json({ id: Number(req.params.id), deleted: true });
  } catch (err) {
    logger.error('webhooks delete failed', { error: err.message });
    res.status(500).json({ error: 'Failed to delete webhook' });
  }
});

// ─── Send test event ─────────────────────────────────────────────────────
router.post(
  '/:id/test',
  adminAuth,
  requirePermission('settings.edit'),
  [body('event_type').optional().isIn(webhookService.EVENT_TYPES)],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const row = await db('webhooks').where({ id: req.params.id }).first();
      if (!row) return res.status(404).json({ error: 'Webhook not found' });
      if (!row.active) return res.status(400).json({ error: 'Webhook is disabled' });

      const eventType = req.body.event_type || (() => {
        const subscribed = typeof row.events === 'string' ? safeJson(row.events, []) : (row.events || []);
        return subscribed[0] || 'event.published';
      })();

      // Fire a synthetic event WITHOUT writing to webhooks table — the test
      // bypasses subscription matching by inserting a delivery directly.
      const crypto = require('crypto');
      const deliveryId = crypto.randomUUID();
      const payload = {
        id: deliveryId,
        type: eventType,
        created_at: new Date().toISOString(),
        data: { test: true, fired_by: req.admin.username, webhook_id: row.id },
      };
      await db('webhook_deliveries').insert({
        webhook_id: row.id,
        event_type: eventType,
        payload: JSON.stringify(payload),
        attempt_count: 0,
        status: 'pending',
        next_retry_at: new Date(),
        created_at: new Date(),
      });

      res.status(202).json({ enqueued: true, event_type: eventType });
    } catch (err) {
      logger.error('webhook test failed', { error: err.message });
      res.status(500).json({ error: 'Failed to enqueue test event' });
    }
  }
);

// ─── List deliveries ─────────────────────────────────────────────────────
router.get(
  '/:id/deliveries',
  adminAuth,
  requirePermission('settings.view'),
  [
    query('status').optional().isIn(['pending', 'success', 'failed']),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const webhookId = req.params.id;
      const exists = await db('webhooks').where({ id: webhookId }).first();
      if (!exists) return res.status(404).json({ error: 'Webhook not found' });

      const page = parseInt(req.query.page || '1', 10);
      const limit = parseInt(req.query.limit || '25', 10);
      const offset = (page - 1) * limit;

      let q = db('webhook_deliveries').where({ webhook_id: webhookId });
      if (req.query.status) q = q.where({ status: req.query.status });

      const totalRow = await q.clone().count('id as count').first();
      const total = parseInt(totalRow?.count || 0, 10);

      const rows = await q
        .select(
          'id', 'event_type', 'attempt_count', 'status', 'response_status',
          'latency_ms', 'next_retry_at', 'created_at', 'completed_at', 'last_error'
        )
        .orderBy('created_at', 'desc')
        .limit(limit)
        .offset(offset);

      res.json({ deliveries: rows, pagination: { page, limit, total } });
    } catch (err) {
      logger.error('deliveries list failed', { error: err.message });
      res.status(500).json({ error: 'Failed to list deliveries' });
    }
  }
);

// ─── Delivery detail ─────────────────────────────────────────────────────
router.get(
  '/:id/deliveries/:deliveryId',
  adminAuth,
  requirePermission('settings.view'),
  async (req, res) => {
    try {
      const row = await db('webhook_deliveries')
        .where({ id: req.params.deliveryId, webhook_id: req.params.id })
        .first();
      if (!row) return res.status(404).json({ error: 'Delivery not found' });
      res.json({
        ...row,
        payload: typeof row.payload === 'string' ? safeJson(row.payload, row.payload) : row.payload,
      });
    } catch (err) {
      logger.error('delivery detail failed', { error: err.message });
      res.status(500).json({ error: 'Failed to load delivery' });
    }
  }
);

// ─── Replay ──────────────────────────────────────────────────────────────
router.post(
  '/:id/deliveries/:deliveryId/replay',
  adminAuth,
  requirePermission('settings.edit'),
  async (req, res) => {
    try {
      const row = await db('webhook_deliveries')
        .where({ id: req.params.deliveryId, webhook_id: req.params.id })
        .first();
      if (!row) return res.status(404).json({ error: 'Delivery not found' });

      // Re-enqueue: copy the original payload + event_type into a new row
      // marked pending. Preserves the audit log of the original attempt.
      const crypto = require('crypto');
      const newPayload = (() => {
        const obj = typeof row.payload === 'string' ? safeJson(row.payload, {}) : row.payload || {};
        // Replays get a fresh delivery id but keep the event payload data.
        return JSON.stringify({ ...obj, id: crypto.randomUUID(), replayed_from: row.id });
      })();
      const insertResult = await db('webhook_deliveries').insert({
        webhook_id: row.webhook_id,
        event_type: row.event_type,
        payload: newPayload,
        attempt_count: 0,
        status: 'pending',
        next_retry_at: new Date(),
        created_at: new Date(),
      }).returning('id');
      const newId = insertResult[0]?.id || insertResult[0];
      res.status(202).json({ enqueued: true, original_id: row.id, replay_id: newId });
    } catch (err) {
      logger.error('delivery replay failed', { error: err.message });
      res.status(500).json({ error: 'Failed to replay delivery' });
    }
  }
);

module.exports = router;
