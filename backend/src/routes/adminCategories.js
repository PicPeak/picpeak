const express = require('express');
const { body, validationResult } = require('express-validator');
const { db, logActivity } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { requireEventOwnership } = require('../middleware/ownership');
const { getEventCategoriesOrdered } = require('../utils/categoryOrder');
const logger = require('../utils/logger');
const router = express.Router();

// Get all global categories
router.get('/global', adminAuth, requirePermission('settings.view'), async (req, res) => {
  try {
    const categories = await db('photo_categories')
      .where('is_global', formatBoolean(true))
      .orderBy('display_order', 'asc')
      .orderBy('name', 'asc');

    res.json(categories);
  } catch (error) {
    logger.error('Error fetching categories:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// Get categories for a specific event (global + event-specific), resolved to
// the event's effective order: per-event override, else global default, else
// name (#782). Each row carries `override_position` (null when not customised).
router.get('/event/:eventId', adminAuth, requirePermission('settings.view'), requireEventOwnership, async (req, res) => {
  try {
    const categories = await getEventCategoriesOrdered(req.params.eventId);
    res.json(categories);
  } catch (error) {
    logger.error('Error fetching event categories:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// Create a new category
router.post('/', adminAuth, requirePermission('settings.edit'), [
  body('name').notEmpty().withMessage('Category name is required'),
  body('slug').optional(),
  body('is_global').optional().isBoolean(),
  body('event_id').optional().isInt()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    const { name, slug, is_global = true, event_id = null } = req.body;
    
    // Generate slug if not provided
    const categorySlug = slug || name
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim();
    
    // Check if slug already exists for this scope
    const existing = await db('photo_categories')
      .where('slug', categorySlug)
      .where(function() {
        if (is_global) {
          this.where('is_global', formatBoolean(true));
        } else {
          this.where('event_id', event_id);
        }
      })
      .first();
    
    if (existing) {
      return res.status(400).json({ error: 'Category with this slug already exists' });
    }
    
    // Append to the end of its scope so a new category doesn't jump to the
    // top of an admin-defined order (#782).
    const maxRow = await db('photo_categories')
      .where(function() {
        if (is_global) {
          this.where('is_global', formatBoolean(true));
        } else {
          this.where('event_id', event_id);
        }
      })
      .max('display_order as maxOrder')
      .first();
    const nextOrder = (maxRow?.maxOrder || 0) + 1;

    // Create category
    const insertResult = await db('photo_categories').insert({
      name,
      slug: categorySlug,
      is_global,
      event_id: is_global ? null : event_id,
      display_order: nextOrder
    }).returning('id');
    
    const categoryId = insertResult[0]?.id || insertResult[0];
    
    const category = await db('photo_categories').where('id', categoryId).first();
    
    // Log activity
    await logActivity('category_created', 
      { categoryName: name, isGlobal: is_global },
      event_id,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );
    
    res.json(category);
  } catch (error) {
    logger.error('Error creating category:', error);
    res.status(500).json({ error: 'Failed to create category' });
  }
});

// Update a category
router.put('/:id', adminAuth, requirePermission('settings.edit'), [
  body('name').notEmpty().withMessage('Category name is required'),
  body('hero_photo_id').optional({ nullable: true }).custom((value) => {
    if (value === null || value === undefined) return true;
    return Number.isInteger(Number(value));
  }).withMessage('hero_photo_id must be an integer or null'),
  body('allow_downloads').optional().isBoolean()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { id } = req.params;
    const { name, hero_photo_id } = req.body;

    const category = await db('photo_categories').where('id', id).first();
    if (!category) {
      return res.status(404).json({ error: 'Category not found' });
    }

    const updateData = {
      name,
      slug: name
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .trim()
    };

    // Update hero_photo_id if provided (including null to clear it). A
    // non-null hero must belong to this category (GHSA-j2f4) — the general
    // update path previously wrote it with no membership check at all.
    if (Object.prototype.hasOwnProperty.call(req.body, 'hero_photo_id')) {
      if (hero_photo_id) {
        const heroPhoto = await db('photos')
          .where({ id: hero_photo_id, category_id: id })
          .first();
        if (!heroPhoto) {
          return res.status(404).json({ error: 'Photo not found in this category' });
        }
      }
      updateData.hero_photo_id = hero_photo_id || null;
    }

    // Per-category download permission (#640). AND with event-level allow_downloads.
    if (Object.prototype.hasOwnProperty.call(req.body, 'allow_downloads')) {
      updateData.allow_downloads = req.body.allow_downloads;
    }

    await db('photo_categories')
      .where('id', id)
      .update(updateData);

    const updated = await db('photo_categories').where('id', id).first();

    // Log activity
    await logActivity('category_updated',
      { categoryName: name, heroPhotoId: hero_photo_id },
      category.event_id,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );

    res.json(updated);
  } catch (error) {
    logger.error('Error updating category:', error);
    res.status(500).json({ error: 'Failed to update category' });
  }
});

// Set category hero photo (#163)
router.put('/:id/hero', adminAuth, requirePermission('settings.edit'), [
  body('hero_photo_id').optional({ nullable: true }).custom((value) => {
    if (value === null || value === undefined) return true;
    return Number.isInteger(Number(value));
  }).withMessage('hero_photo_id must be an integer or null')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { id } = req.params;
    const { hero_photo_id } = req.body;

    const category = await db('photo_categories').where('id', id).first();
    if (!category) {
      return res.status(404).json({ error: 'Category not found' });
    }

    // If hero_photo_id is provided, verify the photo actually belongs to
    // THIS category — checking existence alone let an admin point a
    // category's hero at a photo from a different category or event
    // (GHSA-j2f4).
    if (hero_photo_id) {
      const photo = await db('photos')
        .where({ id: hero_photo_id, category_id: id })
        .first();
      if (!photo) {
        return res.status(404).json({ error: 'Photo not found in this category' });
      }
    }

    await db('photo_categories')
      .where('id', id)
      .update({ hero_photo_id: hero_photo_id || null });

    const updated = await db('photo_categories').where('id', id).first();

    // Log activity
    await logActivity('category_hero_updated',
      { categoryName: category.name, heroPhotoId: hero_photo_id },
      category.event_id,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );

    res.json(updated);
  } catch (error) {
    logger.error('Error updating category hero:', error);
    res.status(500).json({ error: 'Failed to update category hero' });
  }
});

// Delete a category
router.delete('/:id', adminAuth, requirePermission('settings.edit'), async (req, res) => {
  try {
    const { id } = req.params;
    
    const category = await db('photo_categories').where('id', id).first();
    if (!category) {
      return res.status(404).json({ error: 'Category not found' });
    }
    
    // Check if category has photos
    const photoCount = await db('photos').where('category_id', id).count('id as count').first();
    if (photoCount.count > 0) {
      return res.status(400).json({ 
        error: 'Cannot delete category with photos. Please reassign photos first.' 
      });
    }
    
    await db('photo_categories').where('id', id).delete();
    
    // Log activity
    await logActivity('category_deleted',
      { categoryName: category.name },
      category.event_id,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );
    
    res.json({ message: 'Category deleted successfully' });
  } catch (error) {
    logger.error('Error deleting category:', error);
    res.status(500).json({ error: 'Failed to delete category' });
  }
});

// Set a per-event category order override (#782). The client sends the full
// ordered id list for THIS event — globals + event-specific, interleaved — and
// we replace the event's override rows in one transaction. This overrides the
// global default order for this gallery only.
router.post('/reorder', adminAuth, requirePermission('settings.edit'), [
  body('event_id').isInt().withMessage('event_id must be an integer'),
  body('orderedIds').isArray({ min: 1 }).withMessage('orderedIds must be a non-empty array'),
  body('orderedIds.*').isInt().withMessage('Each id must be an integer')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const eventId = parseInt(req.body.event_id, 10);
    const orderedIds = req.body.orderedIds.map((id) => parseInt(id, 10));

    // Event ownership (event_id comes from the body, so requireEventOwnership —
    // which reads req.params — can't be used here). Mirror it: super_admins
    // bypass; other admins may only reorder events they own (ownerless
    // legacy/system events allowed).
    if (req.admin.roleName !== 'super_admin') {
      const event = await db('events').where('id', eventId).first();
      if (!event) {
        return res.status(404).json({ error: 'Event not found' });
      }
      if (event.created_by && event.created_by !== req.admin.id) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    // Every id must be a category available to this event: a shared global OR
    // one of the event's own categories. Anything else is out of scope.
    const available = await db('photo_categories')
      .where(function() {
        this.where('is_global', formatBoolean(true)).orWhere('event_id', eventId);
      })
      .pluck('id');
    const availableSet = new Set(available);
    const invalid = orderedIds.filter((id) => !availableSet.has(id));
    if (invalid.length > 0) {
      return res.status(400).json({ error: 'One or more categories are not available for this event' });
    }

    await db.transaction(async (trx) => {
      await trx('event_category_order').where('event_id', eventId).del();
      await trx('event_category_order').insert(
        orderedIds.map((id, i) => ({ event_id: eventId, category_id: id, position: i + 1 }))
      );
    });

    // Log activity after commit (avoids a SQLite in-transaction global write).
    await logActivity('event_category_order_set',
      { eventId, count: orderedIds.length },
      eventId,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );

    res.json(await getEventCategoriesOrdered(eventId));
  } catch (error) {
    logger.error('Error reordering categories:', error);
    res.status(500).json({ error: 'Failed to reorder categories' });
  }
});

// Clear an event's override — revert this gallery to the global default order.
router.delete('/reorder/:eventId', adminAuth, requirePermission('settings.edit'), requireEventOwnership, async (req, res) => {
  try {
    const eventId = parseInt(req.params.eventId, 10);
    await db('event_category_order').where('event_id', eventId).del();

    await logActivity('event_category_order_reset',
      { eventId },
      eventId,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );

    res.json(await getEventCategoriesOrdered(eventId));
  } catch (error) {
    logger.error('Error resetting category order:', error);
    res.status(500).json({ error: 'Failed to reset category order' });
  }
});

// Set the GLOBAL default order for shared (global) categories (#782). Applies
// to every gallery that hasn't set its own override. Rewrites display_order.
router.post('/reorder-global', adminAuth, requirePermission('settings.edit'), [
  body('orderedIds').isArray({ min: 1 }).withMessage('orderedIds must be a non-empty array'),
  body('orderedIds.*').isInt().withMessage('Each id must be an integer')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const orderedIds = req.body.orderedIds.map((id) => parseInt(id, 10));

    const globals = await db('photo_categories').where('is_global', formatBoolean(true)).pluck('id');
    const globalsSet = new Set(globals);
    const invalid = orderedIds.filter((id) => !globalsSet.has(id));
    if (invalid.length > 0) {
      return res.status(400).json({ error: 'One or more categories are not global' });
    }

    await db.transaction(async (trx) => {
      for (let i = 0; i < orderedIds.length; i += 1) {
        await trx('photo_categories').where('id', orderedIds[i]).update({ display_order: i + 1 });
      }
    });

    await logActivity('global_category_order_set',
      { count: orderedIds.length },
      null,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );

    const categories = await db('photo_categories')
      .where('is_global', formatBoolean(true))
      .orderBy('display_order', 'asc')
      .orderBy('name', 'asc');
    res.json(categories);
  } catch (error) {
    logger.error('Error reordering global categories:', error);
    res.status(500).json({ error: 'Failed to reorder global categories' });
  }
});

module.exports = router;