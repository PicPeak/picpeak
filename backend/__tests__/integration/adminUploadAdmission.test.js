const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');
const { admissionVideo } = require('../fixtures/admissionVideo');
// The unrelated ZIP warm-up timer is not an upload boundary or storage sink.
jest.mock('../../src/services/downloadZipService', () => ({ invalidate: jest.fn() }));

let db, cleanup, app, eventId, token, apiToken, settings, jpeg, storage, quota, stagedBytes;
const chunkUploads = new Set();
const originalLimits = process.env.ADMIN_UPLOAD_LIMITS_JSON;
const GiB = 1024 * 1024 * 1024;
// 4 TiB free of 8 TiB: admission outcomes must not depend on the CI disk.
const disk = (freeBytes = 4096 * GiB) => jest.spyOn(fs.promises, 'statfs')
  .mockResolvedValue({ bavail: Math.floor(freeBytes / 4096), bsize: 4096, blocks: 2 * 1024 * 1024 * 1024, ffree: 100000000 });
const idOf = rows => rows[0]?.id || rows[0];
const setting = (key, value) => db('app_settings').insert({
  setting_key: key, setting_value: JSON.stringify(value), setting_type: 'general',
}).onConflict('setting_key').merge({ setting_value: JSON.stringify(value) });
const upload = (alias = 'photos', id = eventId) => request(app).post(`/api/admin/${alias}/${id}/upload`).set('Authorization', `Bearer ${token}`);
const image = bytes => Buffer.concat([jpeg, Buffer.alloc(Math.max(0, bytes - jpeg.length))]);
const attach = (req, bytes, filename = 'control.jpg', contentType = 'image/jpeg') => req.attach('photos', bytes, { filename, contentType });
async function waitSettled() {
  for (let n = 0; n < 100; n++) {
    if (!(await db('public_upload_requests').where({ active: 1 }).first())) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Admission was not settled');
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  const { adminId } = await seedMinimal(db);
  const roleId = idOf(await db('roles').insert({ name: 'scoped_admission', display_name: 'Scoped admission', description: 'Owned uploads only' }).returning('id'));
  const permission = await db('permissions').where({ name: 'photos.upload' }).first();
  await db('role_permissions').insert({ role_id: roleId, permission_id: permission.id });
  await db('admin_users').where({ id: adminId }).update({ role_id: roleId, is_active: 1 });
  eventId = idOf(await db('events').insert({
    slug: 'admin-admission', event_type: 'wedding', event_name: 'Admission', event_date: '2026-10-08',
    host_email: 'host@fixture.invalid', admin_email: 'admin@fixture.invalid', password_hash: 'x', share_link: '/gallery/admin-admission/share',
    expires_at: new Date(Date.now() + 3600000).toISOString(), is_active: 1, is_archived: 0, created_by: adminId,
  }).returning('id'));
  token = jwt.sign({ id: adminId, username: 'tester', type: 'admin', loginTime: Date.now() }, process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' });
  settings = require('../../src/services/uploadSettings');
  storage = require('../../src/services/storage').getStorage();
  quota = require('../../src/services/publicUploadQuota');
  const router = require('../../src/routes/adminPhotos');
  app = express(); app.use(express.json()); app.use('/api/admin/photos', router); app.use('/api/admin/events', router);
  const issued = require('../../src/middleware/apiTokenAuth').generateApiToken();
  await db('api_tokens').insert({ name: 'Owned admission', hashed_token: issued.hashed, scopes: 'write', created_by: adminId });
  apiToken = issued.plaintext;
  app.use('/api/v1', require('../../src/routes/v1/events'));
  jpeg = await require('sharp')({ create: { width: 16, height: 16, channels: 3, background: 'white' } }).jpeg().toBuffer();
}, 120000);
beforeEach(async () => {
  await db('public_upload_objects').del(); await db('public_upload_requests').del(); await db('photos').del();
  process.env.ADMIN_UPLOAD_LIMITS_JSON = '{}'; delete process.env.PUBLIC_UPLOAD_LIMITS_JSON;
  await setting('general_max_file_size_mb', 4); await setting('general_max_video_size_mb', 8);
  await setting('general_max_upload_batch_size_mb', 95);
  await setting('general_allowed_file_types', 'jpg,jpeg,png,webp,mp4,mov,avi,webm');
  settings.clearMaxFileSizeCache(); settings.clearMaxVideoSizeCache(); settings.clearAllowedTypesCache();
  stagedBytes = 0;
  const create = fs.createWriteStream;
  jest.spyOn(fs, 'createWriteStream').mockImplementation(function(file, options) {
    const stream = create.call(this, file, options);
    stream.once('close', () => {
      if (String(file).includes(path.join('temp', 'public-uploads'))) stagedBytes += stream.bytesWritten;
    });
    return stream;
  });
  jest.spyOn(storage, 'putFromFile');
});
afterEach(async () => {
  const chunks = require('../../src/services/chunkedUploadService');
  for (const id of chunkUploads) await chunks.abortUpload(id);
  chunkUploads.clear();
  await waitSettled(); jest.restoreAllMocks();
});
afterAll(async () => {
  require('../../src/services/chunkedUploadService').stop();
  if (originalLimits === undefined) delete process.env.ADMIN_UPLOAD_LIMITS_JSON; else process.env.ADMIN_UPLOAD_LIMITS_JSON = originalLimits;
  if (cleanup) await cleanup();
});

test.each(['photos', 'events'])('ordinary scoped JPEG through the %s alias preserves pending-row response and actual storage', async alias => {
  const res = await attach(upload(alias), jpeg);
  expect(res.status).toBe(202); expect(res.body.count).toBe(1);
  const photo = await db('photos').where({ id: res.body.photo_ids[0] }).first();
  expect(photo.processing_status).toBe('pending');
  expect(await storage.stat('events/active/' + photo.path)).toMatchObject({ size: jpeg.length });
  // Recorded while it was staged, charged to nothing once stored: no ledger
  // row survives, so a photo that later fails processing holds nothing either.
  expect(await db('public_upload_objects')).toHaveLength(0);
  expect(await db('public_upload_requests').first()).toMatchObject({ upload_kind: 'admin', active: 0, bytes: 0, rate_bytes: 0 });
});
test('a multipart body above the request ceiling is refused from its declared length, before anything is staged', async () => {
  await setting('general_max_upload_batch_size_mb', 1);
  // Ceiling: the larger of the batch setting and one maximum (8 MB video) file.
  let req = upload();
  for (const name of ['a.jpg', 'b.jpg', 'c.jpg']) req = attach(req, image(4 * 1024 * 1024 - 1024), name);
  const res = await req;
  expect(res.status).toBe(413); expect(res.body.code).toBe('UPLOAD_REQUEST_TOO_LARGE');
  expect(res.body.error).not.toMatch(/gallery owner/);
  await waitSettled(); expect(stagedBytes).toBe(0);
  expect(storage.putFromFile).not.toHaveBeenCalled(); expect(await db('photos')).toHaveLength(0);
});
test('an image cannot be fully staged up to the larger video ceiling', async () => {
  await setting('general_max_file_size_mb', 1); settings.clearMaxFileSizeCache();
  const res = await attach(upload(), image(2 * 1024 * 1024));
  expect(res.status).toBe(400); expect(res.body.code).toBe('UPLOAD_FILE_TOO_LARGE');
  expect(res.body.error).toBe('File too large. Maximum size is 1 MB per file.');
  await waitSettled(); expect(stagedBytes).toBeLessThanOrEqual(1024 * 1024); expect(storage.putFromFile).not.toHaveBeenCalled();
});
test('a HEIF ftyp disguised as MP4 is refused before staging its larger body', async () => {
  const b = Buffer.alloc(2 * 1024 * 1024);
  b.writeUInt32BE(20); b.write('ftyp', 4); b.write('isom', 8); b.write('heic', 16);
  const res = await attach(upload(), b, 'disguised.mp4', 'video/mp4');
  expect(res.status).toBe(400); expect(res.body.code).toBe('UPLOAD_TYPE_REJECTED');
  await waitSettled(); expect(stagedBytes).toBe(0); expect(storage.putFromFile).not.toHaveBeenCalled();
});
test('an actual MP4 above the photo cap retains its configured video cap and pending response', async () => {
  await setting('general_max_file_size_mb', 1); settings.clearMaxFileSizeCache();
  const video = admissionVideo(2 * 1024 * 1024);
  const res = await attach(upload(), video, 'ordinary.mp4', 'video/mp4');
  expect(res.status).toBe(202); expect(res.body.count).toBe(1);
  expect(await db('photos').first()).toMatchObject({ mime_type: 'video/mp4', size_bytes: video.length, media_type: 'video' });
});
test('the defaults carry a 2000-photo wedding: no hourly, lifetime or per-gallery cap on authenticated uploads', async () => {
  disk();
  const limits = quota.configuration('admin');
  expect(limits).toEqual({ headroomBytes: 512 * 1024 * 1024, headroomPercent: 5, headroomFiles: 1024, requestTimeoutMs: 600000,
    stagedFiles: 50000, accountRequests: 16, requests: 64 });
  // 700 batches of 90 MiB in one hour: 61 GiB. The previous defaults stopped
  // at 10 GiB/hour, 600 requests/hour and 100 GiB per gallery.
  for (let n = 0; n < 700; n++) {
    const session = await quota.begin({ eventId, mode: 'admin', accountId: 1, maxFiles: 50, declaredBytes: 90 * 1024 * 1024 });
    await quota.finish(session);
  }
  expect(await db('public_upload_requests').where({ active: 1 })).toHaveLength(0);
}, 120000);
test('one resumable file of any allowed size is admitted when the disk has room, and refused only for disk space', async () => {
  disk();
  await setting('general_max_video_size_mb', 10240); settings.clearMaxVideoSizeCache();
  const init = await initChunk(9 * GiB, 'ceremony.mp4');
  expect(init.status).toBe(200);
  expect(await db('public_upload_requests').where({ active: 1 }).first()).toMatchObject({ bytes: 9 * GiB, files: 1, upload_kind: 'admin' });
  await require('../../src/services/chunkedUploadService').abortUpload(init.body.uploadId);
  // Even past the staged-bytes bound: a request that is alone always fits.
  process.env.ADMIN_UPLOAD_LIMITS_JSON = '{"stagedBytes":1048576}';
  expect((await initChunk(9 * GiB, 'ceremony.mp4')).status).toBe(200);
  for (const id of chunkUploads) await require('../../src/services/chunkedUploadService').abortUpload(id);
  fs.promises.statfs.mockRestore(); disk(20 * GiB);
  const low = await initChunk(9 * GiB, 'ceremony.mp4');
  expect(low.status).toBe(507); expect(low.body.code).toBe('UPLOAD_STORAGE_LOW');
  expect(low.body.error).toMatch(/disk space/); expect(low.body.error).not.toMatch(/gallery owner/);
});
test('what authenticated requests hold in staging together is bounded by a share of free disk, as a transient refusal', async () => {
  disk(); // a quarter of the free space is far above the 50 GiB ceiling
  const first = await quota.begin({ eventId, mode: 'admin', maxFiles: 1, requestedBytes: 30 * GiB });
  await expect(quota.begin({ eventId, mode: 'admin', maxFiles: 1, requestedBytes: 30 * GiB })).rejects.toMatchObject({ code: 'UPLOAD_PENDING_LIMIT', status: 429 });
  const second = await quota.begin({ eventId, mode: 'admin', maxFiles: 1, requestedBytes: 10 * GiB });
  await quota.finish(first); await quota.finish(second);
  fs.promises.statfs.mockRestore(); disk(1024 * GiB);
  process.env.ADMIN_UPLOAD_LIMITS_JSON = '{"stagedFiles":1}';
  const one = await quota.begin({ eventId, mode: 'admin', maxFiles: 5, declaredBytes: 1024 });
  await expect(quota.begin({ eventId, mode: 'admin', maxFiles: 5, declaredBytes: 1024 })).rejects.toMatchObject({ code: 'UPLOAD_PENDING_LIMIT' });
  await quota.finish(one);
});
test('concurrency is bounded per uploading account and per deployment', async () => {
  process.env.ADMIN_UPLOAD_LIMITS_JSON = JSON.stringify({ accountRequests: 1, requests: 2 });
  const mine = await quota.begin({ eventId, mode: 'admin', accountId: 7, maxFiles: 1, declaredBytes: 10 });
  await expect(quota.begin({ eventId, mode: 'admin', accountId: 7, maxFiles: 1, declaredBytes: 10 })).rejects.toMatchObject({ code: 'UPLOAD_CONCURRENCY_LIMIT' });
  const other = await quota.begin({ eventId, mode: 'admin', accountId: 8, maxFiles: 1, declaredBytes: 10 });
  await expect(quota.begin({ eventId, mode: 'admin', accountId: 9, maxFiles: 1, declaredBytes: 10 })).rejects.toMatchObject({ code: 'UPLOAD_CONCURRENCY_LIMIT' });
  await quota.finish(mine); await quota.finish(other);
});
test('authenticated uploads are neither charged to nor refused by the public allowance, and take no public slot', async () => {
  process.env.PUBLIC_UPLOAD_LIMITS_JSON = JSON.stringify({ gallery: { bytes: 2 * 1024 * 1024, files: 2, pendingFiles: 1, requests: 1 } });
  process.env.ADMIN_UPLOAD_LIMITS_JSON = '{"requests":1}';
  quota._legacyCache.clear();
  for (let n = 0; n < 3; n++) expect((await attach(upload(), image(1024 * 1024), `admin-${n}.jpg`)).status).toBe(202);
  expect(await db('photos').where({ processing_status: 'pending' })).toHaveLength(3);
  const held = await quota.begin({ eventId, mode: 'admin', maxFiles: 1, declaredBytes: 1024 });
  const guest = await quota.begin({ eventId, maxFiles: 1, declaredBytes: 1024 });
  expect(guest.upload_kind).toBe('public');
  await expect(quota.begin({ eventId, mode: 'admin', maxFiles: 1, declaredBytes: 1024 })).rejects.toMatchObject({ code: 'UPLOAD_CONCURRENCY_LIMIT' });
  await quota.finish(held); await quota.finish(guest);
});
test('a restart reclaims authenticated requests and resumable sessions by their lapsed heartbeat', async () => {
  process.env.ADMIN_UPLOAD_LIMITS_JSON = '{"requests":1}';
  const id = crypto.randomUUID();
  // What a killed process leaves: an active row, its chunks, a half promotion.
  await db('public_upload_requests').insert({ id, event_id: eventId, account_id: 1, bytes: 4096, files: 1, rate_bytes: 0, active: 1,
    host: 'gone', pid: process.pid, upload_kind: 'admin', heartbeat_at: Date.now() - quota.STALE_MS - 1000, created_at: new Date().toISOString() });
  await db('public_upload_objects').insert({ id: crypto.randomUUID(), request_id: id, object_key: 'events/active/none.jpg', bytes: 10, files: 1,
    event_id: eventId, upload_kind: 'admin', created_at: new Date().toISOString() });
  const dir = path.join(process.env.STORAGE_PATH, 'temp', 'public-uploads', id);
  fs.mkdirSync(path.join(dir, 'chunks'), { recursive: true }); fs.writeFileSync(path.join(dir, 'chunks', 'chunk_000000'), 'x');
  await expect(quota.begin({ eventId, mode: 'admin', maxFiles: 1, declaredBytes: 10 })).rejects.toMatchObject({ code: 'UPLOAD_CONCURRENCY_LIMIT' });
  await quota.cleanupAbandoned();
  expect(await db('public_upload_requests').where({ id }).first()).toMatchObject({ active: 0, bytes: 0 });
  expect(await db('public_upload_objects')).toHaveLength(0); expect(fs.existsSync(dir)).toBe(false);
  // A live session is kept by this process's heartbeat however old its row.
  const init = await initChunk(jpeg.length);
  await db('public_upload_requests').where({ active: 1 }).update({ heartbeat_at: Date.now() - quota.STALE_MS - 1000 });
  await quota.heartbeat(); await quota.cleanupAbandoned();
  expect(Number((await db('public_upload_requests').where({ active: 1 }).first()).heartbeat_at)).toBeGreaterThan(Date.now() - 5000);
  expect((await sendChunk(init.body.uploadId, jpeg)).status).toBe(200);
});
test('an abandoned resumable session releases its slot after fifteen idle minutes, not twenty-four hours', async () => {
  process.env.ADMIN_UPLOAD_LIMITS_JSON = '{"requests":1}';
  await setting('general_max_file_size_mb', 20); settings.clearMaxFileSizeCache();
  const chunks = require('../../src/services/chunkedUploadService');
  const init = await initChunk(chunks.CHUNK_SIZE + 10);
  expect((await sendChunk(init.body.uploadId, Buffer.alloc(10), 1)).status).toBe(200);
  const hold = await db('public_upload_requests').where({ active: 1 }).first();
  const now = Date.now();
  const clock = jest.spyOn(Date, 'now').mockReturnValue(now + chunks.ADMITTED_IDLE_MS - 60000);
  expect(await chunks.cleanupExpiredUploads()).toBe(0);
  expect(chunks.getUploadStatus(init.body.uploadId)).not.toBeNull();
  clock.mockReturnValue(now + chunks.ADMITTED_IDLE_MS + 60000);
  expect(await chunks.cleanupExpiredUploads()).toBe(1);
  clock.mockRestore();
  expect(chunks.getUploadStatus(init.body.uploadId)).toBeNull();
  expect(await db('public_upload_requests').where({ id: hold.id }).first()).toMatchObject({ active: 0 });
  expect(fs.existsSync(path.join(process.env.STORAGE_PATH, 'temp', 'public-uploads', hold.id))).toBe(false);
  expect((await initChunk(jpeg.length)).status).toBe(200);
});
test('a settled PUT followed by atomic row failure is compensated instead of orphaning an uncharged original', async () => {
  const commit = quota.commitObject;
  jest.spyOn(quota, 'commitObject').mockImplementationOnce(async (object, type, write) => commit(object, type, async conn => {
    await write(conn); throw new Error('Owned post-insert failure');
  }));
  const res = await attach(upload(), jpeg);
  expect(res.status).toBe(202); expect(res.body.count).toBe(0); expect(res.body.failureCount).toBe(1);
  expect(await db('photos')).toHaveLength(0); expect(await db('public_upload_objects')).toHaveLength(0);
  const key = storage.putFromFile.mock.calls[0][0]; expect(await storage.stat(key)).toBeNull();
});
test('invalid private operator limits fail closed before any staging writer', async () => {
  process.env.ADMIN_UPLOAD_LIMITS_JSON = '{"deployment":{"bytes":0}}';
  const res = await attach(upload(), jpeg);
  expect(res.status).toBe(503); expect(res.body.code).toBe('UPLOAD_QUOTA_UNAVAILABLE'); expect(stagedBytes).toBe(0);
});

test.each([
  { filename: 'ignored.bin', mime: 'application/x-owned', prefix: Buffer.alloc(20) },
  { filename: 'disguised.mp4', mime: 'video/mp4', prefix: Buffer.from('not-a-video-header!!') },
])('rejected $filename bodies cannot bypass the raw limit through Multer error draining', async ({ filename, mime, prefix }) => {
  process.env.ADMIN_UPLOAD_LIMITS_JSON = '{"requestBytes":4096}';
  // The ceiling still admits one maximum file plus framing: 2 MiB here.
  await setting('general_max_file_size_mb', 1); await setting('general_max_video_size_mb', 1);
  settings.clearMaxFileSizeCache(); settings.clearMaxVideoSizeCache();
  const total = 4 * 1024 * 1024;
  const http = require('http');
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let sent = 0; let interval;
  try {
    const result = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST',
        path: `/api/admin/photos/${eventId}/upload`, headers: {
          Authorization: `Bearer ${token}`, 'Content-Type': 'multipart/form-data; boundary=owned-drain',
        } }, res => {
        let body = ''; res.on('data', b => { body += b; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      });
      req.on('error', err => { if (!['EPIPE', 'ECONNRESET'].includes(err.code)) reject(err); });
      req.write(`--owned-drain\r\nContent-Disposition: form-data; name="photos"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`);
      req.write(prefix);
      interval = setInterval(() => {
        sent += 65536; req.write(Buffer.alloc(65536));
        if (sent >= total) { clearInterval(interval); req.end('\r\n--owned-drain--\r\n'); }
      }, 5);
    });
    expect(result.status).toBe(413); expect(result.body.code).toBe('UPLOAD_REQUEST_TOO_LARGE');
    expect(sent).toBeLessThanOrEqual(total);
  } finally { clearInterval(interval); await new Promise(resolve => server.close(resolve)); }
  await waitSettled(); expect(storage.putFromFile).not.toHaveBeenCalled();
});

