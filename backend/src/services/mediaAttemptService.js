/**
 * Execution attempts for queued photos ('photo') and web renditions ('web').
 *
 * Every claim gets an id. The row carries it, every result is written with
 * the id in the same UPDATE, and output files carry it in their name, so a
 * worker that lost its claim can neither publish nor overwrite what a newer
 * attempt wrote. That fencing is all correctness needs.
 *
 * Kernel leases, where the host has them (mediaCapabilities), only make
 * recovery faster and surer: a crashed worker's row is put back as soon as
 * its lock is free. Without them, and for anything a lease cannot settle
 * (another host, a missing lease file, a row from before this existed), a
 * row is recovered by age, as the queues always did.
 */
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const processLease = require('./linuxProcessLease');
const kernelLease = require('./linuxKernelLease');
const context = require('./mediaAttemptContext');
const capabilities = require('./mediaCapabilities');
const { refusal } = require('./mediaProcessPolicy');

const claimed = new Map();
const active = new Map();
// Claims per row before it is recorded as failed: those that ended in a
// "not now" and those recovered from a process that died.
const MAX_ATTEMPTS = 5;
const CANDIDATES = 16;
const HEARTBEAT_MS = 5000;
const HEARTBEAT_STALE_MS = 120000;
const LEASE_SWEEP_AGE_MS = 600000;
const ATTEMPT_SUFFIX = /_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=(?:\.[^./]+)?$)/i;
const fields = kind => kind === 'web'
  ? { status: 'web_status', id: 'web_attempt_id', count: 'web_attempts', started: 'web_started_at', error: 'web_error', retry: 'web_retry_at',
    exhausted: `Video conversion did not complete after ${MAX_ATTEMPTS} attempts` }
  : { status: 'processing_status', id: 'processing_attempt_id', count: 'processing_attempts', started: 'processing_started_at', error: 'processing_error', retry: 'processing_retry_at',
    exhausted: `Image processing did not complete after ${MAX_ATTEMPTS} attempts` };
