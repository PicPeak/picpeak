/**
 * Migration 241: abuse signals for customer documents (#1444, plan slice 9).
 *
 * customer_document_abuse_counters  One row per customer, signal and hour:
 *                                   forbidden_access (a document id that
 *                                   exists but belongs to someone else),
 *                                   quota_exceeded, rate_limited. A loop
 *                                   hammering the portal bumps a counter
 *                                   instead of writing a log row per request.
 *
 *   window_start  epoch ms of the hour, an integer on both engines so it
 *                 compares the same everywhere.
 *   logged_at /   claimed with a conditional update (… WHERE logged_at IS
 *   alerted_at    NULL), so across replicas each window logs once and alerts
 *                 once.
 *
 * Plus the setting `customer_documents_forbidden_alert_threshold` (default
 * 20): forbidden-access attempts by one customer within an hour that alert
 * the business address.
 *
 * hasTable-guarded and safe to re-run; down() drops the table and the setting
 * (the counters are derived signals, not records).
 */

const SETTINGS = [
  { setting_key: 'customer_documents_forbidden_alert_threshold', setting_value: JSON.stringify(20), setting_type: 'number' },
];

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('customer_document_abuse_counters'))) {
    await knex.schema.createTable('customer_document_abuse_counters', (t) => {
      t.increments('id').primary();
      t.integer('customer_account_id').unsigned().notNullable()
        .references('id').inTable('customer_accounts').onDelete('CASCADE');
      t.string('signal', 32).notNullable();
      t.bigInteger('window_start').notNullable();
      t.integer('count').notNullable().defaultTo(0);
      t.timestamp('logged_at');
      t.timestamp('alerted_at');
      t.unique(['customer_account_id', 'signal', 'window_start'], 'customer_document_abuse_counters_window_uq');
      t.index(['window_start'], 'customer_document_abuse_counters_window_idx');
    });
  }

  if (await knex.schema.hasTable('app_settings')) {
    for (const s of SETTINGS) {
      const exists = await knex('app_settings').where('setting_key', s.setting_key).first();
      if (!exists) await knex('app_settings').insert({ ...s, updated_at: knex.fn.now() });
    }
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasTable('customer_document_abuse_counters')) {
    await knex.schema.dropTable('customer_document_abuse_counters');
  }
  if (await knex.schema.hasTable('app_settings')) {
    await knex('app_settings').whereIn('setting_key', SETTINGS.map((s) => s.setting_key)).del();
  }
};
