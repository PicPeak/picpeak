/**
 * Migration 132: incoming-invoice categorisation note + customer linkage.
 *
 *   - note               : free-text note captured during triage (issue: no
 *                          note field on categorisation).
 *   - customer_account_id: the client a rebill/passthrough is attached to.
 *                          Previously the customer was passed transiently to
 *                          the re-bill call and only lived on the resulting
 *                          invoice. Persisting it lets a categorised-but-not-
 *                          yet-billed item sit as a PENDING re-bill in the
 *                          customer's pool (per-event customers), exactly like
 *                          unbilled hour entries. Loose link (no hard FK —
 *                          mirrors the inbound event_id / expenses approach),
 *                          indexed for the pending-summary lookup.
 *
 * Migration 126 (which added the disposition/re-bill columns) is already
 * deployed to beta, so these go in a NEW migration rather than an in-place
 * edit. Additive + hasColumn-guarded so re-runs are safe.
 */
async function addColumn(knex, table, column, builder) {
  // eslint-disable-next-line no-await-in-loop
  if (!(await knex.schema.hasColumn(table, column))) {
    await knex.schema.alterTable(table, builder);
  }
}

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('inbound_documents'))) return;
  await addColumn(knex, 'inbound_documents', 'note', (t) => t.text('note'));
  await addColumn(knex, 'inbound_documents', 'customer_account_id', (t) => t.integer('customer_account_id').unsigned());
  if (await knex.schema.hasColumn('inbound_documents', 'customer_account_id')) {
    // Index the pending-rebill lookup (customer_account_id + billed_invoice_id).
    try {
      await knex.schema.alterTable('inbound_documents', (t) => t.index(['customer_account_id'], 'inbound_documents_customer_account_id_index'));
    } catch (_e) { /* index may already exist */ }
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('inbound_documents'))) return;
  for (const col of ['note', 'customer_account_id']) {
    // eslint-disable-next-line no-await-in-loop
    if (await knex.schema.hasColumn('inbound_documents', col)) {
      // eslint-disable-next-line no-await-in-loop
      await knex.schema.alterTable('inbound_documents', (t) => t.dropColumn(col));
    }
  }
};
