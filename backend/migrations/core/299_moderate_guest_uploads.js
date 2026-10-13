'use strict';

/**
 * Migration 299: guest uploads with approval (issue 1733, item C3).
 *
 *   events.moderate_guest_uploads   hold photos guests upload until the owner
 *                                   or a reviewer approves them. Off on every
 *                                   existing event.
 *
 * A held guest upload is stored the way a held team upload is (migration
 * 269): photos.visibility 'hidden' and photos.moderation_status 'pending', so
 * no gallery viewer sees it, and it leaves that state through the same
 * moderation route.
 *
 * Additive and hasTable/hasColumn-guarded.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('events')
    && !(await knex.schema.hasColumn('events', 'moderate_guest_uploads'))) {
    await knex.schema.alterTable('events', (t) => {
      t.boolean('moderate_guest_uploads').notNullable().defaultTo(false);
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('events')
    && await knex.schema.hasColumn('events', 'moderate_guest_uploads')) {
    await knex.schema.alterTable('events', (t) => t.dropColumn('moderate_guest_uploads'));
  }
};
