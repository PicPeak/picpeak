/**
 * Hidden/client-only photo access control across the bulk + secure photo
 * routes (GHSA cluster: fpwq / ghf8 / 3jvw / 9cc4 / 2hqg / jc22).
 *
 * A photo with visibility='hidden' is client-only. The main photo-list and
 * single-photo download/view routes enforced this, but the bulk-download,
 * protected-image, and secure-image routes shipped without the check —
 * letting an ordinary guest reach hidden photos. These tests pin that
 * guests are refused and PIN-clients (accessLevel='client') still succeed.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-hidden-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'hidden-photo-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-hidden-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const SLUG = 'hidden-photo-test-event';

describe('hidden-photo access control (GHSA cluster)', () => {
  let db;
  let cleanup;
  let app;
  let eventId;
  let visibleId;
  let hiddenId;

  const guestToken = () => jwt.sign(
    { eventId, eventSlug: SLUG, type: 'gallery' },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' }
  );
  const clientToken = () => jwt.sign(
    { eventId, eventSlug: SLUG, type: 'gallery', accessLevel: 'client' },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' }
  );

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const inserted = await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Hidden Photo Test',
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'hidden-photo-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, allow_downloads: 1,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = inserted[0]?.id ?? inserted[0];

    const photoDir = path.join(process.env.STORAGE_PATH, 'events/active', SLUG);
    fs.mkdirSync(photoDir, { recursive: true });

    // A real 1x1 PNG so the protected /view route's Sharp processing path
    // succeeds (fake bytes 500 on metadata()). Content, not extension,
    // drives Sharp's format detection.
    const PNG_1x1 = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAQGV2rY9AAAAAElFTkSuQmCC',
      'base64'
    );
    const mkPhoto = async (filename, visibility) => {
      fs.writeFileSync(path.join(photoDir, filename), PNG_1x1);
      const p = await db('photos').insert({
        event_id: eventId,
        filename,
        path: `${SLUG}/${filename}`,
        type: 'individual',
        visibility,
        uploaded_at: new Date().toISOString(),
      }).returning('id');
      return p[0]?.id ?? p[0];
    };
    visibleId = await mkPhoto('visible.jpg', 'visible');
    hiddenId = await mkPhoto('hidden.jpg', 'hidden');

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
    app.use('/api/images', require('../../src/routes/protectedImages'));
    app.use('/api/secure-images', require('../../src/routes/secureImages'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  describe('download-selected (GHSA-ghf8, medium)', () => {
    it('omits a hidden photo for a guest even when its id is requested', async () => {
      const res = await request(app)
        .post(`/api/gallery/${SLUG}/download-selected`)
        .set('Authorization', `Bearer ${guestToken()}`)
        .send({ photo_ids: [visibleId, hiddenId] });
      // The visible photo still zips; the hidden one is filtered out. If
      // only the hidden id were requested, the filter empties the set → 404.
      expect(res.status).toBe(200);
      const solo = await request(app)
        .post(`/api/gallery/${SLUG}/download-selected`)
        .set('Authorization', `Bearer ${guestToken()}`)
        .send({ photo_ids: [hiddenId] });
      expect(solo.status).toBe(404);
    });

    it('includes the hidden photo for a client', async () => {
      const res = await request(app)
        .post(`/api/gallery/${SLUG}/download-selected`)
        .set('Authorization', `Bearer ${clientToken()}`)
        .send({ photo_ids: [hiddenId] });
      expect(res.status).toBe(200);
    });
  });

  describe('download-all (GHSA-fpwq, medium)', () => {
    it('streams for a guest without erroring (hidden photos filtered)', async () => {
      const res = await request(app)
        .get(`/api/gallery/${SLUG}/download-all`)
        .set('Authorization', `Bearer ${guestToken()}`);
      expect(res.status).toBe(200);
    });
  });

  describe('protected-image view (GHSA-9cc4)', () => {
    it('403s a hidden photo for a guest', async () => {
      const res = await request(app)
        .get(`/api/images/${SLUG}/photo/${hiddenId}/view`)
        .set('Authorization', `Bearer ${guestToken()}`);
      expect(res.status).toBe(403);
    });
    it('serves a visible photo for a guest', async () => {
      const res = await request(app)
        .get(`/api/images/${SLUG}/photo/${visibleId}/view`)
        .set('Authorization', `Bearer ${guestToken()}`);
      expect(res.status).toBe(200);
    });
    it('serves a hidden photo for a client', async () => {
      const res = await request(app)
        .get(`/api/images/${SLUG}/photo/${hiddenId}/view`)
        .set('Authorization', `Bearer ${clientToken()}`);
      expect(res.status).toBe(200);
    });
  });

  describe('signed-URL mint (GHSA-3jvw)', () => {
    it('403s minting a signed URL for a hidden photo as a guest', async () => {
      const res = await request(app)
        .post(`/api/images/${SLUG}/photo/${hiddenId}/generate-url`)
        .set('Authorization', `Bearer ${guestToken()}`);
      expect(res.status).toBe(403);
    });
    it('mints for a client', async () => {
      const res = await request(app)
        .post(`/api/images/${SLUG}/photo/${hiddenId}/generate-url`)
        .set('Authorization', `Bearer ${clientToken()}`);
      expect(res.status).toBe(200);
      expect(res.body.url).toContain('/signed/');
    });
  });

  describe('legacy secure-token mint (protectedImages generate-secure-token)', () => {
    it('403s a hidden photo for a guest', async () => {
      const res = await request(app)
        .post(`/api/images/${SLUG}/photo/${hiddenId}/generate-secure-token`)
        .set('Authorization', `Bearer ${guestToken()}`);
      expect(res.status).toBe(403);
    });
    it('mints for a client', async () => {
      const res = await request(app)
        .post(`/api/images/${SLUG}/photo/${hiddenId}/generate-secure-token`)
        .set('Authorization', `Bearer ${clientToken()}`);
      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
    });
  });

  describe('secure-token mint (GHSA-2hqg)', () => {
    it('403s minting a secure token for a hidden photo as a guest', async () => {
      const res = await request(app)
        .post(`/api/secure-images/${SLUG}/generate-token`)
        .set('Authorization', `Bearer ${guestToken()}`)
        .send({ photoId: hiddenId });
      expect(res.status).toBe(403);
    });
    it('mints for a client', async () => {
      const res = await request(app)
        .post(`/api/secure-images/${SLUG}/generate-token`)
        .set('Authorization', `Bearer ${clientToken()}`)
        .send({ photoId: hiddenId });
      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
    });
  });

  // A capability minted while a photo is visible must stop serving once the
  // photo is hidden — unless minted by a client (clientBypass in the token).
  describe('signed-URL TOCTOU (hidden AFTER minting)', () => {
    afterEach(async () => {
      await db('photos').where({ id: visibleId }).update({ visibility: 'visible' });
    });

    it("a guest's pre-minted signed URL stops serving once the photo is hidden", async () => {
      const mint = await request(app)
        .post(`/api/images/${SLUG}/photo/${visibleId}/generate-url`)
        .set('Authorization', `Bearer ${guestToken()}`);
      expect(mint.status).toBe(200);
      const url = mint.body.url;
      // Still visible → serves.
      expect((await request(app).get(url)).status).toBe(200);
      // Hide it → the guest token (no clientBypass) must now be refused.
      await db('photos').where({ id: visibleId }).update({ visibility: 'hidden' });
      expect((await request(app).get(url)).status).toBe(403);
    });

    it("a client's pre-minted signed URL keeps serving after the photo is hidden", async () => {
      const mint = await request(app)
        .post(`/api/images/${SLUG}/photo/${visibleId}/generate-url`)
        .set('Authorization', `Bearer ${clientToken()}`);
      expect(mint.status).toBe(200);
      const url = mint.body.url;
      await db('photos').where({ id: visibleId }).update({ visibility: 'hidden' });
      expect((await request(app).get(url)).status).toBe(200);
    });
  });
});
