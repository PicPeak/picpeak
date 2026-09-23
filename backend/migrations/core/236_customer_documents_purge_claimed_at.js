'use strict';

/**
 * Migration 236: `customer_documents.purge_claimed_at` (#1592).
 *
 * `purgeFiles()` used to stamp `purged_at` as its claim, before deleting the
 * bytes. A crash between the stamp and the delete (process death, deploy,
 * OOM kill) left the row saying the bytes were gone while they stayed in
 * storage — and no later sweep could find it again, because every sweep
 * filters on `whereNull('purged_at')`.
 *
 * This column splits the claim from the result: `purge_claimed_at` is set
 * first (still guarded by `whereNull('contract_id')`, unchanged), the delete
 * runs, and only then is `purged_at` set. A claim that survives without a
 * matching `purged_at` past a short staleness window is a crashed attempt,
 * and a retry sweep can find it with `whereNotNull('purge_claimed_at')`
 * `whereNull('purged_at')` — something `purged_at` alone could never encode.
 */

const COLUMNS = [
  ['purge_claimed_at', (t) => t.timestamp('purge_claimed_at')],
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customer_documents'))) return;
  for (const [column, add] of COLUMNS) {
    if (!(await knex.schema.hasColumn('customer_documents', column))) {
      await knex.schema.alterTable('customer_documents', (t) => add(t));
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('customer_documents'))) return;
  for (const [column] of COLUMNS) {
    if (await knex.schema.hasColumn('customer_documents', column)) {
      await knex.schema.alterTable('customer_documents', (t) => t.dropColumn(column));
    }
  }
};
