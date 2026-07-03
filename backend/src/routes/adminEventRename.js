/**
 * Admin Event Rename Routes
 * Handles event renaming operations
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const eventRenameService = require('../services/eventRenameService');
const router = express.Router();

/**
 * POST /api/admin/events/:eventId/rename
 * Rename an event
 */
router.post('/:eventId/rename', adminAuth, requirePermission('events.edit'), [
  body('newEventName')
    .trim()
    .isLength({ min: 3, max: 100 })
    .withMessage('Event name must be between 3 and 100 characters'),
  body('resendEmail')
    .optional()
    .isBoolean()
    .withMessage('resendEmail must be a boolean')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { eventId } = req.params;
    const { newEventName, resendEmail = false } = req.body;

    const result = await eventRenameService.renameEvent(
      parseInt(eventId, 10),
      newEventName,
      resendEmail,
      req.admin
    );

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json({
      success: true,
      message: 'Event renamed successfully',
      data: result.data
    });
  } catch (error) {
    console.error('Error renaming event:', error);
    res.status(500).json({ success: false, error: 'Failed to rename event' });
  }
});

/**
 * POST /api/admin/events/:eventId/validate-rename
 * Validate a potential rename without executing it
 */
router.post('/:eventId/validate-rename', adminAuth, requirePermission('events.edit'), [
  body('newEventName')
    .trim()
    .isLength({ min: 3, max: 100 })
    .withMessage('Event name must be between 3 and 100 characters')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ valid: false, errors: errors.array() });
    }

    const { eventId } = req.params;
    const { newEventName } = req.body;

    const validation = await eventRenameService.validateRename(
      parseInt(eventId, 10),
      newEventName
    );

    res.json(validation);
  } catch (error) {
    console.error('Error validating rename:', error);
    res.status(500).json({ valid: false, error: 'Validation failed' });
  }
});

module.exports = router;
