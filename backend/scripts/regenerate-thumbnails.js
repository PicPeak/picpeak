#!/usr/bin/env node

/**
 * Fill in missing thumbnails for photos already in the database.
 *
 * The CLI fallback for when the admin UI is not reachable. It is deliberately
 * "missing only": ensureThumbnail short-circuits on a thumbnail that is
 * already present and valid, so re-running this is cheap and safe. To REBUILD
 * everything after a settings change, use POST /api/admin/thumbnails/regenerate
 * — that path drops the existing renditions first, which this one must not do.
 *
 * Resolution goes through ensureThumbnail rather than a hand-built path
 * (#1148, same defect as #1129). This script used to compute
 * `storage/events/active/<photo.path>` and fs.access it, a location that does
 * not exist for `external` or `reference` rows — their originals live under
 * the mount in events.external_path. Every such photo failed the check and was
 * counted as an error, so on an external-media install the script was inert
 * while reporting one error per photo.
 *
 * ensureThumbnail already branches on source_origin, resolves both kinds via
 * photoResolver, uses the per-photo `ext<id>_` output name so two events
 * referencing one NAS basename cannot clobber each other, and writes
 * thumbnail_path back itself. Sharing it is what stops the script and the
 * route drifting apart again.
 *
 * Usage:
 *   node scripts/regenerate-thumbnails.js [eventId] [--no-tiers]
 */

const { db } = require('../src/database/db');
const {
  ensureThumbnail,
  ensureThumbnailAtWidth,
  THUMBNAIL_WIDTHS,
} = require('../src/services/imageProcessor');

async function regenerateThumbnails(eventId = null, { tiers = true } = {}) {
  console.log('Starting thumbnail regeneration...');

  // These columns are what ensureThumbnail and ensureThumbnailAtWidth branch
  // on to resolve a source and name their output. Selecting a subset that
  // misses source_origin/external_relpath is how the old path bug would come
  // back — an external row would look managed and resolve under events/active.
  let query = db('photos').select(
    'id', 'event_id', 'path', 'filename', 'thumbnail_path',
    'media_type', 'mime_type', 'source_origin', 'external_relpath'
  );

  if (eventId) {
    query = query.where('event_id', eventId);
    console.log(`Filtering for event ID: ${eventId}`);
  }

  // Skip videos, matching the admin route. A video's thumbnail is a poster
  // frame produced by videoProcessor, not a resize of the stored file, so
  // handing the container to Sharp here only ever produced one error per row.
  query = query.where(function () {
    this.whereNull('media_type').orWhere('media_type', '!=', 'video');
  });

  const photos = await query;
  console.log(`Found ${photos.length} photos to process`);

  let successCount = 0;
  let skipCount = 0;
  let errorCount = 0;
  let tierCount = 0;

  for (const photo of photos) {
    const label = photo.filename || `photo ${photo.id}`;
    try {
      const existing = photo.thumbnail_path;
      const thumbnailPath = await ensureThumbnail(photo);

      if (!thumbnailPath) {
        console.error(`✗ Could not generate thumbnail for ${label}`);
        errorCount++;
        continue;
      }

      if (existing && thumbnailPath === existing) {
        skipCount++;
      } else {
        successCount++;
        console.log(`✓ Generated thumbnail for ${label}`);
      }

      // The responsive tiers (#1095/#1109) are cached separately from
      // thumbnail_path, so a gallery can have every canonical rendition and
      // still serve phones the full-size image. Backfilling them is the most
      // likely reason to reach for this script at all, so it is the default.
      // Each call is a no-op when the tier is already stored.
      if (tiers) {
        for (const width of THUMBNAIL_WIDTHS) {
          try {
            if (await ensureThumbnailAtWidth({ ...photo, thumbnail_path: thumbnailPath }, width)) {
              tierCount++;
            }
          } catch (error) {
            // One missing tier is not a failed photo — the canonical
            // rendition above is what the gallery falls back to.
            console.warn(`  ! tier ${width}px failed for ${label}: ${error.message}`);
          }
        }
      }
    } catch (error) {
      console.error(`✗ Failed for ${label}: ${error.message}`);
      errorCount++;
    }
  }

  console.log('\nThumbnail regeneration complete!');
  console.log(`- Generated: ${successCount}`);
  console.log(`- Skipped (already valid): ${skipCount}`);
  console.log(`- Errors: ${errorCount}`);
  if (tiers) console.log(`- Responsive tiers present: ${tierCount}`);
  console.log(`- Total processed: ${photos.length}`);

  return { successCount, skipCount, errorCount, tierCount };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const tiers = !args.includes('--no-tiers');
  const eventArg = args.find((a) => !a.startsWith('--'));
  const eventId = eventArg ? parseInt(eventArg, 10) : null;

  if (eventArg && !Number.isInteger(eventId)) {
    console.error(`Not an event id: ${eventArg}`);
    process.exit(1);
  }

  regenerateThumbnails(eventId, { tiers })
    .then(() => db.destroy())
    .then(() => {
      console.log('Script completed successfully');
      process.exit(0);
    })
    .catch(async (error) => {
      console.error('Script failed:', error);
      await db.destroy().catch(() => {});
      process.exit(1);
    });
}

module.exports = { regenerateThumbnails };
