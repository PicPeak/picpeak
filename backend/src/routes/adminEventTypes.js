/**
 * Admin Event Types Routes
 * CRUD operations for managing customizable event types
 *
 * @module routes/adminEventTypes
 */

const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { logActivity } = require('../database/db');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const eventTypeService = require('../services/eventTypeService');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * GET /admin/event-types
 * Get all event types (for admin management)
 */
router.get('/', adminAuth, requirePermission('settings.view'), async (req, res) => {
  try {
    const includeInactive = req.query.includeInactive === 'true';
    const eventTypes = await eventTypeService.getAllEventTypes({
      activeOnly: !includeInactive
    });

    res.json({ eventTypes });
  } catch (error) {
    logger.error('Error fetching event types:', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch event types' });
  }
});

/**
 * GET /admin/event-types/active
 * Get only active event types (for dropdowns/selection)
 */
router.get('/active', adminAuth, async (req, res) => {
  try {
    const eventTypes = await eventTypeService.getActiveEventTypes();
    res.json({ eventTypes });
  } catch (error) {
    logger.error('Error fetching active event types:', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch event types' });
  }
});

/**
 * GET /admin/event-types/:id
 * Get a single event type by ID
 */
router.get('/:id', adminAuth, requirePermission('settings.view'), [
  param('id').isInt().withMessage('Invalid event type ID')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { id } = req.params;
    const eventType = await eventTypeService.getEventTypeById(parseInt(id));

    if (!eventType) {
      return res.status(404).json({ error: 'Event type not found' });
    }

    res.json(eventType);
  } catch (error) {
    logger.error('Error fetching event type:', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch event type' });
  }
});

/**
 * POST /admin/event-types
 * Create a new event type
 */
router.post('/', adminAuth, requirePermission('settings.edit'), [
  body('name').notEmpty().trim().withMessage('Name is required'),
  body('slug_prefix')
    .notEmpty()
    .trim()
    .isLength({ min: 2, max: 50 })
    .matches(/^[a-z0-9-]+$/i)
    .withMessage('Slug prefix must be 2-50 characters and contain only letters, numbers, and hyphens'),
  body('emoji').optional().trim(),
  body('theme_preset').optional().trim(),
  body('theme_config').optional(),
  body('display_order').optional().isInt({ min: 0 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      name,
      slug_prefix,
      emoji,
      theme_preset,
      theme_config,
      display_order
    } = req.body;

    const eventType = await eventTypeService.createEventType({
      name,
      slug_prefix,
      emoji,
      theme_preset,
      theme_config,
      display_order
    });

    // Log activity
    await logActivity('event_type_created',
      { name, slug_prefix },
      null,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );

    res.status(201).json(eventType);
  } catch (error) {
    logger.error('Error creating event type:', { error: error.message });

    if (error.code === 'DUPLICATE_SLUG_PREFIX') {
      return res.status(400).json({ error: error.message });
    }

    res.status(500).json({ error: 'Failed to create event type' });
  }
});

/**
 * PUT /admin/event-types/:id
 * Update an event type
 */
router.put('/:id', adminAuth, requirePermission('settings.edit'), [
  param('id').isInt().withMessage('Invalid event type ID'),
  body('name').optional().notEmpty().trim().withMessage('Name cannot be empty'),
  body('slug_prefix')
    .optional()
    .trim()
    .isLength({ min: 2, max: 50 })
    .matches(/^[a-z0-9-]+$/i)
    .withMessage('Slug prefix must be 2-50 characters and contain only letters, numbers, and hyphens'),
  body('emoji').optional().trim(),
  body('theme_preset').optional().trim(),
  body('theme_config').optional(),
  body('display_order').optional().isInt({ min: 0 }),
  body('is_active').optional().isBoolean()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { id } = req.params;
    const updates = req.body;

    const eventType = await eventTypeService.updateEventType(parseInt(id), updates);

    // Log activity
    await logActivity('event_type_updated',
      { id, changes: Object.keys(updates) },
      null,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );

    res.json(eventType);
  } catch (error) {
    logger.error('Error updating event type:', { error: error.message });

    if (error.code === 'NOT_FOUND') {
      return res.status(404).json({ error: error.message });
    }
    if (error.code === 'DUPLICATE_SLUG_PREFIX') {
      return res.status(400).json({ error: error.message });
    }

    res.status(500).json({ error: 'Failed to update event type' });
  }
});

/**
 * DELETE /admin/event-types/:id
 * Delete an event type (only non-system types with no events)
 */
router.delete('/:id', adminAuth, requirePermission('settings.edit'), [
  param('id').isInt().withMessage('Invalid event type ID')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { id } = req.params;
    const result = await eventTypeService.deleteEventType(parseInt(id));

    // Log activity
    await logActivity('event_type_deleted',
      { id, name: result.deleted.name, slug_prefix: result.deleted.slug_prefix },
      null,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );

    res.json({ message: 'Event type deleted successfully' });
  } catch (error) {
    logger.error('Error deleting event type:', { error: error.message });

    if (error.code === 'NOT_FOUND') {
      return res.status(404).json({ error: error.message });
    }
    if (error.code === 'SYSTEM_TYPE' || error.code === 'IN_USE') {
      return res.status(400).json({ error: error.message });
    }

    res.status(500).json({ error: 'Failed to delete event type' });
  }
});

/**
 * POST /admin/event-types/reorder
 * Reorder event types by providing an array of IDs in the desired order
 */
router.post('/reorder', adminAuth, requirePermission('settings.edit'), [
  body('orderedIds').isArray().withMessage('orderedIds must be an array'),
  body('orderedIds.*').isInt().withMessage('Each ID must be an integer')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { orderedIds } = req.body;
    const eventTypes = await eventTypeService.reorderEventTypes(orderedIds);

    // Log activity
    await logActivity('event_types_reordered',
      { newOrder: orderedIds },
      null,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );

    res.json({ eventTypes, message: 'Event types reordered successfully' });
  } catch (error) {
    logger.error('Error reordering event types:', { error: error.message });
    res.status(500).json({ error: 'Failed to reorder event types' });
  }
});

module.exports = router;
