'use strict';

/**
 * Migration 229: per-event download limit (issue 1560).
 *
 *   events.download_limit     Nullable integer, null = unlimited — which is
 *                             every existing event, so nothing changes until
 *                             an admin sets one. Same shape as photo_cap (074).
 *   event_download_grants     One row per photo a gallery has handed out while
 *                             a limit applied. The quota counts distinct
 *                             photos, so UNIQUE (event_id, photo_id) turns
 *                             "used" into a count and a repeated download into
 *                             a no-op insert. guest_id is nullable and unused
 *                             for now; it keeps a per-guest quota from needing
 *                             a second migration.
 *
 * Both FKs cascade on PostgreSQL. PicPeak does not enable foreign keys on
 * SQLite, so the event delete paths clear the table explicitly and the quota
 * counts grants joined to photos that still exist (services/downloadQuota.js).
 *
 * hasTable/hasColumn-guarded and safe to re-run.
 */

const { addColumnIfNotExists } = require('../helpers');

exports.up = async function up(knex) {
  await addColumnIfNotExists(knex, 'events', 'download_limit', (table) => {
    table.integer('download_limit').nullable().defaultTo(null);
  });

  if (!(await knex.schema.hasTable('event_download_grants'))) {
    await knex.schema.createTable('event_download_grants', (t) => {
      t.increments('id').primary();
      t.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE');
      t.integer('photo_id').notNullable().references('id').inTable('photos').onDelete('CASCADE');
      t.integer('guest_id').nullable();
      // ISO string, not a timestamp column: Dates written from Jest land as
      // "[object Object]" on SQLite, and the string round-trips on both engines.
      t.string('granted_at', 32).notNullable();
      t.unique(['event_id', 'photo_id'], 'event_download_grants_event_photo_uniq');
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('event_download_grants');
  if (await knex.schema.hasColumn('events', 'download_limit')) {
    await knex.schema.alterTable('events', (t) => t.dropColumn('download_limit'));
  }
};
