'use strict';

/**
 * Migration 294: the photo trash (issue 1733, item D2).
 *
 * A photo an admin deletes stays where it is and is flagged instead: its
 * row, file, thumbnails and child rows are untouched, every reader that
 * shows photos skips it (utils/photoVisibility.js livePhotos), and a restore
 * clears the flag again.
 *
 *   deleted_at           when it was trashed; NULL for a photo in the gallery
 *   purge_after          when the hourly sweep deletes it for good. NULL with
 *                        deleted_at set means that delete is under way
 *                        (services/photoTrash.js)
 *   deleted_by_admin_id  who trashed it. No foreign key: deleting that admin
 *                        must not be blocked (userManagementService nulls it)
 *
 * Additive and nullable; safe to re-run.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('photos'))) return;
  for (const column of ['deleted_at', 'purge_after']) {
    if (!(await knex.schema.hasColumn('photos', column))) {
      await knex.schema.alterTable('photos', (table) => table.timestamp(column).nullable());
    }
  }
  if (!(await knex.schema.hasColumn('photos', 'deleted_by_admin_id'))) {
    await knex.schema.alterTable('photos', (table) => table.integer('deleted_by_admin_id').nullable());
  }
  // The gallery's trash list, and the live filter next to event_id.
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_photos_event_deleted_at ON photos (event_id, deleted_at)');
  // The sweep: only trashed rows are in it.
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_photos_trash_purge_after ON photos (purge_after) WHERE deleted_at IS NOT NULL');
};

// Photos in the trash are back in their galleries without the flag: nothing
// is deleted here.
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('photos'))) return;
  await knex.raw('DROP INDEX IF EXISTS idx_photos_trash_purge_after');
  await knex.raw('DROP INDEX IF EXISTS idx_photos_event_deleted_at');
  for (const column of ['deleted_by_admin_id', 'purge_after', 'deleted_at']) {
    if (await knex.schema.hasColumn('photos', column)) {
      await knex.schema.alterTable('photos', (table) => table.dropColumn(column));
    }
  }
};
