#!/usr/bin/env node

/**
 * Script to regenerate all thumbnails with new square dimensions
 * This fixes the blurry thumbnail issue by creating proper 300x300 square thumbnails
 */

const path = require('path');
const fs = require('fs').promises;
const { db } = require('../src/database/db');
const { generateThumbnail, withProcessableImage } = require('../src/services/imageProcessor');
const logger = require('../src/utils/logger');

const getStoragePath = () => process.env.STORAGE_PATH || path.join(__dirname, '../../storage');

async function regenerateAllThumbnails() {
  try {
    console.log('Starting thumbnail regeneration with square dimensions...');
    
    // First, ensure the new thumbnail settings are in the database
    const settings = [
      { key: 'thumbnail_width', value: '300' },
      { key: 'thumbnail_height', value: '300' },
      { key: 'thumbnail_fit', value: 'cover' },
      { key: 'thumbnail_quality', value: '85' },
      { key: 'thumbnail_format', value: 'jpeg' }
    ];
    
    for (const setting of settings) {
      const exists = await db('app_settings').where('key', setting.key).first();
      if (!exists) {
        await db('app_settings').insert({
          ...setting,
          description: `Thumbnail ${setting.key.replace('thumbnail_', '')}`,
          created_at: db.fn.now(),
          updated_at: db.fn.now()
        });
        console.log(`Added setting: ${setting.key} = ${setting.value}`);
      }
    }
    
    // Get all photos
    const photos = await db('photos')
      .select('id', 'event_id', 'path', 'filename', 'original_filename')
      .orderBy('id');
    
    console.log(`Found ${photos.length} photos to process`);
    
    let successCount = 0;
    let errorCount = 0;
    let skippedCount = 0;
    
    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i];
      const progress = Math.round((i + 1) / photos.length * 100);
      
      try {
        const storagePath = getStoragePath();
        const originalPath = path.join(storagePath, 'events/active', photo.path);
        
        // Check if original file exists
        try {
          await fs.access(originalPath);
        } catch (err) {
          console.log(`[${progress}%] Skipping photo ${photo.id} - original file not found`);
          skippedCount++;
          continue;
        }
        
        // Regenerate thumbnail with new square dimensions.
        // Through the RAW extraction: sharp cannot open a RAW original, so
        // without this every RAW in the library is counted as an error and
        // keeps whatever thumbnail it had, at the old dimensions.
        const proc = await withProcessableImage(
          originalPath,
          photo.original_filename || photo.filename
        );
        let thumbnailPath;
        try {
          thumbnailPath = await generateThumbnail(proc.path, { regenerate: true });
        } finally {
          await proc.cleanup();
        }
        
        if (thumbnailPath) {
          // Update database with new thumbnail path
          await db('photos')
            .where({ id: photo.id })
            .update({ 
              thumbnail_path: thumbnailPath,
              updated_at: db.fn.now()
            });
          
          successCount++;
          console.log(`[${progress}%] ✓ Regenerated thumbnail for ${photo.filename}`);
        } else {
          errorCount++;
          console.error(`[${progress}%] ✗ Failed to generate thumbnail for ${photo.filename}`);
        }
      } catch (error) {
        errorCount++;
        console.error(`[${progress}%] ✗ Error processing photo ${photo.id}:`, error.message);
      }
    }
    
    console.log('\n=== Regeneration Complete ===');
    console.log(`✓ Success: ${successCount} thumbnails`);
    console.log(`✗ Errors: ${errorCount} thumbnails`);
    console.log(`⊘ Skipped: ${skippedCount} thumbnails (original files not found)`);
    console.log(`Total processed: ${photos.length} photos`);
    
    process.exit(0);
  } catch (error) {
    console.error('Fatal error during thumbnail regeneration:', error);
    process.exit(1);
  }
}

// Run the script
regenerateAllThumbnails();