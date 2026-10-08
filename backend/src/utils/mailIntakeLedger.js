const META_BYTES = 16384;
const AUDIT_BYTES = 65536;

// Pure database repair shared by upgrade and whole-DB restore. Never retain
// a different installation's runtime rows or reduce archived audit charges.
async function backfillMailIntake(knex) {
  if (!(await knex.schema.hasTable('mail_intake_state'))) return;
  await knex('mail_intake_state').insert({ key: 'installation' }).onConflict('key').ignore();
  const size = knex.client.config.client === 'pg'
    ? 'COALESCE(octet_length(body_text), 0) + COALESCE(octet_length(body_html), 0) + ?'
    : 'COALESCE(length(CAST(body_text AS BLOB)), 0) + COALESCE(length(CAST(body_html AS BLOB)), 0) + ?';
  await knex('received_emails').where('retained_bytes', 0).update({ retained_bytes: knex.raw(size, [META_BYTES]) });
  if (!(await knex.schema.hasTable('inbound_documents'))) return;
  await knex('inbound_documents').where({ source: 'email' }).whereNull('mail_account_key').update({ mail_account_key: 'accounting' });
  const counts = await knex('inbound_documents').where({ source: 'email' }).groupBy('mail_account_key').select('mail_account_key').count({ n: '*' });
  for (const row of counts) {
    await knex('mail_intake_state').insert({ key: `audit:${row.mail_account_key}`, retained_audit_bytes: Number(row.n) * AUDIT_BYTES }).onConflict('key').ignore();
  }
  let last = 0;
  let rows;
  do {
    rows = await knex('inbound_documents').where({ source: 'email' }).where('id', '>', last).orderBy('id').limit(100)
      .select('id', 'file_path', 'file_sha256', 'created_at', 'mail_account_key');
    if (!rows.length) break;
    for (const row of rows) {
      // Unknown legacy size blocks admission until a strict stat measures it.
      if (row.file_path) await knex('mail_intake_files').insert({ file_path: row.file_path, file_sha256: row.file_sha256,
        account_key: row.mail_account_key, byte_size: 2 ** 42, created_at: row.created_at || knex.fn.now() }).onConflict('file_path').ignore();
    }
    last = rows[rows.length - 1].id;
  } while (rows.length === 100);
}

module.exports = { backfillMailIntake, META_BYTES, AUDIT_BYTES };
