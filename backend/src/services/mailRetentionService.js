const crypto = require('crypto');
const path = require('path');
const fsp = require('fs').promises;
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { getStoragePath } = require('../config/storage');
const { toStoredPath, resolveStoredPath, STORED_PATH_COLUMNS } = require('../utils/storedPath');
const { assertPathInside } = require('../utils/safePath');
const { whereTimestamp } = require('../utils/dbCompat');
const { auditedDelete } = require('./accountingHistory');

const { META_BYTES, AUDIT_BYTES, timestampMs } = require('../utils/mailIntakeLedger');
const CLAIM_MS = 10 * 60 * 1000;
const HOUR = 3600000;
const DAY = 24 * HOUR;
// How far back the poller searches the mailbox (emailIntakeService). A row
// this module removes while its message is still inside that window would be
// fetched and imported again, so expiry never reaches into it.
const LOOKBACK_DAYS = 90;
const TOMBSTONE_DAYS = LOOKBACK_DAYS + 7;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const number = (key, fallback, max = 2 ** 42) => {
  const n = Number(process.env[key]);
  return Number.isSafeInteger(n) && n > 0 && n <= max ? n : fallback;
};
const LIMITS = {
  EMAIL_INTAKE_INSTALLATION_BYTES: 'installationBytes', EMAIL_INTAKE_MAILBOX_BYTES: 'mailboxBytes',
  EMAIL_INTAKE_INSTALLATION_ROWS: 'installationRows', EMAIL_INTAKE_MAILBOX_ROWS: 'mailboxRows',
  EMAIL_INTAKE_INSTALLATION_PER_HOUR: 'installationRate', EMAIL_INTAKE_MAILBOX_PER_HOUR: 'mailboxRate',
  EMAIL_INTAKE_SENDER_PER_HOUR: 'senderRate',
};
const warned = new Map();
function warnHourly(key, message) {
  if (Date.now() - (warned.get(key) || 0) < HOUR) return;
  warned.set(key, Date.now());
  logger.warn(message);
}
function policy() {
  // Age-based deletion is opt-in: unset or 0 keeps every message and document.
  let retentionDays = number('EMAIL_INTAKE_RETENTION_DAYS', 0, 36500);
  if (retentionDays && retentionDays <= LOOKBACK_DAYS) {
    if (!warned.has('retention-clamp')) warnHourly('retention-clamp', `EMAIL_INTAKE_RETENTION_DAYS=${retentionDays} is inside the ${LOOKBACK_DAYS}-day mailbox lookback; using ${LOOKBACK_DAYS + 1} days so expired mail is not imported again`);
    retentionDays = LOOKBACK_DAYS + 1;
  }
  return {
    installationBytes: number('EMAIL_INTAKE_INSTALLATION_BYTES', 2 * 1024 ** 3),
    mailboxBytes: number('EMAIL_INTAKE_MAILBOX_BYTES', 512 * 1024 ** 2),
    installationRows: number('EMAIL_INTAKE_INSTALLATION_ROWS', 50000, 2147483647),
    mailboxRows: number('EMAIL_INTAKE_MAILBOX_ROWS', 10000, 2147483647),
    installationRate: number('EMAIL_INTAKE_INSTALLATION_PER_HOUR', 1000, 2147483647),
    mailboxRate: number('EMAIL_INTAKE_MAILBOX_PER_HOUR', 500, 2147483647),
    senderRate: number('EMAIL_INTAKE_SENDER_PER_HOUR', 50, 2147483647),
    retentionDays,
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

// Automated captures nobody has booked, edited or linked yet.
function untriaged(query) {
  return query.where({ source: 'email' }).whereNotNull('mail_account_key').whereNull('created_by_admin_id').whereNull('disposition').whereNull('billed_invoice_id').whereNull('customer_account_id').whereNull('event_id').whereIn('status', ['unsorted', 'duplicate', 'declined']).whereNot('parse_status', 'manual');
}

// What admission is measured against: reservations in flight plus captured
// documents (file and audit allowance) nobody has handled yet. Stored mail,
// booked documents and everything captured before the ledger existed (no
// received_email_id) are kept on purpose and never stop new mail.
async function backlog(trx, accountKey) {
  const pending = () => untriaged(trx('inbound_documents')).whereNotNull('received_email_id');
  const mail = trx('received_emails').where({ status: 'processing' });
  const docs = pending();
  const files = trx('mail_intake_files').whereIn('file_path', pending().select('file_path'));
  if (accountKey) {
    mail.where({ account_key: accountKey });
    docs.where({ mail_account_key: accountKey });
    files.where({ account_key: accountKey });
  }
  const m = await mail.sum({ bytes: 'retained_bytes' }).count({ rows: '*' }).first();
  const d = await docs.count({ rows: '*' }).first();
  const f = await files.sum({ bytes: 'byte_size' }).first();
  return { bytes: Number(m.bytes || 0) + Number(d.rows || 0) * AUDIT_BYTES + Number(f.bytes || 0), rows: Number(m.rows || 0) + Number(d.rows || 0) };
}

/** The env var of the first backlog limit `bytes` more would break, or null. */
async function exceeded(trx, accountKey, bytes) {
  const p = policy();
  const all = await backlog(trx);
  const mailbox = await backlog(trx, accountKey);
  if (all.bytes + bytes > p.installationBytes) return 'EMAIL_INTAKE_INSTALLATION_BYTES';
  if (mailbox.bytes + bytes > p.mailboxBytes) return 'EMAIL_INTAKE_MAILBOX_BYTES';
  if (all.rows >= p.installationRows) return 'EMAIL_INTAKE_INSTALLATION_ROWS';
  if (mailbox.rows >= p.mailboxRows) return 'EMAIL_INTAKE_MAILBOX_ROWS';
  return null;
}

async function rateWindow(trx, key, limit, now) {
  const old = await trx('mail_intake_state').where({ key }).first();
  const current = old && old.window_start && new Date(old.window_start).getTime() > now.getTime() - HOUR;
  const count = current ? Number(old.window_count) : 0;
  return { key, old, full: count >= limit, row: { window_start: current ? old.window_start : now.toISOString(), window_count: count + 1 } };
}

async function blocked(trx) {
  const row = await trx('mail_intake_state').where({ key: 'installation' }).first();
  await trx('mail_intake_state').where({ key: 'installation' }).update({ blocked_count: Math.min(2147483647, Number(row.blocked_count) + 1) });
}

/**
 * Atomically claim and reserve before the first source download. A capacity
 * or rate refusal returns `retry`: nothing is stored for the message, so the
 * caller leaves it unread and a later poll admits it once there is room.
 */
async function admit({ messageId, accountKey, sender, bytes, error = null, now = new Date() }) {
  const result = await locked(async trx => {
    if (await trx('received_emails').where({ message_id: messageId }).first()) return { skip: true };
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid incoming mail reservation');
    const p = policy();
    const reserve = Math.max(META_BYTES, bytes);
    if (error) {
      await blocked(trx);
      if (!(await exceeded(trx, accountKey, META_BYTES))) {
        await trx('received_emails').insert({ message_id: messageId, account_key: accountKey, status: 'error', error: error.slice(0, 2000), retained_bytes: META_BYTES, created_at: now.toISOString(), received_at: now.toISOString() });
      }
      return { skip: true, reason: error };
    }
    // Capacity first, and a window is only charged for mail that is admitted:
    // a refused message is asked about again every poll and must not use up
    // the hour's budget while it waits.
    let limit = await exceeded(trx, accountKey, reserve);
    const windows = [];
    for (const [key, name] of [
      ['installation', 'EMAIL_INTAKE_INSTALLATION_PER_HOUR'],
      [`rate:mail:${hash(accountKey)}`, 'EMAIL_INTAKE_MAILBOX_PER_HOUR'],
      [`rate:sender:${hash(`${accountKey}\0${String(sender || '<unknown>').trim().toLowerCase()}`)}`, 'EMAIL_INTAKE_SENDER_PER_HOUR'],
    ]) {
      if (limit) break;
      const window = await rateWindow(trx, key, p[LIMITS[name]], now);
      if (window.full) limit = name;
      windows.push(window);
    }
    if (limit) {
      await blocked(trx);
      return { skip: true, retry: true, limit, reason: limit.endsWith('_PER_HOUR') ? 'Incoming mail rate budget reached' : 'Incoming mail backlog capacity reached' };
    }
    for (const { key, old, row } of windows) {
      if (old) await trx('mail_intake_state').where({ key }).update(row);
      else await trx('mail_intake_state').insert({ key, ...row });
    }
    const token = crypto.randomUUID();
    const inserted = await trx('received_emails').insert({ message_id: messageId, account_key: accountKey, status: 'processing', retained_bytes: reserve, claim_token: token, claim_expires_at: new Date(now.getTime() + CLAIM_MS).toISOString(), created_at: now.toISOString(), received_at: now.toISOString() }).returning('id');
    return { id: inserted[0]?.id || inserted[0], token, accountKey };
  });
  if (result.limit) {
    warnHourly(`${accountKey}\0${result.limit}`, `Incoming mail for mailbox "${accountKey}" is waiting: ${result.limit} (${policy()[LIMITS[result.limit]]}) is reached. Refused messages stay unread on the mail server and are retried on a later poll; see docs/incoming-mail-retention.md`);
  }
  return result;
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

/**
 * Reuse verified hashes before writing. File reads and writes run outside the
 * admission lock; only the ledger accounting is done under it.
 */
async function saveAttachment(att, claim) {
  const sha = hash(att.content);
  let reuse = null;
  const old = await db('mail_intake_files').where({ file_sha256: sha }).first();
  const owned = old && ownedPath(old.file_path);
  if (owned) {
    try {
      const safe = assertPathInside(owned, [inboundRoot()]);
      if (hash(await fsp.readFile(safe)) === sha) reuse = { stored: old.file_path, file: safe };
    } catch (e) { if (!['ENOENT', 'FILE_MISSING'].includes(e.code)) throw e; }
  }
  const prepared = await withClaim(claim, async (trx, row) => {
    // The sweeper removes a file and its ledger row together under this lock,
    // so a row that is still here, refreshed now, keeps the verified copy.
    if (reuse && await trx('mail_intake_files').where({ file_path: reuse.stored }).update({ created_at: new Date().toISOString() })) return { file: reuse.file, exists: true };
    if (Number(row.retained_bytes) < att.content.length + META_BYTES) throw new Error('Attachment exceeds its retained-byte reservation');
    const file = path.join(inboundRoot(), 'mail', `email-${sha}.bin`);
    const stored = toStoredPath(file);
    const registered = await trx('mail_intake_files').where({ file_path: stored }).first();
    if (!registered) {
      await trx('mail_intake_files').insert({ file_path: stored, file_sha256: sha, account_key: claim.accountKey, byte_size: att.content.length, created_at: new Date().toISOString() });
      await trx('received_emails').where({ id: row.id }).update({ retained_bytes: Number(row.retained_bytes) - att.content.length });
    } else {
      await trx('mail_intake_files').where({ file_path: stored }).update({ created_at: new Date().toISOString() });
    }
    return { file, exists: false };
  });
  if (prepared.exists) return prepared.file;
  // Ownership and its byte charge are committed BEFORE the physical write, so
  // a crash cannot leave an uncharged orphan behind. The sweeper leaves a
  // tracked file alone for CLAIM_MS after created_at; the claim and the
  // reservation are checked again once the bytes are on disk.
  const dir = path.dirname(prepared.file);
  await fsp.mkdir(dir, { recursive: true });
  assertPathInside(dir, [inboundRoot()]);
  try { await fsp.writeFile(prepared.file, att.content, { flag: 'wx', mode: 0o600 }); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    if (hash(await fsp.readFile(assertPathInside(prepared.file, [inboundRoot()]))) !== sha) throw new Error('Existing mail hash file does not match its content');
  }
  return withClaim(claim, async trx => {
    if (!(await trx('mail_intake_files').where({ file_path: toStoredPath(prepared.file) }).first())) throw new Error('Mail file reservation no longer exists');
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
// Which stored-path columns exist is fixed for the life of the process. Read
// on the pool, never inside a transaction.
let pathColumns = null;
async function storedPathColumns() {
  if (!pathColumns) {
    const found = [];
    for (const entry of STORED_PATH_COLUMNS) {
      if (entry.table !== 'mail_intake_files' && await db.schema.hasTable(entry.table) && await db.schema.hasColumn(entry.table, entry.column)) found.push(entry);
    }
    pathColumns = found;
  }
  return pathColumns;
}
async function referenced(stored) {
  const columns = await storedPathColumns();
  // The usual holders by exact path first: a kept document answers here,
  // without the wildcard scan over every stored-path column below.
  for (const { table, column } of columns) {
    if (['inbound_documents', 'expenses'].includes(table) && await db(table).where(column, stored).first(column)) return true;
  }
  const target = canonical(stored);
  for (const { table, column } of columns) {
    // Narrow by the owned basename, then compare every matching legacy/
    // relocated representation in bounded pages, not whole document tables.
    const basename = path.basename(target);
    const query = db(table).where(q => q.where(column, stored).orWhere(column, resolveStoredPath(stored))
      .orWhere(column, 'like', `%/${basename}`).orWhere(column, 'like', `%\\${basename}`));
    for (let offset = 0; ; offset += 200) {
      const rows = await query.clone().orderBy(column).offset(offset).limit(200).select(column);
      if (rows.some(row => canonical(row[column]) === target)) return true;
      if (rows.length < 200) break;
    }
  }
  return false;
}

// A message the user filed, or one whose captured document still exists, is
// never removed by age.
const notArchived = q => q.whereNull('mailbox_state').orWhereNot('mailbox_state', 'archived');
function hasDocument() {
  this.select(db.raw('1')).from('inbound_documents').whereRaw('inbound_documents.received_email_id = received_emails.id')
    .orWhereRaw('inbound_documents.id = received_emails.inbound_document_id');
}
// What stays of an expired message: its id, mailbox and capture time, so the
// poller's Message-ID dedup still knows it. Hidden from every mail folder.
const TOMBSTONE = { status: 'expired', mailbox_state: 'expired', from_address: null, to_address: null, subject: null, body_html: null, body_text: null, error: null, attachment_count: 0, inbound_document_id: null, retained_bytes: META_BYTES };

/** Called by the existing scheduler even while intake is disabled. */
async function sweep({ now = new Date() } = {}) {
  if (!(await db.schema.hasTable('mail_intake_state'))) return;
  const p = policy();
  const counts = { messages: 0, documents: 0, refusals: 0, files: 0 };
  const files = await locked(async trx => {
    const state = await trx('mail_intake_state').where({ key: 'installation' }).first();
    await trx('received_emails').where({ status: 'processing' }).where(q => q.modify(whereTimestamp, 'claim_expires_at', '<=', now).orWhere(q2 => q2.whereNull('claim_expires_at').modify(whereTimestamp, 'created_at', '<=', new Date(now.getTime() - CLAIM_MS)))).update({ status: 'error', error: 'Incoming mail claim expired', retained_bytes: META_BYTES, body_html: null, body_text: null, claim_token: null, claim_expires_at: null });
    // Refusal and failure records that never held a body, a sender, a subject
    // or a document carry no user content; they go after the short window.
    const bare = await trx('received_emails').where({ status: 'error' }).whereNull('body_html').whereNull('body_text').whereNull('from_address').whereNull('subject').whereNull('inbound_document_id').where(notArchived).whereNotExists(hasDocument)
      .modify(whereTimestamp, 'created_at', '<=', new Date(now.getTime() - p.metadataDays * DAY)).limit(100).select('id');
    if (bare.length) counts.refusals = await trx('received_emails').whereIn('id', bare.map(r => r.id)).del();
    await trx('received_emails').where({ status: 'expired' }).modify(whereTimestamp, 'created_at', '<=', new Date(now.getTime() - TOMBSTONE_DAYS * DAY)).del();
    if (p.retentionDays) {
      const cutoff = new Date(now.getTime() - p.retentionDays * DAY);
      const expired = await trx('received_emails').whereNotIn('status', ['processing', 'expired']).where(notArchived).whereNotExists(hasDocument).modify(whereTimestamp, 'created_at', '<=', cutoff).limit(100).select('id');
      if (expired.length) counts.messages = await trx('received_emails').whereIn('id', expired.map(r => r.id)).update(TOMBSTONE);
      const docs = await untriaged(trx('inbound_documents')).where('id', '>', state.sweep_document_id || 0).modify(whereTimestamp, 'created_at', '<=', cutoff).orderBy('id').limit(100).select('id');
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
          counts.documents += 1;
        }
      }
      await trx('mail_intake_state').where({ key: 'installation' }).update({ sweep_document_id: docs.length ? docs[docs.length - 1].id : 0 });
    }
    const batch = await trx('mail_intake_files').where('file_path', '>', state.sweep_cursor || '').orderBy('file_path').limit(100);
    await trx('mail_intake_state').where({ key: 'installation' }).update({ sweep_cursor: batch.length ? batch[batch.length - 1].file_path : null });
    await trx('mail_intake_state').where('key', 'like', 'rate:%').modify(whereTimestamp, 'window_start', '<=', new Date(now.getTime() - 2 * HOUR)).del();
    return batch;
  });
  // Row expiry is committed first. Measuring files and scanning for
  // references runs outside the admission lock; one bad file is logged and
  // skipped, the rest of the batch continues.
  for (const file of files) {
    try {
      // A tracked file is left alone while a claim may still be writing it.
      if (timestampMs(file.created_at) > now.getTime() - CLAIM_MS) continue;
      let size = null;
      try { size = (await fsp.stat(assertPathInside(resolveStoredPath(file.file_path), [path.join(getStoragePath(), 'business-docs')]))).size; }
      catch (e) { if (!['ENOENT', 'FILE_MISSING'].includes(e.code)) throw e; }
      const absolute = ownedPath(file.file_path);
      if ((size !== null && !absolute) || await referenced(file.file_path)) {
        // Kept: charge what is really on disk, nothing for a file that is gone.
        if (Number(file.byte_size) !== (size || 0)) {
          if (size === null) logger.warn(`Incoming mail: ${file.file_path} is still referenced but missing on disk; it is now charged 0 bytes`);
          await db('mail_intake_files').where({ file_path: file.file_path }).update({ byte_size: size || 0 });
        }
        continue;
      }
      counts.files += await locked(async trx => {
        // Reuse refreshes created_at under this lock: an unchanged row is
        // still unclaimed. Removing the file and its row together here is
        // what lets saveAttachment trust a row it finds.
        const row = await trx('mail_intake_files').where({ file_path: file.file_path }).first();
        if (!row || timestampMs(row.created_at) !== timestampMs(file.created_at)) return 0;
        if (size !== null) await fsp.rm(absolute, { force: true });
        return trx('mail_intake_files').where({ file_path: file.file_path }).del();
      });
    } catch (e) {
      warnHourly(`file\0${file.file_path}`, `Incoming mail sweep skipped ${file.file_path}: ${e.message}`);
    }
  }
  if (counts.messages || counts.documents || counts.refusals || counts.files) {
    logger.info(`Incoming mail sweep (retention ${p.retentionDays ? `${p.retentionDays} days` : 'off'}): expired ${counts.messages} message(s), removed ${counts.documents} untouched document(s), ${counts.refusals} refusal record(s) and ${counts.files} unreferenced file(s)`);
  }
}

module.exports = { admit, rekey, checkSize, saveAttachment, recordDocument, finish, fail, sweep, policy, META_BYTES, AUDIT_BYTES, CLAIM_MS, LOOKBACK_DAYS, _internal: { locked, usage, backlog, claimRow, ownedPath, warned } };
