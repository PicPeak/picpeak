const crypto = require('crypto');
const path = require('path');
const fsp = require('fs').promises;
const { db } = require('../database/db');
const { getStoragePath } = require('../config/storage');
const { toStoredPath, resolveStoredPath, STORED_PATH_COLUMNS } = require('../utils/storedPath');
const { assertPathInside } = require('../utils/safePath');
const { whereTimestamp } = require('../utils/dbCompat');
const { auditedDelete } = require('./accountingHistory');

const { META_BYTES, AUDIT_BYTES } = require('../utils/mailIntakeLedger');
const CLAIM_MS = 10 * 60 * 1000;
const HOUR = 3600000;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const number = (key, fallback, max = 2 ** 42) => {
  const n = Number(process.env[key]);
  return Number.isSafeInteger(n) && n > 0 && n <= max ? n : fallback;
};
function policy() {
  return {
    installationBytes: number('EMAIL_INTAKE_INSTALLATION_BYTES', 2 * 1024 ** 3),
    mailboxBytes: number('EMAIL_INTAKE_MAILBOX_BYTES', 512 * 1024 ** 2),
    installationRows: number('EMAIL_INTAKE_INSTALLATION_ROWS', 50000, 2147483647),
    mailboxRows: number('EMAIL_INTAKE_MAILBOX_ROWS', 10000, 2147483647),
    installationRate: number('EMAIL_INTAKE_INSTALLATION_PER_HOUR', 1000, 2147483647),
    mailboxRate: number('EMAIL_INTAKE_MAILBOX_PER_HOUR', 500, 2147483647),
    senderRate: number('EMAIL_INTAKE_SENDER_PER_HOUR', 50, 2147483647),
    retentionDays: number('EMAIL_INTAKE_RETENTION_DAYS', 90, 36500),
    metadataDays: number('EMAIL_INTAKE_METADATA_RETENTION_DAYS', 7, 36500),
  };
}

// The first write acquires SQLite's writer lock; PostgreSQL locks this one
// common row. All claims, byte transfers, settlement and cleanup use it.
function locked(work) {
  return db.transaction(async trx => {
    const n = await trx('mail_intake_state').where({ key: 'installation' }).increment('blocked_count', 0);
    if (!n) throw new Error('Incoming-mail admission migration is required');
    return work(trx);
  });
}

async function usage(trx, accountKey) {
  const mail = trx('received_emails');
  const files = trx('mail_intake_files');
  const audits = trx('mail_intake_state').where('key', 'like', 'audit:%');
  if (accountKey) {
    mail.where(q => { q.where({ account_key: accountKey }); if (accountKey === 'accounting') q.orWhereNull('account_key'); });
    files.where({ account_key: accountKey });
    audits.where({ key: `audit:${accountKey}` });
  }
  const m = await mail.sum({ bytes: 'retained_bytes' }).count({ rows: '*' }).first();
  const f = await files.sum({ bytes: 'byte_size' }).first();
  const a = await audits.sum({ bytes: 'retained_audit_bytes' }).first();
  return { bytes: Number(m.bytes || 0) + Number(f.bytes || 0) + Number(a.bytes || 0), rows: Number(m.rows || 0) };
}

async function within(trx, accountKey, bytes) {
  const p = policy();
  const all = await usage(trx);
  const mailbox = await usage(trx, accountKey);
  return all.bytes + bytes <= p.installationBytes && mailbox.bytes + bytes <= p.mailboxBytes
    && all.rows < p.installationRows && mailbox.rows < p.mailboxRows;
}

async function rate(trx, key, limit, now) {
  const old = await trx('mail_intake_state').where({ key }).first();
  const current = old && old.window_start && new Date(old.window_start).getTime() > now.getTime() - HOUR;
  const count = current ? Number(old.window_count) : 0;
  if (count >= limit) return false;
  const row = { window_start: current ? old.window_start : now.toISOString(), window_count: count + 1 };
  if (old) await trx('mail_intake_state').where({ key }).update(row);
  else await trx('mail_intake_state').insert({ key, ...row });
  return true;
}

async function blocked(trx) {
  const row = await trx('mail_intake_state').where({ key: 'installation' }).first();
  await trx('mail_intake_state').where({ key: 'installation' }).update({ blocked_count: Math.min(2147483647, Number(row.blocked_count) + 1) });
}

