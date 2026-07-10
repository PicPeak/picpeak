/**
 * Migration: book logged hours to a project.
 *
 * Adds customer_hour_entries.project_id (nullable FK → projects, SET NULL).
 * Hours stay primarily customer-scoped; the optional project link powers the
 * "book to project" checkbox + the Project Overview hours roll-up. Null =
 * not booked to a project (existing behaviour preserved).
 *
 * Idempotent: column guarded by hasColumn.
 */

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('customer_hour_entries'))) return;
  if (!(await knex.schema.hasColumn('customer_hour_entries', 'project_id'))) {
    await knex.schema.alterTable('customer_hour_entries', (table) => {
      table.integer('project_id').unsigned()
        .references('id').inTable('projects').onDelete('SET NULL');
      table.index(['project_id']);
    });
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('customer_hour_entries'))) return;
  if (await knex.schema.hasColumn('customer_hour_entries', 'project_id')) {
    await knex.schema.alterTable('customer_hour_entries', (table) => {
      table.dropColumn('project_id');
    });
  }
};