function isPostgres() {
  const client = db.client.config.client;
  return client === 'pg' || (typeof client === 'string' && client.includes('postgres'));
}
async function volumeMarker(root) {
  const filename = path.join(root, '.volume-id');
  try { await fs.writeFile(filename, crypto.randomUUID(), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const value = (await fs.readFile(filename, 'utf8')).trim();
  if (!/^[a-f0-9-]{36}$/i.test(value)) throw new Error('Media lease volume identity is unreadable');
  return value;
}
async function removeLeaseFiles(record) {
  let children = [];
  try { children = JSON.parse(record.children_json || '[]'); } catch (_) { /* Nothing to remove. */ }
  for (const file of [record.lease_path, ...(Array.isArray(children) ? children.map(child => child?.leasePath) : [])]) {
    if (typeof file === 'string' && file.endsWith('.lease')) await fs.rm(file, { force: true }).catch(() => {});
  }
}
const stale = record => !(Date.now() - new Date(record.heartbeat_at).getTime() <= HEARTBEAT_STALE_MS);
/**
 * Is the attempt behind this record still running?
 *   alive    yes: it runs in this process, its owner process exists, or a
 *            kernel lease of its is held
 *   dead     no: shown by the kernel
 *   unknown  cannot be shown from here; the caller goes by age
 */
async function proof(record, caps) {
  if (active.has(record.id) || claimed.has(record.id)) return 'alive';
  if (record.state === 'terminated') return 'dead';
  let owner, children;
  try { owner = JSON.parse(record.owner_json); children = JSON.parse(record.children_json || '[]'); } catch (_) { return 'unknown'; }
  const current = await processLease.currentIdentity();
  if (!owner?.host || !current?.host || current.host !== owner.host || !Array.isArray(children)) return 'unknown';
  const ownerProof = await processLease.proveTermination(owner);
  if (ownerProof === 'alive') return 'alive';
  if (!caps.leases || !record.lease_path) return 'unknown';
  try { if (await volumeMarker(caps.leaseRoot) !== owner.volumeMarker) return 'unknown'; } catch (_) { return 'unknown'; }
  // The Node process itself holds this descriptor for the attempt's
  // lifetime: the same inode, unlocked, shows the owner is gone.
  const lease = await kernelLease.probe(record.lease_path, { device: record.lease_device, inode: record.lease_inode, filesystem: record.lease_filesystem });
  if (lease === 'busy') return 'alive';
  if (lease !== 'free') return 'unknown';
  for (const child of children) {
    if (child.terminated) continue;
    const state = await kernelLease.probe(child.leasePath, child);
    if (state === 'busy') return 'alive';
    if (state !== 'free') return 'unknown';
  }
  return 'dead';
}
async function claimOne(kind, id, pending, caps) {
  const names = fields(kind);
  let holder = null, superseded = [];
  try {
    const result = await db.transaction(async trx => {
      let query = pending(trx).where('id', id);
      if (isPostgres()) query = query.forUpdate().skipLocked();
      const row = await query.first();
      if (!row) return null;
      const prior = await trx('media_process_attempts').where({ photo_id: row.id, kind });
      // An earlier attempt on this row that is still running keeps the row
      // and the caller moves on to the next one. An attempt whose end cannot
      // be shown does not hold the queue: its writes are fenced by its id.
      for (const record of prior) if (await proof(record, caps) === 'alive') return null;
      if (prior.length) { await trx('media_process_attempts').where({ photo_id: row.id, kind }).delete(); superseded = prior; }
      if (Number(row[names.count] || 0) >= MAX_ATTEMPTS) {
        const failed = await trx('photos').where({ id: row.id, [names.status]: 'pending' }).update({ [names.status]: 'failed', [names.error]: names.exhausted });
        return failed > 0 ? { exhausted: row.id } : null;
      }
      const attemptId = crypto.randomUUID();
      const owner = await processLease.currentIdentity() || { host: (await processLease.hostIdentity()).host, pid: process.pid };
      let lease = { device: '', inode: '', filesystem: '', path: '' };
      if (caps.leases) {
        try {
          owner.volumeMarker = await volumeMarker(caps.leaseRoot);
          holder = lease = await kernelLease.acquire(path.join(caps.leaseRoot, `${attemptId}.owner.lease`));
        } catch (error) {
          // Recovery of this attempt goes by age instead.
          logger.debug('Media attempt runs without a kernel lease', { error: error.message });
        }
      }
      const startedAt = new Date().toISOString();
      const update = { [names.status]: 'processing', [names.id]: attemptId, [names.count]: Number(row[names.count] || 0) + 1, [names.started]: startedAt };
      if (await trx('photos').where({ id: row.id, [names.status]: 'pending' }).update(update) !== 1) return null;
      await trx('media_process_attempts').insert({ id: attemptId, photo_id: row.id, kind, owner_json: JSON.stringify(owner), children_json: '[]',
        lease_path: lease.path, lease_device: lease.device, lease_inode: lease.inode, lease_filesystem: lease.filesystem,
        state: 'active', heartbeat_at: startedAt, created_at: startedAt });
      return { ...row, ...update };
    });
    for (const record of superseded) await removeLeaseFiles(record);
    if (!result || result.exhausted) {
      if (holder) { await holder.release().catch(() => {}); await fs.rm(holder.path, { force: true }).catch(() => {}); }
      return result;
    }
    claimed.set(result[names.id], { holder, kind, root: caps.leases ? caps.leaseRoot : null });
    return result;
  } catch (error) {
    if (holder) { await holder.release().catch(() => {}); await fs.rm(holder.path, { force: true }).catch(() => {}); }
    throw error;
  }
}
/**
 * Claim the oldest pending row that is due, or the given one. Resolves the
 * claimed row (status 'processing', a fresh attempt id), `{ exhausted: id }`
 * for a row that used up its attempts and was recorded as failed, or null.
 */
async function claimNext(kind, photoId) {
  const caps = await capabilities.probe();
  const names = fields(kind), now = new Date().toISOString();
  const pending = conn => {
    let query = conn('photos').where(names.status, 'pending');
    // A row put back after a "not now" is not due before its time; an
    // explicit request for one row is.
    if (photoId === undefined) query = query.where(function () { this.whereNull(names.retry).orWhere(names.retry, '<=', now); });
    if (kind === 'web') query = query.where(function () { this.where('processing_status', 'complete').orWhereNull('processing_status'); });
    return query;
  };
  const ids = photoId !== undefined ? [photoId]
    : (await pending(db).orderBy('id', 'asc').limit(CANDIDATES).select('id')).map(row => row.id);
  for (const id of ids) {
    const outcome = await claimOne(kind, id, pending, caps);
    if (outcome) return outcome;
  }
  return null;
}
function guard(attempt, conn = db, processing = false) {
  const names = fields(attempt.kind);
  let query = conn('photos').where({ id: attempt.photo.id, [names.id]: attempt.id,
    path: attempt.photo.path, filename: attempt.photo.filename });
  if (processing) query = query.where(names.status, 'processing');
  return query;
}
async function execute(photo, kind, callback) {
  const names = fields(kind), id = photo[names.id], claim = claimed.get(id);
  if (!id || !claim) throw refusal('Media processing requires a current execution attempt', 'MEDIA_ATTEMPT_REQUIRED');
  const controller = new AbortController();
  const attempt = { id, kind, photo, signal: controller.signal, children: [], commands: 0, writes: Promise.resolve() };
  // Bookkeeping about the attempt never fails the work it describes.
  const record = values => {
    attempt.writes = attempt.writes.then(() => db('media_process_attempts').where({ id }).update({ ...values, heartbeat_at: new Date().toISOString() }))
      .catch(error => logger.warn('Media attempt record not updated', { id, error: error.message }));
    return attempt.writes;
  };
  attempt.assertCurrent = async () => {
    if (controller.signal.aborted) throw refusal('Media processing was cancelled', 'MEDIA_CANCELLED');
    if (!(await guard(attempt).first())) throw refusal('Media processing attempt was superseded', 'MEDIA_SUPERSEDED');
  };
  attempt.hooks = ({ lease = false } = {}) => {
    if (++attempt.commands > 32) throw refusal('Media command attempt limit reached');
    if (!lease || !claim.root) return { leasePath: undefined, onStart: () => attempt.assertCurrent(), onFinish: async () => {} };
    const childLease = path.join(claim.root, `${id}.${crypto.randomUUID()}.child.lease`);
    return { leasePath: childLease, onStart: async held => {
      await attempt.assertCurrent();
      if (!held?.inode) return; // Ran without the guard after all.
      attempt.children.push({ ...held, leasePath: childLease, terminated: false });
      await record({ children_json: JSON.stringify(attempt.children) });
    }, onFinish: async () => {
      const child = attempt.children.find(item => item.leasePath === childLease);
      if (child && !child.terminated) { child.terminated = true; await record({ children_json: JSON.stringify(attempt.children) }); }
      await fs.rm(childLease, { force: true }).catch(() => {});
    } };
  };
  attempt.cancel = () => controller.abort();
  active.set(id, attempt); claimed.delete(id);
  const heartbeat = setInterval(() => {
    // Work for a row that has moved on is stopped; a failed write is not a
    // reason to stop anything.
    guard(attempt).first('id').then(row => { if (!row) controller.abort(); }, () => {});
    record({});
  }, HEARTBEAT_MS);
  try { return await context.run(attempt, () => callback(attempt)); }
  finally {
    clearInterval(heartbeat);
    await attempt.writes;
    // The attempt is over either way: its record and lease files go now.
    await db('media_process_attempts').where({ id }).delete()
      .catch(error => logger.warn('Media attempt record not removed; the janitor removes it', { id, error: error.message }));
    for (const child of attempt.children) await fs.rm(child.leasePath, { force: true }).catch(() => {});
    if (claim.holder) { await claim.holder.release().catch(() => {}); await fs.rm(claim.holder.path, { force: true }).catch(() => {}); }
    active.delete(id);
  }
}
/** Records and lease files nothing refers to any more. */
async function reap(kind, caps) {
  const names = fields(kind);
  for (const record of await db('media_process_attempts').where({ kind })) {
    if (active.has(record.id) || claimed.has(record.id)) continue;
    if (await db('photos').where({ id: record.photo_id, [names.id]: record.id, [names.status]: 'processing' }).first('id')) continue;
    if (await proof(record, caps) === 'alive') continue;
    await db('media_process_attempts').where({ id: record.id }).delete();
    await removeLeaseFiles(record);
  }
  if (!caps.leases) return;
  const names_ = await fs.readdir(caps.leaseRoot).catch(() => []);
  for (const name of names_.filter(entry => entry.endsWith('.lease')).slice(0, 500)) {
    const file = path.join(caps.leaseRoot, name), id = name.slice(0, 36);
    if (active.has(id) || claimed.has(id)) continue;
    const stat = await fs.stat(file).catch(() => null);
    if (!stat || Date.now() - stat.mtimeMs < LEASE_SWEEP_AGE_MS) continue;
    if (await db('media_process_attempts').where({ id }).first('id')) continue;
    if (await kernelLease.probe(file) === 'free') await fs.rm(file, { force: true }).catch(() => {});
  }
}
/**
 * Put rows whose worker is gone back to pending; returns how many. `cutoff`
 * (ISO) is the age beyond which a row with no attempt record is taken as
 * abandoned: every row from before this layer, exactly as the janitors did.
 * A row with a record is recovered when the kernel shows its attempt is
 * dead, or when nothing can be shown and its heartbeat has stopped.
 */
async function recover(kind, cutoff) {
  const caps = await capabilities.probe();
  const names = fields(kind);
  const rows = await db('photos').where(names.status, 'processing').select('id', names.id);
  let recovered = 0;
  if (rows.length) {
    const aged = new Set(await db('photos').where(names.status, 'processing').where(names.started, '<', cutoff).pluck('id'));
    for (const photo of rows) {
      const record = photo[names.id] ? await db('media_process_attempts').where({ id: photo[names.id] }).first() : null;
      let due = aged.has(photo.id);
      if (record) {
        const state = await proof(record, caps);
        due = state === 'dead' || (state === 'unknown' && stale(record));
      }
      if (!due) continue;
      recovered += await db.transaction(async trx => {
        const updated = await trx('photos').where({ id: photo.id, [names.status]: 'processing', [names.id]: photo[names.id] ?? null })
          .update({ [names.status]: 'pending', [names.started]: null });
        if (updated && record) await trx('media_process_attempts').where({ id: record.id }).delete();
        return updated;
      });
      if (record) await removeLeaseFiles(record);
    }
  }
  await reap(kind, caps).catch(error => logger.warn('Media attempt housekeeping failed', { kind, error: error.message }));
  return recovered;
}
function cancel(kind) { for (const attempt of active.values()) if (!kind || kind === attempt.kind) attempt.cancel(); }
function assertDrained(kind) {
  if ([...active.values()].some(attempt => !kind || attempt.kind === kind) ||
      [...claimed.values()].some(lease => !kind || lease.kind === kind)) {
    throw refusal('Media work is still running', 'MEDIA_LEASE_BUSY');
  }
}
function outputName(name, attempt = context.current()) {
  if (!attempt) return name;
  const basename = path.basename(name), extension = path.extname(basename);
  let stem = '';
  for (const character of basename.slice(0, -extension.length || undefined)) {
    if (Buffer.byteLength(stem + character) > 160) break; stem += character;
  }
  return `${stem}_${attempt.id}${extension}`;
}
/**
 * After a newer attempt has committed `current`: the attempt-named file an
 * earlier attempt left under `previous` is no longer referenced. Names
 * without an attempt id are never touched.
 */
async function dropSuperseded(storage, previous, current) {
  if (!previous || previous === current || !ATTEMPT_SUFFIX.test(previous)) return;
  await storage.delete(previous).catch(error => logger.warn('Superseded media output not removed', { key: previous, error: error.message }));
}
// Trusted restore worker only, after coordinated drain/epoch validation.
// Never adopt imported runtime identities, and never escape the caller's
// transaction (SQLite restore holds its sole connection).
async function resetImportedMediaAttempts(trx) {
  const web = await trx.schema.hasColumn('photos', 'web_status');
  await trx('photos').update({ processing_attempt_id: null, processing_attempts: 0, processing_retry_at: null,
    processing_started_at: null, processing_error: null, ...(web ? { web_attempt_id: null,
      web_attempts: 0, web_retry_at: null, web_started_at: null, web_error: null } : {}) });
  await trx('photos').where({ processing_status: 'processing' }).update({ processing_status: 'pending' });
  if (web) await trx('photos').where({ web_status: 'processing' }).update({ web_status: 'pending' });
  if (await trx.schema.hasTable('media_process_attempts')) await trx('media_process_attempts').delete();
}
module.exports = { claimNext, execute, recover, cancel, assertDrained, guard, outputName, dropSuperseded, resetImportedMediaAttempts,
  current: context.current, MAX_ATTEMPTS, HEARTBEAT_STALE_MS };
