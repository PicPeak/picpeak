/**
 * Per-photo engagement counters (#895).
 *
 * Pins the contract that the admin EVENT > IMAGES table depends on:
 *  - photos.view_count increments when the full-size photo is served
 *    (it existed in the schema + admin UI but had NO writer at all)
 *  - the slideshow kiosk never increments views (migration 138 design)
 *  - single-photo downloads increment download_count (regression pin)
 *  - zip downloads (download-all, download-selected) increment
 *    download_count for the contained photos — previously they didn't,
 *    so zip-heavy galleries showed 0 per-photo downloads forever
 *  - the admin event-detail total_downloads counts singles AND zips
 *    (it counted action='download' only, disagreeing with the dashboard)
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-engagement-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'engagement-test-secret';
// Real files on disk so /photo and the zip routes actually stream bytes.
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-engagement-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const SLUG = 'engagement-test-event';

describe('photo engagement counters (#895)', () => {
  let db;
  let cleanup;
  let app;
  let eventId;
  let photoIds;
  let adminToken;

  const galleryToken = (extra = {}) => jwt.sign(
    { eventId, eventSlug: SLUG, type: 'gallery', ...extra },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' }
  );

  const getPhoto = async (id) => db('photos').where('id', id).first();
  // The counter writes are fire-and-forget on purpose — give the event
  // loop a beat before asserting.
  const settle = () => new Promise((r) => setTimeout(r, 400));

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const inserted = await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Engagement Test',
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'engagement-test-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      allow_downloads: 1,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = inserted[0]?.id ?? inserted[0];

    const photoDir = path.join(process.env.STORAGE_PATH, 'events/active', SLUG);
    fs.mkdirSync(photoDir, { recursive: true });

    photoIds = [];
    for (let i = 0; i < 3; i++) {
      const filename = `photo-${i}.jpg`;
      fs.writeFileSync(path.join(photoDir, filename), Buffer.from(`fake-jpeg-bytes-${i}`));
      const p = await db('photos').insert({
        event_id: eventId,
        filename,
        path: `${SLUG}/${filename}`,
        type: 'individual',
        uploaded_at: new Date().toISOString(),
      }).returning('id');
      photoIds.push(p[0]?.id ?? p[0]);
    }

    const superRole = await db('roles').where({ name: 'super_admin' }).first();
    const [rootId] = await db('admin_users').insert({
      username: 'engagement-admin',
      email: 'engagement-admin@example.com',
      password_hash: await bcrypt.hash('EngagementAdmin123', 4),
      role_id: superRole.id,
      is_active: 1,
      created_at: new Date(),
      updated_at: new Date(),
    }).returning('id').then((r) => [r[0]?.id || r[0]]);
    adminToken = jwt.sign(
      { id: rootId, username: 'engagement-admin', type: 'admin', role: 'super_admin', loginTime: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' }
    );

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
    app.use('/api/admin/events', require('../../src/routes/adminEvents'));
    app.use('/api/admin/photos', require('../../src/routes/adminPhotos'));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  beforeEach(async () => {
    await db('photos').where('event_id', eventId).update({ view_count: 0, download_count: 0 });
    await db('access_logs').where('event_id', eventId).del();
  });

  describe('view_count via the view beacon (#895 — previously never written)', () => {
    const beacon = (photoId, token = galleryToken()) => request(app)
      .post(`/api/gallery/${SLUG}/photo/${photoId}/view`)
      .set('Authorization', `Bearer ${token}`);

    it('increments exactly the beaconed photo', async () => {
      expect((await beacon(photoIds[0])).status).toBe(204);
      expect((await getPhoto(photoIds[0])).view_count).toBe(1);

      expect((await beacon(photoIds[0])).status).toBe(204);
      expect((await getPhoto(photoIds[0])).view_count).toBe(2);
      // Other photos untouched
      expect((await getPhoto(photoIds[1])).view_count).toBe(0);
    });

    it('serving the image bytes does NOT count (preloads must not inflate)', async () => {
      const res = await request(app)
        .get(`/api/gallery/${SLUG}/photo/${photoIds[0]}`)
        .set('Authorization', `Bearer ${galleryToken()}`);
      expect(res.status).toBe(200);
      await settle();
      expect((await getPhoto(photoIds[0])).view_count).toBe(0);
    });

    it('rejects the slideshow kiosk (migration 138 design)', async () => {
      const res = await beacon(photoIds[0], galleryToken({ accessLevel: 'slideshow' }));
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect((await getPhoto(photoIds[0])).view_count).toBe(0);
    });

    it("404s a photo that isn't in the event", async () => {
      const res = await beacon(999999);
      expect(res.status).toBe(404);
    });
  });

  describe('download_count', () => {
    it('single-photo download increments (regression pin)', async () => {
      const res = await request(app)
        .get(`/api/gallery/${SLUG}/download/${photoIds[0]}`)
        .set('Authorization', `Bearer ${galleryToken()}`);
      expect(res.status).toBe(200);
      await settle();
      expect((await getPhoto(photoIds[0])).download_count).toBe(1);
      expect((await getPhoto(photoIds[1])).download_count).toBe(0);
    });

    it('download-selected increments exactly the selected photos (#895)', async () => {
      const res = await request(app)
        .post(`/api/gallery/${SLUG}/download-selected`)
        .set('Authorization', `Bearer ${galleryToken()}`)
        .send({ photo_ids: [photoIds[0], photoIds[1]] });
      expect(res.status).toBe(200);
      await settle();
      expect((await getPhoto(photoIds[0])).download_count).toBe(1);
      expect((await getPhoto(photoIds[1])).download_count).toBe(1);
      expect((await getPhoto(photoIds[2])).download_count).toBe(0);
    });

    it('download-all increments every downloadable photo (#895)', async () => {
      const res = await request(app)
        .get(`/api/gallery/${SLUG}/download-all`)
        .set('Authorization', `Bearer ${galleryToken()}`);
      expect(res.status).toBe(200);
      await settle();
      for (const id of photoIds) {
        expect((await getPhoto(id)).download_count).toBe(1);
      }
    });

    it('skipped archive entries do not count (missing source file)', async () => {
      // Own event so the on-the-fly archiver path is guaranteed — the
      // main event may have a cached zip from the previous test's
      // background generation, and racing its build/invalidate hangs.
      // The route also fires a background pre-zip build after streaming;
      // against this event's intentionally missing file it crashes with
      // an async ENOENT that jest attributes to whatever test is running
      // by then — neutralize it, it's not under test here.
      const downloadZipService = require('../../src/services/downloadZipService');
      const generateZipSpy = jest.spyOn(downloadZipService, 'generateZip')
        .mockResolvedValue({ success: false, error: 'disabled in test' });
      const slug2 = `${SLUG}-skip`;
      const ev = await db('events').insert({
        slug: slug2,
        event_type: 'wedding',
        event_name: 'Engagement Skip Test',
        event_date: '2026-08-01',
        host_email: 'host@example.com',
        admin_email: 'admin@example.com',
        password_hash: 'x',
        share_link: `/gallery/${slug2}/share`,
        share_token: 'engagement-skip-share',
        expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
        is_active: 1,
        is_archived: 0,
        is_draft: 0,
        allow_downloads: 1,
        created_at: new Date().toISOString(),
      }).returning('id');
      const eventId2 = ev[0]?.id ?? ev[0];
      const dir2 = path.join(process.env.STORAGE_PATH, 'events/active', slug2);
      fs.mkdirSync(dir2, { recursive: true });
      const ids2 = [];
      for (let i = 0; i < 2; i++) {
        // Only photo 0 gets a real file — photo 1's source is missing.
        if (i === 0) fs.writeFileSync(path.join(dir2, `photo-${i}.jpg`), Buffer.from('skip-test-bytes'));
        const p = await db('photos').insert({
          event_id: eventId2,
          filename: `photo-${i}.jpg`,
          path: `${slug2}/photo-${i}.jpg`,
          type: 'individual',
          uploaded_at: new Date().toISOString(),
        }).returning('id');
        ids2.push(p[0]?.id ?? p[0]);
      }
      const token2 = jwt.sign(
        { eventId: eventId2, eventSlug: slug2, type: 'gallery' },
        process.env.JWT_SECRET,
        { expiresIn: '1h', issuer: 'picpeak-auth' }
      );

      const res = await request(app)
        .get(`/api/gallery/${slug2}/download-all`)
        .set('Authorization', `Bearer ${token2}`);
      expect(res.status).toBe(200);
      await settle();
      expect((await db('photos').where('id', ids2[0]).first()).download_count).toBe(1);
      // photo-1's source was missing → skipped from the zip → not counted
      expect((await db('photos').where('id', ids2[1]).first()).download_count).toBe(0);
      generateZipSpy.mockRestore();
    });
  });

  describe('admin photos list exposes the counters (#895 follow-up)', () => {
    it('returns view_count and download_count so the Engagement column can render them', async () => {
      // The list mapper builds an explicit object — before this fix it
      // omitted both fields, so the admin table showed 0 forever even
      // though the DB counted correctly.
      await request(app)
        .post(`/api/gallery/${SLUG}/photo/${photoIds[0]}/view`)
        .set('Authorization', `Bearer ${galleryToken()}`);
      await request(app)
        .get(`/api/gallery/${SLUG}/download/${photoIds[0]}`)
        .set('Authorization', `Bearer ${galleryToken()}`);
      await settle();

      const res = await request(app)
        .get(`/api/admin/photos/${eventId}/photos`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      const row = res.body.photos.find((p) => p.id === photoIds[0]);
      expect(row.view_count).toBe(1);
      expect(row.download_count).toBe(1);
      const untouched = res.body.photos.find((p) => p.id === photoIds[1]);
      expect(untouched.view_count).toBe(0);
      expect(untouched.download_count).toBe(0);
    });
  });

  describe('admin event-detail total_downloads (#895 — one definition everywhere)', () => {
    it('counts singles and every zip variant, one row each', async () => {
      const row = (action) => ({
        event_id: eventId,
        ip_address: '127.0.0.1',
        user_agent: 'jest',
        action,
      });
      await db('access_logs').insert([
        row('download'),
        row('download_all'),
        row('download_all_presigned'),
        row('download_selected'),
        row('view'), // not a download
      ]);

      const res = await request(app)
        .get(`/api/admin/events/${eventId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.total_downloads).toBe(4);
    });
  });
});
