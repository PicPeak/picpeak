/**
 * Script to backfill photo dimensions for photos that are missing them
 */
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

// Dynamic require for knex to use the app's config
const config = require('../backend/knexfile');
const knex = require('knex')(config);

const storagePath = process.env.STORAGE_PATH || path.join(__dirname, '../storage');

async function backfillDimensions() {
  console.log('Storage path:', storagePath);

  const photos = await knex('photos')
    .whereNull('width')
    .orWhereNull('height')
    .select('id', 'path', 'filename', 'media_type');

  console.log(`Found ${photos.length} photos without dimensions`);

  let updated = 0;
  let failed = 0;

  for (const photo of photos) {
    if (photo.media_type === 'video') continue;

    if (!photo.path) {
      console.log(`Photo ${photo.id} has no path`);
      failed++;
      continue;
    }

    const fullPath = path.join(storagePath, 'events/active', photo.path);

    if (!fs.existsSync(fullPath)) {
      console.log(`Not found: ${fullPath}`);
      failed++;
      continue;
    }

    try {
      const metadata = await sharp(fullPath).metadata();
      if (metadata.width && metadata.height) {
        await knex('photos')
          .where('id', photo.id)
          .update({ width: metadata.width, height: metadata.height });
        updated++;

        if (updated % 20 === 0) {
          console.log(`Updated ${updated} photos...`);
        }
      }
    } catch (err) {
      console.log(`Error processing photo ${photo.id}:`, err.message);
      failed++;
    }
  }

  console.log(`\nCompleted: ${updated} updated, ${failed} failed`);
  await knex.destroy();
  process.exit(0);
}

backfillDimensions().catch(err => {
  console.error(err);
  process.exit(1);
});