/** Atomically claim and reserve before the first source download. */
async function admit({ messageId, accountKey, sender, bytes, error = null, now = new Date() }) {
  return locked(async trx => {
    if (await trx('received_emails').where({ message_id: messageId }).first()) return { skip: true };
    const p = policy();
    const allowed = await rate(trx, 'installation', p.installationRate, now)
      && await rate(trx, `rate:mail:${hash(accountKey)}`, p.mailboxRate, now)
      && await rate(trx, `rate:sender:${hash(`${accountKey}\0${String(sender || '<unknown>').trim().toLowerCase()}`)}`, p.senderRate, now);
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid incoming mail reservation');
    const reserve = Math.max(META_BYTES, bytes);
    const reason = error || (!allowed ? 'Incoming mail rate budget reached' : !(await within(trx, accountKey, reserve)) ? 'Incoming mail retained-byte or row capacity reached' : null);
    if (reason) {
      await blocked(trx);
      if (await within(trx, accountKey, META_BYTES)) {
        await trx('received_emails').insert({ message_id: messageId, account_key: accountKey, status: 'error', error: reason.slice(0, 2000), retained_bytes: META_BYTES, created_at: now.toISOString(), received_at: now.toISOString() });
      }
      return { skip: true, reason };
    }
    const token = crypto.randomUUID();
    const result = await trx('received_emails').insert({ message_id: messageId, account_key: accountKey, status: 'processing', retained_bytes: reserve, claim_token: token, claim_expires_at: new Date(now.getTime() + CLAIM_MS).toISOString(), created_at: now.toISOString(), received_at: now.toISOString() }).returning('id');
    return { id: result[0]?.id || result[0], token, accountKey };
  });
}

async function claimRow(trx, claim) {
  const row = await trx('received_emails').where({ id: claim.id, claim_token: claim.token, status: 'processing' }).first();
  const expires = row?.claim_expires_at && new Date(row.claim_expires_at).getTime();
  if (!row || !Number.isFinite(expires) || expires <= Date.now()) throw new Error('Incoming mail claim expired or superseded');
  return row;
}

function withClaim(claim, work) {
  return locked(async trx => work(trx, await claimRow(trx, claim)));
}

async function rekey(claim, messageId) {
  return withClaim(claim, async (trx, row) => {
    if (row.message_id === messageId) return true;
    if (await trx('received_emails').where({ message_id: messageId }).first()) {
      await trx('received_emails').where({ id: row.id }).del();
      return false;
    }
    await trx('received_emails').where({ id: row.id }).update({ message_id: messageId });
    return true;
  });
}

async function checkSize(claim, bodyBytes, atts) {
  return withClaim(claim, async (_trx, row) => {
    const required = META_BYTES + bodyBytes + atts.reduce((n, a) => n + a.content.length + AUDIT_BYTES, 0);
    if (required > Number(row.retained_bytes)) throw new Error('Parsed mail exceeds its retained-byte reservation');
  });
}

const inboundRoot = () => path.resolve(getStoragePath(), 'business-docs', 'inbound');
function ownedPath(stored) {
  const resolved = resolveStoredPath(stored);
  if (!resolved) return null;
  const relative = path.relative(inboundRoot(), resolved).split(path.sep).join('/');
  return /^(?:mail\/email-[a-f0-9]{64}\.bin|\d{4}\/email-\d+-\d+\.[^/\\]+)$/.test(relative) ? resolved : null;
}

/** Reuse verified hashes before writing; filesystem+ledger commit is fenced. */
async function saveAttachment(att, claim) {
  const sha = hash(att.content);
  const prepared = await withClaim(claim, async (trx, row) => {
    const old = await trx('mail_intake_files').where({ file_sha256: sha }).first();
    if (old) {
      const file = ownedPath(old.file_path);
      if (file) {
        try {
          const safe = assertPathInside(file, [inboundRoot()]);
          if (hash(await fsp.readFile(safe)) === sha) {
            await trx('mail_intake_files').where({ file_path: old.file_path }).update({ created_at: new Date().toISOString() });
            return { file: safe, exists: true };
          }
        } catch (e) { if (!['ENOENT', 'FILE_MISSING'].includes(e.code)) throw e; }
      }
    }
    if (Number(row.retained_bytes) < att.content.length + META_BYTES) throw new Error('Attachment exceeds its retained-byte reservation');
    const file = path.join(inboundRoot(), 'mail', `email-${sha}.bin`);
    const stored = toStoredPath(file);
    const registered = await trx('mail_intake_files').where({ file_path: stored }).first();
    if (!registered) {
      await trx('mail_intake_files').insert({ file_path: stored, file_sha256: sha, account_key: claim.accountKey, byte_size: att.content.length });
      await trx('received_emails').where({ id: row.id }).update({ retained_bytes: Number(row.retained_bytes) - att.content.length });
    } else {
      await trx('mail_intake_files').where({ file_path: stored }).update({ created_at: new Date().toISOString() });
    }
    return { file, exists: false };
  });
  if (prepared.exists) return prepared.file;
  // Commit ownership and its byte charge BEFORE the physical write. A crash
  // cannot roll back the ledger while leaving an uncharged orphan behind.
  return withClaim(claim, async trx => {
    if (!(await trx('mail_intake_files').where({ file_path: toStoredPath(prepared.file) }).first())) throw new Error('Mail file reservation no longer exists');
    const dir = path.dirname(prepared.file);
    await fsp.mkdir(dir, { recursive: true });
    assertPathInside(dir, [inboundRoot()]);
    try { await fsp.writeFile(prepared.file, att.content, { flag: 'wx', mode: 0o600 }); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (hash(await fsp.readFile(assertPathInside(prepared.file, [inboundRoot()]))) !== sha) throw new Error('Existing mail hash file does not match its content');
    }
    return prepared.file;
  });
}

