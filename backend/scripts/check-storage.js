#!/usr/bin/env node

/**
 * Script to check storage directory structure and verify files
 * Usage: node scripts/check-storage.js [eventSlug]
 */

const path = require('path');
const fs = require('fs').promises;
const { db } = require('../src/database/db');

const STORAGE_PATH = process.env.STORAGE_PATH || path.join(__dirname, '../../storage');

async function checkDirectory(dirPath, description) {
  try {
    await fs.access(dirPath);
    const stats = await fs.stat(dirPath);
    const files = await fs.readdir(dirPath);
    console.log(`✓ ${description}: ${dirPath}`);
    console.log(`  - Files/Folders: ${files.length}`);
    console.log(`  - Permissions: ${(stats.mode & parseInt('777', 8)).toString(8)}`);
    return true;
  } catch (error) {
    console.log(`✗ ${description}: ${dirPath} - ${error.message}`);
    return false;
  }
}

async function checkStorageStructure(eventSlug = null) {
  console.log('Checking storage structure...');
  console.log(`Storage base path: ${STORAGE_PATH}\n`);
  
  // Check main directories
  await checkDirectory(STORAGE_PATH, 'Storage root');
  await checkDirectory(path.join(STORAGE_PATH, 'events'), 'Events directory');
  await checkDirectory(path.join(STORAGE_PATH, 'events/active'), 'Active events');
  await checkDirectory(path.join(STORAGE_PATH, 'events/archived'), 'Archived events');
  await checkDirectory(path.join(STORAGE_PATH, 'thumbnails'), 'Thumbnails');
  await checkDirectory(path.join(STORAGE_PATH, 'uploads'), 'Uploads');
  
  console.log('\n---\n');
  
  // If event slug provided, check specific event
  if (eventSlug) {
    console.log(`Checking specific event: ${eventSlug}`);
    
    const event = await db('events').where('slug', eventSlug).first();
    if (!event) {
      console.log(`✗ Event not found in database: ${eventSlug}`);
      return;
    }
    
    console.log(`✓ Event found in database:`);
    console.log(`  - ID: ${event.id}`);
    console.log(`  - Name: ${event.event_name}`);
    console.log(`  - Active: ${event.is_active}`);
    console.log(`  - Archived: ${event.is_archived}`);
    
    // Check event directory
    const eventDir = path.join(STORAGE_PATH, 'events/active', eventSlug);
    const eventExists = await checkDirectory(eventDir, 'Event directory');
    
    if (eventExists) {
      const files = await fs.readdir(eventDir);
      console.log(`  - Photo files: ${files.filter(f => /\.(jpg|jpeg|png|gif)$/i.test(f)).length}`);
    }
    
    // Check photos in database
    const photos = await db('photos').where('event_id', event.id).select('id', 'filename', 'path', 'thumbnail_path');
    console.log(`\nDatabase photos: ${photos.length}`);
    
    // Check if photo files exist
    let existingPhotos = 0;
    let missingPhotos = 0;
    let existingThumbnails = 0;
    let missingThumbnails = 0;
    
    for (const photo of photos) {
      const photoPath = path.join(STORAGE_PATH, 'events/active', photo.path);
      try {
        await fs.access(photoPath);
        existingPhotos++;
      } catch {
        missingPhotos++;
        console.log(`  ✗ Missing photo: ${photo.path}`);
      }
      
      if (photo.thumbnail_path) {
        const thumbPath = path.join(STORAGE_PATH, photo.thumbnail_path.replace(/^\//, ''));
        try {
          await fs.access(thumbPath);
          existingThumbnails++;
        } catch {
          missingThumbnails++;
          console.log(`  ✗ Missing thumbnail: ${photo.thumbnail_path}`);
        }
      }
    }
    
    console.log(`\nFile check summary:`);
    console.log(`  - Photos: ${existingPhotos} exist, ${missingPhotos} missing`);
    console.log(`  - Thumbnails: ${existingThumbnails} exist, ${missingThumbnails} missing`);
  } else {
    // List all event directories
    try {
      const activeDir = path.join(STORAGE_PATH, 'events/active');
      const eventDirs = await fs.readdir(activeDir);
      console.log(`Active event directories: ${eventDirs.length}`);
      for (const dir of eventDirs.slice(0, 10)) {
        console.log(`  - ${dir}`);
      }
      if (eventDirs.length > 10) {
        console.log(`  ... and ${eventDirs.length - 10} more`);
      }
    } catch (error) {
      console.log('Could not list event directories:', error.message);
    }
  }
}

// Parse command line arguments
const eventSlug = process.argv[2] || null;

// Run the script
checkStorageStructure(eventSlug).then(async () => {
  await db.destroy();
  console.log('\nStorage check complete');
}).catch(async error => {
  console.error('Error:', error);
  await db.destroy();
  process.exit(1);
});