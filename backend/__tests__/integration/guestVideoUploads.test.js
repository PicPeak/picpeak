/**
 * Guest uploads and Max Video Size, single request and chunked (issue 2315).
 *
 * Pins the contract:
 *  - POST /gallery/:eventId/upload holds a video to general_max_video_size_mb
 *    and a photo to general_max_file_size_mb; multer's cap is the larger of
 *    the two while a video type is allowed, the photo limit otherwise
 *  - /api/public/settings exposes the video limit for the dialog
 *  - the guest chunk routes apply the single route's gates (gallery token,
 *    guest uploads on, name rule), the per-type limit and the allow-list
 *  - an upload id only works for the gallery session and guest that started it
 *  - a completed chunked upload goes through the same processing and
 *    moderation path as a single-request one
 *  - the session holds one public admission from init until complete or
 *    abort, charged to the same gallery and guest allowances
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal, buildRouteApp } = require('./helpers/crmDb');
const { admissionVideo } = require('../fixtures/admissionVideo');

const mockObjects = new Map();
const mockStorage = {
  kind: () => 'local',
  resolveLocalPath: key => path.join(process.env.STORAGE_PATH, key),
  putFromFile: jest.fn(async (key, file) => mockObjects.set(key, fs.statSync(file).size)),
  stat: jest.fn(async key => (mockObjects.has(key) ? { size: mockObjects.get(key) } : null)),
  delete: jest.fn(async key => { mockObjects.delete(key); }),
};
jest.mock('../../src/services/storage', () => ({ getStorage: () => mockStorage, initStorage: async () => mockStorage }));
// Records the options each request builds its multer instance with.
jest.mock('multer', () => {
  const real = jest.requireActual('multer');
  return Object.assign(jest.fn(options => real(options)), real);
});
jest.mock('../../src/services/downloadZipService', () => ({ invalidate: jest.fn() }));

process.env.JWT_SECRET = process.env.JWT_SECRET || 'guest-chunked-upload-secret';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const idOf = rows => rows[0]?.id ?? rows[0];
let db; let cleanup; let app; let adminId; let jpeg; let settings; let chunks; let multer;
let seq = 0;
const started = new Set();

const setting = (key, value) => db('app_settings').insert({
  setting_key: key, setting_value: JSON.stringify(value), setting_type: 'general',
}).onConflict('setting_key').merge({ setting_value: JSON.stringify(value) });

async function makeEvent(extra = {}) {
  seq += 1;
  const slug = `guest-chunked-${seq}`;
  const id = idOf(await db('events').insert({
    slug, event_type: 'wedding', event_name: `Guest Chunked ${seq}`, event_date: '2026-10-28',
    host_email: 'host@fixture.invalid', admin_email: 'admin@fixture.invalid', password_hash: 'x',
    share_link: `/gallery/${slug}/share`, expires_at: new Date(Date.now() + 3600000).toISOString(),
    is_active: 1, is_archived: 0, is_draft: 0, allow_user_uploads: 1, guest_name_mode: 'optional',
    created_by: adminId, created_at: new Date().toISOString(), ...extra,
  }).returning('id'));
  return { id, slug };
}
// Every login carries its own jti, as the gallery login route issues them.
const galleryToken = (event, jti = crypto.randomUUID()) => jwt.sign(
  { eventId: event.id, eventSlug: event.slug, type: 'gallery', jti },
  process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' });
async function makeGuest(event, name = 'Anna') {
  const guestId = idOf(await db('gallery_guests').insert({
    event_id: event.id, name, identifier: `${name}-${crypto.randomUUID()}`, created_at: new Date().toISOString(), is_deleted: false,
  }).returning('id'));
  const token = jwt.sign({ type: 'guest', guestId, eventId: event.id }, process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' });
  return { guestId, token };
}
const as = (req, token, guest) => {
  req.set('Authorization', `Bearer ${token}`);
  if (guest) req.set('x-guest-token', guest);
  return req;
};
const single = (event, token, bytes, filename, contentType, guest) => as(request(app)
  .post(`/api/gallery/${event.id}/upload`), token, guest).attach('photos', bytes, { filename, contentType });
const init = async (event, token, body, guest) => {
  const res = await as(request(app).post(`/api/gallery/${event.id}/chunked-upload/init`), token, guest).send(body);
  if (res.body.uploadId) started.add(res.body.uploadId);
  return res;
};
const chunk = (event, token, uploadId, index, bytes, guest) => as(request(app)
  .post(`/api/gallery/${event.id}/chunked-upload/${uploadId}/chunk/${index}`), token, guest)
  .set('Content-Type', 'application/octet-stream').send(bytes);
const complete = (event, token, uploadId, guest, body = {}) => as(request(app)
  .post(`/api/gallery/${event.id}/chunked-upload/${uploadId}/complete`), token, guest).send(body);
const abort = (event, token, uploadId, guest) => as(request(app)
  .delete(`/api/gallery/${event.id}/chunked-upload/${uploadId}`), token, guest);

/** Init, send every chunk, complete. */
async function chunked(event, token, bytes, filename, guest) {
  const started = await init(event, token, { filename, fileSize: bytes.length }, guest);
  expect(started.status).toBe(200);
  const { uploadId, chunkSize, expectedChunks } = started.body;
  for (let i = 0; i < expectedChunks; i += 1) {
    const sent = await chunk(event, token, uploadId, i, bytes.subarray(i * chunkSize, (i + 1) * chunkSize), guest);
    expect(sent.status).toBe(200);
  }
  return { uploadId, res: await complete(event, token, uploadId, guest) };
}
async function waitSettled() {
  for (let n = 0; n < 100; n++) {
    if (!(await db('public_upload_requests').where({ active: 1 }).first())) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Admission was not settled');
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId } = await seedMinimal(db));
  settings = require('../../src/services/uploadSettings');
  chunks = require('../../src/services/chunkedUploadService');
  multer = require('multer');
  jpeg = await require('sharp')({ create: { width: 16, height: 16, channels: 3, background: 'white' } }).jpeg().toBuffer();
  app = buildRouteApp('/api/gallery', require('../../src/routes/gallery'));
  app.use('/api/public/settings', require('../../src/routes/publicSettings'));
}, 120000);
beforeEach(async () => {
  await db('public_upload_objects').del(); await db('public_upload_requests').del(); await db('photos').del();
  delete process.env.PUBLIC_UPLOAD_LIMITS_JSON;
  await setting('general_max_file_size_mb', 1); await setting('general_max_video_size_mb', 8);
  await setting('general_max_upload_batch_size_mb', 95);
  await setting('general_allowed_file_types', 'jpg,jpeg,png,webp,mp4');
  settings.clearMaxFileSizeCache(); settings.clearMaxVideoSizeCache(); settings.clearAllowedTypesCache();
  require('../../src/services/publicUploadQuota')._legacyCache.clear();
  mockObjects.clear(); jest.clearAllMocks();
  // 4 TiB free of 8 TiB: admission outcomes must not depend on the CI disk.
  jest.spyOn(fs.promises, 'statfs').mockResolvedValue({
    bavail: Math.floor(4096 * GiB / 4096), bsize: 4096, blocks: 2 * 1024 * 1024 * 1024, files: 10000000, ffree: 100000000,
  });
});
afterEach(async () => {
  for (const id of started) await chunks.abortUpload(id).catch(() => {});
  started.clear();
  await waitSettled(); jest.restoreAllMocks();
});
afterAll(async () => {
  chunks.stop();
  if (cleanup) await cleanup();
});

