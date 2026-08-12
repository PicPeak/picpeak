/**
 * SQLite boolean coercion in the guest gallery surface (#1028).
 *
 * SQLite stores booleans as 0/1; Postgres stores true/false. The /photos
 * payload and every download guard compared strictly against `true`/`false`,
 * so on SQLite:
 *
 *   allow_downloads:    0 !== false → true   (button shown while disabled)
 *   allow_user_uploads: 1 === true  → false  (button hidden while enabled)
 *   if (allow_downloads === false)  → never fires, so ALL download endpoints
 *                                     kept serving with downloads switched off
 *
 * The harness runs on SQLite, so these assertions exercise the real engine
 * values rather than a mock. Every test here fails on the unfixed code.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-sqlite-flags-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'sqlite-flags-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-sqlite-flags-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const SLUG = 'sqlite-flags-gallery';

describe('gallery flags survive SQLite 0/1 storage (#1028)', () => {
  let db; let cleanup; let app; let eventId; let photoId;

  async function setEventFlags(patch) {
    await db('events').where('id', eventId).update(patch);
  }

  async function getPayload() {
    const res = await request(app).get(`/api/gallery/${SLUG}/photos`);
    expect(res.status).toBe(200);
    return res.body.event;
  }

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const ev = await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'SQLite Flags',
      event_date: '2026-08-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/s`,
      share_token: 'sqlite-flags-share',
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      // Password-free so verifyGalleryAccess takes the public path and loads
      // the row with SELECT * — i.e. the raw 0/1 values, same as production.
      require_password: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = ev[0]?.id ?? ev[0];

    const ph = await db('photos').insert({
      event_id: eventId,
      filename: 'p.jpg',
      path: `${SLUG}/p.jpg`,
      type: 'individual',
      uploaded_at: new Date().toISOString(),
    }).returning('id');
    photoId = ph[0]?.id ?? ph[0];

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  test('the engine under test really is SQLite storing 0/1', async () => {
    expect(['sqlite3', 'better-sqlite3']).toContain(db.client.config.client);
    await setEventFlags({ allow_downloads: 0 });
    const row = await db('events').where('id', eventId).first('allow_downloads');
    expect(row.allow_downloads).toBe(0);
  });

  describe('with downloads disabled (allow_downloads = 0)', () => {
    beforeAll(async () => {
      await setEventFlags({ allow_downloads: 0, allow_user_uploads: 1 });
    });

    test('payload reports allow_downloads false (was true — header button shown)', async () => {
      expect((await getPayload()).allow_downloads).toBe(false);
    });

    test('payload reports allow_user_uploads true (was false — upload button hidden)', async () => {
      expect((await getPayload()).allow_user_uploads).toBe(true);
    });

    test('single-photo download is refused', async () => {
      const res = await request(app).get(`/api/gallery/${SLUG}/download/${photoId}`);
      expect(res.status).toBe(403);
    });

    test('download-all is refused', async () => {
      const res = await request(app).get(`/api/gallery/${SLUG}/download-all`);
      expect(res.status).toBe(403);
    });

    test('download-selected is refused', async () => {
      const res = await request(app)
        .post(`/api/gallery/${SLUG}/download-selected`)
        .send({ photo_ids: [photoId] });
      expect(res.status).toBe(403);
    });

    test('download-jobs is refused', async () => {
      const res = await request(app).post(`/api/gallery/${SLUG}/download-jobs`).send({});
      expect(res.status).toBe(403);
    });
  });

  describe('with downloads enabled (allow_downloads = 1)', () => {
    beforeAll(async () => {
      await setEventFlags({ allow_downloads: 1, allow_user_uploads: 0 });
    });

    test('payload reports allow_downloads true / allow_user_uploads false', async () => {
      const event = await getPayload();
      expect(event.allow_downloads).toBe(true);
      expect(event.allow_user_uploads).toBe(false);
    });

    test('download-all is no longer refused', async () => {
      const res = await request(app).get(`/api/gallery/${SLUG}/download-all`);
      expect(res.status).not.toBe(403);
    });
  });

  describe('protection flags', () => {
    test('0/1 protection toggles are reported the way they are stored', async () => {
      await setEventFlags({
        disable_right_click: 1,
        enable_devtools_protection: 1,
        use_canvas_rendering: 1,
        watermark_downloads: 1,
        overlay_protection: 0,
      });
      const event = await getPayload();
      expect(event.disable_right_click).toBe(true);
      expect(event.enable_devtools_protection).toBe(true);
      expect(event.use_canvas_rendering).toBe(true);
      expect(event.watermark_downloads).toBe(true);
      expect(event.overlay_protection).toBe(false);
    });
  });

  describe('per-category download blocking (#640) on SQLite', () => {
    test('a category with allow_downloads = 0 is reported as blocked', async () => {
      const cat = await db('photo_categories').insert({
        name: 'Blocked', slug: 'blocked', event_id: eventId, is_global: 0, allow_downloads: 0,
      }).returning('id');
      const categoryId = cat[0]?.id ?? cat[0];
      await db('photos').where('id', photoId).update({ category_id: categoryId });

      await setEventFlags({ allow_downloads: 1 });
      const res = await request(app).get(`/api/gallery/${SLUG}/photos`);
      expect(res.status).toBe(200);

      const category = res.body.categories.find((c) => c.id === categoryId);
      expect(category.allow_downloads).toBe(false);
      const photo = res.body.photos.find((p) => p.id === photoId);
      expect(photo.category_allow_downloads).toBe(false);

      // …and the per-category guard on the single-photo route fires.
      const dl = await request(app).get(`/api/gallery/${SLUG}/download/${photoId}`);
      expect(dl.status).toBe(403);
    });
  });
});
