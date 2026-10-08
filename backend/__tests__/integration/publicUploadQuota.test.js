const fs = require('fs');
const path = require('path');
const http = require('http');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal, buildRouteApp } = require('./helpers/crmDb');

const mockObjects = new Map();
const mockStorage = {
  kind: () => 'local',
  resolveLocalPath: key => path.join(process.env.STORAGE_PATH, key),
  putFromFile: jest.fn(async (key, file) => mockObjects.set(key, fs.statSync(file).size)),
  stat: jest.fn(async key => mockObjects.has(key) ? { size: mockObjects.get(key) } : null),
  delete: jest.fn(async key => { mockObjects.delete(key); }),
};
jest.mock('../../src/services/storage', () => ({ getStorage: () => mockStorage, initStorage: async () => mockStorage }));
// Isolate the persistent byte budget from the existing per-network request
// counter, whose own route suites continue to exercise its behavior.
jest.mock('express-rate-limit', () => Object.assign(() => (_req, _res, next) => next(), jest.requireActual('express-rate-limit')));

const JPEG = Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1]);
const largeJPEG = size => { const b = Buffer.alloc(size); JPEG.copy(b); return b; };
const idOf = rows => rows[0]?.id ?? rows[0];
let db; let cleanup; let galleryApp; let transferApp; let quota; let transferService; let event; let transfer; let token; let adminId;
const originalLimits = process.env.PUBLIC_UPLOAD_LIMITS_JSON;
const limits = value => { process.env.PUBLIC_UPLOAD_LIMITS_JSON = JSON.stringify(value); };
const MiB = 1024 * 1024;
const setting = async (key, value) => {
  if (!(await db('app_settings').where({ setting_key: key }).update({ setting_value: JSON.stringify(value) }))) {
    await db('app_settings').insert({ setting_key: key, setting_value: JSON.stringify(value), setting_type: 'number' });
  }
};
// The per-request ceiling always admits one file of the configured maximum,
// so the raw-body tests lower that maximum to reach the ceiling.
const galleryFileMax = bytes => jest.spyOn(require('../../src/services/uploadSettings'), 'getMaxFileSizeBytes').mockResolvedValue(bytes);
const photoRow = (n, fields = {}) => ({
  event_id: event.id, filename: `seed-${n}.jpg`, path: `owned-quota-gallery/seed-${n}.jpg`, type: 'individual', size_bytes: 2 * MiB, ...fields,
});
const galleryRequest = () => request(galleryApp).post(`/api/gallery/${event.id}/upload`).set('Authorization', `Bearer ${jwt.sign({
  eventId: event.id, eventSlug: event.slug, type: 'gallery',
}, process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' })}`);
const transferRequest = () => request(transferApp).post(`/api/public/transfer-upload/${token}`);
const attach = (req, field, size = 12, name = 'ordinary.jpg') => req.attach(field, largeJPEG(size), { filename: name, contentType: 'image/jpeg' });
async function waitSettled() {
  for (let n = 0; n < 100; n++) {
    if (!(await db('public_upload_requests').where({ active: 1 }).first())) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('staging reservation was not settled');
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId } = await seedMinimal(db));
  await db('feature_flags').insert({ key: 'transfers', value: 1 }).onConflict('key').merge({ value: 1 });
  quota = require('../../src/services/publicUploadQuota');
  transferService = require('../../src/services/transferService');
  galleryApp = buildRouteApp('/api/gallery', require('../../src/routes/gallery'));
  transferApp = buildRouteApp('/api/public/transfer-upload', require('../../src/routes/publicTransferUpload'));
}, 120000);
beforeEach(async () => {
  await db('public_upload_objects').del(); await db('public_upload_requests').del();
  await db('transfer_uploads').del(); await db('photos').del();
  await db('transfers').del(); await db('events').del();
  mockObjects.clear(); jest.clearAllMocks(); quota._legacyCache.clear();
  limits({});
  await db('app_settings').where({ setting_key: 'general_max_upload_batch_size_mb' }).update({ setting_value: '95' });
  await setting('transfer_max_upload_size_mb', 50);
  const future = new Date(Date.now() + 3600000).toISOString();
  event = { slug: 'owned-quota-gallery', id: idOf(await db('events').insert({
    slug: 'owned-quota-gallery', event_type: 'wedding', event_name: 'Owned gallery', event_date: '2026-10-07',
    host_email: 'host@fixture.invalid', admin_email: 'admin@fixture.invalid', password_hash: 'x', share_link: '/gallery/owned-quota-gallery/share',
    expires_at: future, is_active: 1, is_archived: 0, is_draft: 0, allow_user_uploads: 1, created_by: adminId,
  }).returning('id')) };
  const row = { token: 'e'.repeat(64), title: 'Owned request', expires_at: future, is_active: 1, grace_days: 7, allow_uploads: 1, created_by: adminId };
  if (await db.schema.hasColumn('transfers', 'kind')) { row.kind = 'request'; token = row.token; }
  else { row.upload_token = 'OWND7K'; row.upload_expires_at = future; token = row.upload_token; }
  transfer = idOf(await db('transfers').insert(row).returning('id'));
});
afterEach(async () => { jest.restoreAllMocks(); });
afterAll(async () => {
  if (originalLimits === undefined) delete process.env.PUBLIC_UPLOAD_LIMITS_JSON; else process.env.PUBLIC_UPLOAD_LIMITS_JSON = originalLimits;
  if (cleanup) await cleanup();
});

