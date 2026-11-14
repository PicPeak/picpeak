'use strict';
/**
 * Migration 361: a curated selection inside an external source (issue 2356).
 *
 * - events.selection_path: a folder inside the event's external source,
 *   relative to EXTERNAL_MEDIA_ROOT like external_path. NULL = no selection;
 *   the gallery works as before.
 * - events.full_share_token: the "full link", which opens the gallery with
 *   every photo of the source. NULL = no full link.
 * - photos.selection_hidden: true for a photo of the source outside the
 *   selection folder. Guests of the ordinary link and QR code do not see it;
 *   the full link, the client login and the admin do. Written by the
 *   importer and by a selection change (services/externalSelection.js).
 *
 * Additive and idempotent; every existing photo starts in the selection.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('events')) {
    if (!(await knex.schema.hasColumn('events', 'selection_path'))) {
      await knex.schema.alterTable('events', (t) => t.text('selection_path').nullable());
    }
    if (!(await knex.schema.hasColumn('events', 'full_share_token'))) {
      await knex.schema.alterTable('events', (t) => t.string('full_share_token', 64).nullable().unique());
    }
  }
  if ((await knex.schema.hasTable('photos')) && !(await knex.schema.hasColumn('photos', 'selection_hidden'))) {
    await knex.schema.alterTable('photos', (t) => t.boolean('selection_hidden').notNullable().defaultTo(false));
  }
};

exports.down = async function down(knex) {
  if ((await knex.schema.hasTable('photos')) && (await knex.schema.hasColumn('photos', 'selection_hidden'))) {
    await knex.schema.alterTable('photos', (t) => t.dropColumn('selection_hidden'));
  }
  if (await knex.schema.hasTable('events')) {
    if (await knex.schema.hasColumn('events', 'full_share_token')) {
      await knex.schema.alterTable('events', (t) => {
        t.dropUnique(['full_share_token']);
        t.dropColumn('full_share_token');
      });
    }
    if (await knex.schema.hasColumn('events', 'selection_path')) {
      await knex.schema.alterTable('events', (t) => t.dropColumn('selection_path'));
    }
  }
};
