/** Persistent admission for public capabilities. Charges are lifetime ingress
 * through PUBLIC endpoints only (the ledger, plus guest/transfer uploads that
 * predate it); photographer, admin, API and import content never counts.
 * Deleting a ledger-charged row does not regenerate a public link's allowance.
 * A live writer keeps its reservation by heartbeat, not by host or pid.
 * Authenticated uploads (mode 'admin') share the request table for staging
 * and concurrency accounting only: they are never charged and never counted
 * against a public allowance, and their rows go when the upload settles. */
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
const UNLIMITED = Number.MAX_SAFE_INTEGER;
const HEARTBEAT_MS = 30000;
// Ten missed heartbeats. Independent of requestTimeoutMs: a live request is
// kept by its process's timer however long its body is allowed to take.
const STALE_MS = 5 * 60000;
const LEGACY_TTL_MS = 60000;
// Multipart boundaries and part headers ride on top of the file bytes.
const FRAMING_BYTES = MiB;
const DEFAULTS = Object.freeze({
  requestBytes: 95 * MiB, headroomBytes: 512 * MiB, headroomPercent: 0, headroomFiles: 1024,
  requestTimeoutMs: 300000,
  gallery: { bytes: 50 * GiB, files: 20000, pendingBytes: 20 * GiB, pendingFiles: 5000, requests: 16, hourBytes: 20 * GiB },
  // Same as the gallery: guests without an identity are bucketed by client
  // network, and a whole venue usually shares one address.
  guest: { bytes: 50 * GiB, files: 20000, pendingBytes: 20 * GiB, pendingFiles: 5000, requests: 16, hourBytes: 20 * GiB },
  transfer: { bytes: 50 * GiB, files: 20000, pendingBytes: 20 * GiB, pendingFiles: 5000, requests: 4, hourBytes: 20 * GiB },
  account: { bytes: 500 * GiB, files: 200000, pendingBytes: 50 * GiB, pendingFiles: 20000, requests: 32, hourBytes: 100 * GiB },
  // No lifetime ceiling for the whole deployment: free-disk headroom bounds it.
  deployment: { bytes: UNLIMITED, files: UNLIMITED, pendingBytes: 100 * GiB, pendingFiles: 50000, requests: 64, hourBytes: 200 * GiB },
});
// Authenticated uploads (admin UI, API token, resumable) come from trusted
// users: no lifetime, hourly or per-gallery cap. Only what is in flight at
// once is bounded. stagedBytes defaults to min(50 GiB, 25% of free space).
// No requestBytes: one request may carry the admin's own batch setting.
const ADMIN_DEFAULTS = Object.freeze({
  headroomBytes: 512 * MiB, headroomPercent: 0, headroomFiles: 1024,
  requestTimeoutMs: 600000,
  stagedFiles: 50000, accountRequests: 16, requests: 64,
});
const ADMIN_STAGED_BYTES = 50 * GiB;
const ADMIN_MESSAGE = 'The server cannot take this upload right now: it is busy with other uploads or short on disk space. Retry shortly, or check free space and ADMIN_UPLOAD_LIMITS_JSON.';
const scopeNames = ['gallery', 'guest', 'transfer', 'account', 'deployment'];
const capNames = ['bytes', 'files', 'pendingBytes', 'pendingFiles', 'requests', 'hourBytes'];

