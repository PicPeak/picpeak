/**
 * Migration 191: remember which photos the orientation backfill has already
 * looked at (#1198).
 *
 * Without this the job is not idempotent, and the way it fails is expensive.
 * Its trigger is the EXIF orientation tag on the ORIGINAL, which the backfill
 * never changes — correcting the derived data does not untag the source. So on
 * a second run every orientation-tagged photo still reads as "transformed",
 * gets its freshly-regenerated thumbnail, preview and hero thrown away again,
 * and has a completed face scan requeued. On an install with face detection on,
 * running the job twice means re-detecting the whole library for nothing.
 *
 * The same applies to photos imported AFTER #1185, which are already correct
 * but still carry their tag.
 *
 * A timestamp rather than a boolean so a future fix to the orientation
 * handling can re-open the rows it needs by comparing against its own release
 * date, instead of needing another column.
 */

exports.up = async function (knex) {
  if (!(await knex.schema.hasColumn('photos', 'orientation_checked_at'))) {
    await knex.schema.alterTable('photos', (table) => {
      table.timestamp('orientation_checked_at').nullable();
    });
    console.log('191: added photos.orientation_checked_at');
  }

  // Outside the column guard, for the same reason as 185: a run that died
  // between the two statements would leave the column present and the index
  // missing, and the re-run would skip both. The backfill's candidate query
  // filters on this column across the whole photos table, so it wants one.
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS photos_orientation_checked_idx '
    + 'ON photos (orientation_checked_at)'
  );
};

exports.down = async function (knex) {
  // Index first and unconditionally: SQLite rebuilds the table on dropColumn,
  // and an index over the dropped column makes that rebuild fail.
  await knex.raw('DROP INDEX IF EXISTS photos_orientation_checked_idx');
  if (await knex.schema.hasColumn('photos', 'orientation_checked_at')) {
    await knex.schema.alterTable('photos', (table) => {
      table.dropColumn('orientation_checked_at');
    });
  }
};
