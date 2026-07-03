const express = require('express');
const router = express.Router();
const { db } = require('../database/db');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { generateThumbnail, ensurePreviewImage } = require('../services/imageProcessor');
const path = require('path');
const fs = require('fs').promises;
const logger = require('../utils/logger');

const getStoragePath = () => process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');

// Parse JSON-encoded setting values
function parseSettingValue(value) {
  if (value === null || value === undefined) return null;
  try { return JSON.parse(value); } catch (e) { return value; }
}

// Get thumbnail settings
router.get('/settings', adminAuth, requirePermission('photos.view'), async (req, res) => {
  try {
    const settings = await db('app_settings')
      .whereIn('setting_key', [
        'thumbnail_width',
        'thumbnail_height',
        'thumbnail_fit',
        'thumbnail_quality',
        'thumbnail_format',
        // Lightbox preview tier (#492). Boolean, default false.
        'lightbox_preview_enabled'
      ])
      .select('setting_key', 'setting_value');

    const settingsMap = {};
    settings.forEach(s => {
      const parsed = parseSettingValue(s.setting_value);
      settingsMap[s.setting_key] = {
        value: String(parsed ?? '')
      };
    });

    res.json({
      settings: settingsMap,
      fitOptions: ['cover', 'contain', 'fill', 'inside', 'outside'],
      formatOptions: ['jpeg', 'png', 'webp']
    });
  } catch (error) {
    logger.error('Error fetching thumbnail settings:', error);
    res.status(500).json({ error: 'Failed to fetch thumbnail settings' });
  }
});

// Update thumbnail settings
router.put('/settings', adminAuth, requirePermission('photos.edit'), async (req, res) => {
  try {
    const { width, height, fit, quality, format, lightbox_preview_enabled } = req.body;
    
    // Validate inputs
    if (width && (width < 50 || width > 1000)) {
      return res.status(400).json({ error: 'Width must be between 50 and 1000 pixels' });
    }
    if (height && (height < 50 || height > 1000)) {
      return res.status(400).json({ error: 'Height must be between 50 and 1000 pixels' });
    }
    if (quality && (quality < 1 || quality > 100)) {
      return res.status(400).json({ error: 'Quality must be between 1 and 100' });
    }
    if (fit && !['cover', 'contain', 'fill', 'inside', 'outside'].includes(fit)) {
      return res.status(400).json({ error: 'Invalid fit option' });
    }
    if (format && !['jpeg', 'png', 'webp'].includes(format)) {
      return res.status(400).json({ error: 'Invalid format option' });
    }
    
    // Update settings
    const updates = [];
    if (width) updates.push({ setting_key: 'thumbnail_width', setting_value: width });
    if (height) updates.push({ setting_key: 'thumbnail_height', setting_value: height });
    if (fit) updates.push({ setting_key: 'thumbnail_fit', setting_value: JSON.stringify(fit) });
    if (quality) updates.push({ setting_key: 'thumbnail_quality', setting_value: quality });
    if (format) updates.push({ setting_key: 'thumbnail_format', setting_value: JSON.stringify(format) });
    // Lightbox preview tier (#492). Boolean — store JSON-stringified
    // so the round-trip matches what migration 104 seeds.
    if (typeof lightbox_preview_enabled === 'boolean') {
      updates.push({
        setting_key: 'lightbox_preview_enabled',
        setting_value: JSON.stringify(lightbox_preview_enabled),
      });
    }

    for (const update of updates) {
      const updated = await db('app_settings')
        .where('setting_key', update.setting_key)
        .update({
          setting_value: update.setting_value,
          updated_at: db.fn.now()
        });
      // Defensive insert when the row is missing — covers the case
      // where lightbox_preview_enabled is being saved on an install
      // that pre-dates migration 104. Existing thumbnail_* keys are
      // seeded by migration 040 so the update path always wins for
      // them; this only fires on the new key.
      if (!updated) {
        await db('app_settings').insert({
          setting_key: update.setting_key,
          setting_value: update.setting_value,
          setting_type: update.setting_key === 'lightbox_preview_enabled' ? 'thumbnail' : 'thumbnail',
          updated_at: db.fn.now(),
        });
      }
    }
    
    res.json({ 
      message: 'Thumbnail settings updated successfully',
      regenerateRequired: true 
    });
  } catch (error) {
    logger.error('Error updating thumbnail settings:', error);
    res.status(500).json({ error: 'Failed to update thumbnail settings' });
  }
});

