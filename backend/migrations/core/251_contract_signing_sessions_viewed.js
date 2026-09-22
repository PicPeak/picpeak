'use strict';

/**
 * Migration 251: `contract_signing_sessions.viewed_at` (#1446).
 *
 * A verified signer opening the contract is recorded once per session as a
 * `viewed` event in the signing log. The column is the claim that makes it
 * once: the first request to set it appends the event, every later one —
 * a reload, or a second request racing the first — finds it set.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('contract_signing_sessions'))) return;
  if (!(await knex.schema.hasColumn('contract_signing_sessions', 'viewed_at'))) {
    await knex.schema.alterTable('contract_signing_sessions', (t) => t.timestamp('viewed_at'));
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('contract_signing_sessions'))) return;
  if (await knex.schema.hasColumn('contract_signing_sessions', 'viewed_at')) {
    await knex.schema.alterTable('contract_signing_sessions', (t) => t.dropColumn('viewed_at'));
  }
};
