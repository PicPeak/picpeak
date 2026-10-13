'use strict';

/**
 * Migration 288: camera details per photo (issue 1733, D1).
 *
 * photos.exif_json holds the allow-listed EXIF fields (services/photoExif.js)
 * as a JSON string: TEXT, so it reads the same on PostgreSQL and SQLite. NULL
 * means "not read yet" (the capture-date backfill picks those up), '{}' means
 * "read, nothing to show".
 *
 * events.show_exif_to_guests decides whether guests get them; off by default,
 * so no existing gallery starts showing anything. Additive; safe to re-run.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('photos') && !(await knex.schema.hasColumn('photos', 'exif_json'))) {
    await knex.schema.alterTable('photos', (table) => {
      table.text('exif_json').nullable();
    });
  }
  if (await knex.schema.hasTable('events') && !(await knex.schema.hasColumn('events', 'show_exif_to_guests'))) {
    await knex.schema.alterTable('events', (table) => {
      table.boolean('show_exif_to_guests').notNullable().defaultTo(false);
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('events') && await knex.schema.hasColumn('events', 'show_exif_to_guests')) {
    await knex.schema.alterTable('events', (table) => {
      table.dropColumn('show_exif_to_guests');
    });
  }
  if (await knex.schema.hasTable('photos') && await knex.schema.hasColumn('photos', 'exif_json')) {
    await knex.schema.alterTable('photos', (table) => {
      table.dropColumn('exif_json');
    });
  }
};
