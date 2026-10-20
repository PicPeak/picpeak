'use strict';

/**
 * Migration 314: neutral photo labels per gallery (issue 1733, E6).
 *
 * events.neutral_photo_labels: when on, guests see "Photo 12 of 84" instead
 * of the filename in the lightbox, on tile captions and in alt text. Display
 * only; downloads keep their names. Off by default, so every existing gallery
 * keeps showing what it shows today. Additive; safe to re-run.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('events') && !(await knex.schema.hasColumn('events', 'neutral_photo_labels'))) {
    await knex.schema.alterTable('events', (table) => {
      table.boolean('neutral_photo_labels').notNullable().defaultTo(false);
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('events') && await knex.schema.hasColumn('events', 'neutral_photo_labels')) {
    await knex.schema.alterTable('events', (table) => {
      table.dropColumn('neutral_photo_labels');
    });
  }
};
