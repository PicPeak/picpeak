/**
 * Migration 369: chapter markers for categories (issue 2548).
 *
 * A marker is a heading, a subheading, a time and a location shown above a
 * category's photos. The text belongs to one gallery, not to the category:
 * the shared global categories ("Ceremony", "Reception") are used by every
 * event, and "12:00 · Standesamt" is only true for one of them. So the
 * marker lives in its own table keyed by (event, category), next to
 * event_category_order (migration 160), which layers per-event order over
 * the same shared categories.
 *
 * chapter_time is a wall-clock time of day, 'HH:MM' (24 h). The event
 * already has its date, and a plain string cannot be shifted by a server or
 * browser time zone; the gallery formats it per locale.
 *
 * events.chapter_marker_style: 'off' (default, unchanged gallery) |
 * 'divider' | 'hero'.
 *
 * Additive, hasTable/hasColumn-guarded, safe to re-run.
 */
exports.up = async function (knex) {
  if (await knex.schema.hasTable('events')
    && !(await knex.schema.hasColumn('events', 'chapter_marker_style'))) {
    await knex.schema.alterTable('events', (t) => {
      t.string('chapter_marker_style', 10).notNullable().defaultTo('off');
    });
  }

  if (!(await knex.schema.hasTable('photo_categories'))) return;
  if (await knex.schema.hasTable('event_category_chapters')) return;

  await knex.schema.createTable('event_category_chapters', (t) => {
    t.increments('id').primary();
    t.integer('event_id').notNullable()
      .references('id').inTable('events').onDelete('CASCADE');
    t.integer('category_id').notNullable()
      .references('id').inTable('photo_categories').onDelete('CASCADE');
    t.string('chapter_heading', 100).nullable();
    t.string('chapter_subheading', 200).nullable();
    t.string('chapter_time', 5).nullable();
    t.string('chapter_location', 120).nullable();
    t.timestamp('updated_at').nullable();

    // One marker per (event, category).
    t.unique(['event_id', 'category_id']);
  });
};

exports.down = async function (knex) {
  if (await knex.schema.hasTable('event_category_chapters')) {
    await knex.schema.dropTable('event_category_chapters');
  }
  if (await knex.schema.hasTable('events')
    && await knex.schema.hasColumn('events', 'chapter_marker_style')) {
    await knex.schema.alterTable('events', (t) => {
      t.dropColumn('chapter_marker_style');
    });
  }
};
