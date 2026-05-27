const express = require('express');
const { body, validationResult } = require('express-validator');
const { db, logActivity } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const router = express.Router();

// Get all global categories
router.get('/global', adminAuth, requirePermission('settings.view'), async (req, res) => {
  try {
    const categories = await db('photo_categories')
      .where('is_global', formatBoolean(true))
      .orderBy('name', 'asc');
    
    res.json(categories);
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// Get categories for a specific event (global + event-specific)
router.get('/event/:eventId', adminAuth, requirePermission('settings.view'), async (req, res) => {
  try {
    const { eventId } = req.params;
    
    const categories = await db('photo_categories')
      .where(function() {
        this.where('is_global', formatBoolean(true))
          .orWhere('event_id', eventId);
      })
      .orderBy('is_global', 'desc')
      .orderBy('name', 'asc');
    
    res.json(categories);
  } catch (error) {
    console.error('Error fetching event categories:', error);
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
    
    // Create category
    const insertResult = await db('photo_categories').insert({
      name,
      slug: categorySlug,
      is_global,
      event_id: is_global ? null : event_id
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
    console.error('Error creating category:', error);
    res.status(500).json({ error: 'Failed to create category' });
  }
});

// Update a category
router.put('/:id', adminAuth, requirePermission('settings.edit'), [
  body('name').notEmpty().withMessage('Category name is required'),
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

    // Update hero_photo_id if provided (including null to clear it)
    if (Object.prototype.hasOwnProperty.call(req.body, 'hero_photo_id')) {
      updateData.hero_photo_id = hero_photo_id || null;
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
    console.error('Error updating category:', error);
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

    // If hero_photo_id is provided, verify it belongs to a photo in this category
    if (hero_photo_id) {
      const photo = await db('photos').where('id', hero_photo_id).first();
      if (!photo) {
        return res.status(404).json({ error: 'Photo not found' });
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
    console.error('Error updating category hero:', error);
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
    console.error('Error deleting category:', error);
    res.status(500).json({ error: 'Failed to delete category' });
  }
});

module.exports = router;