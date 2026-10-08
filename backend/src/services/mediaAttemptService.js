const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { db } = require('../database/db');
const { getStoragePath } = require('../config/storage');
const logger = require('../utils/logger');
const processLease = require('./linuxProcessLease');
const kernelLease = require('./linuxKernelLease');
const context = require('./mediaAttemptContext');
const { configuration, refusal } = require('./mediaProcessPolicy');
const claimedLeases = new Map();
const active = new Set();
const MAX_ATTEMPTS = 2;
let warnedUnknownHost = false;
const fields = kind => kind === 'web' ? { status: 'web_status', id: 'web_attempt_id', count: 'web_attempts', started: 'web_started_at', error: 'web_error' } :
  { status: 'processing_status', id: 'processing_attempt_id', count: 'processing_attempts', started: 'processing_started_at', error: 'processing_error' };
async function leaseRoot() {
  const requested = process.env.MEDIA_PROCESS_LEASE_PATH || path.join(getStoragePath(), '.media-process-leases');
  if (process.env.MEDIA_PROCESS_LEASE_PATH && !path.isAbsolute(requested)) throw refusal('Invalid media process lease directory', 'MEDIA_LEASE_UNAVAILABLE');
  await fs.mkdir(requested, { recursive: true, mode: 0o700 });
  return fs.realpath(requested);
}
async function volumeMarker(root) {
  const filename = path.join(root, '.volume-id');
  try { await fs.writeFile(filename, crypto.randomUUID(), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const constants = require('fs').constants;
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 36) throw refusal('Media lease volume identity is unavailable', 'MEDIA_LEASE_UNAVAILABLE');
    const value = await file.readFile('utf8');
    if (!/^[a-f0-9-]{36}$/i.test(value)) throw refusal('Media lease volume identity is unavailable', 'MEDIA_LEASE_UNAVAILABLE');
    return value;
  } finally { await file.close(); }
}
async function claimNext(kind, photoId) {
  const names = fields(kind); let holder;
  // Imported/pre-upgrade/missing-copy rows can enter a queue without an upload
  // reservation. They still pass the same signature/probe/work admission
  // before an execution claim; failure never becomes a parser retry loop.
  let candidateQuery = db('photos').where(names.status, 'pending').orderBy('id', 'asc');
  if (photoId !== undefined) candidateQuery = candidateQuery.where('id', photoId);
  if (kind === 'web') candidateQuery = candidateQuery.where(function () { this.where('processing_status', 'complete').orWhereNull('processing_status'); });
  const candidate = await candidateQuery.first();
  if (!candidate) return null;
  if (Number(candidate[names.count] || 0) < MAX_ATTEMPTS &&
      (candidate.media_type === 'video' || candidate.mime_type?.startsWith('video/'))) {
    const prior = await db('media_process_attempts').where({ photo_id: candidate.id, kind, state: 'active' });
    for (const record of prior) if (!(await proveRecord(record))) return null;
    try { await require('./mediaWorkAdmission').ensureQueued(candidate); }
    catch (error) {
      if (!/^MEDIA_|^IMAGE_/.test(error.code || '')) throw error;
      await db('photos').where({ id: candidate.id, [names.status]: 'pending', path: candidate.path, filename: candidate.filename })
        .update({ [names.status]: 'failed', [names.error]: String(error.message).slice(0, 1000) });
      return null;
    }
  }
  try {
    const result = await db.transaction(async trx => {
      let query = trx('photos').where(names.status, 'pending').orderBy('id', 'asc');
      if (kind === 'web') query = query.where(function () {
        this.where('processing_status', 'complete').orWhereNull('processing_status');
      });
      query = query.where('id', candidate.id);
      const client = db.client.config.client;
      if (client === 'pg' || typeof client === 'string' && client.includes('postgres')) query = query.forUpdate().skipLocked();
      const row = await query.first(); if (!row) return null;
      let priorQuery = trx('media_process_attempts').where({ photo_id: row.id, kind, state: 'active' });
      if (client === 'pg' || typeof client === 'string' && client.includes('postgres')) priorQuery = priorQuery.forUpdate();
      const prior = await priorQuery;
      for (const record of prior) {
        if (!(await proveRecord(record))) return null;
        await trx('media_process_attempts').where({ id: record.id, state: 'active' }).update({ state: 'terminated' });
      }
      if (Number(row[names.count] || 0) >= MAX_ATTEMPTS) {
        await trx('photos').where({ id: row.id, [names.status]: 'pending' }).update({ [names.status]: 'failed', [names.error]: 'Media processing retry limit reached' });
        await trx('image_work_reservations').where({ photo_id: row.id }).delete();
        await trx('media_video_work_reservations').where({ photo_id: row.id }).delete();
        return null;
      }
      const root = await leaseRoot();
      const id = crypto.randomUUID(), owner = { ...await processLease.currentIdentity(), volumeMarker: await volumeMarker(root) };
      if (!owner?.host && !warnedUnknownHost) {
        warnedUnknownHost = true;
        logger.warn('Media crash recovery is fenced without authoritative host identity; configure MEDIA_PROCESS_HOST_ID on this Linux host');
      }
      const leasePath = path.join(root, `${id}.owner.lease`);
      holder = await kernelLease.acquire(leasePath);
      const update = { [names.status]: 'processing', [names.id]: id, [names.count]: Number(row[names.count] || 0) + 1, [names.started]: new Date().toISOString() };
      if (await trx('photos').where({ id: row.id, [names.status]: 'pending' }).update(update) !== 1) return null;
      await trx('media_process_attempts').insert({ id, photo_id: row.id, kind, owner_json: JSON.stringify(owner), lease_path: leasePath,
        lease_device: holder.device, lease_inode: holder.inode, lease_filesystem: holder.filesystem });
      return { ...row, ...update, _leaseRoot: root };
    });
    if (!result) { await holder?.release(); return null; }
    claimedLeases.set(result[names.id], { holder, kind }); return result;
  } catch (error) { await holder?.release().catch(() => {}); throw error; }
}
function guard(attempt, conn = db, processing = false) {
  const names = fields(attempt.kind);
  let query = conn('photos').where({ id: attempt.photo.id, [names.id]: attempt.id,
    path: attempt.photo.path, filename: attempt.photo.filename });
  if (processing) query = query.where(names.status, 'processing');
  return query;
}
async function execute(photo, kind, callback) {
  const names = fields(kind), id = photo[names.id], holder = claimedLeases.get(id)?.holder;
  if (!id || !holder) throw refusal('Media processing requires a current execution attempt', 'MEDIA_ATTEMPT_REQUIRED');
  claimedLeases.delete(id);
  const controller = new AbortController();
  const timeout = kind === 'web' ? configuration().renditionMs + 120000 : 300000;
  const attempt = { id, kind, photo, signal: controller.signal, deadline: Date.now() + timeout,
    children: [], commands: 0, writes: Promise.resolve(), controller };
  attempt.assertCurrent = async () => {
    if (controller.signal.aborted) throw refusal('Media processing was cancelled', 'MEDIA_CANCELLED');
    if (!(await guard(attempt).first())) throw refusal('Media processing attempt was superseded', 'MEDIA_SUPERSEDED');
  };
  attempt.hooks = () => {
    if (++attempt.commands > 32) throw refusal('Media command attempt limit reached');
    const childLease = path.join(photo._leaseRoot, `${id}.${crypto.randomUUID()}.child.lease`);
    return { leasePath: childLease, onStart: async lease => {
      await attempt.assertCurrent();
      attempt.children.push({ ...lease, leasePath: childLease, terminated: false });
      attempt.writes = attempt.writes.then(() => db('media_process_attempts').where({ id, state: 'active' }).update({ children_json: JSON.stringify(attempt.children), heartbeat_at: db.fn.now() }));
      if (await attempt.writes !== 1) throw refusal('Media execution lease was superseded', 'MEDIA_SUPERSEDED');
    }, onFinish: async lease => {
      const child = attempt.children.find(item => item.pid === lease?.pid && item.startTicks === lease?.startTicks);
      if (!child) return;
      child.terminated = true;
      attempt.writes = attempt.writes.then(() => db('media_process_attempts').where({ id, state: 'active' }).update({ children_json: JSON.stringify(attempt.children), heartbeat_at: db.fn.now() }));
      await attempt.writes;
    } };
  };
  attempt.cancel = () => controller.abort(); active.add(attempt);
  let heartbeatRunning = false;
  const heartbeat = setInterval(() => {
    if (heartbeatRunning) return; heartbeatRunning = true;
    attempt.writes = attempt.writes.then(async () => {
      await attempt.assertCurrent();
      await db('media_process_attempts').where({ id, state: 'active' }).update({ heartbeat_at: db.fn.now() });
    }).catch(error => { controller.abort(); logger.warn('Media attempt heartbeat failed', { id, error: error.message }); })
      .finally(() => { heartbeatRunning = false; });
  }, 5000);
  const timer = setTimeout(() => controller.abort(), timeout);
  try { return await context.run(attempt, () => callback(attempt)); }
  finally {
    clearInterval(heartbeat); clearTimeout(timer); await finishAttempt(attempt, holder);
  }
}
async function finishAttempt(attempt, holder) {
  await attempt.writes;
  if (attempt.children.some(child => !child.terminated)) throw refusal('Media execution termination is unproven', 'MEDIA_LEASE_UNAVAILABLE');
  // All native/result work is already terminal; publish that proof, then
  // drain the lifetime-lock holder before this execution promise settles.
  await db('media_process_attempts').where({ id: attempt.id, state: 'active' }).update({ state: 'terminated', heartbeat_at: db.fn.now() });
  await holder.release(); active.delete(attempt);
}
async function recover(kind, cutoff) {
  const names = fields(kind);
  const rows = await db('photos').where(names.status, 'processing').where(names.started, '<', cutoff);
  let recovered = 0;
  for (const photo of rows) {
    const record = photo[names.id] ? await db('media_process_attempts').where({ id: photo[names.id], photo_id: photo.id, kind }).first() : null;
    const safe = record && await proveRecord(record);
    if (!safe) continue;
    const state = Number(photo[names.count] || 0) >= MAX_ATTEMPTS ? 'failed' : 'pending';
    recovered += await db.transaction(async trx => {
      const updated = await trx('photos').where({ id: photo.id, [names.status]: 'processing', [names.id]: photo[names.id] })
        .update({ [names.status]: state, [names.started]: null, [names.error]: state === 'failed' ? 'Media processing retry limit reached' : null });
      if (updated) {
        await trx('media_process_attempts').where({ id: record.id, state: 'active' }).update({ state: 'terminated' });
        if (state === 'failed') {
          await trx('image_work_reservations').where({ photo_id: photo.id }).delete();
          await trx('media_video_work_reservations').where({ photo_id: photo.id }).delete();
        }
      }
      return updated;
    });
  }
  return recovered;
}
async function proveRecord(record) {
  if (record.state === 'terminated') return true;
  let owner, children;
  try { owner = JSON.parse(record.owner_json); children = JSON.parse(record.children_json); } catch (_) { return false; }
  const current = await processLease.currentIdentity();
  if (!owner?.host || !current?.host || current.host !== owner.host || !Array.isArray(children)) return false;
  try { if (await volumeMarker(await leaseRoot()) !== owner.volumeMarker) return false; } catch (_) { return false; }
  const ownerProof = await processLease.proveTermination(owner);
  if (ownerProof === 'alive') return false;
  if (current.bootId !== owner.bootId && ownerProof !== 'dead') return false;
  // The actual Node holds this lifetime FD, not a helper process. A matching
  // free local inode proves owner termination even after its namespace is gone.
  if (await kernelLease.probe(record.lease_path, { device: record.lease_device, inode: record.lease_inode, filesystem: record.lease_filesystem }) !== 'free') return false;
  for (const child of children) {
    if (!child.terminated && await kernelLease.probe(child.leasePath, child) !== 'free') return false;
  }
  return true;
}
function cancel(kind) { for (const attempt of active) if (!kind || kind === attempt.kind) attempt.cancel(); }
function assertDrained(kind) {
  if ([...active].some(attempt => !kind || attempt.kind === kind) ||
      [...claimedLeases.values()].some(lease => !kind || lease.kind === kind)) {
    throw refusal('Media execution termination is unproven; maintenance remains fenced', 'MEDIA_LEASE_UNAVAILABLE');
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
// Trusted restore worker only, after coordinated drain/epoch validation.
// Never adopt imported runtime identities or credits, and never escape the
// caller's transaction (SQLite restore holds its sole connection).
async function resetImportedMediaAttempts(trx) {
  const web = await trx.schema.hasColumn('photos', 'web_status');
  await trx('photos').update({ processing_attempt_id: null, processing_attempts: 0,
    processing_started_at: null, processing_error: null, ...(web ? { web_attempt_id: null,
      web_attempts: 0, web_started_at: null, web_error: null } : {}) });
  await trx('photos').where({ processing_status: 'processing' }).update({ processing_status: 'pending' });
  if (web) await trx('photos').where({ web_status: 'processing' }).update({ web_status: 'pending' });
  for (const table of ['media_process_attempts', 'media_video_work_reservations', 'image_work_reservations']) {
    if (await trx.schema.hasTable(table)) await trx(table).delete();
  }
}
module.exports = { claimNext, execute, recover, cancel, assertDrained, guard, outputName, resetImportedMediaAttempts, current: context.current, MAX_ATTEMPTS };