async function recordDocument(claim, work) {
  return withClaim(claim, async (trx, row) => {
    if (Number(row.retained_bytes) < META_BYTES + AUDIT_BYTES) throw new Error('Document exceeds its retained-byte reservation');
    const result = await work(trx);
    const key = `audit:${claim.accountKey}`;
    await trx('mail_intake_state').insert({ key }).onConflict('key').ignore();
    await trx('mail_intake_state').where({ key }).increment('retained_audit_bytes', AUDIT_BYTES);
    await trx('received_emails').where({ id: row.id }).update({ retained_bytes: Number(row.retained_bytes) - AUDIT_BYTES });
    return result;
  });
}

async function finish(claim, values) {
  return withClaim(claim, async (trx, row) => {
    const bytes = META_BYTES + Buffer.byteLength(values.body_html || '') + Buffer.byteLength(values.body_text || '');
    if (bytes > Number(row.retained_bytes)) throw new Error('Mail body exceeds its retained-byte reservation');
    const receivedAt = values.received_at?.toISOString ? values.received_at.toISOString() : values.received_at;
    await trx('received_emails').where({ id: row.id }).update({ ...values, ...(receivedAt ? { received_at: receivedAt } : {}), retained_bytes: bytes, claim_token: null, claim_expires_at: null });
  });
}

async function fail(claim, error) {
  return locked(async trx => {
    await trx('received_emails').where({ id: claim.id, claim_token: claim.token }).update({ status: 'error', error: String(error.message || error).slice(0, 2000), retained_bytes: META_BYTES, body_html: null, body_text: null, claim_token: null, claim_expires_at: null });
  });
}

function canonical(value) { const resolved = resolveStoredPath(value); return resolved && toStoredPath(resolved); }
async function referenced(trx, stored) {
  const target = canonical(stored);
  for (const { table, column } of STORED_PATH_COLUMNS) {
    if (table === 'mail_intake_files' || !(await trx.schema.hasTable(table)) || !(await trx.schema.hasColumn(table, column))) continue;
    // Narrow by the owned basename, then compare every matching legacy/
    // relocated representation in bounded pages, not whole document tables.
    const basename = path.basename(target);
    const query = trx(table).where(q => q.where(column, stored).orWhere(column, resolveStoredPath(stored))
      .orWhere(column, 'like', `%/${basename}`).orWhere(column, 'like', `%\\${basename}`));
    for (let offset = 0; ; offset += 200) {
      const rows = await query.clone().orderBy(column).offset(offset).limit(200).select(column);
      if (rows.some(row => canonical(row[column]) === target)) return true;
      if (rows.length < 200) break;
    }
  }
  return false;
}