test('ordinary anonymous gallery upload commits a pending row and lifetime charge together', async () => {
  const res = await attach(galleryRequest(), 'photos');
  expect(res.status).toBe(202); expect(res.body.count).toBe(1);
  const object = await db('public_upload_objects').first();
  expect(object).toMatchObject({ bytes: 12, reference_type: 'photo', reference_id: res.body.photo_ids[0], state: 'stored', pending: 1 });
  // No guest identity: the bucket is the client network, not one shared name.
  expect(object.guest_scope).toMatch(new RegExp(`^${event.id}:ip:.+`));
  expect(await db('public_upload_requests').where({ active: 1 })).toHaveLength(0);
});
test('ordinary reusable file-request upload retains the existing response and byte metadata', async () => {
  const res = await attach(transferRequest(), 'files');
  expect(res.status).toBe(201); expect(res.body.uploaded).toBe(1);
  expect(await db('public_upload_objects').first()).toMatchObject({ bytes: 12, reference_type: 'transfer', state: 'stored', pending: 0 });
});
test('gallery rejects the reproduced above-batch body before any durable promotion', async () => {
  await db('app_settings').where({ setting_key: 'general_max_upload_batch_size_mb' }).update({ setting_value: '1' });
  galleryFileMax(700 * 1024);
  const res = await attach(attach(attach(galleryRequest(), 'photos', 600 * 1024, 'first.jpg'), 'photos', 600 * 1024, 'second.jpg'), 'photos', 600 * 1024, 'third.jpg');
  expect(res.status).toBe(413); expect(res.body.code).toBe('UPLOAD_REQUEST_TOO_LARGE');
  await waitSettled();
  expect(mockStorage.putFromFile).not.toHaveBeenCalled();
  expect(await db('photos')).toHaveLength(0);
  expect(await fs.promises.readdir(path.join(process.env.STORAGE_PATH, 'temp', 'public-uploads'))).toEqual([]);
});
test('transfer rejects the same above-batch body', async () => {
  limits({ requestBytes: MiB }); await setting('transfer_max_upload_size_mb', 1);
  let req = transferRequest();
  for (const name of ['first.jpg', 'second.jpg', 'third.jpg', 'fourth.jpg']) req = attach(req, 'files', 600 * 1024, name);
  const res = await req;
  expect(res.status).toBe(413); expect(res.body.code).toBe('UPLOAD_REQUEST_TOO_LARGE'); await waitSettled();
  expect(mockStorage.putFromFile).not.toHaveBeenCalled();
});
test('chunked multipart without Content-Length is cut off mid-body, and the client still reads the refusal', async () => {
  // One byte of file allowance: the ceiling is that plus the framing margin.
  limits({ requestBytes: 4096 }); galleryFileMax(1);
  const total = 16 * MiB;
  const server = http.createServer(galleryApp); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const auth = jwt.sign({ eventId: event.id, eventSlug: event.slug, type: 'gallery' }, process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' });
  let sent = 0; let interval;
  try {
    const result = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: `/api/gallery/${event.id}/upload`, headers: {
        Authorization: `Bearer ${auth}`, 'Content-Type': 'multipart/form-data; boundary=owned-boundary',
      } }, res => { let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) })); });
      req.on('error', err => { if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') reject(err); });
      // Bytes ahead of the first boundary: metered as raw body, never staged.
      interval = setInterval(() => {
        if (req.destroyed) return clearInterval(interval);
        sent += 64 * 1024; req.write(Buffer.alloc(64 * 1024, 49));
        if (sent >= total) { clearInterval(interval); req.end('\r\n--owned-boundary--\r\n'); }
      }, 2);
    });
    // The refusal arrived as JSON although the client was still sending, and
    // the server stopped reading long before the body ended.
    expect(result.status).toBe(413); expect(result.body.code).toBe('UPLOAD_REQUEST_TOO_LARGE'); expect(sent).toBeLessThan(total);
  } finally { clearInterval(interval); await new Promise(resolve => server.close(resolve)); }
  await waitSettled(); expect(mockStorage.putFromFile).not.toHaveBeenCalled();
});
test('a repeated transfer reaches its lifetime allowance, even after its catalogue rows are deleted', async () => {
  limits({ requestBytes: 4096, transfer: { bytes: 3000 } });
  expect((await attach(transferRequest(), 'files', 1024)).status).toBe(201);
  expect((await attach(transferRequest(), 'files', 1024)).status).toBe(201);
  await db('transfer_uploads').del();
  const res = await attach(transferRequest(), 'files', 1024);
  expect(res.status).toBe(413); await waitSettled();
  expect(mockStorage.putFromFile).toHaveBeenCalledTimes(2);
  expect(await db('public_upload_objects')).toHaveLength(2);
});
test.each(['gallery', 'guest', 'account', 'deployment'])('%s allowance is binding before another gallery file is promoted', async scope => {
  limits({ requestBytes: 4096, [scope]: { files: 1 } });
  expect((await attach(galleryRequest(), 'photos')).status).toBe(202);
  const res = await attach(galleryRequest(), 'photos');
  expect(res.status).toBe(429); expect(res.body.code).toBe('UPLOAD_LIFETIME_LIMIT');
  expect(mockStorage.putFromFile).toHaveBeenCalledTimes(1);
});
test('parallel reservations serialize and cannot exceed deployment capacity', async () => {
  limits({ requestBytes: 4096, deployment: { bytes: 4096, requests: 4 } });
  const calls = await Promise.allSettled([
    quota.begin({ eventId: event.id, maxFiles: 1 }), quota.begin({ transferId: transfer, maxFiles: 1 }),
  ]);
  expect(calls.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(calls.filter(r => r.status === 'rejected')[0].reason.code).toBe('UPLOAD_LIFETIME_LIMIT');
  const accepted = calls.find(r => r.status === 'fulfilled').value;
  expect(Number((await db('public_upload_requests').where({ active: 1 }).sum('bytes as n').first()).n)).toBe(4096);
  await quota.finish(accepted);
});
test('ownerless galleries and requests share a charged account bucket', async () => {
  await db('events').where({ id: event.id }).update({ created_by: null });
  await db('transfers').where({ id: transfer }).update({ created_by: null });
  limits({ account: { files: 1 } });
  expect((await attach(galleryRequest(), 'photos')).status).toBe(202);
  const res = await attach(transferRequest(), 'files');
  expect(res.status).toBe(429); expect(res.body.code).toBe('UPLOAD_LIFETIME_LIMIT');
});
test('a deleted pending photo stops holding pending capacity at the next reconcile, its lifetime charge stays', async () => {
  limits({ guest: { pendingFiles: 1 } });
  expect((await attach(galleryRequest(), 'photos')).status).toBe(202);
  await quota.reconcilePending();
  const busy = await attach(galleryRequest(), 'photos');
  expect(busy.status).toBe(429); expect(busy.body.code).toBe('UPLOAD_PENDING_LIMIT');
  await db('photos').del();
  await quota.reconcilePending();
  expect((await attach(galleryRequest(), 'photos')).status).toBe(202);
  expect(await db('public_upload_objects')).toHaveLength(2);
});
test('a photo whose processing fails terminally releases its pending hold', async () => {
  limits({ guest: { pendingFiles: 1 } });
  const first = await attach(galleryRequest(), 'photos'); expect(first.status).toBe(202);
  const photoProcessor = require('../../src/services/photoProcessor');
  jest.spyOn(photoProcessor, 'processPhoto').mockRejectedValue(new Error('owned processing failure'));
  const worker = require('../../src/services/backgroundProcessor');
  worker.start();
  try {
    for (let n = 0; n < 500; n++) {
      if ((await db('photos').where({ id: first.body.photo_ids[0] }).first()).processing_status === 'failed'
        && !(await db('public_upload_objects').where({ pending: 1 }).first())) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  } finally { await worker.stop(); }
  expect(await db('photos').where({ id: first.body.photo_ids[0] }).first()).toMatchObject({ processing_status: 'failed' });
  expect(await db('public_upload_objects').first()).toMatchObject({ pending: 0, state: 'stored', bytes: 12 });
  expect((await attach(galleryRequest(), 'photos')).status).toBe(202);
});
test('only confirmed successful processing releases pending capacity, not lifetime storage', async () => {
  limits({ guest: { pendingFiles: 1 } });
  const first = await attach(galleryRequest(), 'photos'); expect(first.status).toBe(202);
  await quota.processingComplete(first.body.photo_ids[0]);
  expect((await attach(galleryRequest(), 'photos')).status).toBe(202);
  expect(await db('public_upload_objects').where({ pending: 0 })).toHaveLength(1);
  expect(await db('public_upload_objects')).toHaveLength(2);
});
test('a settled transfer PUT followed by row failure is compensated and releases its object charge', async () => {
  jest.spyOn(transferService, 'addUpload').mockRejectedValueOnce(new Error('owned insert failure'));
  const res = await attach(transferRequest(), 'files');
  expect(res.status).toBe(500); expect(res.body.code).toBe('STORE_FAILED');
  expect(mockObjects.size).toBe(0); expect(await db('public_upload_objects')).toHaveLength(0);
});
test('a rejected PUT that wrote bytes remains charged even after best-effort deletion', async () => {
  mockStorage.putFromFile.mockImplementationOnce(async (key, file) => { mockObjects.set(key, fs.statSync(file).size); throw new Error('uncertain remote result'); });
  const res = await attach(transferRequest(), 'files'); expect(res.status).toBe(500);
  expect(await db('public_upload_objects').first()).toMatchObject({ bytes: 12, state: 'uncertain', pending: 1 });
});
test('failed object cleanup retains a charged tombstone', async () => {
  jest.spyOn(transferService, 'addUpload').mockRejectedValueOnce(new Error('owned insert failure'));
  mockStorage.delete.mockRejectedValueOnce(new Error('owned delete failure'));
  expect((await attach(transferRequest(), 'files')).status).toBe(500);
  expect(mockObjects.size).toBe(1);
  expect(await db('public_upload_objects').first()).toMatchObject({ bytes: 12, state: 'uncertain' });
});
test('byte-aware rate budget includes failed/skipped bodies without permanently reserving tiny successful requests', async () => {
  limits({ requestBytes: 4096, transfer: { hourBytes: 600 } });
  expect((await attach(transferRequest(), 'files')).status).toBe(201);
  const row = await db('public_upload_requests').first(); expect(Number(row.rate_bytes)).toBeGreaterThan(12); expect(Number(row.rate_bytes)).toBeLessThan(600);
  await db('public_upload_requests').where({ id: row.id }).update({ rate_bytes: 600 });
  const res = await attach(transferRequest(), 'files'); expect(res.status).toBe(429); expect(res.body.code).toBe('UPLOAD_BYTE_RATE_LIMIT');
});
test('low disk capacity refuses before body staging', async () => {
  jest.spyOn(fs.promises, 'statfs').mockResolvedValue({ bavail: 1, bsize: 4096, blocks: 1000 });
  const res = await attach(galleryRequest(), 'photos'); expect(res.status).toBe(507); expect(res.body.code).toBe('UPLOAD_STORAGE_LOW');
  expect(mockStorage.putFromFile).not.toHaveBeenCalled();
});
test('free bytes do not bypass inode headroom', async () => {
  jest.spyOn(fs.promises, 'statfs').mockResolvedValue({ bavail: 1000000, bsize: 4096, blocks: 2000000, ffree: 2 });
  const res = await attach(galleryRequest(), 'photos'); expect(res.status).toBe(507); expect(res.body.code).toBe('UPLOAD_STORAGE_LOW');
  expect(mockStorage.putFromFile).not.toHaveBeenCalled();
});
test('unsupported Node timer durations are rejected as invalid configuration', () => {
  limits({ requestTimeoutMs: 2147483648 });
  expect(() => quota.configuration()).toThrow('requestTimeoutMs');
});
test('cancellation before promotion does not create an object charge', async () => {
  const session = await quota.begin({ transferId: transfer, maxFiles: 1 }); session.isCancelled = () => true;
  await expect(quota.prepareObject(session, 'transfers/owned-cancel', 12)).rejects.toMatchObject({ code: 'UPLOAD_CANCELLED' });
  expect(await db('public_upload_objects')).toHaveLength(0); await quota.finish(session);
});
test('cancellation after a settled promotion refuses the row and compensates without dropping uncertain writes', async () => {
  const session = await quota.begin({ transferId: transfer, maxFiles: 1 });
  let cancelled = false; session.isCancelled = () => cancelled;
  const object = await quota.prepareObject(session, 'transfers/owned-cancel', 12); mockObjects.set(object.object_key, 12); cancelled = true;
  const writer = jest.fn(); await expect(quota.commitObject(object, 'transfer', writer)).rejects.toMatchObject({ code: 'UPLOAD_CANCELLED' });
  expect(writer).not.toHaveBeenCalled(); await quota.failedObject(object, { storage: mockStorage, settled: true });
  expect(mockObjects.size).toBe(0); expect(await db('public_upload_objects')).toHaveLength(0); await quota.finish(session);
});
test('invalid/disabled operator limits fail closed', async () => {
  limits({ deployment: { bytes: 0 } });
  const res = await attach(galleryRequest(), 'photos'); expect(res.status).not.toBe(202); expect(mockStorage.putFromFile).not.toHaveBeenCalled();
});
test('the transferred row rolls back if settlement fails after insertion', async () => {
  jest.spyOn(transferService, 'addUpload').mockImplementationOnce(async (id, fields, conn) => {
    await conn('transfer_uploads').insert({ transfer_id: id, original_filename: fields.originalFilename, stored_path: fields.storedPath, size_bytes: fields.sizeBytes });
    throw new Error('owned post-insert failure');
  });
  expect((await attach(transferRequest(), 'files')).status).toBe(500);
  expect(await db('transfer_uploads')).toHaveLength(0);
  expect(await db('public_upload_objects')).toHaveLength(0); expect(mockObjects.size).toBe(0);
});
test('a lost success acknowledgement never deletes an already committed original', async () => {
  const session = await quota.begin({ transferId: transfer, maxFiles: 1 });
  const object = await quota.prepareObject(session, 'transfers/owned-success', 12);
  mockObjects.set(object.object_key, 12);
  await quota.commitObject(object, 'transfer', conn => transferService.addUpload(transfer, {
    originalFilename: 'ordinary.jpg', storedPath: object.object_key, sizeBytes: 12, mimeType: 'image/jpeg',
  }, conn));
  await quota.failedObject(object, { storage: mockStorage, settled: true });
  expect(mockStorage.delete).not.toHaveBeenCalled(); expect(mockObjects.has(object.object_key)).toBe(true);
  await quota.finish(session);
});
// A request row as a process that no longer exists left it: this process
// never served it, so nothing here keeps its lease.
async function orphanRequest(fields) {
  const id = require('crypto').randomUUID();
  const dir = path.join(process.env.STORAGE_PATH, 'temp', 'public-uploads', id);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, 'owned-temp'), JPEG);
  await db('public_upload_requests').insert({ id, transfer_id: transfer, account_id: adminId, bytes: 4096, files: 1, rate_bytes: 4096, active: 1,
    host: 'owned-previous-container', pid: process.pid, created_at: '2000-01-01T00:00:00.000Z', ...fields });
  return { id, dir };
}
test('a request from another host whose heartbeat lapsed is reclaimed; its object charge stays', async () => {
  limits({ transfer: { requests: 1 } });
  // A recreated container has another hostname; a restarted one may reuse the pid.
  const orphan = await orphanRequest({ heartbeat_at: Date.now() - quota.STALE_MS - 1000, created_at: new Date(Date.now() - 3600000).toISOString() });
  await db('public_upload_objects').insert({ id: require('crypto').randomUUID(), request_id: orphan.id, object_key: 'transfers/owned-uncertain',
    bytes: 12, files: 1, transfer_id: transfer, account_id: adminId });
  await expect(quota.begin({ transferId: transfer, maxFiles: 1 })).rejects.toMatchObject({ code: 'UPLOAD_CONCURRENCY_LIMIT' });
  await quota.cleanupAbandoned();
  expect(await db('public_upload_requests').where({ id: orphan.id }).first()).toMatchObject({ active: 0, files: 0 });
  expect(fs.existsSync(orphan.dir)).toBe(false);
  expect(await db('public_upload_objects').first()).toMatchObject({ bytes: 12, state: 'promoting' });
  // The slot it held is free again, including through the upload route.
  expect((await attach(transferRequest(), 'files')).status).toBe(201);
});
test('a fresh heartbeat from another host is not reclaimed', async () => {
  const orphan = await orphanRequest({ host: 'owned-other-replica', heartbeat_at: Date.now() - 60000 });
  await quota.cleanupAbandoned();
  expect(await db('public_upload_requests').where({ id: orphan.id }).first()).toMatchObject({ active: 1, files: 1 });
  expect(fs.existsSync(orphan.dir)).toBe(true);
  await fs.promises.rm(orphan.dir, { recursive: true });
});
test('the heartbeat renews the lease of a request this process is still serving', async () => {
  const session = await quota.begin({ transferId: transfer, maxFiles: 1 });
  const stale = Date.now() - quota.STALE_MS - 1000;
  await db('public_upload_requests').where({ id: session.id }).update({ heartbeat_at: stale });
  // Even with a lapsed lease (a stalled database), its own process never reaps it.
  await quota.cleanupAbandoned();
  expect(await db('public_upload_requests').where({ id: session.id }).first()).toMatchObject({ active: 1 });
  await quota.heartbeat();
  expect(Number((await db('public_upload_requests').where({ id: session.id }).first()).heartbeat_at)).toBeGreaterThan(stale + quota.STALE_MS);
  await quota.finish(session);
});
test('a staging-cleanup failure keeps its capacity and simultaneous-upload slot', async () => {
  const session = await quota.begin({ eventId: event.id, maxFiles: 1 });
  const realRm = fs.promises.rm;
  jest.spyOn(fs.promises, 'rm').mockImplementation(async (target, options) => {
    if (target === session.dir) throw new Error('owned staging cleanup failure');
    return realRm(target, options);
  });
  expect(await quota.finish(session)).toBe(false);
  expect(await db('public_upload_requests').where({ id: session.id }).first()).toMatchObject({ active: 1, bytes: session.bytes });
  jest.restoreAllMocks(); await quota.finish(session);
});
test('unsupported transfer parts cannot bypass the raw body ceiling', async () => {
  limits({ requestBytes: MiB }); await setting('transfer_max_upload_size_mb', 1);
  const unknown = size => transferRequest().attach('files', Buffer.alloc(size), { filename: 'owned.unknown', contentType: 'application/x-owned' });
  const small = await (async () => {
    if (!(await db.schema.hasColumn('transfers', 'kind'))) return unknown(12);
    await db('app_settings').where({ setting_key: 'transfer_upload_accept_all' }).update({ setting_value: 'false' });
    expect((await require('../../src/services/transferUploadPolicy').getTransferUploadPolicy()).acceptAll).toBe(false);
    return unknown(12);
  })();
  // The refusal names the reason on either branch, never a generic failure.
  expect(small.status).toBe(400);
  expect(small.body.code === 'TYPE_REJECTED' || small.body.error === 'This file type is not allowed').toBe(true);
  const res = await unknown(3 * MiB); expect(res.status).toBe(413); expect(res.body.code).toBe('UPLOAD_REQUEST_TOO_LARGE');
  await waitSettled(); expect(mockStorage.putFromFile).not.toHaveBeenCalled();
});

