/**
 * Issue 2549: highlights decide which photos get the larger tiles.
 *
 * photos.highlight_pin is the photographer's manual choice and is tri-state:
 * true = always a highlight, false = never one, NULL = no choice (the
 * gallery's mode decides). A pin is a fact about the photo, not about one
 * admin, so it lives on photos rather than in the per-admin
 * photo_admin_marks rows.
 *
 * events.highlights_mode: 'off' (default, every gallery renders as before),
 * 'manual' (pins only) or 'rating' (pins plus the photos whose admin star
 * rating reaches events.highlights_threshold, capped per category).
 *
 * Additive only; down() drops the three columns.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn('photos', 'highlight_pin'))) {
    await knex.schema.alterTable('photos', (t) => {
      t.boolean('highlight_pin').nullable();
    });
  }
  if (!(await knex.schema.hasColumn('events', 'highlights_mode'))) {
    await knex.schema.alterTable('events', (t) => {
      t.string('highlights_mode', 16).notNullable().defaultTo('off');
    });
  }
  if (!(await knex.schema.hasColumn('events', 'highlights_threshold'))) {
    await knex.schema.alterTable('events', (t) => {
      t.integer('highlights_threshold').notNullable().defaultTo(4);
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('photos', 'highlight_pin')) {
    await knex.schema.alterTable('photos', (t) => {
      t.dropColumn('highlight_pin');
    });
  }
  for (const column of ['highlights_threshold', 'highlights_mode']) {
    if (await knex.schema.hasColumn('events', column)) {
      await knex.schema.alterTable('events', (t) => {
        t.dropColumn(column);
      });
    }
  }
};
