/** Persistent admission for public capabilities. Charges are lifetime ingress,
 * not catalogue occupancy: deleting a row must not regenerate a public link's
 * allowance or erase an orphan. No TTL can release a still-live writer. */
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { db } = require('../database/db');
const { getStoragePath } = require('../config/storage');
const { getStorage } = require('./storage');
const logger = require('../utils/logger');

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const DEFAULTS = Object.freeze({
  requestBytes: 95 * MiB, headroomBytes: 512 * MiB, headroomPercent: 5,
  requestTimeoutMs: 300000,
  gallery: { bytes: 5 * GiB, files: 2000, pendingBytes: 512 * MiB, pendingFiles: 100, requests: 2, hourBytes: GiB },
  guest: { bytes: GiB, files: 500, pendingBytes: 256 * MiB, pendingFiles: 50, requests: 2, hourBytes: 256 * MiB },
  transfer: { bytes: 2 * GiB, files: 500, pendingBytes: 256 * MiB, pendingFiles: 50, requests: 2, hourBytes: 512 * MiB },
  account: { bytes: 50 * GiB, files: 20000, pendingBytes: GiB, pendingFiles: 500, requests: 4, hourBytes: 2 * GiB },
  deployment: { bytes: 200 * GiB, files: 100000, pendingBytes: 2 * GiB, pendingFiles: 1000, requests: 8, hourBytes: 4 * GiB },
});
const scopeNames = ['gallery', 'guest', 'transfer', 'account', 'deployment'];
const capNames = ['bytes', 'files', 'pendingBytes', 'pendingFiles', 'requests', 'hourBytes'];

function configuration() {
  const result = JSON.parse(JSON.stringify(DEFAULTS));
  const raw = process.env.PUBLIC_UPLOAD_LIMITS_JSON;
  if (!raw) return result;
  if (raw.length > 8192) throw new Error('Invalid PUBLIC_UPLOAD_LIMITS_JSON');
  const overrides = JSON.parse(raw);
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('Invalid PUBLIC_UPLOAD_LIMITS_JSON');
  const scalar = ['requestBytes', 'headroomBytes', 'headroomPercent', 'requestTimeoutMs'];
  for (const [key, value] of Object.entries(overrides)) {
    if (scalar.includes(key)) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > (key === 'headroomPercent' ? 50 : 1024 * GiB)) {
        throw new Error(`Invalid public upload limit: ${key}`);
      }
      result[key] = value;
    } else if (scopeNames.includes(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [cap, limit] of Object.entries(value)) {
        if (!capNames.includes(cap) || !Number.isSafeInteger(limit) || limit <= 0 || limit > 1024 * GiB) {
          throw new Error(`Invalid public upload limit: ${key}.${cap}`);
        }
        result[key][cap] = limit;
      }
    } else {
      throw new Error(`Invalid public upload limit: ${key}`);
    }
  }
  return result;
}

function refusal(code, status = 429) {
  return Object.assign(new Error('Public upload capacity is unavailable. Please contact the gallery owner.'), { code, status });
}

// A write FIRST on SQLite avoids a deferred read -> write upgrade race.
// PostgreSQL's UPDATE takes the same singleton row lock across all replicas.
function locked(fn) {
  return db.transaction(async trx => {
    if (await trx('public_upload_lock').where({ id: 1 }).update({ revision: 0 }) !== 1) {
      throw refusal('UPLOAD_QUOTA_UNAVAILABLE', 503);
    }
    return fn(trx);
  });
}

function filter(query, scope, values) {
  if (scope === 'gallery') return query.where('event_id', values.event_id);
  if (scope === 'guest') return query.where('guest_scope', values.guest_scope);
  if (scope === 'transfer') return query.where('transfer_id', values.transfer_id);
  if (scope === 'account') return values.account_id == null ? query.whereNull('account_id') : query.where('account_id', values.account_id);
  return query;
}

async function sum(query) {
  const row = await query.sum('bytes as bytes').sum('files as files').first();
  return { bytes: Number(row?.bytes || 0), files: Number(row?.files || 0) };
}

