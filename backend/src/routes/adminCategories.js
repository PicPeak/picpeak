const { changedEvidence } = require('../usage/adoptionEvidence');
const { capabilityEvidence } = require('../usage/capabilityEvidence');
const express = require('express');
const { body, validationResult } = require('express-validator');
const { safeValidationErrors } = require('../utils/routeHelpers');
const { db, logActivity } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');
const { parseBooleanInput } = require('../utils/parsers');
const { adminAuth } = require('../middleware/auth');
const { requirePermission, userHasAllPermissions } = require('../middleware/permissions');
const folderTree = require('../services/folderTreeService');
const { requireEventOwnership, canAccessEvent } = require('../middleware/ownership');
const { getEventCategoriesOrdered } = require('../utils/categoryOrder');
const logger = require('../utils/logger');
const router = express.Router();

/**
 * A per-event category belongs to its event, so creating, editing or deleting
 * one needs access to that event: the rule requireEventOwnership applies.
 * Global categories are shared and stay on settings.edit alone. Answers the
 * refusal itself and returns true when the caller may not continue.
 */
/**
 * Folders (issue 1786) are edited with folders.manage, on top of the
 * settings.edit these routes already require. Answers the refusal itself.
 */
async function refuseWithoutFolderPermission(req, res) {
  if (await userHasAllPermissions(req.admin.id, ['folders.manage'])) return false;
  res.status(403).json({ error: 'The folders.manage permission is required to change folders' });
  return true;
}

async function refuseForeignCategoryEvent(req, res, eventId) {
  if (eventId === null || eventId === undefined) return false;
  const event = await db('events').where('id', eventId).first();
  if (!event) {
    res.status(404).json({ error: 'Event not found' });
    return true;
  }
  if (!canAccessEvent(req.admin, event)) {
    res.status(403).json({ error: 'Access denied' });
    return true;
  }
  return false;
}

/**
 * A photo that may become this category's cover (GHSA-j2f4: it must belong to
 * the category). For a folder that is any photo in the folder or below it.
 */
async function heroCandidate(category, photoId) {
  if (parseBooleanInput(category.is_folder, false) && category.event_id) {
    const ids = await folderTree.subtreeIds(category.event_id, category.id);
    return db('photos').where('id', photoId).whereIn('folder_id', ids)
      .whereNull('moderation_status').first();
  }
  // A team upload still under review (issue 743) cannot be a hero yet.
  return db('photos').where({ id: photoId, category_id: category.id })
    .whereNull('moderation_status').first();
}

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
  // photo_categories.name is varchar(100) — without the length check Postgres
  // raises "value too long" and the catch below turns it into a raw 500 with
  // no usable message for the form.
  body('name').notEmpty().withMessage('Category name is required')
    .isLength({ max: 100 }).withMessage('Category name must be at most 100 characters'),
  body('slug').optional(),
  body('is_global').optional().isBoolean(),
  body('event_id').optional().isInt(),
  body('is_folder').optional().isBoolean()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: safeValidationErrors(errors) });
    }
    
    const { name, slug, is_global = true, event_id = null, is_folder = false } = req.body;
    if (!is_global && await refuseForeignCategoryEvent(req, res, event_id)) return;
    if (parseBooleanInput(is_folder, false)) {
      // Folders belong to one gallery (issue 1160, option b); a global folder
      // would restructure every gallery at once.
      if (parseBooleanInput(is_global, true) || !event_id) {
        return res.status(400).json({ error: 'Folders belong to one gallery; create them on the event' });
      }
      if (await refuseWithoutFolderPermission(req, res)) return;
    }
    
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
      display_order: nextOrder,
      // #1160: a folder contains its photos instead of filtering them.
      // parseBooleanInput, not `!!`: express-validator's isBoolean() accepts the
      // STRINGS "false" and "0", and `!!'false'` is true — a form-encoded caller
      // asking for a filter would silently get a folder.
      is_folder: formatBoolean(parseBooleanInput(is_folder, false))
    }).returning('id');
    
    const categoryId = insertResult[0]?.id || insertResult[0];
    
    const category = await db('photo_categories').where('id', categoryId).first();
    
    // Log activity
    await logActivity('category_created', 
      { categoryName: name, isGlobal: is_global },
      event_id,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );
    
    capabilityEvidence(res, 'category_editing');
    res.json(category);
  } catch (error) {
    logger.error('Error creating category:', error);
    res.status(500).json({ error: 'Failed to create category' });
  }
});

