'use strict';

/**
 * Migration 255: collect the customer's details before the freeze (#1446).
 *
 * A contract can go out as `awaiting_data` first: only the first signer — the
 * customer themselves — is invited, confirms their email, and completes the
 * details the contract prints (address, company, VAT id, phone). Only then is
 * the contract rendered, hashed and frozen, and the other signers invited.
 * Nothing is frozen before, so nothing has to be revoked after.
 *
 * - contracts.data_request: the fields asked for, as JSON
 *   `{ fields: [...], required: [...] }`.
 * - contracts.data_collected_at: when they were supplied. Set by a
 *   conditional update while it is still NULL, so a second submission is
 *   refused.
 */

const COLUMNS = [
  ['data_request', (t) => t.text('data_request')],
  ['data_collected_at', (t) => t.timestamp('data_collected_at')],
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('contracts'))) return;
  for (const [column, add] of COLUMNS) {
    if (!(await knex.schema.hasColumn('contracts', column))) {
      await knex.schema.alterTable('contracts', (t) => add(t));
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('contracts'))) return;
  for (const [column] of COLUMNS) {
    if (await knex.schema.hasColumn('contracts', column)) {
      await knex.schema.alterTable('contracts', (t) => t.dropColumn(column));
    }
  }
};
