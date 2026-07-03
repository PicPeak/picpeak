/**
 * Admin CRUD for the branded URL shortener (#699).
 *
 * - GET    /api/admin/events/:eventId/short-urls   — list per event
 * - POST   /api/admin/events/:eventId/short-urls   — create (custom or auto-generated slug)
 * - DELETE /api/admin/short-urls/:id               — soft-delete
 *
 * All paths require admin auth + `settings.view` permission (read) /
 * `events.edit` permission (mutate) — short URLs are a per-event admin
 * concern, gated by the same permission as editing the event itself.
 */
const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { requireEventOwnership } = require('../middleware/ownership');
const galleryShortUrlService = require('../services/galleryShortUrlService');
const logger = require('../utils/logger');

const router = express.Router();

router.use(adminAuth);

/**
 * GET /api/admin/events/:eventId/short-urls
 * List live short URLs for an event.
 */
router.get(
  '/events/:eventId/short-urls',
  requirePermission('events.view'),
  param('eventId').isInt({ min: 1 }),
  requireEventOwnership,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      const rows = await galleryShortUrlService.listForEvent(parseInt(req.params.eventId, 10));
      res.json({ shortUrls: rows });
    } catch (err) {
      logger.error('adminShortUrls.list failed', { error: err.message, eventId: req.params.eventId });
      res.status(500).json({ error: 'Failed to list short URLs' });
    }
  },
);

/**
 * POST /api/admin/events/:eventId/short-urls
 * Body: { customSlug?: string }   — omit for auto-generated slug.
 */
router.post(
  '/events/:eventId/short-urls',
  requirePermission('events.edit'),
  param('eventId').isInt({ min: 1 }),
  body('customSlug').optional({ nullable: true })
    .isString().isLength({ min: 1, max: 64 }),
  requireEventOwnership,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      const row = await galleryShortUrlService.createShortUrl({
        eventId: parseInt(req.params.eventId, 10),
        customSlug: req.body.customSlug || null,
        createdBy: req.admin?.id || null,
      });
      res.status(201).json(row);
    } catch (err) {
      // Structured-error fallthrough — the service tags collisions and
      // validation failures with a `code` so the UI can surface a
      // useful message + a suggested alternative slug.
      if (err.code === 'INVALID_SLUG') {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      if (err.code === 'SLUG_TAKEN') {
        return res.status(409).json({
          error: err.message, code: err.code, suggested: err.suggested,
        });
      }
      if (err.code === 'EVENT_NOT_FOUND') {
        return res.status(404).json({ error: err.message, code: err.code });
      }
      logger.error('adminShortUrls.create failed', { error: err.message });
      res.status(500).json({ error: 'Failed to create short URL' });
    }
  },
);

/**
 * DELETE /api/admin/short-urls/:id
 * Soft-delete. The public route serves 410 Gone on a deleted row so the
 * admin can tell their delete worked (vs. 404 for an unknown slug).
 */
router.delete(
  '/short-urls/:id',
  requirePermission('events.edit'),
  param('id').isInt({ min: 1 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      const ok = await galleryShortUrlService.softDelete(
        parseInt(req.params.id, 10),
        req.admin?.id || null,
      );
      if (!ok) return res.status(404).json({ error: 'Short URL not found' });
      res.status(204).end();
    } catch (err) {
      logger.error('adminShortUrls.delete failed', { error: err.message });
      res.status(500).json({ error: 'Failed to delete short URL' });
    }
  },
);

module.exports = router;
