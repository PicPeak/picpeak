/**
 * Photo Service Layer
 * Handles photo-related business logic
 *
 * @module services/photoService
 */

const path = require('path');
const fs = require('fs').promises;
const { db } = require('../database/db');
const { formatBoolean } = require('../utils/dbCompat');

const getStoragePath = () => process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');

/**
 * Get photos for an event with optional filtering
 * @param {number} eventId - Event ID
 * @param {Object} options - Filter options
 * @returns {Promise<Array>}
 */
const getPhotosForEvent = async (eventId, options = {}) => {
  const { categoryId, uploadSource, includeHidden = false } = options;

  let query = db('photos')
    .where('event_id', eventId)
    .orderBy('sort_order', 'asc')
    .orderBy('created_at', 'desc');

  if (!includeHidden) {
    query = query.where('is_hidden', formatBoolean(false));
  }

  if (categoryId) {
    query = query.where('category_id', categoryId);
  }

  if (uploadSource) {
    query = query.where('upload_source', uploadSource);
  }

  return await query.select('*');
};

/**
 * Get a photo by ID
 * @param {number} photoId - Photo ID
 * @returns {Promise<Object|null>}
 */
const getPhotoById = async (photoId) => {
  return await db('photos').where('id', photoId).first();
};

/**
 * Get photo count for an event
 * @param {number} eventId - Event ID
 * @returns {Promise<number>}
 */
const getPhotoCount = async (eventId) => {
  const result = await db('photos')
    .where('event_id', eventId)
    .where('is_hidden', formatBoolean(false))
    .count('id as count')
    .first();
  return result?.count || 0;
};

/**
 * Update photo metadata
 * @param {number} photoId - Photo ID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>}
 */
const updatePhoto = async (photoId, updates) => {
  // Don't allow updating certain fields
  delete updates.id;
  delete updates.event_id;
  delete updates.file_path;
  delete updates.created_at;

  // Handle boolean fields
  if (updates.is_hidden !== undefined) {
    updates.is_hidden = formatBoolean(updates.is_hidden);
  }
  if (updates.is_hero !== undefined) {
    updates.is_hero = formatBoolean(updates.is_hero);
  }

  await db('photos').where('id', photoId).update(updates);
  return { success: true };
};

/**
 * Delete a photo (soft delete by marking hidden, or hard delete)
 * @param {number} photoId - Photo ID
 * @param {Object} options - Delete options
 * @param {boolean} options.hard - Hard delete (remove file)
 * @returns {Promise<Object>}
 */
const deletePhoto = async (photoId, options = {}) => {
  const { hard = false } = options;

  if (hard) {
    const photo = await getPhotoById(photoId);
    if (photo) {
      // Delete the actual file
      const filePath = path.join(getStoragePath(), photo.file_path);
      try {
        await fs.unlink(filePath);
      } catch (err) {
        // File might not exist, continue with database deletion
      }

      // Delete thumbnail if exists
      if (photo.thumbnail_path) {
        const thumbPath = path.join(getStoragePath(), photo.thumbnail_path);
        try {
          await fs.unlink(thumbPath);
        } catch (err) {
          // Thumbnail might not exist
        }
      }

      // Delete from database
      await db('photos').where('id', photoId).delete();
    }
  } else {
    // Soft delete
    await db('photos').where('id', photoId).update({ is_hidden: formatBoolean(true) });
  }

  return { success: true };
};

/**
 * Bulk delete photos
 * @param {number[]} photoIds - Array of photo IDs
 * @param {Object} options - Delete options
 * @returns {Promise<Object>}
 */
const bulkDeletePhotos = async (photoIds, options = {}) => {
  const { hard = false } = options;

  if (hard) {
    for (const photoId of photoIds) {
      await deletePhoto(photoId, { hard: true });
    }
  } else {
    await db('photos').whereIn('id', photoIds).update({ is_hidden: formatBoolean(true) });
  }

  return { success: true, count: photoIds.length };
};

/**
 * Update photo sort order
 * @param {Array<{id: number, sort_order: number}>} photoOrders
 * @returns {Promise<Object>}
 */
const updateSortOrder = async (photoOrders) => {
  const trx = await db.transaction();

  try {
    for (const { id, sort_order } of photoOrders) {
      await trx('photos').where('id', id).update({ sort_order });
    }
    await trx.commit();
    return { success: true };
  } catch (error) {
    await trx.rollback();
    throw error;
  }
};

/**
 * Move photos to a category
 * @param {number[]} photoIds - Photo IDs
 * @param {number|null} categoryId - Target category ID
 * @returns {Promise<Object>}
 */
const moveToCategory = async (photoIds, categoryId) => {
  await db('photos').whereIn('id', photoIds).update({ category_id: categoryId });
  return { success: true, count: photoIds.length };
};

/**
 * Set hero photo for an event
 * @param {number} eventId - Event ID
 * @param {number} photoId - Photo ID to set as hero
 * @returns {Promise<Object>}
 */
const setHeroPhoto = async (eventId, photoId) => {
  const trx = await db.transaction();

  try {
    // Remove hero status from all photos in event
    await trx('photos')
      .where('event_id', eventId)
      .update({ is_hero: formatBoolean(false) });

    // Set new hero photo
    await trx('photos')
      .where('id', photoId)
      .where('event_id', eventId)
      .update({ is_hero: formatBoolean(true) });

    // Update event hero_photo_id
    await trx('events')
      .where('id', eventId)
      .update({ hero_photo_id: photoId });

    await trx.commit();
    return { success: true };
  } catch (error) {
    await trx.rollback();
    throw error;
  }
};

/**
 * Get photos by category
 * @param {number} eventId - Event ID
 * @returns {Promise<Object>}
 */
const getPhotosByCategory = async (eventId) => {
  const photos = await getPhotosForEvent(eventId);
  const categories = await db('categories')
    .where('event_id', eventId)
    .orWhereNull('event_id')
    .orderBy('sort_order', 'asc');

  const grouped = {
    uncategorized: photos.filter(p => !p.category_id)
  };

  for (const category of categories) {
    grouped[category.id] = photos.filter(p => p.category_id === category.id);
  }

  return { photos: grouped, categories };
};

module.exports = {
  getPhotosForEvent,
  getPhotoById,
  getPhotoCount,
  updatePhoto,
  deletePhoto,
  bulkDeletePhotos,
  updateSortOrder,
  moveToCategory,
  setHeroPhoto,
  getPhotosByCategory
};