// Existing media remain charged too. Ledger-associated rows are excluded here
// (their independent lifetime charge already survives archival/deletion).
async function catalogue(trx, scope, values) {
  let photos = trx('photos as p').join('events as e', 'e.id', 'p.event_id')
    .whereNotExists(trx('public_upload_objects as o').select('o.id')
      .where('o.reference_type', 'photo').whereColumn('o.reference_id', 'p.id'))
    .where(q => q.whereNull('e.source_mode').orWhereNot('e.source_mode', 'reference'));
  let uploads = trx('transfer_uploads as u').join('transfers as t', 't.id', 'u.transfer_id')
    .whereNotExists(trx('public_upload_objects as o').select('o.id')
      .where('o.reference_type', 'transfer').whereColumn('o.reference_id', 'u.id'));
  let archives = trx('events as e').whereNotNull('e.archive_path');
  if (scope === 'guest') return { bytes: 0, files: 0 }; // legacy stable has no guest identity
  if (scope === 'gallery') {
    photos = photos.where('e.id', values.event_id);
    archives = archives.where('e.id', values.event_id);
  } else if (scope === 'transfer') {
    uploads = uploads.where('t.id', values.transfer_id);
  } else if (scope === 'account') {
    for (const [query, column] of [[photos, 'e.created_by'], [uploads, 't.created_by'], [archives, 'e.created_by']]) {
      if (values.account_id == null) query.whereNull(column); else query.where(column, values.account_id);
    }
  }
  const total = { bytes: 0, files: 0 };
  if (scope !== 'transfer') {
    const p = await photos.sum('p.size_bytes as bytes').count('p.id as files').first();
    const a = await archives.sum('e.archive_size as bytes').count('e.id as files').first();
    total.bytes += Number(p?.bytes || 0) + Number(a?.bytes || 0);
    total.files += Number(p?.files || 0) + Number(a?.files || 0);
  }
  if (scope !== 'gallery') {
    const u = await uploads.sum('u.size_bytes as bytes').count('u.id as files').first();
    total.bytes += Number(u?.bytes || 0); total.files += Number(u?.files || 0);
  }
  if (!Number.isSafeInteger(total.bytes) || !Number.isSafeInteger(total.files) || total.bytes < 0) {
    throw refusal('UPLOAD_QUOTA_UNAVAILABLE', 503);
  }
  return total;
}

const tempRoot = () => path.join(getStoragePath(), 'temp', 'public-uploads');
function stagingPath(id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid upload reservation id');
  return path.join(tempRoot(), id);
}

async function headroom(trx, bytes, limits, directory = tempRoot()) {
  let stat;
  for (;;) {
    try { stat = await fs.statfs(directory); break; } catch (err) {
      if (err.code !== 'ENOENT' || path.dirname(directory) === directory) throw err;
      directory = path.dirname(directory);
    }
  }
  const free = Number(stat.bavail) * Number(stat.bsize);
  const total = Number(stat.blocks) * Number(stat.bsize);
  const other = await sum(trx('public_upload_requests').where({ active: 1 }));
  const promoting = getStorage().kind() === 'local'
    ? await sum(trx('public_upload_objects').whereIn('state', ['promoting', 'uncertain'])) : { bytes: 0 };
  // Local promotion temporarily needs both copies. S3 needs staging space.
  const copies = getStorage().kind() === 'local' ? 2 : 1;
  const floor = Math.max(limits.headroomBytes, Math.ceil(total * limits.headroomPercent / 100));
  if (!Number.isSafeInteger(free) || !Number.isSafeInteger(total) || total <= 0 || free - copies * (bytes + other.bytes + promoting.bytes) < floor) {
    throw refusal('UPLOAD_STORAGE_LOW', 507);
  }
}

