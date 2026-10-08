const path = require('path');
const fsp = require('fs').promises;
const logger = require('./logger');
const { getStoragePath } = require('../config/storage');
const { resolveStoredPath } = require('./storedPath');
const { assertPathInside } = require('./safePath');

const META_BYTES = 16384;
const AUDIT_BYTES = 65536;

// A stored timestamp as epoch ms. SQLite hands back whatever was written:
// epoch ms, an ISO string, or the column default `YYYY-MM-DD HH:MM:SS`,
// which is UTC but would parse as local time without the suffix.
function timestampMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' || /^\d+$/.test(String(value))) return Number(value);
  const text = String(value || '');
  return new Date(/(?:Z|[+-]\d\d:?\d\d)$/i.test(text) ? text : `${text.replace(' ', 'T')}Z`).getTime();
}

/** Size of a stored business document, or null when it cannot be measured. */
async function measure(storedPath) {
  try {
    return (await fsp.stat(assertPathInside(resolveStoredPath(storedPath), [path.join(getStoragePath(), 'business-docs')]))).size;
  } catch (_) { return null; }
}

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
  let last = 0;
  let missing = 0;
  let rows;
  do {
    rows = await knex('inbound_documents').where({ source: 'email' }).where('id', '>', last).orderBy('id').limit(100)
      .select('id', 'file_path', 'file_sha256', 'created_at', 'mail_account_key');
    if (!rows.length) break;
    for (const row of rows) {
      if (!row.mail_account_key) {
        await require('../services/accountingHistory').auditedUpdate(knex, 'inbound_documents', { id: row.id },
          { mail_account_key: 'accounting' }, { actor: 'mail-ledger', source: 'mail.ledger.backfill' });
        row.mail_account_key = 'accounting';
      }
      if (!row.file_path || await knex('mail_intake_files').where({ file_path: row.file_path }).first()) continue;
      // Charge what is on disk. A file that cannot be measured (a restore
      // loads rows before files) counts 0 until the sweeper measures it.
      const size = await measure(row.file_path);
      if (size === null) missing += 1;
      const created = timestampMs(row.created_at);
      await knex('mail_intake_files').insert({ file_path: row.file_path, file_sha256: row.file_sha256,
        account_key: row.mail_account_key, byte_size: size || 0,
        created_at: new Date(Number.isFinite(created) && row.created_at ? created : Date.now()).toISOString() }).onConflict('file_path').ignore();
    }
    last = rows[rows.length - 1].id;
  } while (rows.length === 100);
  if (missing) logger.warn(`Incoming mail: ${missing} captured attachment file(s) could not be measured and are charged 0 bytes until the sweeper finds them`);
  const counts = await knex('inbound_documents').where({ source: 'email' }).groupBy('mail_account_key').select('mail_account_key').count({ n: '*' });
  for (const row of counts) {
    await knex('mail_intake_state').insert({ key: `audit:${row.mail_account_key}`, retained_audit_bytes: Number(row.n) * AUDIT_BYTES }).onConflict('key').ignore();
  }
}

module.exports = { backfillMailIntake, measure, timestampMs, META_BYTES, AUDIT_BYTES };
