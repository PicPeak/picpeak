/**
 * Admin Photo Export Routes
 * Handles filtering and exporting photos based on guest feedback
 */

const express = require('express');
const { capabilityEvidence } = require('../usage/capabilityEvidence');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { db, withRetry } = require('../database/db');
const { livePhotos } = require('../utils/photoVisibility');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { requireEventOwnership } = require('../middleware/ownership');
const { PhotoFilterBuilder } = require('../utils/photoFilterBuilder');
const { safeValidationErrors } = require('../utils/routeHelpers');
const { PhotoExportService } = require('../services/photoExportService');
const photoAdminMarksService = require('../services/photoAdminMarksService');
const feedbackService = require('../services/feedbackService');
const logger = require('../utils/logger');

const exportService = new PhotoExportService();

/**
 * GET /api/admin/photo-export/:eventId/filter-summary
 * Get just the summary counts for filter UI
 */
router.get('/:eventId/filter-summary', adminAuth, requirePermission('photos.view'), requireEventOwnership, async (req, res) => {
  try {
    const eventId = parseInt(req.params.eventId);
    const { identity_mode: identityMode } =
      await feedbackService.getEventFeedbackSettings(eventId);

    const summary = await withRetry(() =>
      PhotoFilterBuilder.getSummary(db, eventId, identityMode)
    );

    // Per-colour counts for the caller's OWN marks (#1044 follow-up), so the
    // "My marks" chips can show numbers the way the client-selection chips do.
    const myColorLabelCounts = await withRetry(() =>
      photoAdminMarksService.getEventMarkColorCounts(eventId, req.admin.id)
    );

    res.json({
      success: true,
      data: { ...summary, myColorLabelCounts }
    });
  } catch (error) {
    logger.error('Filter summary error:', error);
    res.status(500).json({ error: 'Failed to get filter summary' });
  }
});

/**
 * POST /api/admin/photo-export/:eventId/export
 * Export selected or filtered photos
 */
router.post('/:eventId/export', adminAuth, requirePermission('photos.download'), requireEventOwnership, [
  body('photo_ids').optional().isArray(),
  body('photo_ids.*').optional().isInt(),
  body('filter').optional().isObject(),
  body('format').isIn(['txt', 'csv', 'xmp', 'json']),
  body('options.mark_source').optional().isIn(['client', 'mine']),
  body('options').optional().isObject()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: safeValidationErrors(errors) });
    }

    const eventId = parseInt(req.params.eventId);
    const { photo_ids, filter, format, options = {} } = req.body;

    // Verify event exists
    const event = await withRetry(() =>
      db('events').where('id', eventId).first()
    );

    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // If filter provided instead of photo_ids, get matching photo IDs
    let photoIds = photo_ids;

    if (!photoIds && filter) {
      const { identity_mode: identityMode } =
        await feedbackService.getEventFeedbackSettings(eventId);
      const filterBuilder = new PhotoFilterBuilder(
        livePhotos(db).select('id'),
        eventId,
        identityMode
      );
      // admin_id comes from the session, so a my-marks filter in the body can
      // only ever mean the caller's own marks.
      filterBuilder.applyFilters({ ...filter, admin_id: req.admin.id });
      const filteredPhotos = await withRetry(() => filterBuilder.getQuery());
      photoIds = filteredPhotos.map(p => p.id);
    }

    // Export photos
    const result = await exportService.exportPhotos(eventId, photoIds, format, {
      ...options,
      admin_id: req.admin.id,
    });

    if (format === 'xmp') capabilityEvidence(res, 'photo_xmp_export');

    if (result.type === 'stream') {
      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
      result.stream.pipe(res);
    } else {
      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
      res.send(result.content);
    }
  } catch (error) {
    logger.error('Export photos error:', error);
    res.status(500).json({ error: error.message || 'Failed to export photos' });
  }
});

module.exports = router;