describe('single-request guest upload, per-type limit', () => {
  test('a video over Max File Size but under Max Video Size is accepted', async () => {
    const event = await makeEvent();
    const video = admissionVideo(2 * MiB);
    const res = await single(event, galleryToken(event), video, 'clip.mp4', 'video/mp4');
    expect(res.status).toBe(202); expect(res.body.count).toBe(1);
    expect(await db('photos').where({ event_id: event.id }).first()).toMatchObject({ mime_type: 'video/mp4', size_bytes: video.length, uploaded_by: 'guest' });
  });

  test('a photo over Max File Size is refused with the photo limit', async () => {
    const event = await makeEvent();
    const big = Buffer.concat([jpeg, Buffer.alloc(2 * MiB)]);
    const res = await single(event, galleryToken(event), big, 'big.jpg', 'image/jpeg');
    expect(res.status).toBe(400); expect(res.body.code).toBe('UPLOAD_FILE_TOO_LARGE');
    expect(res.body.error).toBe('File too large. Maximum size is 1 MB per file.');
    expect(mockStorage.putFromFile).not.toHaveBeenCalled();
  });

  test('a video over Max Video Size is refused with the video limit', async () => {
    await setting('general_max_video_size_mb', 2); settings.clearMaxVideoSizeCache();
    const event = await makeEvent();
    const res = await single(event, galleryToken(event), admissionVideo(3 * MiB), 'long.mp4', 'video/mp4');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('File too large. Maximum size is 2 MB per file.');
    expect(mockStorage.putFromFile).not.toHaveBeenCalled();
  });

  test('multer takes the larger limit while videos are allowed, the photo limit otherwise', async () => {
    const event = await makeEvent();
    expect((await single(event, galleryToken(event), jpeg, 'a.jpg', 'image/jpeg')).status).toBe(202);
    expect(multer.mock.calls.at(-1)[0].limits.fileSize).toBe(8 * MiB);
    await setting('general_allowed_file_types', 'jpg,jpeg,png,webp'); settings.clearAllowedTypesCache();
    expect((await single(event, galleryToken(event), jpeg, 'b.jpg', 'image/jpeg')).status).toBe(202);
    expect(multer.mock.calls.at(-1)[0].limits.fileSize).toBe(1 * MiB);
  });

  test('public settings expose Max Video Size', async () => {
    const res = await request(app).get('/api/public/settings');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ general_max_file_size_mb: 1, general_max_video_size_mb: 8 });
  });
});