const v1Upload = () => request(app).post(`/api/v1/events/${eventId}/photos`).set('Authorization', `Bearer ${apiToken}`);
const attachV1 = (req, bytes = jpeg, filename = 'api-control.jpg') => req.attach('photo', bytes, { filename, contentType: 'image/jpeg' });
const initChunk = async (fileSize, filename = 'chunk-control.jpg', alias = 'photos', id = eventId) => {
  const res = await request(app).post(`/api/admin/${alias}/${id}/chunked-upload/init`)
    .set('Authorization', `Bearer ${token}`).send({ filename, fileSize });
  if (res.body.uploadId) chunkUploads.add(res.body.uploadId);
  return res;
};
const sendChunk = (id, bytes, index = 0) => request(app).post(`/api/admin/photos/${eventId}/chunked-upload/${id}/chunk/${index}`)
  .set('Authorization', `Bearer ${token}`).set('Content-Type', 'application/octet-stream').send(bytes);
const completeChunk = id => request(app).post(`/api/admin/photos/${eventId}/chunked-upload/${id}/complete`)
  .set('Authorization', `Bearer ${token}`).send({});

test('a photos.upload-only principal can cancel only their own uncommitted admission without photo-delete permission', async () => {
  const init = await initChunk(jpeg.length);
  expect(init.status).toBe(200);
  const res = await request(app).delete(`/api/admin/photos/${eventId}/chunked-upload/${init.body.uploadId}`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(await db('public_upload_requests').where({ active: 1 })).toHaveLength(0);
  expect(storage.putFromFile).not.toHaveBeenCalled();
});
test.each(['photos', 'events'])('actual admitted chunk JPEG through %s preserves synchronous processing and settles its admission', async alias => {
  const init = await initChunk(jpeg.length, 'chunk-control.jpg', alias);
  expect(init.status).toBe(200);
  const hold = await db('public_upload_requests').where({ active: 1 }).first();
  expect(hold).toMatchObject({ bytes: jpeg.length, files: 1, upload_kind: 'admin', rate_bytes: 0 });
  expect((await sendChunk(init.body.uploadId, jpeg)).status).toBe(200);
  const res = await completeChunk(init.body.uploadId);
  expect(res.status).toBe(200); expect(res.body.uploaded).toBe(1);
  await waitSettled();
  const photo = await db('photos').where({ id: res.body.photos[0].id }).first();
  expect(photo).toMatchObject({ size_bytes: jpeg.length, processing_status: 'complete', mime_type: 'image/jpeg' });
  expect(await storage.stat('events/active/' + photo.path)).toMatchObject({ size: jpeg.length });
  expect(await db('public_upload_objects')).toHaveLength(0);
  expect(await db('public_upload_requests')).toHaveLength(1);
});
test('chunk init keeps image and video ceilings distinct and shares admission with multipart', async () => {
  await setting('general_max_file_size_mb', 1); settings.clearMaxFileSizeCache();
  expect((await initChunk(2 * 1024 * 1024)).status).toBe(400);
  expect(await db('public_upload_requests')).toHaveLength(0);
  process.env.ADMIN_UPLOAD_LIMITS_JSON = '{"requests":1}';
  const init = await initChunk(2 * 1024 * 1024, 'ordinary.mp4');
  expect(init.status).toBe(200);
  expect((await attach(upload(), jpeg)).body.code).toBe('UPLOAD_CONCURRENCY_LIMIT');
  expect((await initChunk(jpeg.length)).body.code).toBe('UPLOAD_CONCURRENCY_LIMIT');
  expect(storage.putFromFile).not.toHaveBeenCalled();
});
test('HEIF renamed MP4 cannot bank bytes at the video ceiling through chunks', async () => {
  const disguised = Buffer.alloc(2 * 1024 * 1024);
  disguised.writeUInt32BE(20); disguised.write('ftyp', 4); disguised.write('isom', 8); disguised.write('heic', 16);
  const init = await initChunk(disguised.length, 'disguised.mp4');
  const res = await sendChunk(init.body.uploadId, disguised);
  expect(res.status).toBe(400); expect(res.body.code).toBe('UPLOAD_TYPE_REJECTED');
  expect(stagedBytes).toBe(0); expect(storage.putFromFile).not.toHaveBeenCalled();
  expect(require('../../src/services/chunkedUploadService').getUploadStatus(init.body.uploadId).receivedChunks).toBe(0);
});
test('video chunk zero must classify before later indices, but ordinary out-of-order image chunks remain supported', async () => {
  await setting('general_max_file_size_mb', 20); await setting('general_max_video_size_mb', 20);
  settings.clearMaxFileSizeCache(); settings.clearMaxVideoSizeCache();
  const chunks = require('../../src/services/chunkedUploadService');
  const video = await initChunk(chunks.CHUNK_SIZE + 10, 'ordered.mp4');
  expect((await sendChunk(video.body.uploadId, Buffer.alloc(10), 1)).status).toBe(409);
  expect(stagedBytes).toBe(0);
  const photo = await initChunk(chunks.CHUNK_SIZE + 10);
  expect((await sendChunk(photo.body.uploadId, Buffer.alloc(10), 1)).status).toBe(200);
});
test('every chunk and re-sent chunk of one resumable session is the same single active request', async () => {
  process.env.ADMIN_UPLOAD_LIMITS_JSON = '{"accountRequests":1}';
  await setting('general_max_file_size_mb', 40); settings.clearMaxFileSizeCache();
  const chunks = require('../../src/services/chunkedUploadService');
  const init = await initChunk(2 * chunks.CHUNK_SIZE + 10);
  for (const [index, bytes] of [[0, chunks.CHUNK_SIZE], [0, chunks.CHUNK_SIZE], [1, chunks.CHUNK_SIZE], [2, 10], [2, 10]]) {
    expect((await sendChunk(init.body.uploadId, Buffer.alloc(bytes), index)).status).toBe(200);
  }
  expect(chunks.getUploadStatus(init.body.uploadId).receivedChunks).toBe(3);
  const requests = await db('public_upload_requests');
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ active: 1, rate_bytes: 0, bytes: 2 * chunks.CHUNK_SIZE + 10 });
  // The session, not its chunks, is what holds the account's one slot.
  const refused = await initChunk(jpeg.length);
  expect(refused.status).toBe(429); expect(refused.body.code).toBe('UPLOAD_CONCURRENCY_LIMIT');
  expect(refused.body.error).not.toMatch(/gallery owner/);
});
test('chunk identity refuses nondecimal event and chunk indices instead of truncating into another scope', async () => {
  expect((await initChunk(jpeg.length, 'control.jpg', 'photos', `${eventId}e0`)).status).toBe(404);
  expect(await db('public_upload_requests')).toHaveLength(0);
  const init = await initChunk(jpeg.length, 'control.jpg', 'photos', `000${eventId}`);
  expect(init.status).toBe(200);
  expect((await sendChunk(init.body.uploadId, jpeg, '0suffix')).status).toBe(400);
  expect(stagedBytes).toBe(0);
});
test.each(['abort', 'expiry'])('%s cannot release a reservation or unlink ahead of a pending native file open and close', async operation => {
  process.env.ADMIN_UPLOAD_LIMITS_JSON = '{"requests":1}';
  const init = await initChunk(jpeg.length);
  const hold = await db('public_upload_requests').where({ active: 1 }).first();
  const chunks = require('../../src/services/chunkedUploadService');
  let releaseOpen, opened;
  const openStarted = new Promise(resolve => { opened = resolve; });
  const create = fs.createWriteStream;
  fs.createWriteStream.mockImplementationOnce((filename, options) => create(filename, { ...options, fs: {
    open: (...args) => {
      const callback = args.pop();
      fs.open(...args, (err, fd) => { releaseOpen = () => callback(err, fd); opened(); });
    }, write: fs.write, writev: fs.writev, close: fs.close,
  } }));
  const source = new (require('stream').PassThrough)();
  const writing = chunks.uploadChunk(init.body.uploadId, 0, source).then(value => ({ value }), error => ({ error }));
  source.end(jpeg);
  await openStarted;
  let released = false;
  if (operation === 'expiry') jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 25 * 3600000);
  const aborting = (operation === 'expiry' ? chunks.cleanupExpiredUploads() : chunks.abortUpload(init.body.uploadId))
    .then(() => { released = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(released).toBe(false);
    expect(await db('public_upload_requests').where({ id: hold.id }).first()).toMatchObject({ active: 1, bytes: jpeg.length });
    await expect(quota.begin({ mode: 'admin', eventId, maxFiles: 1 })).rejects.toMatchObject({ code: 'UPLOAD_CONCURRENCY_LIMIT' });
  } finally { releaseOpen(); }
  expect((await writing).error.code).toBe('UPLOAD_CANCELLED');
  await aborting;
  const finished = await db('public_upload_requests').where({ id: hold.id }).first();
  if (operation === 'expiry') expect(finished).toBeUndefined(); // ordinary inactive >24h rate-row pruning
  else expect(finished).toMatchObject({ active: 0, bytes: 0 });
  expect(fs.existsSync(path.join(process.env.STORAGE_PATH, 'temp', 'public-uploads', hold.id))).toBe(false);
});
test('overlapping chunk attempts are refused before opening another staging writer', async () => {
  const init = await initChunk(jpeg.length);
  const chunks = require('../../src/services/chunkedUploadService');
  const source = new (require('stream').PassThrough)();
  const writing = chunks.uploadChunk(init.body.uploadId, 0, source).then(value => ({ value }), error => ({ error }));
  await expect(chunks.uploadChunk(init.body.uploadId, 0, jpeg)).rejects.toMatchObject({ statusCode: 409 });
  source.end(jpeg);
  expect((await writing).value.complete).toBe(true);
  expect(await db('public_upload_requests')).toHaveLength(1);
});
test('abort during an actual original PUT holds capacity until synchronous processing settles and compensates the original', async () => {
  process.env.ADMIN_UPLOAD_LIMITS_JSON = '{"requests":1}';
  const init = await initChunk(jpeg.length);
  expect((await sendChunk(init.body.uploadId, jpeg)).status).toBe(200);
  let promoted, release;
  const reached = new Promise(resolve => { promoted = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  // Jest's spy calls the actual backend by default; retain its original by
  // restoring before installing this one controlled acknowledgement delay.
  storage.putFromFile.mockRestore();
  const actualPut = storage.putFromFile.bind(storage);
  jest.spyOn(storage, 'putFromFile').mockImplementation(async (...args) => {
    const result = await actualPut(...args); promoted(); await gate; return result;
  });
  const completing = completeChunk(init.body.uploadId).then(res => res);
  await reached;
  const hold = await db('public_upload_requests').where({ active: 1 }).first();
  const object = await db('public_upload_objects').first();
  expect(object.state).toBe('promoting');
  let aborted = false;
  const aborting = require('../../src/services/chunkedUploadService').abortUpload(init.body.uploadId).then(() => { aborted = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(aborted).toBe(false);
    expect(await db('public_upload_requests').where({ id: hold.id }).first()).toMatchObject({ active: 1 });
    await expect(quota.begin({ mode: 'admin', eventId, maxFiles: 1 })).rejects.toMatchObject({ code: 'UPLOAD_CONCURRENCY_LIMIT' });
  } finally { release(); }
  const res = await completing; expect(res.status).toBe(200); expect(res.body.uploaded).toBe(0);
  await aborting;
  expect(await db('photos')).toHaveLength(0); expect(await db('public_upload_objects')).toHaveLength(0);
  expect(await storage.stat(object.object_key)).toBeNull();
});
test('a stalled chunk body times out, closes its writer, retains its resumable admission and can be retried', async () => {
  process.env.ADMIN_UPLOAD_LIMITS_JSON = '{"requestTimeoutMs":40}';
  const init = await initChunk(jpeg.length);
  const chunks = require('../../src/services/chunkedUploadService');
  const source = new (require('stream').PassThrough)();
  const writing = chunks.uploadChunk(init.body.uploadId, 0, source).then(value => ({ value }), error => ({ error }));
  source.write(jpeg.subarray(0, 20));
  expect((await writing).error).toMatchObject({ statusCode: 408, code: 'UPLOAD_REQUEST_TIMEOUT' });
  expect(chunks.getUploadStatus(init.body.uploadId).receivedChunks).toBe(0);
  expect(await db('public_upload_requests').where({ active: 1 }).first()).toBeTruthy();
  expect((await sendChunk(init.body.uploadId, jpeg)).status).toBe(200);
});
test('resumed chunk receipt rechecks disk headroom before reading a body or starting another writer', async () => {
  const init = await initChunk(jpeg.length);
  jest.spyOn(fs.promises, 'statfs').mockResolvedValue({ bavail: 1, bsize: 4096, blocks: 1000000, ffree: 100000 });
  const res = await sendChunk(init.body.uploadId, jpeg);
  expect(res.status).toBe(507); expect(res.body.code).toBe('UPLOAD_STORAGE_LOW');
  expect(stagedBytes).toBe(0);
  fs.promises.statfs.mockRestore();
});
test('merge rechecks inode headroom and cannot leave an unreserved partial copy', async () => {
  const init = await initChunk(jpeg.length);
  expect((await sendChunk(init.body.uploadId, jpeg)).status).toBe(200);
  const hold = await db('public_upload_requests').where({ active: 1 }).first();
  jest.spyOn(fs.promises, 'statfs').mockResolvedValue({ bavail: 1000000, bsize: 4096, blocks: 1000000, ffree: 1 });
  const res = await completeChunk(init.body.uploadId);
  expect(res.status).toBe(507); expect(res.body.code).toBe('UPLOAD_STORAGE_LOW');
  expect(storage.putFromFile).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(process.env.STORAGE_PATH, 'temp', 'public-uploads', hold.id))).toBe(false);
  expect(await db('public_upload_requests').where({ active: 1 })).toHaveLength(0);
  fs.promises.statfs.mockRestore();
});
test('an actual admitted MP4 above the photo cap survives chunk merge and synchronous video processing', async () => {
  await setting('general_max_file_size_mb', 1); settings.clearMaxFileSizeCache();
  const bytes = admissionVideo(2 * 1024 * 1024);
  const init = await initChunk(bytes.length, 'chunk-video.mp4');
  expect(init.status).toBe(200);
  expect((await sendChunk(init.body.uploadId, bytes)).status).toBe(200);
  const res = await completeChunk(init.body.uploadId);
  expect(res.status).toBe(200); expect(res.body.uploaded).toBe(1);
  await waitSettled();
  expect(await db('photos').first()).toMatchObject({ media_type: 'video', mime_type: 'video/mp4', size_bytes: bytes.length, processing_status: 'complete' });
  expect(await db('public_upload_objects')).toHaveLength(0);
});
test('failed part cleanup makes the session nonretryable and failed abort cleanup keeps its claim and metadata', async () => {
  const init = await initChunk(jpeg.length);
  const chunks = require('../../src/services/chunkedUploadService');
  const remove = fs.promises.rm.bind(fs.promises);
  const denied = Object.assign(new Error('Owned cleanup failure'), { code: 'EACCES' });
  jest.spyOn(fs.promises, 'rm').mockImplementation((filename, options) => {
    if (String(filename).endsWith('incoming.part')) return Promise.reject(denied);
    return remove(filename, options);
  });
  const short = new (require('stream').PassThrough)();
  const writing = chunks.uploadChunk(init.body.uploadId, 0, short).then(value => ({ value }), error => ({ error }));
  short.end(jpeg.subarray(0, 10));
  expect((await writing).error.code).toBe('EACCES');
  expect(chunks.getUploadStatus(init.body.uploadId).status).toBe('failed');
  await expect(chunks.uploadChunk(init.body.uploadId, 0, jpeg)).rejects.toMatchObject({ statusCode: 409 });
  fs.promises.rm.mockImplementationOnce(() => Promise.reject(denied));
  await expect(chunks.abortUpload(init.body.uploadId)).rejects.toMatchObject({ statusCode: 503, code: 'UPLOAD_CLEANUP_UNAVAILABLE' });
  expect(chunks.getUploadStatus(init.body.uploadId)).not.toBeNull();
  expect(await db('public_upload_requests').where({ active: 1 })).toHaveLength(1);
  fs.promises.rm.mockRestore();
  expect(await chunks.abortUpload(init.body.uploadId)).toBe(true);
});
test('a rejected PUT with lost acknowledgement leaves no charge and no orphan once chunk staging finishes', async () => {
  const init = await initChunk(jpeg.length);
  expect((await sendChunk(init.body.uploadId, jpeg)).status).toBe(200);
  storage.putFromFile.mockRestore();
  const actual = storage.putFromFile.bind(storage);
  jest.spyOn(storage, 'putFromFile').mockImplementationOnce(async (...args) => {
    await actual(...args); throw new Error('Owned lost acknowledgement after PUT');
  });
  const res = await completeChunk(init.body.uploadId);
  expect(res.status).toBe(200); expect(res.body.uploaded).toBe(0);
  await waitSettled();
  expect(await db('photos')).toHaveLength(0);
  expect(await db('public_upload_objects')).toHaveLength(0);
  expect(await storage.stat(storage.putFromFile.mock.calls[0][0])).toBeNull();
});
test.each(['api-control.jpg', 'api-control.photograph-format'])('ordinary scoped v1 %s preserves its synchronous response and settles its admission', async filename => {
  const res = await attachV1(v1Upload(), jpeg, filename);
  expect(res.status).toBe(201); expect(res.body.size_bytes).toBe(jpeg.length);
  expect(await storage.stat('events/active/' + res.body.path)).toMatchObject({ size: jpeg.length });
  expect(await db('photos').where({ id: res.body.id }).first()).toMatchObject({ width: 16, height: 16, processing_status: 'complete' });
  expect(await db('public_upload_objects')).toHaveLength(0);
  expect(await db('public_upload_requests').first()).toMatchObject({ upload_kind: 'admin', active: 0 });
});
test('v1 retains the photo-only file cap and bounded documented text fields', async () => {
  await setting('general_max_file_size_mb', 1); settings.clearMaxFileSizeCache();
  const tooLarge = await attachV1(v1Upload(), image(2 * 1024 * 1024));
  expect(tooLarge.status).toBe(400); expect(tooLarge.body.error).toBe('File too large. Maximum size is 1 MB per file.');
  await waitSettled(); expect(stagedBytes).toBeLessThanOrEqual(1024 * 1024);
  const field = await attachV1(v1Upload().field('category_id', 'x'.repeat(2048)));
  expect(field.status).toBe(400); expect(storage.putFromFile).not.toHaveBeenCalled();
});
test('v1 replacement keeps identity/source filename and charges nothing', async () => {
  const first = await attachV1(v1Upload(), jpeg, 'camera.jpg'); expect(first.status).toBe(201);
  const res = await attachV1(v1Upload().field('replaces_photo_id', String(first.body.id)), jpeg, 'edited.jpg');
  expect(res.status).toBe(200); expect(res.body.replaced).toBe(true);
  expect(res.body.photo).toMatchObject({ id: first.body.id, original_filename: 'edited.jpg', source_filename: 'camera.jpg' });
  expect(await db('photos')).toHaveLength(1);
  expect(await db('public_upload_objects')).toHaveLength(0);
});
test('a typed session token cannot enter the v1 adapter or create a private reservation', async () => {
  const res = await request(app).post(`/api/v1/events/${eventId}/photos`).set('Authorization', `Bearer ${token}`).attach('photo', jpeg, 'wrong-auth.jpg');
  expect(res.status).toBe(401);
  expect(await db('public_upload_requests')).toHaveLength(0); expect(storage.putFromFile).not.toHaveBeenCalled();
});

test.each(['application/octet-stream', 'multipart/form-data'])('unread %s bodies are closed if the guarded parser cannot start', async contentType => {
  const http = require('http');
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let sent = 0; let interval;
  try {
    const result = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST',
        path: `/api/admin/photos/${eventId}/upload`, headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType } },
      res => { let body = ''; res.on('data', b => { body += b; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) })); });
      req.on('error', err => { if (!['EPIPE', 'ECONNRESET'].includes(err.code)) reject(err); });
      req.write(Buffer.alloc(32));
      interval = setInterval(() => {
        sent += 1024; req.write(Buffer.alloc(1024));
        if (sent >= 64 * 1024) { clearInterval(interval); req.end(); }
      }, 5);
    });
    expect(result.status).toBe(400); expect(sent).toBeLessThan(64 * 1024);
  } finally { clearInterval(interval); await new Promise(resolve => server.close(resolve)); }
  await waitSettled(); expect(storage.putFromFile).not.toHaveBeenCalled();
});

