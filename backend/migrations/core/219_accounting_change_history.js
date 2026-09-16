/**
 * Migration 219: append-only change history for accounting records.
 *
 * activity_logs records that something happened to an invoice, quote,
 * contract or expense, but only with IDs, often without the admin who did it,
 * best-effort, and in a table the notification "clear all" button empties.
 * This table records what changed: one row per inserted, updated or deleted
 * record, with the changed fields' old and new values, written in the same
 * transaction as the change itself (services/accountingHistory.js).
 *
 * `document_type`/`document_id` name the record a person looks up (the invoice
 * a line item or payment belongs to), `entity_type`/`entity_id` the row that
 * actually changed. Nothing in the application updates or deletes these rows.
 *
 * Additive and idempotent: creates the table only when missing, and `down`
 * drops it only when present.
 */
exports.up = async function (knex) {
  if (await knex.schema.hasTable('accounting_change_history')) return;
  await knex.schema.createTable('accounting_change_history', (t) => {
    t.increments('id').primary();
    t.string('document_type', 32).notNullable();
    t.integer('document_id').notNullable();
    t.string('entity_type', 40).notNullable();
    t.integer('entity_id').notNullable();
    // 'created' | 'updated' | 'deleted'
    t.string('action', 16).notNullable();
    // { column: { from, to } }
    t.json('changes').notNullable();
    // 'admin' | 'customer' | 'public' | 'system'
    t.string('actor_type', 16).notNullable();
    t.integer('actor_id').nullable();
    t.string('actor_name', 255).nullable();
    // The code path that made the change, e.g. 'invoice.send'.
    t.string('source', 100).nullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index(['document_type', 'document_id'], 'accounting_change_history_document_idx');
    t.index(['entity_type', 'entity_id'], 'accounting_change_history_entity_idx');
  });
};

exports.down = async function (knex) {
  if (await knex.schema.hasTable('accounting_change_history')) {
    await knex.schema.dropTable('accounting_change_history');
  }
};