async function begin({ eventId = null, guestId = null, transferId = null, maxFiles }) {
  const limits = configuration();
  await fs.mkdir(tempRoot(), { recursive: true, mode: 0o700 });
  const session = await locked(async trx => {
    const ownerTable = eventId ? 'events' : 'transfers';
    const owner = await trx(ownerTable).where({ id: eventId || transferId }).first('created_by');
    if (!owner) throw refusal('UPLOAD_TARGET_GONE', 404);
    const values = { event_id: eventId, transfer_id: transferId, account_id: owner.created_by ?? null,
      guest_scope: eventId ? `${eventId}:${guestId || 'anonymous'}` : null };
    const setting = await trx('app_settings').where({ setting_key: 'general_max_upload_batch_size_mb' }).first('setting_value');
    let batchMb;
    try { batchMb = Number(JSON.parse(setting?.setting_value)); } catch (_) { batchMb = NaN; }
    let bytes = Math.min(limits.requestBytes, Number.isFinite(batchMb) && batchMb > 0 ? Math.floor(batchMb * MiB) : limits.requestBytes);
    let files = maxFiles;
    const scopes = [eventId ? 'gallery' : 'transfer', ...(eventId ? ['guest'] : []), 'account', 'deployment'];
    for (const scope of scopes) {
      const cap = limits[scope];
      const base = await catalogue(trx, scope, values);
      const objects = await sum(filter(trx('public_upload_objects'), scope, values));
      const held = await sum(filter(trx('public_upload_requests').where({ active: 1 }), scope, values));
      const pending = await sum(filter(trx('public_upload_objects').where({ pending: 1 }), scope, values));
      const active = await filter(trx('public_upload_requests').where({ active: 1 }), scope, values).count('id as count').first();
      const rate = await filter(trx('public_upload_requests').where('created_at', '>=', new Date(Date.now() - 3600000).toISOString()), scope, values)
        .sum('rate_bytes as bytes').first();
      if (Number(active?.count || 0) >= cap.requests) throw refusal('UPLOAD_CONCURRENCY_LIMIT');
      const quotaBytes = cap.bytes - base.bytes - objects.bytes - held.bytes;
      const quotaFiles = cap.files - base.files - objects.files - held.files;
      const pendingBytes = cap.pendingBytes - pending.bytes - held.bytes;
      const pendingFiles = cap.pendingFiles - pending.files - held.files;
      const rateBytes = cap.hourBytes - Number(rate?.bytes || 0);
      if (quotaBytes <= 0 || quotaFiles <= 0) throw refusal('UPLOAD_LIFETIME_LIMIT');
      if (pendingBytes <= 0 || pendingFiles <= 0) throw refusal('UPLOAD_PENDING_LIMIT');
      if (rateBytes <= 0) throw refusal('UPLOAD_BYTE_RATE_LIMIT');
      // Leave capacity for the configured number of simultaneous requests,
      // rather than reserving every pending slot for the first small upload.
      bytes = Math.min(bytes, quotaBytes, pendingBytes, Math.ceil(cap.pendingBytes / cap.requests), rateBytes);
      files = Math.min(files, quotaFiles, pendingFiles, Math.ceil(cap.pendingFiles / cap.requests));
    }
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || !Number.isSafeInteger(files) || files <= 0) throw refusal('UPLOAD_QUOTA_UNAVAILABLE', 503);
    await headroom(trx, bytes, limits);
    const row = { id: crypto.randomUUID(), ...values, bytes, files, rate_bytes: bytes, active: 1, host: os.hostname(), pid: process.pid,
      created_at: new Date().toISOString() };
    await trx('public_upload_requests').insert(row);
    return { ...row, limits, dir: stagingPath(row.id), receivedBytes: 0 };
  });
  try {
    await fs.mkdir(session.dir, { mode: 0o700 });
  } catch (err) {
    await finish(session); throw err;
  }
  return session;
}