test('private admission and promotion cannot disagree about exponential event ids, while decimal ids retain compatibility', async () => {
  const max = await db('events').max('id as maximum').first();
  const foreignId = Number(max.maximum) + 1; const ownedId = foreignId * 10;
  const otherId = idOf(await db('admin_users').insert({ username: 'other-admission', email: 'other@fixture.invalid', password_hash: 'unused', is_active: 1 }).returning('id'));
  const ownerId = (await db('events').where({ id: eventId }).first('created_by')).created_by;
  const makeEvent = (id, owner) => ({
    id, slug: `numeric-${id}`, event_type: 'wedding', event_name: 'Numeric scope', event_date: '2026-10-08',
    host_email: 'host@fixture.invalid', admin_email: 'admin@fixture.invalid', password_hash: 'x',
    share_link: `/gallery/numeric-${id}/share`, expires_at: new Date(Date.now() + 3600000).toISOString(),
    is_active: 1, is_archived: 0, created_by: owner,
  });
  await db('events').insert([makeEvent(foreignId, otherId), makeEvent(ownedId, ownerId)]);
  for (const alias of ['photos', 'events']) {
    const res = await attach(upload(alias, `${foreignId}e1`), jpeg);
    expect(res.status).toBe(404);
  }
  const api = await request(app).post(`/api/v1/events/${foreignId}e1/photos`).set('Authorization', `Bearer ${apiToken}`).attach('photo', jpeg, 'scope.jpg');
  expect(api.status).toBe(404);
  expect(storage.putFromFile).not.toHaveBeenCalled(); expect(await db('photos')).toHaveLength(0);
  expect(await db('public_upload_requests')).toHaveLength(0);
  const normal = await attach(upload('photos', `000${ownedId}`), jpeg);
  expect(normal.status).toBe(202);
  expect(await db('photos').first()).toMatchObject({ event_id: ownedId });
  expect(await db('public_upload_requests').first()).toMatchObject({ event_id: ownedId, upload_kind: 'admin' });
});

test('the existing 500-file default still accepts a real bounded batch of small images', async () => {
  let req = upload();
  for (let n = 0; n < 500; n++) req = attach(req, jpeg, `small-${n}.jpg`);
  const res = await req;
  expect(res.status).toBe(202); expect(res.body.count).toBe(500);
  expect(await db('photos')).toHaveLength(500); expect(await db('public_upload_objects')).toHaveLength(0);
}, 120000);