function configuration(mode = 'public') {
  if (!['public', 'admin'].includes(mode)) throw new Error('Invalid upload admission mode');
  const admin = mode === 'admin';
  const result = JSON.parse(JSON.stringify(admin ? ADMIN_DEFAULTS : DEFAULTS));
  const variable = admin ? 'ADMIN_UPLOAD_LIMITS_JSON' : 'PUBLIC_UPLOAD_LIMITS_JSON';
  const raw = process.env[variable];
  if (!raw) return result;
  if (raw.length > 8192) throw new Error(`Invalid ${variable}`);
  const overrides = JSON.parse(raw);
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error(`Invalid ${variable}`);
  const scalar = ['requestBytes', 'headroomBytes', 'headroomPercent', 'headroomFiles', 'requestTimeoutMs',
    ...(admin ? ['stagedBytes', 'stagedFiles', 'accountRequests', 'requests'] : [])];
  for (const [key, value] of Object.entries(overrides)) {
    if (scalar.includes(key)) {
      const maximum = key === 'headroomPercent' ? 50 : key === 'requestTimeoutMs' ? 3600000 : UNLIMITED;
      // 0 switches the percentage floor off; every other scalar must be positive.
      if (!Number.isSafeInteger(value) || value < (key === 'headroomPercent' ? 0 : 1) || value > maximum) {
        throw new Error(`Invalid public upload limit: ${key}`);
      }
      result[key] = value;
    } else if (!admin && scopeNames.includes(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [cap, limit] of Object.entries(value)) {
        if (!capNames.includes(cap) || !Number.isSafeInteger(limit) || limit <= 0) {
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

const PUBLIC_MESSAGE = 'Public upload capacity is unavailable. Please contact the gallery owner.';
function refusal(code, status = 429) {
  return Object.assign(new Error(PUBLIC_MESSAGE), { code, status });
}

/** An authenticated uploader is the operator's own user, not a guest: say
 * what is wrong instead of pointing at "the gallery owner". */
function forAdmin(err) {
  if (err && err.message === PUBLIC_MESSAGE) {
    err.message = err.code === 'UPLOAD_REQUEST_TOO_LARGE' ? 'This upload is larger than the server accepts in one request.'
      : err.code === 'UPLOAD_TARGET_GONE' ? 'The upload target no longer exists.'
        : err.code === 'UPLOAD_TIMEOUT' ? 'The upload took too long and was stopped. Retry it.' : ADMIN_MESSAGE;
  }
  return err;
}

// A write FIRST on SQLite avoids a deferred read -> write upgrade race.
// PostgreSQL's UPDATE takes the same singleton row lock across all replicas.
// Held for ledger reads and writes only, never across file I/O.
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
  const row = await query.sum('bytes as bytes').sum('files as files').count('id as count').first();
  return { bytes: Number(row?.bytes || 0), files: Number(row?.files || 0), count: Number(row?.count || 0) };
}

/** The largest raw body one request may send. A single file of the admin's
 * configured maximum always fits, whatever the batch setting or ceiling. */
async function requestBudget(maxFileBytes = 0, limits = configuration()) {
  const setting = await db('app_settings').where({ setting_key: 'general_max_upload_batch_size_mb' }).first('setting_value');
  let batchMb;
  try { batchMb = Number(JSON.parse(setting?.setting_value)); } catch (_) { batchMb = NaN; }
  const batch = Number.isFinite(batchMb) && batchMb > 0 ? Math.floor(batchMb * MiB) : limits.requestBytes ?? DEFAULTS.requestBytes;
  const oneFile = Number.isFinite(maxFileBytes) && maxFileBytes > 0 ? Math.ceil(maxFileBytes) + FRAMING_BYTES : 0;
  return Math.max(Math.min(limits.requestBytes ?? batch, batch), oneFile);
}

// Public uploads that predate the ledger: guest-marked photos and file-request
// uploads. Ledger-associated rows are excluded (their own charge survives
// deletion). Read outside the lock and cached: new uploads only ever land in
// the ledger, so a stale value can only over-count.
const legacyCache = new Map();
async function legacyCharge(scope, values, cap) {
  // Guests had no identity before the ledger; an unlimited scope needs no sum.
  if (scope === 'guest' || (cap.bytes === UNLIMITED && cap.files === UNLIMITED)) return { bytes: 0, files: 0 };
  const key = `${scope}:${{ gallery: values.event_id, transfer: values.transfer_id, account: values.account_id }[scope] ?? ''}`;
  const hit = legacyCache.get(key);
  if (hit && Date.now() - hit.at < LEGACY_TTL_MS) return hit.total;
  const total = { bytes: 0, files: 0 };
  const add = async query => {
    const row = await query.first();
    total.bytes += Number(row?.bytes || 0); total.files += Number(row?.files || 0);
  };
  const uncharged = (type, column) => db('public_upload_objects as o').select('o.id')
    .where('o.reference_type', type).whereColumn('o.reference_id', column);
  if (scope !== 'transfer') {
    const photos = db('photos as p').where('p.uploaded_by', 'guest').whereNotExists(uncharged('photo', 'p.id'))
      .sum('p.size_bytes as bytes').count('p.id as files');
    if (scope === 'gallery') photos.where('p.event_id', values.event_id);
    else if (scope === 'account') {
      photos.join('events as e', 'e.id', 'p.event_id');
      if (values.account_id == null) photos.whereNull('e.created_by'); else photos.where('e.created_by', values.account_id);
    }
    await add(photos);
  }
  if (scope !== 'gallery') {
    const uploads = db('transfer_uploads as u').whereNotExists(uncharged('transfer', 'u.id'))
      .sum('u.size_bytes as bytes').count('u.id as files');
    if (scope === 'transfer') uploads.where('u.transfer_id', values.transfer_id);
    else if (scope === 'account') {
      uploads.join('transfers as t', 't.id', 'u.transfer_id');
      if (values.account_id == null) uploads.whereNull('t.created_by'); else uploads.where('t.created_by', values.account_id);
    }
    await add(uploads);
  }
  if (!Number.isSafeInteger(total.bytes) || !Number.isSafeInteger(total.files) || total.bytes < 0) {
    throw refusal('UPLOAD_QUOTA_UNAVAILABLE', 503);
  }
  if (legacyCache.size >= 1000) legacyCache.clear();
  legacyCache.set(key, { at: Date.now(), total });
  return total;
}

const tempRoot = () => path.join(getStoragePath(), 'temp', 'public-uploads');
function stagingPath(id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid upload reservation id');
  return path.join(tempRoot(), id);
}

async function diskStat(directory) {
  for (;;) {
    try { return await fs.statfs(directory); } catch (err) {
      if (err.code !== 'ENOENT' || path.dirname(directory) === directory) throw err;
      directory = path.dirname(directory);
    }
  }
}

let warnedUnmeasurable = false;
async function headroom(trx, stat, bytes, limits, files = 0) {
  const free = Number(stat.bavail) * Number(stat.bsize);
  const total = Number(stat.blocks) * Number(stat.bsize);
  const other = await sum(trx('public_upload_requests').where({ active: 1 }));
  const promoting = getStorage().kind() === 'local'
    ? await sum(trx('public_upload_objects').whereIn('state', ['promoting', 'uncertain'])) : { bytes: 0, files: 0 };
  const freeFiles = Number(stat.ffree);
  // Local promotion temporarily needs both copies. S3 needs staging space.
  const copies = getStorage().kind() === 'local' ? 2 : 1;
  // A volume that reports no usable size (some FUSE and network mounts) cannot
  // be judged; refusing every upload there would break a working install.
  if (!Number.isSafeInteger(free) || !Number.isSafeInteger(total) || total <= 0) {
    if (!warnedUnmeasurable) {
      warnedUnmeasurable = true;
      logger.warn('Upload storage reports no usable capacity figures; the free-space check is skipped for it');
    }
    return;
  }
  // The percentage floor is opt-in: 5% of a large volume is hundreds of
  // gigabytes, and an install that full but far from out of space must keep
  // accepting uploads after an upgrade.
  const floor = Math.max(limits.headroomBytes, Math.ceil(total * limits.headroomPercent / 100));
  // btrfs, exFAT and many network filesystems have no inode table and report
  // zero inodes in total; there is nothing to run out of.
  const countsInodes = Number(stat.files) > 0 && Number.isSafeInteger(freeFiles);
  if (free - copies * (bytes + other.bytes + promoting.bytes) < floor
    || (countsInodes && freeFiles - copies * (files + other.files + promoting.files) - other.count - 1 < limits.headroomFiles)) {
    throw refusal('UPLOAD_STORAGE_LOW', 507);
  }
}

// What one public scope still has room for; authenticated rows never count. `held` is every active request's
// reservation, this request's own included once it exists.
async function room(trx, scope, values, cap, legacy) {
  const objects = await sum(filter(trx('public_upload_objects').where({ upload_kind: 'public' }), scope, values));
  const held = await sum(filter(trx('public_upload_requests').where({ active: 1, upload_kind: 'public' }), scope, values));
  const pending = await sum(filter(trx('public_upload_objects').where({ pending: 1, upload_kind: 'public' }), scope, values));
  return {
    active: held.count,
    bytes: cap.bytes - legacy.bytes - objects.bytes - held.bytes,
    files: cap.files - legacy.files - objects.files - held.files,
    pendingBytes: cap.pendingBytes - pending.bytes - held.bytes,
    pendingFiles: cap.pendingFiles - pending.files - held.files,
  };
}

// Authenticated admission: a slot per uploading account and per deployment,
// and a bound on what all authenticated requests hold in staging together.
// A request that is alone is always admitted, so one file of any allowed
// size goes through whenever the disk has room for it.
async function adminRoom(trx, values, limits, stat, bytes) {
  const active = () => trx('public_upload_requests').where({ active: 1, upload_kind: 'admin' });
  const all = await sum(active());
  const mine = await sum(filter(active(), 'account', values));
  if (all.count >= limits.requests || mine.count >= limits.accountRequests) throw refusal('UPLOAD_CONCURRENCY_LIMIT');
  const free = Number(stat.bavail) * Number(stat.bsize);
  const stagedBytes = limits.stagedBytes ?? Math.min(ADMIN_STAGED_BYTES, Math.floor(free / 4));
  if (all.count > 0 && (all.bytes + bytes > stagedBytes || all.files >= limits.stagedFiles)) throw refusal('UPLOAD_PENDING_LIMIT');
}

const scopesOf = values => [values.event_id ? 'gallery' : 'transfer', ...(values.event_id ? ['guest'] : []), 'account', 'deployment'];

// Requests this process is still serving; the heartbeat keeps their lease.
const live = new Set();

/** `declaredBytes` is the request's Content-Length when it has one: the
 * reservation is then what the request will actually send, not the ceiling.
 * One file is reserved; reserveFile() adds one per further file part.
 * mode 'admin': `accountId` is the uploading admin; `requestedBytes` is an
 * exact reservation not held to the request ceiling (one resumable file, whose
 * chunks are not requests of their own, with `stagedCopies` 2 for its merge).
 * An authenticated upload may have no event or transfer yet. */
async function begin({ eventId = null, guestId = null, clientKey = null, transferId = null, maxFiles, maxFileBytes = 0, declaredBytes = null,
  mode = 'public', accountId = null, requestedBytes = null, stagedCopies = 1 }) {
  const admin = mode === 'admin';
  let limits;
  try { limits = configuration(mode); } catch (err) {
    if (!admin) throw err;
    throw refusal('UPLOAD_QUOTA_UNAVAILABLE', 503);
  }
  if (requestedBytes !== null && (!admin || !Number.isSafeInteger(requestedBytes) || requestedBytes <= 0)) throw new Error('Invalid exact upload reservation');
  await fs.mkdir(tempRoot(), { recursive: true, mode: 0o700 });
  const target = eventId || transferId;
  const owner = target ? await db(eventId ? 'events' : 'transfers').where({ id: target }).first('created_by') : admin ? {} : null;
  if (!owner) throw refusal('UPLOAD_TARGET_GONE', 404);
  // A guest without an identity is bucketed by client network, so strangers
  // do not share one allowance and one concurrency slot per gallery.
  const guest = guestId || (clientKey ? `ip:${clientKey}` : 'anonymous');
  const values = { event_id: eventId, transfer_id: transferId, account_id: (admin ? accountId : null) ?? owner.created_by ?? null,
    guest_scope: eventId && !admin ? `${eventId}:${guest}`.slice(0, 80) : null, upload_kind: mode };
  const ceiling = requestedBytes ?? await requestBudget(maxFileBytes, limits);
  if (declaredBytes != null && declaredBytes > ceiling) throw refusal('UPLOAD_REQUEST_TOO_LARGE', 413);
  const scopes = admin ? [] : scopesOf(values);
  const legacy = {};
  for (const scope of scopes) legacy[scope] = await legacyCharge(scope, values, limits[scope]);
  const stat = await diskStat(tempRoot());
  const session = await locked(async trx => {
    let bytes = ceiling;
    for (const scope of scopes) {
      const cap = limits[scope];
      const left = await room(trx, scope, values, cap, legacy[scope]);
      const rate = await filter(trx('public_upload_requests').where({ upload_kind: 'public' }).where('created_at', '>=', new Date(Date.now() - 3600000).toISOString()), scope, values)
        .sum('rate_bytes as bytes').first();
      if (left.active >= cap.requests) throw refusal('UPLOAD_CONCURRENCY_LIMIT');
      const rateBytes = cap.hourBytes - Number(rate?.bytes || 0);
      if (left.bytes <= 0 || left.files <= 0) throw refusal('UPLOAD_LIFETIME_LIMIT');
      // Pending work only needs SOME room: clamping the body to it would
      // refuse a single allowed file whenever the backlog is nearly full.
      if (left.pendingBytes <= 0 || left.pendingFiles <= 0) throw refusal('UPLOAD_PENDING_LIMIT');
      if (rateBytes <= 0) throw refusal('UPLOAD_BYTE_RATE_LIMIT');
      bytes = Math.min(bytes, left.bytes, rateBytes);
    }
    if (declaredBytes != null) {
      if (declaredBytes > bytes) throw refusal('UPLOAD_REQUEST_TOO_LARGE', 413);
      bytes = Math.max(declaredBytes, 1);
    }
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || !Number.isSafeInteger(maxFiles) || maxFiles <= 0) throw refusal('UPLOAD_QUOTA_UNAVAILABLE', 503);
    if (admin) await adminRoom(trx, values, limits, stat, bytes);
    // A resumable file holds its chunks and their merged copy in staging at
    // once, whatever the storage backend; headroom() doubles local claims.
    await headroom(trx, stat, getStorage().kind() === 'local' ? bytes : stagedCopies * bytes, limits, 1);
    const row = { id: crypto.randomUUID(), ...values, bytes, files: 1, rate_bytes: admin ? 0 : bytes, active: 1, host: os.hostname(), pid: process.pid,
      heartbeat_at: Date.now(), created_at: new Date().toISOString() };
    await trx('public_upload_requests').insert(row);
    return { ...row, limits, legacy, maxFiles, stagedFiles: 0, dir: stagingPath(row.id), receivedBytes: 0 };
  });
  live.add(session.id);
  try {
    await fs.mkdir(session.dir, { mode: 0o700 });
  } catch (err) {
    await finish(session); throw err;
  }
  return session;
}

/** Call once per file part before staging it. The first uses the admission
 * reservation; each further one must find lifetime and pending room. */
async function reserveFile(session) {
  session.stagedFiles += 1;
  if (session.stagedFiles === 1) return;
  await locked(async trx => {
    if (session.upload_kind === 'admin') {
      const staged = await sum(trx('public_upload_requests').where({ active: 1, upload_kind: 'admin' }));
      if (staged.files >= session.limits.stagedFiles) throw refusal('UPLOAD_PENDING_LIMIT');
    } else for (const scope of scopesOf(session)) {
      const left = await room(trx, scope, session, session.limits[scope], session.legacy[scope]);
      if (left.files <= 0) throw refusal('UPLOAD_LIFETIME_LIMIT');
      if (left.pendingFiles <= 0) throw refusal('UPLOAD_PENDING_LIMIT');
    }
    if (await trx('public_upload_requests').where({ id: session.id, active: 1 }).increment('files', 1) !== 1) {
      throw refusal('UPLOAD_RESERVATION_LOST', 409);
    }
  });
  session.files += 1;
}

async function prepareObject(session, key, size) {
  if (session.isCancelled?.()) throw refusal('UPLOAD_CANCELLED', 400);
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('Invalid uploaded file size');
  const storage = getStorage();
  // Recheck the actual destination mount immediately before promotion; it
  // may differ from the staging mount or have other writers since admission.
  const stat = await diskStat(storage.kind() === 'local' ? path.dirname(storage.resolveLocalPath(key)) : tempRoot());
  return locked(async trx => {
    const request = await trx('public_upload_requests').where({ id: session.id, active: 1 }).first();
    if (!request || Number(request.bytes) < size || request.files < 1) throw refusal('UPLOAD_RESERVATION_LOST', 409);
    await headroom(trx, stat, 0, session.limits);
    const object = { id: crypto.randomUUID(), request_id: session.id, object_key: key, bytes: size, files: 1,
      event_id: request.event_id, guest_scope: request.guest_scope, transfer_id: request.transfer_id, account_id: request.account_id,
      upload_kind: request.upload_kind };
    await trx('public_upload_objects').insert(object);
    await trx('public_upload_requests').where({ id: session.id }).update({ bytes: Number(request.bytes) - size, files: request.files - 1 });
    return { ...object, isCancelled: session.isCancelled };
  });
}

async function commitObject(object, type, writeRow) {
  return locked(async trx => {
    const charge = await trx('public_upload_objects').where({ id: object.id, state: 'promoting' }).first();
    if (!charge) throw refusal('UPLOAD_RESERVATION_LOST', 409);
    if (object.isCancelled?.()) throw refusal('UPLOAD_CANCELLED', 400);
    const id = await writeRow(trx);
    if (!Number.isInteger(Number(id)) || Number(id) <= 0) throw new Error('Upload row was not inserted');
    // An authenticated upload is charged to nothing once it is stored.
    if (charge.upload_kind === 'admin') await trx('public_upload_objects').where({ id: object.id }).del();
    else await trx('public_upload_objects').where({ id: object.id }).update({ state: 'stored', reference_type: type, reference_id: id, pending: type === 'photo' ? 1 : 0 });
    return id;
  });
}

async function failedObject(object, { storage, settled }) {
  // A commit whose acknowledgement was lost may already have associated the
  // row and charge. Never compensate a successfully committed reference.
  const current = await db('public_upload_objects').where({ id: object.id }).first('state', 'upload_kind');
  if (!current || current.state !== 'promoting') return;
  if (current.upload_kind === 'admin') {
    // No allowance to protect: the hold ends with the attempt either way.
    await storage.delete(object.object_key).catch(() => {});
    await db('public_upload_objects').where({ id: object.id, state: 'promoting' }).del();
    return;
  }
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
  // A failed deletion keeps both capacity and admission slots reserved; the
  // reaper retries it once the lease lapses.
  live.delete(session.id);
  try {
    await fs.rm(session.dir, { recursive: true, force: true });
  } catch (err) {
    logger.warn('Public upload staging cleanup failed; reservation retained', { requestId: session.id, error: err.message });
    return false;
  }
  await locked(async trx => {
    const admin = session.upload_kind === 'admin';
    await trx('public_upload_requests').where({ id: session.id, active: 1 }).update({ active: 0, bytes: 0, files: 0, rate_bytes: admin ? 0 : session.receivedBytes });
    // A promotion that never settled (its process died) holds nothing either.
    if (admin) await trx('public_upload_objects').where({ request_id: session.id, upload_kind: 'admin' }).del();
    await trx('public_upload_requests').where({ active: 0 }).where('created_at', '<', new Date(Date.now() - 86400000).toISOString()).del();
  });
  return true;
}

/** A resumable lease may sit idle while unrelated writers fill the disk, or
 * be reaped after a restart: recheck it and the staging mount before each
 * chunk and before creating the merge copy. */
async function recheckStaging(session) {
  const stat = await diskStat(tempRoot());
  await locked(async trx => {
    if (!(await trx('public_upload_requests').where({ id: session.id, active: 1 }).first('id'))) throw refusal('UPLOAD_RESERVATION_LOST', 409);
    await headroom(trx, stat, 0, session.limits);
  });
}

/** The photo left the processing queue (complete or terminally failed): its
 * work hold ends, its lifetime charge stays. */
async function releasePending(photoId) {
  await db('public_upload_objects').where({ reference_type: 'photo', reference_id: photoId, state: 'stored' }).update({ pending: 0 });
}

// A pending photo that was deleted, or failed without reaching the call
// above, is no longer queued work either.
async function reconcilePending() {
  await db('public_upload_objects').where({ pending: 1, state: 'stored', reference_type: 'photo' })
    .whereNotExists(db('photos as p').select('p.id').whereColumn('p.id', 'public_upload_objects.reference_id')
      .whereIn('p.processing_status', ['pending', 'processing']))
    .update({ pending: 0 });
}

async function heartbeat() {
  if (live.size) await db('public_upload_requests').whereIn('id', [...live]).where({ active: 1 }).update({ heartbeat_at: Date.now() });
}

/** Release requests whose lease lapsed: their process died mid-upload. Host
 * and pid prove nothing (a recreated container has a new hostname, a
 * restarted one reuses its pid), so only the heartbeat decides. */
async function cleanupAbandoned() {
  const rows = await db('public_upload_requests').where({ active: 1 }).where('heartbeat_at', '<', Date.now() - STALE_MS).limit(100);
  for (const row of rows) {
    if (live.has(row.id)) continue;
    // Removes the staging directory when it is under this process's staging
    // root. An uncertain remote PUT remains in the object ledger regardless.
    await finish({ ...row, dir: stagingPath(row.id), receivedBytes: Number(row.rate_bytes) });
  }
}

let maintenance = null;
/** Started once at boot: keeps this process's leases and runs the reapers. */
function startMaintenance() {
  if (maintenance) return;
  maintenance = setInterval(() => {
    heartbeat().then(cleanupAbandoned).then(reconcilePending)
      .catch(err => logger.warn('Public upload maintenance failed', { error: err.message }));
  }, HEARTBEAT_MS);
  maintenance.unref();
}
function stopMaintenance() {
  clearInterval(maintenance);
  maintenance = null;
}

module.exports = {
  begin, reserveFile, recheckStaging, prepareObject, commitObject, failedObject, finish, releasePending, processingComplete: releasePending,
  reconcilePending, heartbeat, cleanupAbandoned, startMaintenance, stopMaintenance, requestBudget, configuration, refusal, forAdmin,
  STALE_MS, _legacyCache: legacyCache,
};