async function prepareObject(session, key, size) {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('Invalid uploaded file size');
  return locked(async trx => {
    const request = await trx('public_upload_requests').where({ id: session.id, active: 1 }).first();
    if (!request || Number(request.bytes) < size || request.files < 1) throw refusal('UPLOAD_RESERVATION_LOST', 409);
    const storage = getStorage();
    // Recheck the actual destination mount immediately before promotion; it
    // may differ from the staging mount or have other writers since admission.
    if (storage.kind() === 'local') {
      await headroom(trx, 0, session.limits, path.dirname(storage.resolveLocalPath(key)));
    } else await headroom(trx, 0, session.limits);
    const object = { id: crypto.randomUUID(), request_id: session.id, object_key: key, bytes: size, files: 1,
      event_id: request.event_id, guest_scope: request.guest_scope, transfer_id: request.transfer_id, account_id: request.account_id };
    await trx('public_upload_objects').insert(object);
    await trx('public_upload_requests').where({ id: session.id }).update({ bytes: Number(request.bytes) - size, files: request.files - 1 });
    return object;
  });
}

async function commitObject(object, type, writeRow) {
  return locked(async trx => {
    const charge = await trx('public_upload_objects').where({ id: object.id, state: 'promoting' }).first();
    if (!charge) throw refusal('UPLOAD_RESERVATION_LOST', 409);
    const id = await writeRow(trx);
    if (!Number.isInteger(Number(id)) || Number(id) <= 0) throw new Error('Upload row was not inserted');
    await trx('public_upload_objects').where({ id: object.id }).update({ state: 'stored', reference_type: type, reference_id: id, pending: type === 'photo' ? 1 : 0 });
    return id;
  });
}

async function failedObject(object, { storage, settled }) {
  // A commit whose acknowledgement was lost may already have associated the
  // row and charge. Never compensate a successfully committed reference.
  const current = await db('public_upload_objects').where({ id: object.id }).first('state');
  if (!current || current.state !== 'promoting') return;
  // A rejected PUT may complete remotely later. A momentary HEAD 404 cannot
  // prove absence in that state, so it never grants reusable capacity.
  if (settled) {
    try {
      await storage.delete(object.object_key);
      if (!(await storage.stat(object.object_key))) {
        await locked(trx => trx('public_upload_objects').where({ id: object.id, state: 'promoting' }).del());
        return;
      }
    } catch (err) {
      logger.warn('Public upload object cleanup failed; quota remains charged', { objectId: object.id, error: err.message });
    }
  } else {
    await storage.delete(object.object_key).catch(() => {});
  }
  await db('public_upload_objects').where({ id: object.id, state: 'promoting' }).update({ state: 'uncertain' });
}

async function finish(session) {
  // Call ONLY after all temp writers and durable promotions have settled.
  // A failed deletion keeps both capacity and admission slots reserved.
  try {
    await fs.rm(session.dir, { recursive: true, force: true });
  } catch (err) {
    logger.warn('Public upload staging cleanup failed; reservation retained', { requestId: session.id, error: err.message });
    return false;
  }
  await locked(async trx => {
    await trx('public_upload_requests').where({ id: session.id, active: 1 }).update({ active: 0, bytes: 0, files: 0, rate_bytes: session.receivedBytes });
    await trx('public_upload_requests').where({ active: 0 }).where('created_at', '<', new Date(Date.now() - 86400000).toISOString()).del();
  });
  return true;
}

async function processingComplete(photoId) {
  // Never called from a janitor or a failed worker. No age-based releases.
  await db('public_upload_objects').where({ reference_type: 'photo', reference_id: photoId, state: 'stored' }).update({ pending: 0 });
}

async function cleanupAbandoned() {
  const rows = await db('public_upload_requests').where({ active: 1, host: os.hostname() }).whereNot('pid', process.pid).limit(100);
  for (const row of rows) {
    try { process.kill(row.pid, 0); continue; } catch (err) { if (err.code !== 'ESRCH') continue; }
    // Only this dead local Node producer wrote this private staging directory.
    // An uncertain remote PUT remains in the object ledger after this cleanup.
    await finish({ ...row, dir: stagingPath(row.id), receivedBytes: Number(row.rate_bytes) });
  }
}

module.exports = { begin, prepareObject, commitObject, failedObject, finish, processingComplete, cleanupAbandoned, configuration, refusal };
