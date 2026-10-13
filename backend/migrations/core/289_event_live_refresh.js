'use strict';

/**
 * Migration 289: per-gallery opt-in for live refresh (issue 1733, C5).
 *
 * events.live_refresh — when on, an open guest gallery polls
 * GET /:slug/photos/state and offers "N new photos". Off by default, so
 * every existing gallery keeps today's behaviour (no polling). Additive;
 * safe to re-run.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('events'))) return;
  if (await knex.schema.hasColumn('events', 'live_refresh')) return;
  await knex.schema.alterTable('events', (table) => {
    table.boolean('live_refresh').notNullable().defaultTo(false);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('events'))) return;
  if (!(await knex.schema.hasColumn('events', 'live_refresh'))) return;
  await knex.schema.alterTable('events', (table) => {
    table.dropColumn('live_refresh');
  });
};
