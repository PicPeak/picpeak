'use strict';

/**
 * Migration 216 — one PDF theme for quotes, invoices and contracts, and a
 * record for every generated PDF (#1445, PDF pass 2).
 *
 * pdf_themes: one row per scope — `default`, plus optional `quote`,
 * `invoice` and `contract` overrides — each holding a validated JSON
 * `settings` object (see services/pdf/theme.js). Only the keys a row sets
 * override; the renderer's built-in values fill in the rest and equal what
 * it drew before this migration, so nothing changes until an admin edits
 * the theme. No rows are seeded: the business profile's existing PDF
 * settings (font family, folding marks) stay the fallback.
 *
 * generated_documents: each PDF the app writes for a quote, invoice or
 * contract (sent, accepted, reminder, storno, unsigned, signed, audit
 * certificate), with its path, sha256, size, page count and the theme it
 * was rendered with. The documents' own rows keep their path columns
 * (pdf_path, signed_pdf_path…) as before.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pdf_themes'))) {
    await knex.schema.createTable('pdf_themes', (t) => {
      t.increments('id').primary();
      t.string('scope', 16).notNullable().unique(); // default | quote | invoice | contract
      t.text('settings').notNullable();
      t.integer('updated_by_admin_id');
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());
    });
  }

  if (!(await knex.schema.hasTable('generated_documents'))) {
    await knex.schema.createTable('generated_documents', (t) => {
      t.increments('id').primary();
      t.string('doc_type', 16).notNullable(); // quote | invoice | contract
      t.integer('doc_id').notNullable();
      // sent | accepted | reminder | storno | unsigned | signed | audit | wet_upload
      t.string('kind', 24).notNullable();
      t.text('path').notNullable();
      t.string('sha256', 64).notNullable();
      t.integer('bytes').notNullable();
      t.integer('pages');
      t.text('theme_snapshot'); // resolved theme + font and logo sha256, JSON
      t.text('manifest'); // attachments and signature slots (contracts), JSON
      t.integer('template_version_id');
      t.string('renderer_version', 16);
      t.integer('parent_id').unsigned()
        .references('id').inTable('generated_documents').onDelete('SET NULL');
      t.timestamp('generated_at').notNullable().defaultTo(knex.fn.now());
      t.index(['doc_type', 'doc_id']);
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('generated_documents');
  await knex.schema.dropTableIfExists('pdf_themes');
};
