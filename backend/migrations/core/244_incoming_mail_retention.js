// Stable numbering. Main carries this migration as 275_incoming_mail_retention.js.
const { backfillMailIntake } = require('../../src/utils/mailIntakeLedger');

async function add(knex, table, column, builder) {
  if (!(await knex.schema.hasColumn(table, column))) await knex.schema.alterTable(table, builder);
}

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('received_emails'))) return;
  await add(knex, 'received_emails', 'retained_bytes', t => t.bigInteger('retained_bytes').notNullable().defaultTo(0));
  await add(knex, 'received_emails', 'claim_token', t => t.string('claim_token', 36));
  await add(knex, 'received_emails', 'claim_expires_at', t => t.timestamp('claim_expires_at'));
  const hasInbound = await knex.schema.hasTable('inbound_documents');
  if (hasInbound) {
    await add(knex, 'inbound_documents', 'mail_account_key', t => t.string('mail_account_key', 64));
    await add(knex, 'inbound_documents', 'received_email_id', t => t.integer('received_email_id').unsigned());
  }
  if (!(await knex.schema.hasTable('mail_intake_state'))) {
    await knex.schema.createTable('mail_intake_state', t => {
      t.string('key', 160).primary();
      t.bigInteger('retained_audit_bytes').notNullable().defaultTo(0);
      t.timestamp('window_start');
      t.integer('window_count').notNullable().defaultTo(0);
      t.integer('blocked_count').notNullable().defaultTo(0);
    });
  }
  if (!(await knex.schema.hasTable('mail_intake_files'))) {
    await knex.schema.createTable('mail_intake_files', t => {
      t.string('file_path', 512).primary();
      t.string('file_sha256', 64).index();
      t.string('account_key', 64).notNullable();
      t.bigInteger('byte_size').notNullable();
      t.timestamp('created_at').defaultTo(knex.fn.now());
    });
  }
  await knex('mail_intake_state').insert({ key: 'installation' }).onConflict('key').ignore();
  await add(knex, 'mail_intake_state', 'sweep_cursor', t => t.string('sweep_cursor', 512));
  await add(knex, 'mail_intake_state', 'sweep_document_id', t => t.integer('sweep_document_id').defaultTo(0));
  await backfillMailIntake(knex);
};

exports.down = async function () {
  // Non-destructive: removing an admission ledger must not make retained
  // evidence disappear from capacity accounting on the next upgrade.
};
