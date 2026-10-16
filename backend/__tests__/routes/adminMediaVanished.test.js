/**
 * Admin media routes and a file removed between the stat and the read
 * (issue 2129). A regeneration, a replacement, a purge or a delete can unlink
 * a file the route has just found with storage.stat(). The read then misses:
 * S3's get() rejects with NoSuchKey, the local read stream fails with ENOENT
 * once it opens. Either answers like the failed stat, a 404 with the headers
 * staged for the file gone and Cache-Control: no-store; any other read error
 * stays a 500. Through the real routers against SQLite and local storage.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-admin-vanished-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'admin-vanished-test-secret-at-least-thirty-two';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-admin-vanished-storage-'));

// The tiers are written by the test; the route only needs to be told where.
jest.mock('../../src/services/imageProcessor', () => {
  const actual = jest.requireActual('../../src/services/imageProcessor');
  return {
    ...actual,
    ensureThumbnail: jest.fn(async (photo) => photo.thumbnail_path),
    ensurePreviewImage: jest.fn(async (photo) => photo.preview_path),
    ensurePreviewImageAtWidth: jest.fn(async (photo) => photo.preview_path),
  };
});

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const SLUG = 'admin-vanished-event';
const ARCHIVED = 'admin-vanished-archived';

const unwrap = (rows) => rows[0]?.id ?? rows[0];
const binary = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('admin media routes, file removed between stat and read (issue 2129)', () => {
  let db; let cleanup; let app; let storage; let adminToken;
  let eventId; let archivedId; let photoId; let trashedId;

  const notFoundOnS3 = () => Object.assign(new Error('The specified key does not exist.'),
    { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
  const accessDenied = () => Object.assign(new Error('Access Denied'),
    { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });

  // The local backend's own race: the stat sees the file, then it is gone.
  const removeAfterStat = (key) => {
    const realStat = storage.stat.bind(storage);
    jest.spyOn(storage, 'stat').mockImplementation(async (k) => {
      const found = await realStat(k);
      if (k === key) await storage.delete(k);
      return found;
    });
  };
  // S3's: get() rejects, after the stat found the object.
  const failGet = (key, error) => {
    const realGet = storage.get.bind(storage);
    jest.spyOn(storage, 'get').mockImplementation(async (k, ...rest) => {
      if (k === key) throw error;
      return realGet(k, ...rest);
    });
  };

  const KEYS = {
    original: `events/active/${SLUG}/raced.jpg`,
    thumbnail: 'thumbnails/thumb_raced.jpg',
    preview: 'previews/preview_raced.jpg',
    trashed: 'thumbnails/thumb_trashed.jpg',
    archive: `archives/${ARCHIVED}.zip`,
  };

  const ROUTES = {
    photo: () => [`/api/admin/photos/${eventId}/photo/${photoId}`, KEYS.original, 'Photo file not found'],
    download: () => [`/api/admin/photos/${eventId}/photos/${photoId}/download`, KEYS.original, 'Photo file not found'],
    thumbnail: () => [`/api/admin/photos/${eventId}/thumbnail/${photoId}`, KEYS.thumbnail, 'Thumbnail not found'],
    preview: () => [`/api/admin/photos/${eventId}/preview/${photoId}`, KEYS.preview, 'Preview not found'],
    'trashed thumbnail': () => [`/api/admin/photos/${eventId}/photos/trash/${trashedId}/thumbnail`, KEYS.trashed, 'Thumbnail not found'],
    'archive download': () => [`/api/admin/archives/${archivedId}/download`, KEYS.archive, 'Archive file not found in storage'],
  };

  const get = (url) => request(app).get(url).set('Authorization', `Bearer ${adminToken}`);

  const insertEvent = async (slug, extra = {}) => unwrap(await db('events').insert({
    slug, event_type: 'wedding', event_name: slug, event_date: '2026-10-15',
    host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
    share_link: `/gallery/${slug}/s`, share_token: `${slug}-share`,
    expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
    is_active: 1, is_archived: 0, is_draft: 0, created_at: new Date().toISOString(), ...extra,
  }).returning('id'));

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    storage = require('../../src/services/storage').getStorage();

    eventId = await insertEvent(SLUG);
    archivedId = await insertEvent(ARCHIVED, { is_active: 0, is_archived: 1, archive_path: KEYS.archive });
    photoId = unwrap(await db('photos').insert({
      event_id: eventId, filename: 'raced.jpg', path: `${SLUG}/raced.jpg`, type: 'individual',
      media_type: 'image', mime_type: 'image/jpeg', thumbnail_path: KEYS.thumbnail, preview_path: KEYS.preview,
      uploaded_at: new Date().toISOString(),
    }).returning('id'));
    trashedId = unwrap(await db('photos').insert({
      event_id: eventId, filename: 'trashed.jpg', path: `${SLUG}/trashed.jpg`, type: 'individual',
      media_type: 'image', mime_type: 'image/jpeg', thumbnail_path: KEYS.trashed,
      uploaded_at: new Date().toISOString(), deleted_at: new Date().toISOString(),
      purge_after: new Date(Date.now() + 864e5).toISOString(),
    }).returning('id'));

    const superRole = await db('roles').where({ name: 'super_admin' }).first();
    const adminId = unwrap(await db('admin_users').insert({
      username: 'vanished-admin', email: 'vanished-admin@example.com', password_hash: 'x',
      role_id: superRole.id, is_active: 1,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).returning('id'));
    adminToken = jwt.sign(
      { id: adminId, username: 'vanished-admin', type: 'admin', role: 'super_admin', loginTime: Date.now() },
      process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' },
    );

    app = express();
    app.use(express.json());
    app.use('/api/admin/photos', require('../../src/routes/adminPhotos'));
    app.use('/api/admin/archives', require('../../src/routes/adminArchives'));
  }, 120000);

  beforeEach(async () => {
    for (const key of Object.values(KEYS)) await storage.put(key, Buffer.from(`bytes of ${key}`));
  });

  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { if (cleanup) await cleanup(); });

  test.each(Object.keys(ROUTES))('the %s route serves the file when it is there', async (name) => {
    const [url, key] = ROUTES[name]();
    const res = await get(url).buffer().parse(binary);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe(`bytes of ${key}`);
  });

  describe.each([
    ['removed from local storage', (key) => removeAfterStat(key)],
    ['missing on S3', (key) => failGet(key, notFoundOnS3())],
  ])('a file %s after the stat', (_label, race) => {
    test.each(Object.keys(ROUTES))('the %s route answers 404 without the file headers', async (name) => {
      const [url, key, message] = ROUTES[name]();
      race(key);
      const res = await get(url);
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-disposition']).toBeUndefined();
      // The local stream's ENOENT is answered by pipeStreamToResponse.
      expect([message, 'File not found']).toContain(res.body.error);
    });
  });

  test.each(Object.keys(ROUTES))('any other read error on the %s route stays a 500', async (name) => {
    const [url, key] = ROUTES[name]();
    failGet(key, accessDenied());
    const res = await get(url);
    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
  });
});
