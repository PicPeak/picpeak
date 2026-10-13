'use strict';

/**
 * Migration 287: per-gallery longest edge for guest uploads (issue 1733).
 *
 * NULL means "upload the original", so every existing gallery keeps today's
 * behaviour. When set, the guest's browser scales JPEG, PNG and WebP photos
 * down to this many pixels on the longest edge before sending them.
 * Additive and nullable; safe to re-run.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('events'))) return;
  if (await knex.schema.hasColumn('events', 'guest_upload_max_edge')) return;
  await knex.schema.alterTable('events', (table) => {
    table.integer('guest_upload_max_edge').nullable();
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('events'))) return;
  if (!(await knex.schema.hasColumn('events', 'guest_upload_max_edge'))) return;
  await knex.schema.alterTable('events', (table) => {
    table.dropColumn('guest_upload_max_edge');
  });
};
