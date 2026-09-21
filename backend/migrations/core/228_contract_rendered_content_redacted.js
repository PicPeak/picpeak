'use strict';

/**
 * Migration 228: `contracts.rendered_content_redacted_at` (#1446).
 *
 * Erasing a customer cancels their contracts that carry no signature yet and
 * clears the customer's name and address out of the frozen `rendered_content`
 * snapshot. The snapshot's sha256 is deliberately left as it was — it is the
 * hash a signer would have been bound to, and rewriting it would rewrite
 * evidence. This column records that the text behind that hash was redacted,
 * so a later integrity check reads a mismatch as "redacted on erasure"
 * instead of "tampered with".
 *
 * Contracts that already carry a signature are never redacted: they are the
 * contractual record, and erasure keeps them whole (see
 * services/contract/erasure.js for the rule).
 */

const COLUMNS = [
  ['rendered_content_redacted_at', (t) => t.timestamp('rendered_content_redacted_at')],
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
