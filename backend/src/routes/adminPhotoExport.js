/**
 * Admin Photo Export Routes
 * Handles filtering and exporting photos based on guest feedback
 */

const express = require('express');
const router = express.Router();
const { body, query, validationResult } = require('express-validator');
const { db, withRetry } = require('../database/db');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { requireEventOwnership } = require('../middleware/ownership');
const { PhotoFilterBuilder } = require('../utils/photoFilterBuilder');
const { getPagination } = require('../utils/routeHelpers');
const { PhotoExportService } = require('../services/photoExportService');
const logger = require('../utils/logger');

const exportService = new PhotoExportService();

/**
 * GET /admin/photos/:eventId/filtered
 * Get filtered photos with pagination
 */
router.get('/:eventId/filtered', adminAuth, requirePermission('photos.view'), requireEventOwnership, [
  query('min_rating').optional().isFloat({ min: 0, max: 5 }),
  query('max_rating').optional().isFloat({ min: 0, max: 5 }),
  query('has_likes').optional().isBoolean(),
  query('min_likes').optional().isInt({ min: 0 }),
  query('has_favorites').optional().isBoolean(),
  query('min_favorites').optional().isInt({ min: 0 }),
  query('has_comments').optional().isBoolean(),
  query('category_id').optional().isInt(),
  query('logic').optional().isIn(['AND', 'OR']),
  query('sort').optional().isIn(['rating', 'likes', 'favorites', 'date', 'filename']),
  query('order').optional().isIn(['asc', 'desc']),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const eventId = parseInt(req.params.eventId);

    // Verify event exists
    const event = await withRetry(() =>
      db('events').where('id', eventId).first()
    );

    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Parse filter params
    const filters = {
      min_rating: req.query.min_rating ? parseFloat(req.query.min_rating) : undefined,
      max_rating: req.query.max_rating ? parseFloat(req.query.max_rating) : undefined,
      has_likes: req.query.has_likes,
      min_likes: req.query.min_likes ? parseInt(req.query.min_likes) : undefined,
      has_favorites: req.query.has_favorites,
      min_favorites: req.query.min_favorites ? parseInt(req.query.min_favorites) : undefined,
      has_comments: req.query.has_comments,
      category_id: req.query.category_id ? parseInt(req.query.category_id) : undefined,
      logic: req.query.logic || 'AND'
    };

    const sort = req.query.sort || 'date';
    const order = req.query.order || 'desc';
    const { page, limit } = getPagination(req, { limit: 50 });

    // Build filtered query
    const filterBuilder = new PhotoFilterBuilder(
      db('photos')
        .leftJoin('photo_categories', 'photos.category_id', 'photo_categories.id')
        .select(
          'photos.id',
          'photos.filename',
          'photos.original_filename',
          'photos.path',
          'photos.average_rating',
          'photos.feedback_count',
          'photos.like_count',
          'photos.favorite_count',
          'photos.comment_count',
          'photos.width',
          'photos.height',
          'photos.uploaded_at',
          'photo_categories.name as category_name'
        ),
      eventId
    );

    filterBuilder
      .applyFilters(filters)
      .applySorting(sort, order)
      .applyPagination(page, limit);

    const photos = await withRetry(() => filterBuilder.getQuery());

    // Get count of filtered photos
    const countResult = await withRetry(() =>
      PhotoFilterBuilder.buildCountQuery(db, eventId, filters)
    );
    const filteredCount = parseInt(countResult[0]?.count) || 0;

    // Get summary counts
    const summary = await withRetry(() =>
      PhotoFilterBuilder.getSummary(db, eventId)
    );

    res.json({
      success: true,
      data: {
        photos,
        pagination: {
          total: summary.total,
          filtered: filteredCount,
          page,
          limit,
          pages: Math.ceil(filteredCount / limit)
        },
        summary
      }
    });
  } catch (error) {
    logger.error('Filter photos error:', error);
    res.status(500).json({ error: 'Failed to filter photos' });
  }
});

/**
 * GET /admin/photos/:eventId/filter-summary
 * Get just the summary counts for filter UI
 */
router.get('/:eventId/filter-summary', adminAuth, requirePermission('photos.view'), requireEventOwnership, async (req, res) => {
  try {
    const eventId = parseInt(req.params.eventId);

    const summary = await withRetry(() =>
      PhotoFilterBuilder.getSummary(db, eventId)
    );

    res.json({
      success: true,
      data: summary
    });
  } catch (error) {
    logger.error('Filter summary error:', error);
    res.status(500).json({ error: 'Failed to get filter summary' });
  }
});

/**
 * POST /admin/photos/:eventId/export
 * Export selected or filtered photos
 */
router.post('/:eventId/export', adminAuth, requirePermission('photos.download'), requireEventOwnership, [
  body('photo_ids').optional().isArray(),
  body('photo_ids.*').optional().isInt(),
  body('filter').optional().isObject(),
  body('format').isIn(['txt', 'csv', 'xmp', 'json']),
  body('options').optional().isObject()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
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
      const filterBuilder = new PhotoFilterBuilder(
        db('photos').select('id'),
        eventId
      );
      filterBuilder.applyFilters(filter);
      const filteredPhotos = await withRetry(() => filterBuilder.getQuery());
      photoIds = filteredPhotos.map(p => p.id);
    }

    // Export photos
    const result = await exportService.exportPhotos(eventId, photoIds, format, options);

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

/**
 * GET /admin/photos/export-formats
 * Get available export format options
 */
router.get('/export-formats', adminAuth, requirePermission('photos.view'), (req, res) => {
  res.json({
    success: true,
    data: PhotoExportService.getFormatOptions()
  });
});

module.exports = router;
