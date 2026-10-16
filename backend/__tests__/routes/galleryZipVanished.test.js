/**
 * Prepared archives removed between the stat and the read (issue 2129).
 *
 * - The prepared download (download-jobs/:token/file) answers 410, as the
 *   failed stat does, with the zip headers gone; it used to answer 500 under
 *   `application/zip` on S3, a corrupt download.
 * - Download All, whose cached archive getZipInfo() found, streams the
 *   archive instead, as it does when that stat misses.
 * Any other read error stays a 500. Through the real gallery router against
 * SQLite and local storage; S3 is its get() rejecting with NoSuchKey.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-zip-vanished-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'zip-vanished-test-secret-at-least-thirty-two';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-zip-vanished-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const SLUG = 'zip-vanished-gallery';
const CACHED = Buffer.from('PREBUILT-ZIP-BYTES');
const PREPARED = Buffer.from('PREPARED-ZIP-BYTES');

const unwrap = (rows) => rows[0]?.id ?? rows[0];
const binary = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('prepared archives removed between stat and read (issue 2129)', () => {
  let db; let cleanup; let app; let storage; let eventId; let jobs; let zips;
  let jobKey; let cacheKey; let jobToken;

  const notFoundOnS3 = () => Object.assign(new Error('The specified key does not exist.'),
    { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
  const accessDenied = () => Object.assign(new Error('Access Denied'),
    { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
  const removeAfterStat = (key) => {
    const realStat = storage.stat.bind(storage);
    jest.spyOn(storage, 'stat').mockImplementation(async (k) => {
      const found = await realStat(k);
      if (k === key) await storage.delete(k);
      return found;
    });
  };
  const failGet = (key, error) => {
    const realGet = storage.get.bind(storage);
    jest.spyOn(storage, 'get').mockImplementation(async (k, ...rest) => {
      if (k === key) throw error;
      return realGet(k, ...rest);
    });
  };
  const races = [
    ['removed from local storage', removeAfterStat],
    ['missing on S3', (key) => failGet(key, notFoundOnS3())],
  ];

  const auth = () => `Bearer ${jwt.sign({ type: 'gallery', eventId, eventSlug: SLUG },
    process.env.JWT_SECRET, { issuer: 'picpeak-auth', expiresIn: '1h' })}`;
  const get = (route) => request(app).get(`/api/gallery/${SLUG}/${route}`)
    .set('Authorization', auth()).buffer().parse(binary);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    storage = require('../../src/services/storage').getStorage();
    jobs = require('../../src/services/downloadJobService');
    zips = require('../../src/services/downloadZipService');

    eventId = unwrap(await db('events').insert({
      slug: SLUG, event_type: 'wedding', event_name: SLUG, event_date: '2026-10-15',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `/gallery/${SLUG}/s`, share_token: `${SLUG}-share`,
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, require_password: 0, allow_downloads: 1,
      created_at: new Date().toISOString(),
    }).returning('id'));
    await storage.put(`events/active/${SLUG}/only.jpg`, Buffer.from('only-photo-bytes'));
    const photoId = unwrap(await db('photos').insert({
      event_id: eventId, filename: 'only.jpg', path: `${SLUG}/only.jpg`, type: 'individual',
      media_type: 'image', mime_type: 'image/jpeg', uploaded_at: new Date().toISOString(),
    }).returning('id'));

    cacheKey = zips.getCacheKey(SLUG);
    jobToken = 'e'.repeat(64);
    jobKey = jobs.jobKey(SLUG, jobToken);
    await db('download_jobs').insert({
      token: jobToken, event_id: eventId, resolution: 'original',
      photo_ids: JSON.stringify([photoId]), delivered_photo_ids: JSON.stringify([photoId]),
      dedup_key: 'zip-vanished-dedup', visibility_scope: 'public', status: 'ready', zip_path: jobKey,
      photo_count: 1, heartbeat_at: new Date().toISOString(), created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3600e3).toISOString(),
    });

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 120000);

  beforeEach(async () => {
    await storage.put(jobKey, PREPARED);
    await storage.put(cacheKey, CACHED);
    await db('events').where({ id: eventId }).update({
      download_zip_path: cacheKey, download_zip_generated_at: new Date().toISOString(),
    });
    // The fallback would start a rebuild of the cache; not this test's business.
    jest.spyOn(zips, 'generateZip').mockResolvedValue({ success: false });
    jest.spyOn(jobs, 'isStillDeliverable').mockResolvedValue(true);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { if (cleanup) await cleanup(); });

  describe('the prepared download', () => {
    test('serves the archive when it is there', async () => {
      const res = await get(`download-jobs/${jobToken}/file`);
      expect(res.status).toBe(200);
      expect(res.body.equals(PREPARED)).toBe(true);
    });

    test.each(races)('an archive %s after the stat answers 410 without the zip headers', async (_label, race) => {
      race(jobKey);
      const res = await get(`download-jobs/${jobToken}/file`);
      expect(res.status).toBe(410);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(res.headers['content-disposition']).toBeUndefined();
      expect(res.headers['cache-control']).toBe('no-store');
    });

    test('any other read error stays a 500', async () => {
      failGet(jobKey, accessDenied());
      const res = await get(`download-jobs/${jobToken}/file`);
      expect(res.status).toBe(500);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(res.headers['content-disposition']).toBeUndefined();
    });
  });

  describe('Download All', () => {
    test('serves the cached archive when it is there', async () => {
      const res = await get('download-all');
      expect(res.status).toBe(200);
      expect(res.body.equals(CACHED)).toBe(true);
    });

    test.each(races)('a cached archive %s after the stat streams the archive instead', async (_label, race) => {
      race(cacheKey);
      const res = await get('download-all');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/zip');
      expect(res.headers['content-length']).toBeUndefined();
      // A zip built on the fly, holding the photo, not the cached bytes.
      expect(res.body.subarray(0, 2).toString()).toBe('PK');
      expect(res.body.includes(Buffer.from('only.jpg'))).toBe(true);
    });

    test('any other read error stays a 500', async () => {
      failGet(cacheKey, accessDenied());
      const res = await get('download-all');
      expect(res.status).toBe(500);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(res.headers['content-disposition']).toBeUndefined();
    });
  });
});
