'use strict';
/**
 * Migration 360: events.face_selfie_search_enabled (issue 2355).
 *
 * Per-event opt-in for "find my photos with a selfie": a guest uploads one
 * selfie, the server matches it against the gallery's stored face signatures
 * and returns the photos, and keeps nothing of the selfie. Off for every
 * event, existing and new; it only takes effect while face detection is on
 * for the event and the people bar is visible to guests (services/faceSearch).
 *
 * Additive and idempotent.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('events'))) return;
  if (!(await knex.schema.hasColumn('events', 'face_selfie_search_enabled'))) {
    await knex.schema.alterTable('events', (t) => {
      t.boolean('face_selfie_search_enabled').notNullable().defaultTo(false);
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('events'))) return;
  if (!(await knex.schema.hasColumn('events', 'face_selfie_search_enabled'))) return;
  await knex.schema.alterTable('events', (t) => t.dropColumn('face_selfie_search_enabled'));
};
