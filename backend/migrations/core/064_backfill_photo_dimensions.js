/**
 * Migration: Backfill photo dimensions
 *
 * This migration extracts width/height from existing photos that don't have
 * these dimensions stored. This is needed for aspect-ratio-aware layouts
 * (masonry, mosaic, justified) to work properly.
 */

const path = require('path');
const fs = require('fs');

exports.up = async function(knex) {
  // Check if the width/height columns exist
  const hasWidth = await knex.schema.hasColumn('photos', 'width');
  const hasHeight = await knex.schema.hasColumn('photos', 'height');

  if (!hasWidth || !hasHeight) {
    console.log('[Migration 064] Width/height columns not found, skipping backfill');
    return;
  }

  // Get storage path
  const storagePath = process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');

  // Find photos without dimensions
  const photos = await knex('photos')
    .whereNull('width')
    .orWhereNull('height')
    .select('id', 'path', 'filename', 'media_type');

  console.log(`[Migration 064] Found ${photos.length} photos without dimensions`);

  if (photos.length === 0) {
    return;
  }

  // Import sharp dynamically (only needed during migration)
  let sharp;
  try {
    sharp = require('sharp');
  } catch (err) {
    console.error('[Migration 064] Sharp not available, skipping backfill:', err.message);
    return;
  }

  let updated = 0;
  let failed = 0;

  for (const photo of photos) {
    try {
      // Skip videos - they need ffprobe for metadata
      if (photo.media_type === 'video') {
        continue;
      }

      // Construct the full file path
      let fullPath;
      if (photo.path) {
        // Path is relative to events/active directory
        fullPath = path.join(storagePath, 'events/active', photo.path);
      } else {
        console.warn(`[Migration 064] Photo ${photo.id} (${photo.filename}) has no path, skipping`);
        continue;
      }

      // Check if file exists
      if (!fs.existsSync(fullPath)) {
        console.warn(`[Migration 064] Photo ${photo.id} file not found: ${fullPath}`);
        failed++;
        continue;
      }

      // Extract dimensions using sharp
      const metadata = await sharp(fullPath).metadata();

      if (metadata.width && metadata.height) {
        await knex('photos')
          .where('id', photo.id)
          .update({
            width: metadata.width,
            height: metadata.height
          });
        updated++;

        if (updated % 50 === 0) {
          console.log(`[Migration 064] Updated ${updated} photos...`);
        }
      } else {
        console.warn(`[Migration 064] Could not extract dimensions for photo ${photo.id}`);
        failed++;
      }
    } catch (err) {
      console.error(`[Migration 064] Error processing photo ${photo.id}:`, err.message);
      failed++;
    }
  }

  console.log(`[Migration 064] Completed: ${updated} updated, ${failed} failed`);
};

exports.down = async function(knex) {
  // This migration only adds data, no rollback needed
  // We don't want to null out dimensions on rollback as they're still valid
  console.log('[Migration 064] Rollback: No action needed (data-only migration)');
};
