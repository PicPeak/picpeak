/**
 * Admin CSS Templates Routes
 * Handles CRUD operations for custom CSS gallery templates
 */

const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const { db, withRetry } = require('../database/db');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { sanitizeCSS, validateCSS, MAX_CSS_SIZE } = require('../utils/cssSanitizer');
const { DEFAULT_CSS_TEMPLATE } = require('../../migrations/core/052_add_css_templates');

/**
 * GET /admin/css-templates
 * Get all CSS templates
 */
router.get('/', adminAuth, requirePermission('branding.view'), async (req, res) => {
  try {
    const templates = await withRetry(() =>
      db('css_templates').orderBy('slot_number')
    );
    res.json({ success: true, templates });
  } catch (error) {
    console.error('Get CSS templates error:', error);
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
});

/**
 * GET /admin/css-templates/enabled
 * Get only enabled templates (for event form dropdown)
 */
router.get('/enabled', adminAuth, requirePermission('branding.view'), async (req, res) => {
  try {
    const templates = await withRetry(() =>
      db('css_templates')
        .where({ is_enabled: true })
        .select('id', 'name', 'slot_number')
        .orderBy('slot_number')
    );
    res.json({ success: true, templates });
  } catch (error) {
    console.error('Get enabled templates error:', error);
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
});

/**
 * GET /admin/css-templates/:slotNumber
 * Get a specific template by slot number
 */
router.get('/:slotNumber', adminAuth, requirePermission('branding.view'), [
  param('slotNumber').isInt({ min: 1, max: 3 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { slotNumber } = req.params;
    const template = await withRetry(() =>
      db('css_templates')
        .where({ slot_number: parseInt(slotNumber) })
        .first()
    );

    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    res.json({ success: true, template });
  } catch (error) {
    console.error('Get template error:', error);
    res.status(500).json({ error: 'Failed to fetch template' });
  }
});

/**
 * PUT /admin/css-templates/:slotNumber
 * Update a template
 */
router.put('/:slotNumber', adminAuth, requirePermission('branding.edit'), [
  param('slotNumber').isInt({ min: 1, max: 3 }),
  body('name').optional().isString().isLength({ max: 50 }),
  body('css_content').optional().isString(),
  body('is_enabled').optional().isBoolean()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { slotNumber } = req.params;
    const { name, css_content, is_enabled } = req.body;

    // Validate CSS size
    if (css_content && css_content.length > MAX_CSS_SIZE) {
      return res.status(400).json({
        error: `CSS content exceeds maximum size of ${MAX_CSS_SIZE / 1024}KB`
      });
    }

    // Validate CSS syntax
    if (css_content) {
      const validation = validateCSS(css_content);
      if (!validation.valid) {
        return res.status(400).json({
          error: 'Invalid CSS syntax',
          details: validation.error
        });
      }
    }

    // Sanitize CSS
    const { sanitized, warnings } = sanitizeCSS(css_content || '');

    const updates = {
      updated_at: db.fn.now()
    };

    if (name !== undefined) {
      updates.name = name.substring(0, 50) || 'Untitled';
    }
    if (css_content !== undefined) {
      updates.css_content = sanitized;
    }
    if (is_enabled !== undefined) {
      updates.is_enabled = Boolean(is_enabled);
    }

    await withRetry(() =>
      db('css_templates')
        .where({ slot_number: parseInt(slotNumber) })
        .update(updates)
    );

    const template = await withRetry(() =>
      db('css_templates')
        .where({ slot_number: parseInt(slotNumber) })
        .first()
    );

    res.json({
      success: true,
      template,
      sanitization_warnings: warnings
    });
  } catch (error) {
    console.error('Update template error:', error);
    res.status(500).json({ error: 'Failed to update template' });
  }
});

/**
 * POST /admin/css-templates/:slotNumber/reset
 * Reset template to default (only for slot 1)
 */
router.post('/:slotNumber/reset', adminAuth, requirePermission('branding.edit'), [
  param('slotNumber').isInt({ min: 1, max: 1 }).withMessage('Only template 1 can be reset to default')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    await withRetry(() =>
      db('css_templates')
        .where({ slot_number: 1 })
        .update({
          name: 'Elegant Dark',
          css_content: DEFAULT_CSS_TEMPLATE,
          is_enabled: true,
          updated_at: db.fn.now()
        })
    );

    const template = await withRetry(() =>
      db('css_templates')
        .where({ slot_number: 1 })
        .first()
    );

    res.json({ success: true, template });
  } catch (error) {
    console.error('Reset template error:', error);
    res.status(500).json({ error: 'Failed to reset template' });
  }
});

module.exports = router;
