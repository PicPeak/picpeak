/**
 * Preserve the camera-original filename across a replace (Lightroom
 * round-trip, #745).
 *
 * `photos.original_filename` is the only carrier of the camera name
 * (`IMG_1234.JPG`) — the stored `filename` is rewritten by
 * `generatePhotoFilename` to `<event>_<category>_<ts>.jpg`. The round-trip
 * matches renders back to their proof on that camera name.
 *
 * The problem: `photoReplacementService.replacePhoto()` overwrites
 * `original_filename` with the incoming name. So the moment an editor uploads
 * `Smith_Wedding_11234.jpg` over the proof, the camera name is gone and a
 * SECOND round-trip on the same photo has nothing left to match on. The bug
 * is invisible on the first pass, which is exactly why it needs a column
 * rather than a convention.
 *
 * `source_filename` is written once at ingest and never touched by a replace.
 * Existing rows are backfilled from `original_filename`, which for any photo
 * that has not yet been replaced IS the camera name — so galleries that
 * predate this migration can still round-trip on their first pass.
 */

exports.up = async function (knex) {
  const hasColumn = await knex.schema.hasColumn('photos', 'source_filename');
  if (!hasColumn) {
    await knex.schema.alterTable('photos', (table) => {
      table.string('source_filename', 255);
    });
  }

  // Backfill deliberately OUTSIDE the column guard, for the same reason as
  // the index below: a run that died after the alterTable but partway through
  // the update would leave the column present and half the rows unfilled, and
  // the re-run would skip both. `whereNull` makes this idempotent and
  // self-healing — it only ever touches rows that still have nothing.
  //
  // For a never-replaced photo original_filename IS the camera name. A photo
  // replaced before this migration existed has already lost it and cannot be
  // recovered; it gets the current name, which is the best available answer
  // and no worse than the NULL it would otherwise keep.
  //
  // COALESCE, not a plain copy: fileWatcher auto-imports and external-media
  // scans never set original_filename at all — for those rows the camera name
  // only ever lived in `filename`. Copying original_filename alone left every
  // NAS-mounted and auto-imported gallery with a NULL match key, which is to
  // say the round-trip could not see the galleries most likely to be driven
  // from Lightroom.
  await knex('photos')
    .whereNull('source_filename')
    .update({
      source_filename: knex.raw('COALESCE(original_filename, filename)'),
    });

  // Outside the column guard, for the same reason as migration 182: a run
  // that died between the two statements would leave the column present and
  // the index missing, and the re-run would skip both. IF NOT EXISTS is
  // supported by Postgres and SQLite alike.
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS photos_source_filename_idx '
    + 'ON photos (event_id, source_filename)'
  );
};

exports.down = async function (knex) {
  // Drop the index first and unconditionally: SQLite rebuilds the table on
  // dropColumn, and a lingering index over the dropped column makes that
  // rebuild fail.
  await knex.raw('DROP INDEX IF EXISTS photos_source_filename_idx');
  if (await knex.schema.hasColumn('photos', 'source_filename')) {
    await knex.schema.alterTable('photos', (table) => {
      table.dropColumn('source_filename');
    });
  }
};
