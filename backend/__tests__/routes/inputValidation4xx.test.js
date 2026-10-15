/**
 * Input validation gaps (issues 2078 and 2086): requests that answered 500,
 * or silently accepted a bad value, now answer a 4xx — and a few small data
 * inconsistencies around uploads, delivery counts and transfers.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-validation-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'validation-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-validation-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const { requireOctetStreamChunk } = require('../../src/middleware/chunkBodyType');
const { parsePositiveInt32 } = require('../../src/utils/parsers');

const SLUG = 'validation-event';

describe('input validation (issues 2078, 2086)', () => {
  let db; let cleanup; let app;
  let eventId; let photoId; let pendingPhotoId; let rejectedPhotoId;
  let adminToken;

  const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);
  const gallery = (extra = {}) => jwt.sign(
    { eventId, eventSlug: SLUG, type: 'gallery', ...extra },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' },
  );
  const asGuest = (req) => req.set('Authorization', `Bearer ${gallery()}`);
  const asClient = (req) => req.set('Authorization', `Bearer ${gallery({ accessLevel: 'client' })}`);
  const asAdmin = (req) => req.set('Authorization', `Bearer ${adminToken}`);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    eventId = unwrap(await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Validation',
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'validation-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      allow_downloads: 1,
      created_at: new Date().toISOString(),
    }).returning('id'));

    const addPhoto = async (filename, extra = {}) => unwrap(await db('photos').insert({
      event_id: eventId,
      filename,
      path: `${SLUG}/${filename}`,
      type: 'individual',
      uploaded_at: new Date().toISOString(),
      ...extra,
    }).returning('id'));
    photoId = await addPhoto('ok.jpg');
    pendingPhotoId = await addPhoto('pending.jpg', { moderation_status: 'pending', visibility: 'hidden' });
    rejectedPhotoId = await addPhoto('rejected.jpg', { moderation_status: 'rejected', visibility: 'hidden' });

    await db('event_feedback_settings').insert({
      event_id: eventId,
      feedback_enabled: true,
      allow_likes: true,
      allow_comments: true,
      allow_ratings: true,
      allow_favorites: true,
      moderate_comments: false,
      show_feedback_to_guests: true,
    });

    const superRole = await db('roles').where({ name: 'super_admin' }).first();
    const adminId = unwrap(await db('admin_users').insert({
      username: 'validation-admin',
      email: 'validation-admin@example.com',
      password_hash: await bcrypt.hash('ValidationAdmin123', 4),
      role_id: superRole.id,
      is_active: 1,
      created_at: new Date(),
      updated_at: new Date(),
    }).returning('id'));
    adminToken = jwt.sign(
      { id: adminId, username: 'validation-admin', type: 'admin', role: 'super_admin', loginTime: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' },
    );

    // The transfers routes sit behind their feature flag.
    await db('feature_flags').where({ key: 'transfers' }).del();
    await db('feature_flags').insert({ key: 'transfers', value: 1 });

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
    app.use('/api/gallery', require('../../src/routes/galleryFeedback'));
    app.use('/api/admin/events', require('../../src/routes/adminEvents'));
    app.use('/api/admin/photos', require('../../src/routes/adminPhotos'));
    app.use('/api/admin/external-media', require('../../src/routes/adminExternalMedia'));
    app.use('/api/admin/transfers', require('../../src/routes/adminTransfers'));
    app.use('/api/admin', require('../../src/routes/adminDelivery'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  describe('parsePositiveInt32', () => {
    it('takes digits within int4 and nothing else', () => {
      expect(parsePositiveInt32('7')).toBe(7);
      expect(parsePositiveInt32(7)).toBe(7);
      expect(parsePositiveInt32('2147483647')).toBe(2147483647);
      for (const bad of ['0', '-1', '1e3', '1.5', 'abc', '', '2147483648', '99999999999999999999', null, undefined, true, 1.5, [1]]) {
        expect(parsePositiveInt32(bad)).toBeNull();
      }
    });
  });

  describe('gallery photo routes (issue 2078)', () => {
    it.each(['1e3', '99999999999999999999', 'abc', '1.5'])('answers 404 for photo id %s', async (id) => {
      const media = await asGuest(request(app).get(`/api/gallery/${SLUG}/photo/${id}`));
      expect(media.status).toBe(404);
      const download = await asGuest(request(app).get(`/api/gallery/${SLUG}/download/${id}`));
      expect(download.status).toBe(404);
      const thumb = await asGuest(request(app).get(`/api/gallery/${SLUG}/thumbnail/${id}`));
      expect(thumb.status).toBe(404);
    });

    it('still serves a real photo id past the guard', async () => {
      const res = await asGuest(request(app).post(`/api/gallery/${SLUG}/photo/${photoId}/view`));
      expect(res.status).toBe(204);
    });
  });

  describe('visibility routes (issue 2078)', () => {
    it('refuses a non-numeric id on the single route with 400', async () => {
      const res = await asClient(request(app).patch(`/api/gallery/${SLUG}/photos/abc/visibility`))
        .send({ visibility: 'hidden' });
      expect(res.status).toBe(400);
    });

    it('refuses non-numeric and overflowing ids in the bulk route with 400', async () => {
      for (const photoIds of [['a'], [99999999999], [photoId, '1e3']]) {
        const res = await asClient(request(app).patch(`/api/gallery/${SLUG}/photos/visibility/bulk`))
          .send({ photoIds, visibility: 'hidden' });
        expect(res.status).toBe(400);
      }
    });

    it('still updates real ids', async () => {
      const res = await asClient(request(app).patch(`/api/gallery/${SLUG}/photos/visibility/bulk`))
        .send({ photoIds: [photoId], visibility: 'visible' });
      expect(res.status).toBe(200);
    });
  });

  describe('feedback routes (issue 2078)', () => {
    it('refuses an int4-overflowing id with 400', async () => {
      const get = await asGuest(request(app).get(`/api/gallery/${SLUG}/photos/99999999999/feedback`));
      expect(get.status).toBe(400);
      const post = await asGuest(request(app).post(`/api/gallery/${SLUG}/photos/99999999999/feedback`))
        .send({ feedback_type: 'like' });
      expect(post.status).toBe(400);
    });

    it('refuses an overflowing id in the bulk rating with 400', async () => {
      const res = await asGuest(request(app).post(`/api/gallery/${SLUG}/feedback/bulk`))
        .send({ photo_ids: [99999999999], rating: 5 });
      expect(res.status).toBe(400);
    });

    it('does not serve feedback on a photo under review', async () => {
      for (const id of [pendingPhotoId, rejectedPhotoId]) {
        const get = await asGuest(request(app).get(`/api/gallery/${SLUG}/photos/${id}/feedback`));
        expect(get.status).toBeGreaterThanOrEqual(400);
        expect(get.status).toBeLessThan(500);
        const post = await asGuest(request(app).post(`/api/gallery/${SLUG}/photos/${id}/feedback`))
          .send({ feedback_type: 'like' });
        expect(post.status).toBeGreaterThanOrEqual(400);
        expect(post.status).toBeLessThan(500);
      }
    });
  });

  describe('view beacon on a photo under review (issue 2086)', () => {
    it('answers 403, not 204, and counts nothing', async () => {
      const res = await asGuest(request(app).post(`/api/gallery/${SLUG}/photo/${pendingPhotoId}/view`));
      expect(res.status).toBe(403);
      expect((await db('photos').where({ id: pendingPhotoId }).first()).view_count || 0).toBe(0);
    });
  });

  describe('admin events (issue 2078)', () => {
    it('ignores an unknown field in an update instead of answering 500', async () => {
      const res = await asAdmin(request(app).put(`/api/admin/events/${eventId}`))
        .send({ bogus_field: 'x', event_name: 'Renamed' });
      expect(res.status).toBe(200);
      expect((await db('events').where({ id: eventId }).first()).event_name).toBe('Renamed');
    });

    it('ignores a body of only unknown fields', async () => {
      const res = await asAdmin(request(app).put(`/api/admin/events/${eventId}`)).send({ bogus_field: 'x' });
      expect(res.status).toBe(200);
    });

    it('refuses a negative limit with 400', async () => {
      const res = await asAdmin(request(app).get('/api/admin/events?limit=-5'));
      expect(res.status).toBe(400);
    });

    it('caps an oversized limit', async () => {
      const res = await asAdmin(request(app).get('/api/admin/events?limit=100000'));
      expect(res.status).toBe(200);
      expect(res.body.pagination.limit).toBe(500);
    });
  });

  describe('external media sources (issue 2078)', () => {
    it.each([{}, { path: 'does/not/exist' }, { path: 42 }])('answers 4xx for %j', async (body) => {
      const res = await asAdmin(request(app).put('/api/admin/external-media/sources')).send({ owner_id: null, ...body });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });
  });

  describe('bulk-update folder_id (issue 2078)', () => {
    const bulk = (folder_id) => asAdmin(request(app).post(`/api/admin/photos/${eventId}/photos/bulk-update`))
      .send({ photoIds: [photoId], updates: { folder_id } });

    it.each(['abc', true, -1, 1.5, '1e3', {}, 99999999999])('refuses %j with 400', async (value) => {
      const res = await bulk(value);
      expect(res.status).toBe(400);
    });

    it('still treats null and 0 as the gallery root', async () => {
      expect((await bulk(null)).status).toBe(200);
      expect((await bulk(0)).status).toBe(200);
    });
  });

  describe('chunk body type (issue 2078)', () => {
    const chunkApp = () => {
      const a = express();
      a.use('/api/admin/photos', requireOctetStreamChunk);
      a.use(express.json({ limit: '2mb' }));
      a.post('/api/admin/photos/:eventId/chunked-upload/:uploadId/chunk/:chunkIndex', (req, res) => res.json({ ok: true }));
      a.post('/api/admin/photos/:eventId/other', (req, res) => res.json({ body: req.body }));
      return a;
    };
    const url = '/api/admin/photos/1/chunked-upload/abc/chunk/0';

    it('answers 415 for a chunk sent as JSON, before any parser reads it', async () => {
      const res = await request(chunkApp()).post(url)
        .set('Content-Type', 'application/json')
        .send(Buffer.alloc(64 * 1024, 'a'));
      expect(res.status).toBe(415);
      expect(res.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    });

    it('lets an octet-stream chunk through, and leaves other routes alone', async () => {
      const ok = await request(chunkApp()).post(url).set('Content-Type', 'application/octet-stream').send(Buffer.from('x'));
      expect(ok.status).toBe(200);
      const other = await request(chunkApp()).post('/api/admin/photos/1/other').send({ a: 1 });
      expect(other.body).toEqual({ body: { a: 1 } });
    });

    it('maps an oversized body to 413 with PAYLOAD_TOO_LARGE rather than INTERNAL_ERROR', async () => {
      const { errorHandler } = require('../../src/middleware/errorHandler');
      const a = express();
      a.use(express.json({ limit: '1kb' }));
      a.post('/x', (req, res) => res.json({}));
      a.use(errorHandler);
      const res = await request(a).post('/x').send({ blob: 'a'.repeat(5000) });
      expect(res.status).toBe(413);
      expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
    });
  });

  describe('delivery count (issue 2086)', () => {
    it('leaves a photo under review or rejected out of delivered_count', async () => {
      const res = await asAdmin(request(app).get(`/api/admin/events/${eventId}/delivery`));
      expect(res.status).toBe(200);
      expect(res.body.delivered_count).toBe(1);
    });
  });

  describe('transfer from photos that are not there (issue 2086)', () => {
    it('refuses a transfer whose photo ids name no photo, creating nothing', async () => {
      const before = await db('transfers').count('* as c').first();
      const res = await asAdmin(request(app).post('/api/admin/transfers'))
        .field('photoIds', JSON.stringify([987654, 987655]));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('NOTHING_TO_SEND');
      const after = await db('transfers').count('* as c').first();
      expect(Number(after.c)).toBe(Number(before.c));
    });

    it('still creates one from a real photo', async () => {
      const res = await asAdmin(request(app).post('/api/admin/transfers'))
        .field('photoIds', JSON.stringify([photoId]));
      expect(res.status).toBe(201);
    });
  });
});
