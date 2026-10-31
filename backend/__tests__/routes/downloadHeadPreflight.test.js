/**
 * HEAD on the single-file download routes (issue 2304). The app sends a HEAD
 * before it navigates a link at a video's download URL, so a refusal or a
 * missing file shows in the app instead of as a failed download in the
 * browser. The HEAD must run the full auth chain and the stat, carry the
 * Content-Disposition, and never open the file or count a download. Through
 * the real routers against SQLite and local storage.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-dl-head-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'download-head-test-secret-at-least-thirty-two';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-dl-head-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const SLUG = 'download-head-event';
const KEY = `events/active/${SLUG}/clip.mp4`;
const BYTES = Buffer.from('video bytes that a HEAD must never read');
const unwrap = (rows) => rows[0]?.id ?? rows[0];

describe('HEAD on the download routes (issue 2304)', () => {
  let db; let cleanup; let app; let storage; let eventId; let photoId; let adminToken;

  const galleryToken = () => jwt.sign(
    { type: 'gallery', eventId, eventSlug: SLUG, iat: Math.floor(Date.now() / 1000) - 60, jti: crypto.randomUUID() },
    process.env.JWT_SECRET, { issuer: 'picpeak-auth', expiresIn: '1h' },
  );
  const adminUrl = () => `/api/admin/photos/${eventId}/photos/${photoId}/download`;
  const guestUrl = () => `/api/gallery/${SLUG}/download/${photoId}`;
  const downloadCount = async () => (await db('photos').where('id', photoId).first()).download_count || 0;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    storage = require('../../src/services/storage').getStorage();

    eventId = unwrap(await db('events').insert({
      slug: SLUG, event_type: 'wedding', event_name: SLUG, event_date: '2026-10-27',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `/gallery/${SLUG}/s`, share_token: `${SLUG}-share`,
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, require_password: 1, allow_downloads: 1,
      created_at: new Date().toISOString(),
    }).returning('id'));
    photoId = unwrap(await db('photos').insert({
      event_id: eventId, filename: 'clip.mp4', path: `${SLUG}/clip.mp4`, type: 'individual',
      source_origin: 'managed', media_type: 'video', mime_type: 'video/mp4',
      processing_status: 'complete', uploaded_at: new Date().toISOString(),
    }).returning('id'));

    const superRole = await db('roles').where({ name: 'super_admin' }).first();
    const adminId = unwrap(await db('admin_users').insert({
      username: 'head-admin', email: 'head-admin@example.com', password_hash: 'x',
      role_id: superRole.id, is_active: 1,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).returning('id'));
    adminToken = jwt.sign(
      { id: adminId, username: 'head-admin', type: 'admin', role: 'super_admin', loginTime: Date.now() },
      process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' },
    );

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/photos', require('../../src/routes/adminPhotos'));
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 120000);

  beforeEach(async () => {
    await storage.put(KEY, BYTES);
    jest.spyOn(storage, 'get');
    jest.spyOn(storage, 'getRange');
    jest.spyOn(fs, 'createReadStream');
  });

  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { if (cleanup) await cleanup(); });

  const expectNothingRead = () => {
    expect(storage.get).not.toHaveBeenCalled();
    expect(storage.getRange).not.toHaveBeenCalled();
    expect(fs.createReadStream).not.toHaveBeenCalled();
  };

  describe.each([
    ['admin', () => adminUrl(), () => `Bearer ${adminToken}`],
    ['guest', () => guestUrl(), () => `Bearer ${galleryToken()}`],
  ])('the %s download route', (_label, url, auth) => {
    it('answers 200 with the download headers and no body, reading nothing', async () => {
      const before = await downloadCount();
      const res = await request(app).head(url()).set('Authorization', auth());

      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toMatch(/^attachment;.*clip\.mp4/);
      expect(res.headers['content-type']).toMatch(/^video\/mp4/);
      expect(res.headers['content-length']).toBe(String(BYTES.length));
      expect(res.text).toBeUndefined();
      expectNothingRead();
      // A probe is not a download.
      expect(await downloadCount()).toBe(before);
    });

    it('enforces the auth chain: no credentials, 401', async () => {
      const res = await request(app).head(url());

      expect(res.status).toBe(401);
      expect(res.headers['content-disposition']).toBeUndefined();
      expectNothingRead();
    });

    it('answers 404 when the file is gone', async () => {
      await storage.delete(KEY);
      const res = await request(app).head(url()).set('Authorization', auth());

      expect(res.status).toBe(404);
      expect(res.headers['content-disposition']).toBeUndefined();
      expectNothingRead();
    });
  });

  it('a GET still streams the file (the admin route)', async () => {
    const res = await request(app).get(adminUrl()).set('Authorization', `Bearer ${adminToken}`)
      .buffer(true).parse((r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });

    expect(res.status).toBe(200);
    expect(res.body.equals(BYTES)).toBe(true);
  });
});
