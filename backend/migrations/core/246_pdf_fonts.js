'use strict';

/**
 * Migration 246 — uploaded PDF fonts (#1445).
 *
 * pdf_fonts        a font family an admin uploaded for PDFs: the name the
 *                  theme refers to it by (`upload-<id>`, derived), a display
 *                  name, the licence note the admin must write and the time
 *                  they confirmed the right to embed it. Archived, never
 *                  deleted: a theme or a generated document's record may
 *                  still name it.
 * pdf_font_files   its faces — regular (400), bold (700), italic (400i) —
 *                  each stored once by content under business-docs/fonts/
 *                  (a backup path) and recorded with its sha256.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pdf_fonts'))) {
    await knex.schema.createTable('pdf_fonts', (t) => {
      t.increments('id').primary();
      t.string('display_name', 64).notNullable().unique();
      t.string('licence_note', 500).notNullable();
      t.timestamp('licence_acknowledged_at');
      t.integer('uploaded_by_admin_id');
      t.boolean('is_active').notNullable().defaultTo(true);
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());
    });
  }
  if (!(await knex.schema.hasTable('pdf_font_files'))) {
    await knex.schema.createTable('pdf_font_files', (t) => {
      t.increments('id').primary();
      t.integer('font_id').unsigned().notNullable()
        .references('id').inTable('pdf_fonts').onDelete('RESTRICT');
      t.string('style', 8).notNullable(); // 400 | 700 | 400i
      t.string('storage_key', 255).notNullable();
      t.string('sha256', 64).notNullable();
      t.integer('bytes').notNullable();
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.unique(['font_id', 'style']);
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('pdf_font_files');
  await knex.schema.dropTableIfExists('pdf_fonts');
};
