/**
 * Migration 242: scan state for customer documents (#1444, plan slice 8).
 *
 * The hourly re-scan picks up documents still `pending` once a scanner
 * (clamd) is registered, and several replicas must not scan the same row at
 * once:
 *
 *   scan_claimed_until  epoch ms until which one worker owns the row. Claimed
 *                       with a conditional update (NULL or in the past); an
 *                       integer so the comparison is the same on both engines.
 *   scanned_at          when a scanner last gave a verdict on the row.
 *
 * hasColumn-guarded and safe to re-run; down() drops both columns.
 */

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('customer_documents'))) return;
  if (!(await knex.schema.hasColumn('customer_documents', 'scan_claimed_until'))) {
    await knex.schema.alterTable('customer_documents', (t) => { t.bigInteger('scan_claimed_until'); });
  }
  if (!(await knex.schema.hasColumn('customer_documents', 'scanned_at'))) {
    await knex.schema.alterTable('customer_documents', (t) => { t.timestamp('scanned_at'); });
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('customer_documents'))) return;
  for (const column of ['scan_claimed_until', 'scanned_at']) {
    if (await knex.schema.hasColumn('customer_documents', column)) {
      await knex.schema.alterTable('customer_documents', (t) => { t.dropColumn(column); });
    }
  }
};
