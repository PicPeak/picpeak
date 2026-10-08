const META_BYTES = 16384;
const AUDIT_BYTES = 65536;

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
  // Backfill without materialising potentially large legacy bodies in JS.
  const size = knex.client.config.client === 'pg'
    ? 'COALESCE(octet_length(body_text), 0) + COALESCE(octet_length(body_html), 0) + ?'
    : 'COALESCE(length(CAST(body_text AS BLOB)), 0) + COALESCE(length(CAST(body_html AS BLOB)), 0) + ?';
  await knex('received_emails').where('retained_bytes', 0).update({ retained_bytes: knex.raw(size, [META_BYTES]) });
  if (!hasInbound) return;
  await knex('inbound_documents').where({ source: 'email' }).whereNull('mail_account_key').update({ mail_account_key: 'accounting' });
  const count = await knex('inbound_documents').where({ source: 'email' }).count({ n: '*' }).first();
  await knex('mail_intake_state').insert({ key: 'audit:accounting', retained_audit_bytes: Number(count.n) * AUDIT_BYTES }).onConflict('key').ignore();
  let last = 0;
  while (true) {
    const rows = await knex('inbound_documents').where({ source: 'email' }).where('id', '>', last).orderBy('id').limit(100).select('id', 'file_path', 'file_sha256', 'created_at');
    if (!rows.length) break;
    for (const row of rows) {
      // Unknown legacy size must block admission until a strict stat measures
      // it; assuming today's per-message cap undercharges older overrides.
      if (row.file_path) await knex('mail_intake_files').insert({ file_path: row.file_path, file_sha256: row.file_sha256, account_key: 'accounting', byte_size: 2 ** 42, created_at: row.created_at || knex.fn.now() }).onConflict('file_path').ignore();
    }
    last = rows[rows.length - 1].id;
  }
};

exports.down = async function () {
  // Non-destructive: removing an admission ledger must not make retained
  // evidence disappear from capacity accounting on the next upgrade.
};
