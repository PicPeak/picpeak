#!/usr/bin/env node

/**
 * Script to generate pre-watermarked versions for existing photos
 * This is a one-time migration script to populate watermarks for photos
 * that existed before the pre-generation feature was implemented.
 *
 * Usage: node scripts/generate-watermarks.js [eventId]
 *
 * Options:
 *   eventId - Optional: Only generate watermarks for a specific event
 *
 * Examples:
 *   node scripts/generate-watermarks.js          # Generate for all photos
 *   node scripts/generate-watermarks.js 5        # Generate for event ID 5
 */

const path = require('path');
const { db } = require('../src/database/db');
const watermarkService = require('../src/services/watermarkService');
const watermarkGeneratorService = require('../src/services/watermarkGeneratorService');

async function generateWatermarks(eventId = null) {
  try {
    console.log('='.repeat(60));
    console.log('PicPeak Watermark Generation Script');
    console.log('='.repeat(60));

    // Check if watermarking is enabled
    const settings = await watermarkService.getWatermarkSettings();

    if (!settings || !settings.enabled) {
      console.log('\nWatermarking is currently DISABLED in settings.');
      console.log('Enable watermarking in Admin > Branding settings first.');
      console.log('Exiting without generating watermarks.');
      process.exit(0);
    }

    console.log('\nWatermark Settings:');
    console.log(`  Enabled: ${settings.enabled}`);
    console.log(`  Position: ${settings.position}`);
    console.log(`  Opacity: ${settings.opacity}%`);
    console.log(`  Size: ${settings.size}%`);
    console.log(`  Logo: ${settings.logoPath || '(using text fallback)'}`);

    // Build query
    let query = db('photos')
      .join('events', 'photos.event_id', 'events.id')
      .whereNull('photos.watermark_path')
      .whereNot(function() {
        this.where('photos.media_type', 'video')
          .orWhere('photos.mime_type', 'like', 'video/%');
      })
      .select(
        'photos.id',
        'photos.filename',
        'photos.event_id',
        'events.event_name'
      );

    if (eventId) {
      query = query.where('photos.event_id', eventId);
      console.log(`\nFiltering to event ID: ${eventId}`);
    }

    const photos = await query;

    if (photos.length === 0) {
      console.log('\nNo photos found without watermarks.');
      if (eventId) {
        console.log(`(Checked event ID: ${eventId})`);
      }
      console.log('All photos already have pre-generated watermarks or watermarking is disabled.');
      process.exit(0);
    }

    console.log(`\nFound ${photos.length} photos without watermarks.`);

    // Group by event for display
    const eventCounts = {};
    photos.forEach(p => {
      eventCounts[p.event_name] = (eventCounts[p.event_name] || 0) + 1;
    });

    console.log('\nPhotos by event:');
    Object.entries(eventCounts).forEach(([name, count]) => {
      console.log(`  ${name}: ${count} photos`);
    });

    console.log('\nStarting watermark generation...\n');

    let successCount = 0;
    let failCount = 0;
    const startTime = Date.now();

    // Process photos with progress display
    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i];
      const progress = Math.round(((i + 1) / photos.length) * 100);

      process.stdout.write(`\r[${progress}%] Processing photo ${i + 1}/${photos.length}: ${photo.filename.substring(0, 30)}...`);

      try {
        const result = await watermarkGeneratorService.generateForPhoto(photo.id);

        if (result.success) {
          successCount++;
        } else {
          failCount++;
          console.log(`\n  Failed: ${photo.filename} - ${result.error}`);
        }
      } catch (error) {
        failCount++;
        console.log(`\n  Error: ${photo.filename} - ${error.message}`);
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('\n');
    console.log('='.repeat(60));
    console.log('Watermark Generation Complete');
    console.log('='.repeat(60));
    console.log(`  Total processed: ${photos.length}`);
    console.log(`  Successful: ${successCount}`);
    console.log(`  Failed: ${failCount}`);
    console.log(`  Duration: ${duration} seconds`);
    console.log(`  Average: ${(photos.length / parseFloat(duration)).toFixed(1)} photos/second`);

    if (failCount > 0) {
      console.log('\nSome watermarks failed to generate. Check the errors above.');
      console.log('You can re-run this script to retry failed photos.');
    }

    process.exit(failCount > 0 ? 1 : 0);
  } catch (error) {
    console.error('\nFatal error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const eventId = args[0] ? parseInt(args[0], 10) : null;

if (args[0] && isNaN(eventId)) {
  console.error('Error: eventId must be a number');
  console.log('Usage: node scripts/generate-watermarks.js [eventId]');
  process.exit(1);
}

// Run the script
generateWatermarks(eventId)
  .then(() => {
    process.exit(0);
  })
  .catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
