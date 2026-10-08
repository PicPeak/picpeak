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
  mockObjects.clear(); jest.clearAllMocks();
  limits({});
  await db('app_settings').where({ setting_key: 'general_max_upload_batch_size_mb' }).update({ setting_value: '95' });
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
  expect(object.guest_scope).toBe(`${event.id}:anonymous`);
  expect(await db('public_upload_requests').where({ active: 1 })).toHaveLength(0);
});
test('ordinary reusable file-request upload retains the existing response and byte metadata', async () => {
  const res = await attach(transferRequest(), 'files');
  expect(res.status).toBe(201); expect(res.body.uploaded).toBe(1);
  expect(await db('public_upload_objects').first()).toMatchObject({ bytes: 12, reference_type: 'transfer', state: 'stored', pending: 0 });
});
test('gallery rejects the reproduced above-batch body before any durable promotion', async () => {
  await db('app_settings').where({ setting_key: 'general_max_upload_batch_size_mb' }).update({ setting_value: '1' });
  const res = await attach(attach(galleryRequest(), 'photos', 600 * 1024, 'first.jpg'), 'photos', 600 * 1024, 'second.jpg');
  expect(res.status).toBe(413); expect(res.body.code).toBe('UPLOAD_REQUEST_TOO_LARGE');
  await waitSettled();
  expect(mockStorage.putFromFile).not.toHaveBeenCalled();
  expect(await db('photos')).toHaveLength(0);
  expect(await fs.promises.readdir(path.join(process.env.STORAGE_PATH, 'temp', 'public-uploads'))).toEqual([]);
});
test('transfer rejects the same above-batch body', async () => {
  limits({ requestBytes: 1024 * 1024 });
  const res = await attach(attach(transferRequest(), 'files', 600 * 1024, 'first.jpg'), 'files', 600 * 1024, 'second.jpg');
  expect(res.status).toBe(413); await waitSettled();
  expect(mockStorage.putFromFile).not.toHaveBeenCalled();
});
test('chunked multipart without Content-Length stops while the sender still has more bytes', async () => {
  limits({ requestBytes: 4096 });
  const server = http.createServer(galleryApp); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const auth = jwt.sign({ eventId: event.id, eventSlug: event.slug, type: 'gallery' }, process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' });
  let sent = 0; let interval;
  try {
    const result = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: `/api/gallery/${event.id}/upload`, headers: {
        Authorization: `Bearer ${auth}`, 'Content-Type': 'multipart/form-data; boundary=owned-boundary',
      } }, res => { let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) })); });
      req.on('error', err => { if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') reject(err); });
      req.write('--owned-boundary\r\nContent-Disposition: form-data; name="photos"; filename="chunked.jpg"\r\nContent-Type: image/jpeg\r\n\r\n');
      interval = setInterval(() => { sent += 1024; req.write(largeJPEG(1024)); if (sent >= 64 * 1024) { clearInterval(interval); req.end('\r\n--owned-boundary--\r\n'); } }, 5);
    });
    expect(result.status).toBe(413); expect(result.body.code).toBe('UPLOAD_REQUEST_TOO_LARGE'); expect(sent).toBeLessThan(64 * 1024);
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
test('pending work is not freed by deleting, hiding or failing a photo row', async () => {
  limits({ guest: { pendingFiles: 1 } });
  expect((await attach(galleryRequest(), 'photos')).status).toBe(202);
  await db('photos').del();
  const res = await attach(galleryRequest(), 'photos');
  expect(res.status).toBe(429); expect(res.body.code).toBe('UPLOAD_PENDING_LIMIT');
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
test('zero-byte rejected requests cannot grow the ledger past its hourly count ceiling', async () => {
  limits({ deployment: { hourRequests: 1 } });
  const first = await transferRequest().set('Content-Type', 'application/octet-stream').send('');
  expect(first.status).toBe(400);
  await waitSettled();
  expect(Number((await db('public_upload_requests').first()).rate_bytes)).toBe(0);
  const second = await transferRequest().set('Content-Type', 'application/octet-stream').send('');
  expect(second.status).toBe(429); expect(second.body.code).toBe('UPLOAD_REQUEST_RATE_LIMIT');
  expect(await db('public_upload_requests')).toHaveLength(1);
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
test('a live producer is not age-reaped, but a confirmed-dead local producer loses only its staging hold', async () => {
  const session = await quota.begin({ transferId: transfer, maxFiles: 1 });
  const object = await quota.prepareObject(session, 'transfers/owned-uncertain', 12);
  await fs.promises.writeFile(path.join(session.dir, 'owned-temp'), JPEG);
  await db('public_upload_requests').where({ id: session.id }).update({ created_at: '2000-01-01T00:00:00.000Z' });
  await quota.cleanupAbandoned();
  expect(fs.existsSync(session.dir)).toBe(true);
  await db('public_upload_requests').where({ id: session.id }).update({ pid: 2147483647 });
  await quota.cleanupAbandoned();
  expect(fs.existsSync(session.dir)).toBe(false);
  expect(await db('public_upload_objects').where({ id: object.id }).first()).toMatchObject({ bytes: 12, state: 'promoting' });
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
test('unsupported transfer parts cannot bypass the raw body ceiling on either branch', async () => {
  limits({ requestBytes: 4096 });
  if (await db.schema.hasColumn('transfers', 'kind')) {
    await db('app_settings').where({ setting_key: 'transfer_upload_accept_all' }).update({ setting_value: 'false' });
    expect((await require('../../src/services/transferUploadPolicy').getTransferUploadPolicy()).acceptAll).toBe(false);
    const skipped = await transferRequest().attach('files', JPEG, { filename: 'owned.unknown', contentType: 'application/x-owned' });
    expect(skipped.status).toBe(400); expect(skipped.body.code).toBe('TYPE_REJECTED');
  }
  const res = await transferRequest().attach('files', Buffer.alloc(8192), { filename: 'owned.unknown', contentType: 'application/x-owned' });
  expect(res.status).toBe(413); await waitSettled(); expect(mockStorage.putFromFile).not.toHaveBeenCalled();
});
