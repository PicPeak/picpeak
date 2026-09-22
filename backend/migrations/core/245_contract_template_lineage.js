'use strict';

/**
 * Migration 245 — contract template lineage and the quote's contract
 * template (#1445).
 *
 * contract_templates.source_template_id / source_version_number
 *     the template a copy was duplicated from, and the version of it the copy
 *     has taken in (set by duplicate, moved on when the admin reviews a newer
 *     one). A newer version of the source is shown on the copy — never
 *     applied to it.
 * contract_template_versions.system_revision
 *     which revision of the built-in template a system version was built
 *     from (services/contract/defaultTemplate.js). NULL on versions made
 *     before this column: the original seed, revision 1.
 * quote_templates.default_contract_template_id
 *     the contract template a contract from a quote made with this quote
 *     template starts from. NULL = the default contract template.
 *
 * Additive and nullable; the foreign keys are SET NULL, so deleting a
 * template never takes a copy or a quote template with it.
 */

async function addColumn(knex, table, column, build) {
  if (!(await knex.schema.hasTable(table))) return;
  if (await knex.schema.hasColumn(table, column)) return;
  await knex.schema.alterTable(table, build);
}

async function dropColumn(knex, table, column) {
  if (!(await knex.schema.hasTable(table))) return;
  if (!(await knex.schema.hasColumn(table, column))) return;
  await knex.schema.alterTable(table, (t) => t.dropColumn(column));
}

exports.up = async function up(knex) {
  await addColumn(knex, 'contract_templates', 'source_template_id', (t) => t.integer('source_template_id').unsigned()
    .references('id').inTable('contract_templates').onDelete('SET NULL'));
  await addColumn(knex, 'contract_templates', 'source_version_number', (t) => t.integer('source_version_number'));
  await addColumn(knex, 'contract_template_versions', 'system_revision', (t) => t.integer('system_revision'));
  if (await knex.schema.hasTable('contract_templates')) {
    await addColumn(knex, 'quote_templates', 'default_contract_template_id', (t) => t.integer('default_contract_template_id')
      .unsigned().references('id').inTable('contract_templates').onDelete('SET NULL'));
  }
};

exports.down = async function down(knex) {
  await dropColumn(knex, 'quote_templates', 'default_contract_template_id');
  await dropColumn(knex, 'contract_template_versions', 'system_revision');
  await dropColumn(knex, 'contract_templates', 'source_version_number');
  await dropColumn(knex, 'contract_templates', 'source_template_id');
};