describe('chunked guest upload gates', () => {
  test('init is refused when guest uploads are off', async () => {
    const event = await makeEvent({ allow_user_uploads: 0 });
    const res = await init(event, galleryToken(event), { filename: 'clip.mp4', fileSize: 1000 });
    expect(res.status).toBe(403);
    expect(await db('public_upload_requests')).toHaveLength(0);
  });

  test('init is refused with another gallery\'s token', async () => {
    const event = await makeEvent();
    const other = await makeEvent();
    const res = await init(event, galleryToken(other), { filename: 'clip.mp4', fileSize: 1000 });
    expect(res.status).toBe(403);
    expect(await db('public_upload_requests')).toHaveLength(0);
  });

  test('init is refused without a token, and without a name where one is required', async () => {
    const event = await makeEvent({ guest_name_mode: 'required' });
    expect((await request(app).post(`/api/gallery/${event.id}/chunked-upload/init`).send({ filename: 'clip.mp4', fileSize: 1000 })).status).toBe(401);
    const res = await init(event, galleryToken(event), { filename: 'clip.mp4', fileSize: 1000 });
    expect(res.status).toBe(400); expect(res.body.code).toBe('UPLOADER_NAME_REQUIRED');
  });

  test('init holds each type to its own limit', async () => {
    const event = await makeEvent();
    const token = galleryToken(event);
    const photo = await init(event, token, { filename: 'big.jpg', fileSize: 2 * MiB });
    expect(photo.status).toBe(400); expect(photo.body.error).toBe('File too large. Maximum size is 1 MB per file.');
    const video = await init(event, token, { filename: 'long.mp4', fileSize: 9 * MiB });
    expect(video.status).toBe(400); expect(video.body.error).toBe('File too large. Maximum size is 8 MB per file.');
    expect((await init(event, token, { filename: 'clip.mp4', fileSize: 2 * MiB })).status).toBe(200);
  });

  test('init refuses a type off the allow-list, whatever MIME type is declared', async () => {
    const event = await makeEvent();
    const token = galleryToken(event);
    expect((await init(event, token, { filename: 'clip.webm', fileSize: 1000, mimeType: 'video/mp4' })).status).toBe(400);
    expect((await init(event, token, { filename: 'page.html', fileSize: 1000, mimeType: 'image/jpeg' })).status).toBe(400);
    expect(await db('public_upload_requests')).toHaveLength(0);
  });

  test('a chunk route refuses a slideshow token like the single route does', async () => {
    const event = await makeEvent();
    const show = jwt.sign({ eventId: event.id, eventSlug: event.slug, type: 'gallery', jti: crypto.randomUUID(), accessLevel: 'slideshow' },
      process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' });
    expect((await init(event, show, { filename: 'clip.mp4', fileSize: 1000 })).status).toBe(403);
  });

  test('a disguised video is refused at its first chunk', async () => {
    const event = await makeEvent();
    const token = galleryToken(event);
    const bytes = Buffer.alloc(2 * MiB, 0x41);
    const started = await init(event, token, { filename: 'disguised.mp4', fileSize: bytes.length });
    const res = await chunk(event, token, started.body.uploadId, 0, bytes);
    expect(res.status).toBe(400); expect(res.body.code).toBe('UPLOAD_TYPE_REJECTED');
  });

  test('merged bytes that are not the declared type are refused and stored nowhere', async () => {
    const event = await makeEvent();
    const token = galleryToken(event);
    const { res } = await chunked(event, token, Buffer.alloc(4096, 0x41), 'fake.jpg');
    expect(res.status).toBe(400);
    expect(mockStorage.putFromFile).not.toHaveBeenCalled();
    await waitSettled();
    expect(await db('photos').where({ event_id: event.id })).toHaveLength(0);
  });
});

describe('chunked guest upload ownership', () => {
  test('another gallery cannot touch the upload', async () => {
    const event = await makeEvent();
    const other = await makeEvent();
    const token = galleryToken(event);
    const otherToken = galleryToken(other);
    const { body: { uploadId } } = await init(event, token, { filename: 'shot.jpg', fileSize: jpeg.length });
    // Its own URL: the upload id names nothing there.
    expect((await chunk(other, otherToken, uploadId, 0, jpeg)).status).toBe(404);
    expect((await complete(other, otherToken, uploadId)).status).toBe(404);
    expect((await abort(other, otherToken, uploadId)).status).toBe(404);
    // This gallery's URL with its own token: refused before the upload is looked up.
    expect((await chunk(event, otherToken, uploadId, 0, jpeg)).status).toBe(403);
    // Still the owner's.
    expect((await chunk(event, token, uploadId, 0, jpeg)).status).toBe(200);
  });

  test('another login or another guest of the same gallery cannot touch it', async () => {
    const event = await makeEvent();
    const token = galleryToken(event);
    const anna = await makeGuest(event, 'Anna');
    const ben = await makeGuest(event, 'Ben');
    const { body: { uploadId } } = await init(event, token, { filename: 'shot.jpg', fileSize: jpeg.length }, anna.token);
    expect((await chunk(event, token, uploadId, 0, jpeg, ben.token)).status).toBe(404);
    expect((await chunk(event, token, uploadId, 0, jpeg)).status).toBe(404);
    expect((await chunk(event, galleryToken(event), uploadId, 0, jpeg, anna.token)).status).toBe(404);
    expect((await abort(event, token, uploadId, ben.token)).status).toBe(404);
    expect((await chunk(event, token, uploadId, 0, jpeg, anna.token)).status).toBe(200);
    expect((await complete(event, token, uploadId, ben.token)).status).toBe(404);
    expect((await complete(event, token, uploadId, anna.token)).status).toBe(202);
  });
});

describe('chunked guest upload processing and quota', () => {
  test('a completed upload takes the single-request path: same rows, held for review the same way', async () => {
    const event = await makeEvent({ moderate_guest_uploads: 1 });
    const token = galleryToken(event);
    const guest = await makeGuest(event, 'Clara');
    const one = await single(event, token, jpeg, 'one.jpg', 'image/jpeg', guest.token);
    expect(one.status).toBe(202);
    const { res } = await chunked(event, token, jpeg, 'two.jpg', guest.token);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ count: 1, held_for_review: true, message: one.body.message });
    expect(res.body.upload_id).toEqual(expect.any(String));
    const columns = ['uploaded_by', 'visibility', 'moderation_status', 'processing_status', 'type', 'mime_type'];
    const rows = await db('photos').where({ event_id: event.id }).orderBy('id').select([...columns, 'uploader_guest_id']);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual(rows[0]);
    expect(rows[1]).toMatchObject({ uploaded_by: 'guest', visibility: 'hidden', moderation_status: 'pending' });
  });

  test('a video above the chunk size and the photo limit merges and is queued', async () => {
    await setting('general_max_video_size_mb', 16); settings.clearMaxVideoSizeCache();
    const event = await makeEvent();
    const video = admissionVideo(chunks.CHUNK_SIZE + 4096);
    const { res } = await chunked(event, galleryToken(event), video, 'phone.mp4');
    expect(res.status).toBe(202); expect(res.body.count).toBe(1);
    expect(await db('photos').where({ event_id: event.id }).first()).toMatchObject({ mime_type: 'video/mp4', size_bytes: video.length });
  });

  test('init reserves the declared size against the guest\'s allowance; complete releases it and keeps the charge', async () => {
    const event = await makeEvent();
    const token = galleryToken(event);
    const guest = await makeGuest(event);
    const started = await init(event, token, { filename: 'shot.jpg', fileSize: jpeg.length }, guest.token);
    expect(await db('public_upload_requests').where({ active: 1 })).toEqual([expect.objectContaining({
      upload_kind: 'public', event_id: event.id, guest_scope: `${event.id}:${guest.guestId}`, bytes: jpeg.length, files: 1,
    })]);
    expect((await chunk(event, token, started.body.uploadId, 0, jpeg, guest.token)).status).toBe(200);
    expect((await complete(event, token, started.body.uploadId, guest.token)).status).toBe(202);
    await waitSettled();
    expect(await db('public_upload_requests').first()).toMatchObject({ active: 0, rate_bytes: jpeg.length });
    expect(await db('public_upload_objects').first()).toMatchObject({
      upload_kind: 'public', state: 'stored', reference_type: 'photo', bytes: jpeg.length, guest_scope: `${event.id}:${guest.guestId}`,
    });
  });

  test('abort releases the reservation and charges nothing', async () => {
    const event = await makeEvent();
    const token = galleryToken(event);
    const started = await init(event, token, { filename: 'clip.mp4', fileSize: 2 * MiB });
    expect(await db('public_upload_requests').where({ active: 1 })).toHaveLength(1);
    expect((await abort(event, token, started.body.uploadId)).status).toBe(200);
    expect(await db('public_upload_requests').where({ active: 1 })).toHaveLength(0);
    expect(await db('public_upload_objects')).toHaveLength(0);
    expect((await abort(event, token, started.body.uploadId)).status).toBe(404);
  });

  test('init is refused when the guest\'s concurrency allowance is used up', async () => {
    process.env.PUBLIC_UPLOAD_LIMITS_JSON = JSON.stringify({ guest: { requests: 1 } });
    const event = await makeEvent();
    const token = galleryToken(event);
    const guest = await makeGuest(event);
    expect((await init(event, token, { filename: 'a.mp4', fileSize: 1000 }, guest.token)).status).toBe(200);
    const second = await init(event, token, { filename: 'b.mp4', fileSize: 1000 }, guest.token);
    expect(second.status).toBe(429); expect(second.body.code).toBe('UPLOAD_CONCURRENCY_LIMIT');
  });

  test('a re-sent chunk is charged again and refused once it would pass the hourly byte rate', async () => {
    process.env.PUBLIC_UPLOAD_LIMITS_JSON = JSON.stringify({ guest: { hourBytes: 2 * jpeg.length } });
    const event = await makeEvent();
    const token = galleryToken(event);
    const guest = await makeGuest(event);
    const { body: { uploadId } } = await init(event, token, { filename: 'shot.jpg', fileSize: jpeg.length }, guest.token);
    expect((await chunk(event, token, uploadId, 0, jpeg, guest.token)).status).toBe(200);
    expect((await chunk(event, token, uploadId, 0, jpeg, guest.token)).status).toBe(200);
    expect(await db('public_upload_requests').where({ active: 1 }).first()).toMatchObject({ rate_bytes: 2 * jpeg.length });
    const third = await chunk(event, token, uploadId, 0, jpeg, guest.token);
    expect(third.status).toBe(429); expect(third.body.code).toBe('UPLOAD_BYTE_RATE_LIMIT');
    expect(await db('public_upload_requests').where({ active: 1 }).first()).toMatchObject({ rate_bytes: 2 * jpeg.length });
  });

  test('complete answers once the admission is settled, so the next file finds its slot', async () => {
    process.env.PUBLIC_UPLOAD_LIMITS_JSON = JSON.stringify({ guest: { requests: 1 } });
    const quota = require('../../src/services/publicUploadQuota');
    const settle = quota.finish;
    // A slow settlement: the answer must still wait for it.
    jest.spyOn(quota, 'finish').mockImplementation(async (...args) => {
      await new Promise(resolve => setTimeout(resolve, 100));
      return settle(...args);
    });
    const event = await makeEvent();
    const token = galleryToken(event);
    const guest = await makeGuest(event);
    const { res } = await chunked(event, token, jpeg, 'one.jpg', guest.token);
    expect(res.status).toBe(202);
    expect((await init(event, token, { filename: 'two.jpg', fileSize: jpeg.length }, guest.token)).status).toBe(200);
  });

  test('a session older than the rate window that grows moves its charge into the current window', async () => {
    process.env.PUBLIC_UPLOAD_LIMITS_JSON = JSON.stringify({ guest: { hourBytes: 2 * jpeg.length } });
    const quota = require('../../src/services/publicUploadQuota');
    const event = await makeEvent();
    const token = galleryToken(event);
    const guest = await makeGuest(event);
    expect((await init(event, token, { filename: 'old.jpg', fileSize: jpeg.length }, guest.token)).status).toBe(200);
    // The same session, begun 61 minutes ago.
    const old = new Date(Date.now() - 61 * 60000).toISOString();
    await db('public_upload_requests').where({ active: 1 }).update({ created_at: old });
    const row = await db('public_upload_requests').where({ active: 1 }).first();
    const session = { ...row, rate_bytes: Number(row.rate_bytes), limits: quota.configuration('public') };
    await quota.growRate(session, 2 * jpeg.length);
    const moved = await db('public_upload_requests').where({ id: row.id }).first();
    expect(Number(moved.rate_bytes)).toBe(2 * jpeg.length);
    expect(new Date(moved.created_at).getTime()).toBeGreaterThan(Date.now() - 60000);
    // The grown charge fills this hour's rate, so a new session is refused.
    const next = await init(event, token, { filename: 'new.jpg', fileSize: jpeg.length }, guest.token);
    expect(next.status).toBe(429); expect(next.body.code).toBe('UPLOAD_BYTE_RATE_LIMIT');
  });

  test('accepted chunks and an abort are refunded to the API rate limit; a refused chunk is not', async () => {
    const refund = jest.fn();
    const limited = express();
    limited.set('trust proxy', true);
    limited.use(express.json());
    limited.use(require('cookie-parser')());
    // Stands in for the general limiter, which leaves the refund on req.
    limited.use((req, res, next) => { req.rateLimitRefund = refund; next(); });
    limited.use('/api/gallery', require('../../src/routes/gallery'));
    const event = await makeEvent();
    const token = galleryToken(event);
    const send = (method, url) => as(request(limited)[method](`/api/gallery/${event.id}/chunked-upload${url}`), token);
    const begun = await send('post', '/init').send({ filename: 'clip.mp4', fileSize: 2 * MiB });
    expect(begun.status).toBe(200);
    started.add(begun.body.uploadId);
    expect(refund).not.toHaveBeenCalled();
    const short = await send('post', `/${begun.body.uploadId}/chunk/0`).set('Content-Type', 'application/octet-stream').send(Buffer.alloc(10));
    expect(short.status).toBe(400);
    expect(refund).not.toHaveBeenCalled();
    const video = admissionVideo(2 * MiB);
    const sent = await send('post', `/${begun.body.uploadId}/chunk/0`).set('Content-Type', 'application/octet-stream')
      .send(video.subarray(0, begun.body.chunkSize));
    expect(sent.status).toBe(200);
    expect(refund).toHaveBeenCalledTimes(1);
    expect((await send('delete', `/${begun.body.uploadId}`)).status).toBe(200);
    expect(refund).toHaveBeenCalledTimes(2);
  });

  test('an idle session is released by the expiry sweep', async () => {
    const event = await makeEvent();
    const started = await init(event, galleryToken(event), { filename: 'clip.mp4', fileSize: 2 * MiB });
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + chunks.ADMITTED_IDLE_MS + 1000);
    expect(await chunks.cleanupExpiredUploads()).toBeGreaterThanOrEqual(1);
    Date.now.mockRestore();
    expect(chunks.getUploadStatus(started.body.uploadId)).toBeNull();
    expect(await db('public_upload_requests').where({ active: 1 })).toHaveLength(0);
  });
});

// The server mounts the chunk body-type guard on the gallery prefix too.
test('a guest chunk labelled as JSON is refused before a parser reads it', async () => {
  const { requireOctetStreamChunk, CHUNK_ROUTE_PREFIXES } = require('../../src/middleware/chunkBodyType');
  expect(CHUNK_ROUTE_PREFIXES).toContain('/api/gallery');
  const guarded = express();
  guarded.use(CHUNK_ROUTE_PREFIXES, requireOctetStreamChunk);
  guarded.use((req, res) => res.status(204).end());
  const res = await request(guarded).post('/api/gallery/1/chunked-upload/abc/chunk/0').set('Content-Type', 'application/json').send('{}');
  expect(res.status).toBe(415);
  expect((await request(guarded).post('/api/gallery/1/upload').set('Content-Type', 'application/json').send('{}')).status).toBe(204);
});
