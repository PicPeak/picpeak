/**
 * Migration: Backfill photo dimensions (v2)
 *
 * Re-runs the dimension backfill from migration 064 for any rows that are
 * still NULL. Migration 064 only ran once at upgrade time; new photos
 * imported via fileWatcher.js or s3AutoImporter.js between then and now
 * had their width/height columns left NULL because those code paths did
 * not capture metadata on insert. This PR fixes both writers, but
 * pre-existing rows still need a backfill — that is what this does.
 *
 * Without dimensions, MasonryGalleryLayout falls back to a hard-coded
 * 800×600 default, which is why every card in masonry mode looks like
 * the same 4:3 box (#447).
 *
 * Local-fs only — S3 deployments cannot read source objects in a
 * migration without instantiating the storage backend. Those
 * deployments rely on the writer fix in s3AutoImporter.js for new
 * photos and can run a one-shot script if a backfill is needed.
 */

const path = require('path');
const fs = require('fs');

exports.up = async function(knex) {
  const hasWidth = await knex.schema.hasColumn('photos', 'width');
  const hasHeight = await knex.schema.hasColumn('photos', 'height');
  if (!hasWidth || !hasHeight) {
    console.log('[Migration 090] width/height columns not present, skipping');
    return;
  }

  const backend = (process.env.STORAGE_BACKEND || 'local').toLowerCase();
  if (backend !== 'local') {
    console.log(`[Migration 090] STORAGE_BACKEND=${backend} — backfill skipped (S3 deployments not supported in-migration)`);
    return;
  }

  const storagePath = process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');

  const photos = await knex('photos')
    .where(function () {
      this.whereNull('width').orWhereNull('height');
    })
    .andWhere(function () {
      // Skip videos — sharp can't handle them; they need ffprobe.
      this.where('media_type', '!=', 'video').orWhereNull('media_type');
    })
    .select('id', 'path', 'filename');

  if (photos.length === 0) {
    console.log('[Migration 090] no photos missing dimensions');
    return;
  }

  console.log(`[Migration 090] backfilling ${photos.length} photos`);

  let sharp;
  try {
    sharp = require('sharp');
  } catch (err) {
    console.error('[Migration 090] sharp unavailable, skipping:', err.message);
    return;
  }

  let updated = 0;
  let failed = 0;
  for (const photo of photos) {
    try {
      if (!photo.path) {
        failed++;
        continue;
      }
      const fullPath = path.join(storagePath, 'events/active', photo.path);
      if (!fs.existsSync(fullPath)) {
        failed++;
        continue;
      }
      const metadata = await sharp(fullPath).metadata();
      if (metadata.width && metadata.height) {
        await knex('photos').where('id', photo.id).update({
          width: metadata.width,
          height: metadata.height,
        });
        updated++;
        if (updated % 100 === 0) {
          console.log(`[Migration 090] ${updated}/${photos.length}`);
        }
      } else {
        failed++;
      }
    } catch (err) {
      console.error(`[Migration 090] photo ${photo.id}: ${err.message}`);
      failed++;
    }
  }

  console.log(`[Migration 090] done — ${updated} updated, ${failed} skipped`);
};

exports.down = async function() {
  // Data-only migration; no rollback action.
};
