'use strict';

/**
 * Migration 218 — contract attachments (#1445).
 *
 * document_attachments                    a library of immutable PDFs (terms,
 *                                         privacy notice, appendices). Stored
 *                                         once under a relative storage key,
 *                                         business-docs/attachments/<sha256>.pdf,
 *                                         so a restore onto another host still
 *                                         finds them; `sha256` is unique, so
 *                                         uploading the same bytes again finds
 *                                         the existing entry.
 * contract_template_version_attachments   the attachments a template version
 *                                         includes, in order, each merged into
 *                                         the contract PDF or delivered as a
 *                                         separate file.
 * contract_attachment_inclusions          the attachments a contract includes,
 *                                         with the sha256 they had when they
 *                                         were added; sending refuses a file
 *                                         whose bytes no longer match.
 *
 * Library entries are archived, never deleted (FK RESTRICT).
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('document_attachments'))) {
    await knex.schema.createTable('document_attachments', (t) => {
      t.increments('id').primary();
      t.string('name', 255).notNullable();
      t.text('description');
      t.string('original_name', 255);
      t.string('storage_key', 255).notNullable();
      t.string('sha256', 64).notNullable().unique();
      t.integer('bytes').notNullable();
      t.integer('page_count').notNullable();
      t.integer('uploaded_by_admin_id');
      t.boolean('is_active').notNullable().defaultTo(true);
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());
      t.index(['is_active']);
    });
  }

  if (!(await knex.schema.hasTable('contract_template_version_attachments'))) {
    await knex.schema.createTable('contract_template_version_attachments', (t) => {
      t.increments('id').primary();
      t.integer('version_id').unsigned().notNullable()
        .references('id').inTable('contract_template_versions').onDelete('CASCADE');
      t.integer('attachment_id').unsigned().notNullable()
        .references('id').inTable('document_attachments').onDelete('RESTRICT');
      t.integer('position').notNullable();
      t.string('delivery', 8).notNullable(); // merged | separate
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.index(['version_id']);
      t.index(['attachment_id']);
    });
  }

  if (!(await knex.schema.hasTable('contract_attachment_inclusions'))) {
    await knex.schema.createTable('contract_attachment_inclusions', (t) => {
      t.increments('id').primary();
      t.integer('contract_id').unsigned().notNullable()
        .references('id').inTable('contracts').onDelete('CASCADE');
      t.integer('attachment_id').unsigned().notNullable()
        .references('id').inTable('document_attachments').onDelete('RESTRICT');
      t.integer('position').notNullable();
      t.string('delivery', 8).notNullable(); // merged | separate
      t.string('sha256', 64).notNullable();
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());
      t.index(['contract_id']);
      t.index(['attachment_id']);
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('contract_attachment_inclusions');
  await knex.schema.dropTableIfExists('contract_template_version_attachments');
  await knex.schema.dropTableIfExists('document_attachments');
};