/** Called by the existing scheduler even while intake is disabled. */
async function sweep({ now = new Date() } = {}) {
  if (!(await db.schema.hasTable('mail_intake_state'))) return;
  const files = await locked(async trx => {
    const p = policy();
    const state = await trx('mail_intake_state').where({ key: 'installation' }).first();
    const cutoff = new Date(now.getTime() - p.retentionDays * 86400000);
    const metaCutoff = new Date(now.getTime() - p.metadataDays * 86400000);
    await trx('received_emails').where({ status: 'processing' }).where(q => q.modify(whereTimestamp, 'claim_expires_at', '<=', now).orWhere(q2 => q2.whereNull('claim_expires_at').modify(whereTimestamp, 'created_at', '<=', new Date(now.getTime() - CLAIM_MS)))).update({ status: 'error', error: 'Incoming mail claim expired', retained_bytes: META_BYTES, body_html: null, body_text: null, claim_token: null, claim_expires_at: null });
    const expired = await trx('received_emails').whereNot('status', 'processing').where(q => q.modify(whereTimestamp, 'created_at', '<=', cutoff).orWhere(q2 => q2.where({ status: 'error' }).whereNull('body_html').whereNull('body_text').modify(whereTimestamp, 'created_at', '<=', metaCutoff))).limit(100).select('id');
    if (expired.length) await trx('received_emails').whereIn('id', expired.map(r => r.id)).del();
    const docs = await trx('inbound_documents').where({ source: 'email' }).whereNotNull('mail_account_key').whereNull('created_by_admin_id').whereNull('disposition').whereNull('billed_invoice_id').whereNull('customer_account_id').whereNull('event_id').whereIn('status', ['unsorted', 'duplicate', 'declined']).whereNot('parse_status', 'manual').where('id', '>', state.sweep_document_id || 0).modify(whereTimestamp, 'created_at', '<=', cutoff).orderBy('id').limit(100).select('id');
    for (const { id } of docs) {
      if (trx.client.config.client === 'pg') await trx('inbound_documents').where({ id }).forUpdate().first();
      const doc = await trx('inbound_documents').where({ id }).first();
      if (!doc || doc.disposition || doc.created_by_admin_id || doc.billed_invoice_id || doc.customer_account_id || doc.event_id || doc.supplier_paid || doc.parse_status === 'manual' || !['unsorted', 'duplicate', 'declined'].includes(doc.status)) continue;
      const curated = await trx('accounting_change_history').where({ document_type: 'inbound_document', document_id: id, actor_type: 'admin' }).first();
      const used = await trx('expenses').where({ inbound_document_id: id }).first()
        || await trx('inbound_documents').where({ duplicate_of_id: id }).first();
      if (!curated && !used) {
        await trx('received_emails').where({ inbound_document_id: id }).update({ inbound_document_id: null });
        await auditedDelete(trx, 'inbound_documents', { id }, { actor: 'email-retention', source: 'inbound.retention' });
      }
    }
    await trx('mail_intake_state').where({ key: 'installation' }).update({ sweep_document_id: docs.length ? docs[docs.length - 1].id : 0 });
    const batch = await trx('mail_intake_files').where('file_path', '>', state.sweep_cursor || '').orderBy('file_path').limit(100);
    await trx('mail_intake_state').where({ key: 'installation' }).update({ sweep_cursor: batch.length ? batch[batch.length - 1].file_path : null });
    await trx('mail_intake_state').where('key', 'like', 'rate:%').modify(whereTimestamp, 'window_start', '<=', new Date(now.getTime() - 2 * HOUR)).del();
    return batch;
  });
  // Commit row expiry first. No later filesystem error may restore a deleted
  // accounting record whose now-unreferenced physical file was removed.
  for (const candidate of files) {
    await locked(async trx => {
      const file = await trx('mail_intake_files').where({ file_path: candidate.file_path }).first();
      if (!file) return;
      const absolute = ownedPath(file.file_path);
      try {
        const resolved = resolveStoredPath(file.file_path);
        const safe = assertPathInside(resolved, [path.join(getStoragePath(), 'business-docs')]);
        const stat = await fsp.stat(safe);
        // Legacy rows start with a conservative per-file charge. Count their
        // real bytes without dropping retained curated/reference-held files.
        await trx('mail_intake_files').where({ file_path: file.file_path }).update({ byte_size: stat.size });
        if (!absolute || new Date(file.created_at).getTime() > now.getTime() - CLAIM_MS || await referenced(trx, file.file_path)) return;
        await fsp.unlink(absolute);
        await trx('mail_intake_files').where({ file_path: file.file_path }).del();
      } catch (e) {
        if (!['ENOENT', 'FILE_MISSING'].includes(e.code)) throw e;
        if (new Date(file.created_at).getTime() <= now.getTime() - CLAIM_MS && !(await referenced(trx, file.file_path))) await trx('mail_intake_files').where({ file_path: file.file_path }).del();
      }
    });
  }
}

module.exports = { admit, rekey, checkSize, saveAttachment, recordDocument, finish, fail, sweep, policy, META_BYTES, AUDIT_BYTES, CLAIM_MS, _internal: { locked, usage, claimRow, ownedPath } };