test('only public uploads are charged: 5000 photographer photos leave the guest allowance untouched', async () => {
  limits({ gallery: { files: 3, bytes: 4096 }, account: { files: 3, bytes: 4096 } });
  for (let n = 0; n < 5000; n += 100) {
    await db('photos').insert(Array.from({ length: 100 }, (_, i) => photoRow(n + i, { uploaded_by: 'admin' })));
  }
  await db('events').where({ id: event.id }).update({ archive_path: 'archives/owned.zip', archive_size: 50 * MiB });
  const res = await attach(galleryRequest(), 'photos');
  expect(res.status).toBe(202); expect(res.body.count).toBe(1);
});
test('guest uploads that predate the ledger still count toward the gallery allowance', async () => {
  limits({ gallery: { files: 2 } });
  await db('photos').insert([photoRow(1, { uploaded_by: 'guest' }), photoRow(2, { uploaded_by: 'guest' })]);
  const res = await attach(galleryRequest(), 'photos');
  expect(res.status).toBe(429); expect(res.body.code).toBe('UPLOAD_LIFETIME_LIMIT');
  expect(mockStorage.putFromFile).not.toHaveBeenCalled();
});
test('file-request uploads that predate the ledger still count toward that request', async () => {
  limits({ transfer: { files: 1 } });
  await db('transfer_uploads').insert({ transfer_id: transfer, original_filename: 'old.jpg', stored_path: 'transfers/old', size_bytes: 12 });
  const res = await attach(transferRequest(), 'files');
  expect(res.status).toBe(429); expect(res.body.code).toBe('UPLOAD_LIFETIME_LIMIT');
});
test('defaults fit a real event, and overrides accept any positive integer', () => {
  delete process.env.PUBLIC_UPLOAD_LIMITS_JSON;
  const GiB = 1024 * MiB;
  expect(quota.configuration()).toMatchObject({
    gallery: { bytes: 50 * GiB, files: 20000, requests: 16, hourBytes: 20 * GiB },
    guest: { bytes: 50 * GiB, files: 20000, requests: 16, hourBytes: 20 * GiB },
    account: { bytes: 500 * GiB, files: 200000 },
    deployment: { bytes: Number.MAX_SAFE_INTEGER, files: Number.MAX_SAFE_INTEGER },
  });
  expect(quota.configuration().gallery.hourRequests).toBeUndefined();
  limits({ gallery: { bytes: 4096 * GiB } });
  expect(quota.configuration().gallery.bytes).toBe(4096 * GiB);
});
test('the guest UI pattern, one file per request, is not rate limited by request count', async () => {
  for (let n = 0; n < 130; n++) await quota.finish(await quota.begin({ eventId: event.id, clientKey: '203.0.113.7', maxFiles: 1, declaredBytes: 512 }));
  expect((await attach(galleryRequest(), 'photos')).status).toBe(202);
});
test('anonymous guests are bucketed by client network, not together', async () => {
  limits({ guest: { requests: 1 } });
  const first = await quota.begin({ eventId: event.id, clientKey: '203.0.113.7', maxFiles: 1 });
  expect(first.guest_scope).toBe(`${event.id}:ip:203.0.113.7`);
  const other = await quota.begin({ eventId: event.id, clientKey: '198.51.100.9', maxFiles: 1 });
  await expect(quota.begin({ eventId: event.id, clientKey: '203.0.113.7', maxFiles: 1 })).rejects.toMatchObject({ code: 'UPLOAD_CONCURRENCY_LIMIT' });
  await quota.finish(first); await quota.finish(other);
});
test('a single file of the configured maximum always fits the request ceiling', async () => {
  expect(await quota.requestBudget()).toBe(95 * MiB);
  expect(await quota.requestBudget(50 * MiB)).toBe(95 * MiB);
  expect(await quota.requestBudget(500 * MiB)).toBe(501 * MiB);
  const session = await quota.begin({ transferId: transfer, maxFiles: 25, maxFileBytes: 500 * MiB, declaredBytes: 400 * MiB });
  expect(session.bytes).toBe(400 * MiB);
  await quota.finish(session);
  await expect(quota.begin({ transferId: transfer, maxFiles: 25, maxFileBytes: 500 * MiB, declaredBytes: 502 * MiB }))
    .rejects.toMatchObject({ code: 'UPLOAD_REQUEST_TOO_LARGE', status: 413 });
});
test('the file-request page is told the per-request byte budget', async () => {
  await setting('transfer_max_upload_size_mb', 300);
  const res = await request(transferApp).get(`/api/public/transfer-upload/${token}`);
  expect(res.status).toBe(200);
  expect(res.body.transfer).toMatchObject({ max_size_mb: 300, max_files: 25, max_request_bytes: 301 * MiB });
});
test('a request reserves what it declares: its Content-Length and one file, growing per file part', async () => {
  const session = await quota.begin({ transferId: transfer, maxFiles: 25, declaredBytes: 4096 });
  expect(session).toMatchObject({ bytes: 4096, files: 1, maxFiles: 25 });
  expect(await db('public_upload_requests').where({ id: session.id }).first()).toMatchObject({ bytes: 4096, files: 1 });
  await quota.reserveFile(session); await quota.reserveFile(session); await quota.reserveFile(session);
  expect(await db('public_upload_requests').where({ id: session.id }).first()).toMatchObject({ files: 3 });
  await quota.finish(session);
  const res = await attach(attach(attach(transferRequest(), 'files', 12, 'a.jpg'), 'files', 12, 'b.jpg'), 'files', 12, 'c.jpg');
  expect(res.status).toBe(201); expect(res.body.uploaded).toBe(3);
});
test('a file part beyond the remaining allowance refuses the request before anything is promoted', async () => {
  limits({ transfer: { files: 2 } });
  const res = await attach(attach(attach(transferRequest(), 'files', 12, 'a.jpg'), 'files', 12, 'b.jpg'), 'files', 12, 'c.jpg');
  expect(res.status).toBe(429); expect(res.body.code).toBe('UPLOAD_LIFETIME_LIMIT');
  await waitSettled(); expect(mockStorage.putFromFile).not.toHaveBeenCalled();
});
test('validation refusals keep their specific message; unexpected errors stay generic', async () => {
  const type = await galleryRequest().attach('photos', JPEG, { filename: 'owned.exe', contentType: 'application/x-msdownload' });
  expect(type.status).toBe(400); expect(type.body).toMatchObject({ error: 'Invalid file type', code: 'UPLOAD_REJECTED' });
  galleryFileMax(8);
  const large = await attach(galleryRequest(), 'photos', 64);
  expect(large.status).toBe(400); expect(large.body.error).toBe('File too large. Maximum size is 0 MB per file.');
  jest.restoreAllMocks();
  jest.spyOn(require('../../src/services/uploadSettings'), 'getMaxFilesPerUpload').mockResolvedValue(1);
  const many = await attach(attach(galleryRequest(), 'photos', 12, 'a.jpg'), 'photos', 12, 'b.jpg');
  expect(many.status).toBe(400); expect(many.body.error).toBe('Too many files');
  jest.restoreAllMocks();
  jest.spyOn(fs, 'createWriteStream').mockImplementationOnce(() => { throw new Error('/app/storage/owned-secret-path'); });
  const broken = await attach(galleryRequest(), 'photos');
  expect(broken.status).toBe(400); expect(broken.body.error).toBe('Upload failed');
  await waitSettled();
});
