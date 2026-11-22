/**
 * Migration 373: multilingual gallery texts (issue 2550).
 *
 * A gallery can carry its title, welcome message, category names and chapter
 * marker texts in more than one language. The existing columns
 * (events.event_name, events.welcome_message, photo_categories.name,
 * event_category_chapters.*) stay the default-language text; this table holds
 * the hand-written texts for the other languages.
 *
 * Rows are keyed by the gallery (event_id), also for a shared global category:
 * "Ceremony" is used by every event, and its German name in one gallery says
 * nothing about another. entity_type 'event' points entity_id at the event
 * itself, 'category' and 'chapter' at photo_categories.id (a chapter marker is
 * one per event and category, migration 369).
 *
 * events.text_language_mode: 'off' (default, unchanged gallery) | 'visitor'
 * (the visitor's UI language) | 'bilingual' (primary and secondary together).
 *
 * Additive, hasTable/hasColumn-guarded, safe to re-run.
 */
exports.up = async function (knex) {
  if (await knex.schema.hasTable('events')) {
    const add = [];
    if (!(await knex.schema.hasColumn('events', 'text_language_mode'))) add.push('text_language_mode');
    if (!(await knex.schema.hasColumn('events', 'text_primary_language'))) add.push('text_primary_language');
    if (!(await knex.schema.hasColumn('events', 'text_secondary_language'))) add.push('text_secondary_language');
    if (add.length > 0) {
      await knex.schema.alterTable('events', (t) => {
        if (add.includes('text_language_mode')) t.string('text_language_mode', 10).notNullable().defaultTo('off');
        if (add.includes('text_primary_language')) t.string('text_primary_language', 10).nullable();
        if (add.includes('text_secondary_language')) t.string('text_secondary_language', 10).nullable();
      });
    }
  }

  if (!(await knex.schema.hasTable('events'))) return;
  if (await knex.schema.hasTable('content_translations')) return;

  await knex.schema.createTable('content_translations', (t) => {
    t.increments('id').primary();
    t.integer('event_id').notNullable()
      .references('id').inTable('events').onDelete('CASCADE');
    t.string('entity_type', 20).notNullable();
    t.integer('entity_id').notNullable();
    t.string('field', 40).notNullable();
    t.string('language', 10).notNullable();
    t.text('text').notNullable();
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();

    t.unique(['event_id', 'entity_type', 'entity_id', 'field', 'language'], { indexName: 'content_translations_unique' });
  });
};

exports.down = async function (knex) {
  if (await knex.schema.hasTable('content_translations')) {
    await knex.schema.dropTable('content_translations');
  }
  if (await knex.schema.hasTable('events')) {
    for (const column of ['text_secondary_language', 'text_primary_language', 'text_language_mode']) {
      if (await knex.schema.hasColumn('events', column)) {
        await knex.schema.alterTable('events', (t) => { t.dropColumn(column); });
      }
    }
  }
};
