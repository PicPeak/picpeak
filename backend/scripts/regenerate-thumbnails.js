#!/usr/bin/env node

/**
 * Script to regenerate missing thumbnails for photos in the database
 * Usage: node scripts/regenerate-thumbnails.js [eventId]
 */

const path = require('path');
const fs = require('fs').promises;
const sharp = require('sharp');
const { db } = require('../src/database/db');

// Configuration
const THUMBNAIL_SIZE = 300;
const STORAGE_PATH = process.env.STORAGE_PATH || path.join(__dirname, '../../storage');
const THUMBNAILS_DIR = path.join(STORAGE_PATH, 'thumbnails');

async function ensureDirectoryExists(dirPath) {
  try {
    await fs.access(dirPath);
  } catch {
    await fs.mkdir(dirPath, { recursive: true });
    console.log(`Created directory: ${dirPath}`);
  }
}

async function generateThumbnail(photoPath, thumbnailPath) {
  try {
    await sharp(photoPath)
      .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, {
        fit: 'cover',
        position: 'center'
      })
      .jpeg({ quality: 80 })
      .toFile(thumbnailPath);
    
    return true;
  } catch (error) {
    console.error(`Failed to generate thumbnail for ${photoPath}:`, error.message);
    return false;
  }
}

async function regenerateThumbnails(eventId = null) {
  try {
    console.log('Starting thumbnail regeneration...');
    console.log(`Storage path: ${STORAGE_PATH}`);
    console.log(`Thumbnails directory: ${THUMBNAILS_DIR}`);
    
    // Ensure thumbnails directory exists
    await ensureDirectoryExists(THUMBNAILS_DIR);
    
    // Build query
    let query = db('photos')
      .join('events', 'photos.event_id', 'events.id')
      .select(
        'photos.id',
        'photos.filename',
        'photos.path',
        'photos.thumbnail_path',
        'events.slug as event_slug'
      );
    
    if (eventId) {
      query = query.where('photos.event_id', eventId);
      console.log(`Filtering for event ID: ${eventId}`);
    }
    
    const photos = await query;
    console.log(`Found ${photos.length} photos to process`);
    
    let successCount = 0;
    let skipCount = 0;
    let errorCount = 0;
    
    for (const photo of photos) {
      const photoPath = path.join(STORAGE_PATH, 'events/active', photo.path);
      const thumbnailFilename = `thumb_${photo.filename}`;
      const thumbnailPath = path.join(THUMBNAILS_DIR, thumbnailFilename);
      
      try {
        // Check if photo file exists
        await fs.access(photoPath);
        
        // Check if thumbnail already exists
        try {
          await fs.access(thumbnailPath);
          console.log(`Thumbnail already exists for ${photo.filename}, skipping...`);
          skipCount++;
          continue;
        } catch {
          // Thumbnail doesn't exist, generate it
        }
        
        console.log(`Generating thumbnail for ${photo.filename}...`);
        const success = await generateThumbnail(photoPath, thumbnailPath);
        
        if (success) {
          // Update database with thumbnail path
          await db('photos')
            .where('id', photo.id)
            .update({
              thumbnail_path: `thumbnails/${thumbnailFilename}`
            });
          
          successCount++;
          console.log(`✓ Generated thumbnail for ${photo.filename}`);
        } else {
          errorCount++;
        }
      } catch (error) {
        console.error(`✗ Photo file not found: ${photoPath}`);
        errorCount++;
      }
    }
    
    console.log('\nThumbnail regeneration complete!');
    console.log(`- Successfully generated: ${successCount}`);
    console.log(`- Skipped (already exist): ${skipCount}`);
    console.log(`- Errors: ${errorCount}`);
    console.log(`- Total processed: ${photos.length}`);
    
  } catch (error) {
    console.error('Error during thumbnail regeneration:', error);
    process.exit(1);
  } finally {
    await db.destroy();
  }
}

// Parse command line arguments
const eventId = process.argv[2] ? parseInt(process.argv[2]) : null;

// Run the script
regenerateThumbnails(eventId).then(() => {
  console.log('Script completed successfully');
  process.exit(0);
}).catch(error => {
  console.error('Script failed:', error);
  process.exit(1);
});