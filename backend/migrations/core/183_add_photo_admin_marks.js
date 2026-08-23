/**
 * Photographer-side stars and colour labels (#1044 follow-up).
 *
 * The photographer triages their own shoot with the same 1-5 stars and five
 * Lightroom colours the client uses while proofing — but their marks are a
 * SEPARATE table rather than more photo_feedback rows, for one reason:
 * photo_feedback is read by a long tail of guest-facing queries (the gallery
 * payload, the per-photo tallies, the denormalized photos.average_rating /
 * *_count columns, the feedback exports, moderation). Adding admin rows there
 * would leak the photographer's own opinions into the client's proofing view
 * through whichever of those queries someone forgot to filter — and "forgot to
 * filter" is exactly the failure this shape makes impossible.
 *
 * One row per (photo, admin): rating and colour live together because they are
 * one person's verdict on one photo, and a row with neither is deleted rather
 * than kept as a tombstone.
 */

exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable('photo_admin_marks');
  if (!hasTable) {
    await knex.schema.createTable('photo_admin_marks', (table) => {
      table.increments('id').primary();
      table.integer('photo_id').notNullable()
        .references('id').inTable('photos').onDelete('CASCADE');
      // Denormalized from photos.event_id so the per-event filter and the
      // count queries don't have to join photos on every admin grid render.
      table.integer('event_id').notNullable();
      table.integer('admin_id').notNullable();
      table.integer('rating'); // 1-5, NULL = no star rating
      table.string('color_label', 16); // NULL = no colour
      table.timestamp('created_at').defaultTo(knex.fn.now());
      table.timestamp('updated_at').defaultTo(knex.fn.now());

      // One verdict per photo per admin. Two admins on the same event keep
      // their own marks; the same admin marking twice updates in place.
      table.unique(['photo_id', 'admin_id'], 'photo_admin_marks_photo_admin_uniq');
      table.index(['event_id', 'admin_id'], 'photo_admin_marks_event_admin_idx');
      table.index(['event_id', 'color_label'], 'photo_admin_marks_color_idx');
    });
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasTable('photo_admin_marks')) {
    await knex.schema.dropTable('photo_admin_marks');
  }
};
