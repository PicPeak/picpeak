/**
 * Migration 243: document requests (#1444, plan slice 10).
 *
 * The photographer asks a customer for a document ("signed contract", "copy
 * of your ID"); the request shows under "Needs action" in the portal until
 * the customer uploads against it, and reminder mails follow a configurable
 * ladder until then.
 *
 *   customer_document_requests
 *     status                open | fulfilled | cancelled
 *     fulfilled_document_id the upload that answered it (SET NULL: deleting
 *                           that document later does not reopen the request)
 *     reminder_count        steps of the ladder already sent. The reminder
 *                           job claims a step with a conditional update on
 *                           this column, so two replicas never both send it.
 *     ladder_started_at     what the ladder's days count from: the request's
 *                           creation, and again when it is reopened (the
 *                           answering upload was rejected or deleted).
 *
 * Setting `customer_documents_request_reminder_days` (default "3,7"): days
 * after the request at which a reminder goes out; empty turns reminders off.
 *
 * hasTable-guarded and safe to re-run; down() drops the table and setting.
 */

const SETTINGS = [
  { setting_key: 'customer_documents_request_reminder_days', setting_value: JSON.stringify('3,7'), setting_type: 'crm' },
];

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('customer_document_requests'))) {
    const hasContracts = await knex.schema.hasTable('contracts');
    await knex.schema.createTable('customer_document_requests', (t) => {
      t.increments('id').primary();
      t.integer('customer_account_id').unsigned().notNullable()
        .references('id').inTable('customer_accounts').onDelete('CASCADE');
      t.integer('event_id').unsigned()
        .references('id').inTable('events').onDelete('SET NULL');
      if (hasContracts) {
        t.integer('contract_id').unsigned()
          .references('id').inTable('contracts').onDelete('SET NULL');
      } else {
        t.integer('contract_id').unsigned();
      }
      t.string('title', 200).notNullable();
      t.string('note', 1000);
      t.timestamp('due_at');
      t.string('status', 16).notNullable().defaultTo('open');
      t.integer('fulfilled_document_id').unsigned()
        .references('id').inTable('customer_documents').onDelete('SET NULL');
      t.timestamp('fulfilled_at');
      t.timestamp('cancelled_at');
      t.integer('created_by_admin_id').unsigned()
        .references('id').inTable('admin_users').onDelete('SET NULL');
      t.timestamp('reminded_at');
      t.integer('reminder_count').notNullable().defaultTo(0);
      t.timestamp('ladder_started_at');
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());
      t.index(['customer_account_id', 'status'], 'customer_document_requests_owner_idx');
      t.index(['status'], 'customer_document_requests_status_idx');
    });
  }

  // An install that ran an earlier cut of this migration has the table
  // without the column.
  if (await knex.schema.hasTable('customer_document_requests')
    && !(await knex.schema.hasColumn('customer_document_requests', 'ladder_started_at'))) {
    await knex.schema.alterTable('customer_document_requests', (t) => { t.timestamp('ladder_started_at'); });
  }

  if (await knex.schema.hasTable('app_settings')) {
    for (const s of SETTINGS) {
      const exists = await knex('app_settings').where('setting_key', s.setting_key).first();
      if (!exists) await knex('app_settings').insert({ ...s, updated_at: knex.fn.now() });
    }
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasTable('customer_document_requests')) {
    await knex.schema.dropTable('customer_document_requests');
  }
  if (await knex.schema.hasTable('app_settings')) {
    await knex('app_settings').whereIn('setting_key', SETTINGS.map((s) => s.setting_key)).del();
  }
};
