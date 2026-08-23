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
 *   node scripts/regenerate-thumbnails.js [eventId]
 */

const { db } = require('../src/database/db');
const { ensureThumbnail, isThumbnailValid } = require('../src/services/imageProcessor');

async function regenerateThumbnails(eventId = null) {
  console.log('Starting thumbnail regeneration...');

  // These columns are what ensureThumbnail branches on to resolve a source and
  // name its output. Selecting a subset that misses
  // source_origin/external_relpath is how the old path bug would come back —
  // an external row would look managed and resolve under events/active.
  let query = db('photos').select(
    'id', 'event_id', 'path', 'filename', 'thumbnail_path',
    'type', 'media_type', 'mime_type', 'source_origin', 'external_relpath'
  );

  if (eventId) {
    query = query.where('event_id', eventId);
    console.log(`Filtering for event ID: ${eventId}`);
  }

  // Skip videos. A video's thumbnail is a poster frame produced by
  // videoProcessor, not a resize of the stored file, so handing the container
  // to Sharp here only ever produced one error per row.
  //
  // Tested on every marker a video row can carry, not media_type alone:
  // fileWatcher.processNewPhoto writes `type` and `mime_type` but never
  // media_type, which defaults to 'image' — so an auto-imported video passes a
  // media_type-only filter. Each clause is null-safe on its own so a row that
  // simply has no mime_type is not swept up with them.
  query = query
    .where(function () {
      this.whereNull('media_type').orWhere('media_type', '!=', 'video');
    })
    .where(function () {
      this.whereNull('type').orWhere('type', '!=', 'video');
    })
    .where(function () {
      this.whereNull('mime_type').orWhereNot('mime_type', 'like', 'video/%');
    });

  const photos = await query;
  console.log(`Found ${photos.length} photos to process`);

  let successCount = 0;
  let skipCount = 0;
  let errorCount = 0;

  for (const photo of photos) {
    const label = photo.filename || `photo ${photo.id}`;
    try {
      const existing = photo.thumbnail_path;
      // Asked BEFORE the call, not inferred from the returned path afterwards.
      // On local and external storage the key is deterministic, so repairing a
      // missing or corrupt thumbnail hands back the identical string — and
      // comparing paths would report that repair as "already valid", which is
      // the one number an operator running this is actually reading.
      const wasValid = existing ? await isThumbnailValid(existing) : false;
      const thumbnailPath = await ensureThumbnail(photo);

      if (!thumbnailPath) {
        console.error(`✗ Could not generate thumbnail for ${label}`);
        errorCount++;
        continue;
      }

      if (wasValid && thumbnailPath === existing) {
        skipCount++;
      } else {
        successCount++;
        console.log(`✓ Generated thumbnail for ${label}`);
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
  console.log(`- Total processed: ${photos.length}`);

  return { successCount, skipCount, errorCount };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const eventArg = args.find((a) => !a.startsWith('--'));
  const eventId = eventArg ? parseInt(eventArg, 10) : null;

  if (eventArg && !Number.isInteger(eventId)) {
    console.error(`Not an event id: ${eventArg}`);
    process.exit(1);
  }

  regenerateThumbnails(eventId)
    .then(async (result) => {
      await db.destroy();
      // Exit status is the only thing a cron job reads. Resolving with a
      // nonzero errorCount and still exiting 0 told automation the backfill
      // was done when it had failed — which is how an unavailable mount stays
      // unnoticed until someone opens a gallery.
      if (result.errorCount) {
        console.error(`Script completed with failures: ${result.errorCount} photo(s)`);
        process.exit(1);
      }
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
