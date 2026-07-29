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
  const settle = () => new Promise((r) => setTimeout(r, 100));

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
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  beforeEach(async () => {
    await db('photos').where('event_id', eventId).update({ view_count: 0, download_count: 0 });
    await db('access_logs').where('event_id', eventId).del();
  });

  describe('view_count (#895 — previously never written)', () => {
    it('increments when the full-size photo is served', async () => {
      const res = await request(app)
        .get(`/api/gallery/${SLUG}/photo/${photoIds[0]}`)
        .set('Authorization', `Bearer ${galleryToken()}`);
      expect(res.status).toBe(200);
      await settle();
      expect((await getPhoto(photoIds[0])).view_count).toBe(1);

      await request(app)
        .get(`/api/gallery/${SLUG}/photo/${photoIds[0]}`)
        .set('Authorization', `Bearer ${galleryToken()}`);
      await settle();
      expect((await getPhoto(photoIds[0])).view_count).toBe(2);
      // Other photos untouched
      expect((await getPhoto(photoIds[1])).view_count).toBe(0);
    });

    it('does NOT count the slideshow kiosk (migration 138 design)', async () => {
      const res = await request(app)
        .get(`/api/gallery/${SLUG}/photo/${photoIds[0]}`)
        .set('Authorization', `Bearer ${galleryToken({ accessLevel: 'slideshow' })}`);
      expect(res.status).toBe(200);
      await settle();
      expect((await getPhoto(photoIds[0])).view_count).toBe(0);
    });

    it('does NOT count follow-up video Range requests (seeks are not views)', async () => {
      await db('photos').where('id', photoIds[2]).update({ media_type: 'video', mime_type: 'video/mp4' });
      try {
        await request(app)
          .get(`/api/gallery/${SLUG}/photo/${photoIds[2]}`)
          .set('Authorization', `Bearer ${galleryToken()}`)
          .set('Range', 'bytes=5-');
        await settle();
        expect((await getPhoto(photoIds[2])).view_count).toBe(0);

        // The opening request (start of playback) does count.
        await request(app)
          .get(`/api/gallery/${SLUG}/photo/${photoIds[2]}`)
          .set('Authorization', `Bearer ${galleryToken()}`)
          .set('Range', 'bytes=0-');
        await settle();
        expect((await getPhoto(photoIds[2])).view_count).toBe(1);
      } finally {
        await db('photos').where('id', photoIds[2]).update({ media_type: null, mime_type: null });
      }
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
