/**
 * Guest uploads and Max Video Size (issue 2315).
 *
 * Pins the contract:
 *  - POST /gallery/:eventId/upload holds a video to general_max_video_size_mb
 *    and a photo to general_max_file_size_mb; multer's cap is the larger of
 *    the two while a video type is allowed, the photo limit otherwise
 *  - /api/public/settings exposes the video limit for the dialog
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');
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
let db; let cleanup; let app; let adminId; let jpeg; let settings; let multer;
let seq = 0;

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
const galleryToken = (event) => jwt.sign(
  { eventId: event.id, eventSlug: event.slug, type: 'gallery' },
  process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' });
const as = (req, token, guest) => {
  req.set('Authorization', `Bearer ${token}`);
  if (guest) req.set('x-guest-token', guest);
  return req;
};
const single = (event, token, bytes, filename, contentType, guest) => as(request(app)
  .post(`/api/gallery/${event.id}/upload`), token, guest).attach('photos', bytes, { filename, contentType });
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
  await waitSettled(); jest.restoreAllMocks();
});
afterAll(async () => {
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