// Regenerate all thumbnails with new settings
router.post('/regenerate', adminAuth, requirePermission('photos.edit'), async (req, res) => {
  try {
    const { eventId } = req.body; // Optional: regenerate for specific event only
    
    let query = db('photos').select('id', 'event_id', 'path');
    if (eventId) {
      query = query.where('event_id', eventId);
    }
    
    const photos = await query;
    
    if (photos.length === 0) {
      return res.json({ message: 'No photos to regenerate' });
    }
    
    // Start regeneration in background
    res.json({ 
      message: `Started regenerating ${photos.length} thumbnails`,
      count: photos.length 
    });
    
    // Process thumbnails in background
    setImmediate(async () => {
      let successCount = 0;
      let errorCount = 0;
      
      for (const photo of photos) {
        try {
          const storagePath = getStoragePath();
          const originalPath = path.join(storagePath, 'events/active', photo.path);
          
          // Check if original file exists
          try {
            await fs.access(originalPath);
          } catch (err) {
            logger.warn(`Original file not found for photo ${photo.id}: ${originalPath}`);
            errorCount++;
            continue;
          }
          
          // Regenerate thumbnail
          const thumbnailPath = await generateThumbnail(originalPath, { regenerate: true });
          
          if (thumbnailPath) {
            // Update database with new thumbnail path
            await db('photos')
              .where({ id: photo.id })
              .update({ 
                thumbnail_path: thumbnailPath,
                updated_at: db.fn.now()
              });
            
            successCount++;
            logger.info(`Regenerated thumbnail for photo ${photo.id}`);
          } else {
            errorCount++;
          }
        } catch (error) {
          logger.error(`Error regenerating thumbnail for photo ${photo.id}:`, error);
          errorCount++;
        }
      }
      
      logger.info(`Thumbnail regeneration complete: ${successCount} success, ${errorCount} errors`);
    });
    
  } catch (error) {
    logger.error('Error starting thumbnail regeneration:', error);
    res.status(500).json({ error: 'Failed to start thumbnail regeneration' });
  }
});

// Regenerate all preview-tier images (#492). Eager backfill counterpart
// to ensurePreviewImage's lazy generation. Mirrors the regenerate
// (thumbnails) endpoint above — same auth, same fire-and-forget shape,
// same per-photo error handling.
router.post('/regenerate-previews', adminAuth, requirePermission('photos.edit'), async (req, res) => {
  try {
    const { eventId } = req.body;

    let query = db('photos').select('id', 'event_id', 'path', 'media_type', 'mime_type', 'preview_path');
    if (eventId) query = query.where('event_id', eventId);
    // Skip videos — preview tier is image-only.
    query = query.where(function() {
      this.whereNull('media_type').orWhere('media_type', '!=', 'video');
    });

    const photos = await query;
    if (photos.length === 0) {
      return res.json({ message: 'No image photos to regenerate previews for', count: 0 });
    }

    res.json({
      message: `Started regenerating ${photos.length} previews`,
      count: photos.length,
    });

    setImmediate(async () => {
      let successCount = 0;
      let errorCount = 0;
      for (const photo of photos) {
        try {
          // Force regeneration regardless of existing preview state by
          // nulling the cached path so ensurePreviewImage doesn't
          // short-circuit on a stale isPreviewValid check.
          const newPreviewPath = await ensurePreviewImage({ ...photo, preview_path: null });
          if (newPreviewPath) {
            successCount++;
          } else {
            errorCount++;
          }
        } catch (error) {
          logger.error(`Error regenerating preview for photo ${photo.id}:`, error);
          errorCount++;
        }
      }
      logger.info(`Preview regeneration complete: ${successCount} success, ${errorCount} errors`);
    });
  } catch (error) {
    logger.error('Error starting preview regeneration:', error);
    res.status(500).json({ error: 'Failed to start preview regeneration' });
  }
});

// Get regeneration status
router.get('/regenerate/status', adminAuth, requirePermission('photos.view'), async (req, res) => {
  try {
    // Count photos with and without thumbnails
    const totalPhotos = await db('photos').count('id as count').first();
    const photosWithThumbnails = await db('photos')
      .whereNotNull('thumbnail_path')
      .count('id as count')
      .first();
    
    res.json({
      total: totalPhotos.count,
      withThumbnails: photosWithThumbnails.count,
      withoutThumbnails: totalPhotos.count - photosWithThumbnails.count,
      percentage: Math.round((photosWithThumbnails.count / totalPhotos.count) * 100)
    });
  } catch (error) {
    logger.error('Error fetching regeneration status:', error);
    res.status(500).json({ error: 'Failed to fetch regeneration status' });
  }
});

module.exports = router;