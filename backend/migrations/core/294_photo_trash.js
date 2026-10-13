'use strict';

/**
 * Migration 294: the photo trash (issue 1733, item D2).
 *
 * A photo an admin deletes moves here instead of vanishing: one row per
 * photo, holding the whole `photos` row and the child rows worth keeping as
 * JSON, next to the columns the list, the purge and the restore filter on.
 * The original file moves under the `trash/` storage prefix (trash_key);
 * an external photo has no keys, its file stays where it is.
 *
 * `state` fences the multi-step moves (see services/photoTrashService.js):
 *   pending    the row exists, the photo row still does too
 *   trashed    at rest
 *   restoring  being put back
 *   purging    being deleted for good
 * A photo has at most one `pending` row: the partial unique index is what
 * makes "this request is the one trashing it" an atomic claim. Rows at rest
 * are not limited (see photo_id below).
 *
 * `restore_move_at` is set when a restore starts moving the file back. A
 * crashed restore without it moved nothing, so whatever lies at the
 * destination is not its own.
 *
 * Timestamps are ISO strings in varchar columns, like
 * event_download_grants.granted_at: the same text on both engines, so
 * `purge_after <= now` compares the same way on SQLite and PostgreSQL.
 *
 * Additive; safe to re-run.
 */

exports.up = async function up(knex) {
  // Set on a photo that came back from the trash: its processing run only
  // makes the derived files again and does not announce an upload.
  if (!(await knex.schema.hasColumn('photos', 'restored_from_trash_at'))) {
    await knex.schema.alterTable('photos', (t) => t.string('restored_from_trash_at', 32).nullable());
  }
  if (!(await knex.schema.hasTable('photo_trash'))) await createPhotoTrash(knex);
  // Partial indexes read the same on PostgreSQL and SQLite.
  await knex.raw(
    'CREATE UNIQUE INDEX IF NOT EXISTS photo_trash_pending_photo_uidx ON photo_trash (photo_id) WHERE state = \'pending\''
  );
};

async function createPhotoTrash(knex) {
  await knex.schema.createTable('photo_trash', (t) => {
    t.increments('id').primary();
    // The id the photo had, and gets back on restore. Not unique: restoring
    // a database backup resets the id sequence to the highest live photo, so
    // a later photo can carry the id of one still in the trash.
    t.integer('photo_id').notNullable().index();
    t.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
    t.string('state', 16).notNullable().defaultTo('pending');
    t.string('state_changed_at', 32).notNullable();
    t.string('filename', 512).notNullable();
    t.bigInteger('size_bytes').notNullable().defaultTo(0);
    t.string('original_key', 1024).nullable();
    t.string('trash_key', 1024).nullable();
    t.string('restore_move_at', 32).nullable();
    t.string('deleted_at', 32).notNullable();
    t.integer('deleted_by').nullable();
    t.string('deleted_by_name', 255).nullable();
    t.string('purge_after', 32).notNullable();
    t.text('photo_row').notNullable();
    t.text('children').notNullable();
    t.index(['event_id', 'state'], 'photo_trash_event_state_idx');
    t.index(['state', 'purge_after'], 'photo_trash_state_purge_idx');
  });
}

exports.down = async function down(knex) {
  // The files under trash/ stay; without the rows nothing can restore them.
  await knex.schema.dropTableIfExists('photo_trash');
  if (await knex.schema.hasColumn('photos', 'restored_from_trash_at')) {
    await knex.schema.alterTable('photos', (t) => t.dropColumn('restored_from_trash_at'));
  }
};
