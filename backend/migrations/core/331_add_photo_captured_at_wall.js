/**
 * Issue 2305: the camera's own clock for a photo's capture time, as the EXIF
 * wrote it ('YYYY-MM-DDTHH:MM:SS', plus '+HH:MM' when the camera recorded its
 * offset). captured_at keeps the instant exifr makes of it in the server's
 * zone; that instant cannot give the camera time back for a time inside the
 * zone's spring-forward gap, nor after the operator changes TZ.
 *
 * NULL = not read yet (the capture date backfill reads it from the file);
 * '' = read, and the file carries no camera time. Additive: existing rows
 * stay NULL until the backfill runs, and the list shows them as before.
 * Nothing is read from files here.
 */
exports.up = async function up(knex) {
  if (!await knex.schema.hasTable('photos')) return;
  const has = await knex.schema.hasColumn('photos', 'captured_at_wall');
  if (!has) {
    await knex.schema.alterTable('photos', (t) => {
      t.string('captured_at_wall', 32).nullable().defaultTo(null);
    });
  }
};

exports.down = async function down(knex) {
  if (!await knex.schema.hasTable('photos')) return;
  const has = await knex.schema.hasColumn('photos', 'captured_at_wall');
  if (has) {
    await knex.schema.alterTable('photos', (t) => {
      t.dropColumn('captured_at_wall');
    });
  }
};
