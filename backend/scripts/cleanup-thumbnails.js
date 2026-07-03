#!/usr/bin/env node

/**
 * Script to clean up orphaned and temporary thumbnails
 * Usage: node scripts/cleanup-thumbnails.js [--dry-run]
 */

const path = require('path');
const fs = require('fs').promises;
const { db } = require('../src/database/db');

const STORAGE_PATH = process.env.STORAGE_PATH || path.join(__dirname, '../../storage');
const THUMBNAILS_DIR = path.join(STORAGE_PATH, 'thumbnails');

async function cleanupThumbnails(dryRun = false) {
  console.log('Starting thumbnail cleanup...');
  console.log(`Thumbnails directory: ${THUMBNAILS_DIR}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}\n`);
  
  try {
    // Get all thumbnail files
    const files = await fs.readdir(THUMBNAILS_DIR);
    console.log(`Found ${files.length} files in thumbnails directory`);
    
    // Get all valid thumbnail paths from database
    const validThumbnails = await db('photos')
      .whereNotNull('thumbnail_path')
      .select('thumbnail_path');
    
    const validPaths = new Set(
      validThumbnails.map(t => path.basename(t.thumbnail_path))
    );
    
    console.log(`Found ${validPaths.size} valid thumbnails in database\n`);
    
    let tempCount = 0;
    let orphanedCount = 0;
    let validCount = 0;
    let deletedCount = 0;
    
    for (const file of files) {
      // Skip directories
      const filePath = path.join(THUMBNAILS_DIR, file);
      const stats = await fs.stat(filePath);
      if (stats.isDirectory()) continue;
      
      // Check if it's a temporary file
      if (file.startsWith('thumb_temp_')) {
        tempCount++;
        console.log(`Temporary file: ${file}`);
        
        if (!dryRun) {
          try {
            await fs.unlink(filePath);
            deletedCount++;
          } catch (error) {
            console.error(`  Failed to delete: ${error.message}`);
          }
        }
      }
      // Check if it's an orphaned thumbnail
      else if (!validPaths.has(file)) {
        orphanedCount++;
        console.log(`Orphaned file: ${file}`);
        
        if (!dryRun) {
          try {
            await fs.unlink(filePath);
            deletedCount++;
          } catch (error) {
            console.error(`  Failed to delete: ${error.message}`);
          }
        }
      } else {
        validCount++;
      }
    }
    
    console.log('\n--- Summary ---');
    console.log(`Total files: ${files.length}`);
    console.log(`Valid thumbnails: ${validCount}`);
    console.log(`Temporary files: ${tempCount}`);
    console.log(`Orphaned files: ${orphanedCount}`);
    if (!dryRun) {
      console.log(`Deleted files: ${deletedCount}`);
    } else {
      console.log(`Files to be deleted: ${tempCount + orphanedCount}`);
    }
    
  } catch (error) {
    console.error('Error during cleanup:', error);
    process.exit(1);
  }
}

// Parse command line arguments
const dryRun = process.argv.includes('--dry-run');

// Run the cleanup
cleanupThumbnails(dryRun).then(async () => {
  await db.destroy();
  console.log('\nCleanup complete');
}).catch(async error => {
  console.error('Cleanup failed:', error);
  await db.destroy();
  process.exit(1);
});