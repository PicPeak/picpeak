'use strict';

/**
 * Migration 253: signing reminders (#1446).
 *
 * `contract_signers.reminder_count` is how many reminder steps a signer has
 * had, and the claim that keeps two replicas from sending the same step:
 * the sweep moves it from n to n + 1 with a conditional update, and only
 * the run that changed the row sends. `reminded_at` is when the last one
 * went out.
 */

const COLUMNS = [
  ['reminder_count', (t) => t.integer('reminder_count').notNullable().defaultTo(0)],
  ['reminded_at', (t) => t.timestamp('reminded_at')],
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('contract_signers'))) return;
  for (const [column, add] of COLUMNS) {
    if (!(await knex.schema.hasColumn('contract_signers', column))) {
      await knex.schema.alterTable('contract_signers', (t) => add(t));
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('contract_signers'))) return;
  for (const [column] of COLUMNS) {
    if (await knex.schema.hasColumn('contract_signers', column)) {
      await knex.schema.alterTable('contract_signers', (t) => t.dropColumn(column));
    }
  }
};