// Update a category
router.put('/:id', adminAuth, requirePermission('settings.edit'), [
  body('name').notEmpty().withMessage('Category name is required')
    .isLength({ max: 100 }).withMessage('Category name must be at most 100 characters'),
  body('hero_photo_id').optional({ nullable: true }).custom((value) => {
    if (value === null || value === undefined) return true;
    return Number.isInteger(Number(value));
  }).withMessage('hero_photo_id must be an integer or null'),
  body('allow_downloads').optional().isBoolean(),
  body('is_folder').optional().isBoolean()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: safeValidationErrors(errors) });
    }

    const { id } = req.params;
    const { name, hero_photo_id } = req.body;

    const category = await db('photo_categories').where('id', id).first();
    if (!category) {
      return res.status(404).json({ error: 'Category not found' });
    }
    if (await refuseForeignCategoryEvent(req, res, category.event_id)) return;
    const wasFolder = parseBooleanInput(category.is_folder, false);
    const togglesFolder = Object.prototype.hasOwnProperty.call(req.body, 'is_folder')
      && parseBooleanInput(req.body.is_folder, false) !== wasFolder;
    if ((wasFolder || togglesFolder) && await refuseWithoutFolderPermission(req, res)) return;
    if (togglesFolder && !wasFolder && (parseBooleanInput(category.is_global, false) || !category.event_id)) {
      return res.status(400).json({ error: 'Folders belong to one gallery; global categories cannot become folders' });
    }
    if (togglesFolder && wasFolder) {
      const child = await db('photo_categories').where('parent_id', id).first('id');
      if (child) {
        return res.status(400).json({ error: 'Move or delete the subfolders first; a filter category cannot contain folders' });
      }
    }

    // A folder (issue 1786) renames through the tree service: sibling-name
    // clash as 409, path-joined slug. The generic slug below would collide
    // for "Activity A" under two different parents.
    const staysFolder = wasFolder && !togglesFolder && category.event_id;
    if (staysFolder && name !== category.name) {
      try {
        await folderTree.renameFolder(category.event_id, category.id, name);
      } catch (err) {
        if (err instanceof folderTree.FolderError) return res.status(err.status).json({ error: err.message, code: err.code });
        throw err;
      }
    }

    const updateData = staysFolder ? {} : {
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
        const heroPhoto = await heroCandidate(category, hero_photo_id);
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

    // Folder vs filter (#1160). Flipping this moves the category's photos out of
    // (or back into) the root grid with no re-upload — it only changes where they
    // render, never which photos exist or who may reach them.
    if (Object.prototype.hasOwnProperty.call(req.body, 'is_folder')) {
      updateData.is_folder = formatBoolean(parseBooleanInput(req.body.is_folder, false));
    }

    await db.transaction(async (trx) => {
      if (Object.keys(updateData).length > 0) {
        await trx('photo_categories')
          .where('id', id)
          .update(updateData);
      }
      // Since migration 265 a folder holds its photos in folder_id and a
      // filter category in category_id, so the flip moves them across.
      if (togglesFolder && !wasFolder) {
        await trx('photos').where('category_id', id).update({ folder_id: Number(id), category_id: null });
      } else if (togglesFolder && wasFolder) {
        await trx('photos').where('folder_id', id).whereNull('category_id').update({ category_id: Number(id), folder_id: null });
        await trx('photos').where('folder_id', id).update({ folder_id: null });
        // A filter category is no tree node: without this the next upload of
        // its old path collides on the source_path index and lands photos in
        // a "folder" that is a filter category.
        await trx('photo_categories').where('id', id).update({ parent_id: null, source_path: null });
      }
    });

    const updated = await db('photo_categories').where('id', id).first();
    // Folder moves and download flags change what the guest ZIP may hold.
    if (category.event_id && (togglesFolder || Object.prototype.hasOwnProperty.call(req.body, 'allow_downloads'))) {
      require('../services/downloadZipService').invalidate(Number(category.event_id));
    }

    // Log activity
    await logActivity('category_updated',
      { categoryName: name, heroPhotoId: hero_photo_id },
      category.event_id,
      { type: 'admin', id: req.admin.id, name: req.admin.username }
    );

    changedEvidence(res, 'category_editing', category, updated,
      ['name', 'slug', 'hero_photo_id', 'allow_downloads', 'is_folder']);
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
      return res.status(400).json({ errors: safeValidationErrors(errors) });
    }

    const { id } = req.params;
    const { hero_photo_id } = req.body;

    const category = await db('photo_categories').where('id', id).first();
    if (!category) {
      return res.status(404).json({ error: 'Category not found' });
    }
    if (await refuseForeignCategoryEvent(req, res, category.event_id)) return;

    // If hero_photo_id is provided, verify the photo actually belongs to
    // THIS category — checking existence alone let an admin point a
    // category's hero at a photo from a different category or event
    // (GHSA-j2f4).
    if (hero_photo_id) {
      const photo = await heroCandidate(category, hero_photo_id);
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

    changedEvidence(res, 'category_editing', category, updated, ['hero_photo_id']);
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
    if (await refuseForeignCategoryEvent(req, res, category.event_id)) return;

    // A folder (issue 1786) is deleted without deleting anything in it: its
    // photos and subfolders move up to its parent.
    if (parseBooleanInput(category.is_folder, false) && category.event_id) {
      if (await refuseWithoutFolderPermission(req, res)) return;
      const moved = await folderTree.deleteFolder(category.event_id, category.id);
      require('../services/downloadZipService').invalidate(Number(category.event_id));
      await logActivity('folder_deleted', { name: category.name, movedPhotos: moved }, category.event_id,
        { type: 'admin', id: req.admin.id, name: req.admin.username });
      capabilityEvidence(res, 'category_editing');
      return res.json({ message: 'Folder deleted successfully', moved_photos: moved });
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
    
    capabilityEvidence(res, 'category_editing');
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
      return res.status(400).json({ errors: safeValidationErrors(errors) });
    }

    const eventId = parseInt(req.body.event_id, 10);
    const orderedIds = req.body.orderedIds.map((id) => parseInt(id, 10));

    // Event ownership (event_id comes from the body, so requireEventOwnership —
    // which reads req.params — can't be used here). Same rule, same helper:
    // super_admin bypasses; other admins may only reorder events they own
    // (ownerless legacy/system events allowed).
    const event = await db('events').where('id', eventId).first();
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    if (!canAccessEvent(req.admin, event)) {
      return res.status(403).json({ error: 'Access denied' });
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

    const before = await db('event_category_order').where('event_id', eventId).orderBy('position', 'asc').pluck('category_id');
    await db.transaction(async (trx) => {
      await trx('event_category_order').where('event_id', eventId).del();
      await trx('event_category_order').insert(
        orderedIds.map((id, i) => ({ event_id: eventId, category_id: id, position: i + 1 }))
      );
    });
    changedEvidence(res, 'category_editing', { order: before }, { order: orderedIds }, ['order']);

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
    const removed = await db('event_category_order').where('event_id', eventId).del();
    if (removed > 0) capabilityEvidence(res, 'category_editing');

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
      return res.status(400).json({ errors: safeValidationErrors(errors) });
    }

    const orderedIds = req.body.orderedIds.map((id) => parseInt(id, 10));

    const globals = await db('photo_categories').where('is_global', formatBoolean(true))
      .orderBy('display_order', 'asc').orderBy('name', 'asc').pluck('id');
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
    changedEvidence(res, 'category_editing', { order: globals }, { order: categories.map((category) => category.id) }, ['order']);
    res.json(categories);
  } catch (error) {
    logger.error('Error reordering global categories:', error);
    res.status(500).json({ error: 'Failed to reorder global categories' });
  }
});

module.exports = router;