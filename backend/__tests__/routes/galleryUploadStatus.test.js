/**
 * Guest-facing upload processing status + cache headers on the gallery router
 * (testplan REPORT.md B6 / B7).
 *
 * B7: a guest upload is queued — POST /gallery/:eventId/upload answers 202 and
 * /gallery/:slug/photos only returns rows that reached 'complete'. Without a
 * status signal the gallery has to poll the photo list blind and cannot tell a
 * slow worker from a photo that failed outright. The contract that matters
 * most here is the authorization scope: the endpoint is keyed on an opaque
 * upload_id, so it must never report on an upload belonging to a gallery the
 * caller's token did not unlock.
 *
 * B6: the private per-guest JSON on this router carried no Cache-Control at
 * all and fell back to heuristic freshness. The media routes must keep their
 * own caching — the point of the change is that it is per route, not global.
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'upload-status-test-secret';

const SLUG_A = 'upload-status-a';
const SLUG_B = 'upload-status-b';

// Shape of a real guest upload id: crypto.randomBytes(16).toString('hex').
const UPLOAD_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const UPLOAD_A2 = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const UPLOAD_B = 'ffeeddccbbaa99887766554433221100';

describe('gallery upload status + cache headers (B6/B7)', () => {
  let db;
  let cleanup;
  let app;
  let eventA;
  let eventB;

  const galleryToken = (eventId, slug, extra = {}) => jwt.sign(
    { eventId, eventSlug: slug, type: 'gallery', ...extra },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' }
  );

  const createEvent = async (slug, name) => {
    const inserted = await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: name,
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${slug}/share`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      allow_user_uploads: 1,
      created_at: new Date().toISOString(),
    }).returning('id');
    return inserted[0]?.id ?? inserted[0];
  };

  // `status: undefined` writes no processing_status at all, so the column
  // default ('complete', migration 085) applies — the shape a row imported by
  // a path that predates async processing has.
  const addPhoto = async (eventId, filename, uploadId, status) => {
    await db('photos').insert({
      event_id: eventId,
      filename,
      path: `events/${filename}`,
      type: 'individual',
      upload_id: uploadId,
      ...(status ? { processing_status: status } : {}),
      uploaded_at: new Date().toISOString(),
    });
  };

  const status = (slug, token, query) => request(app)
    .get(`/api/gallery/${slug}/uploads/status`)
    .query(query)
    .set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    eventA = await createEvent(SLUG_A, 'Upload Status A');
    eventB = await createEvent(SLUG_B, 'Upload Status B');

    // Gallery A: one settled group (complete + failed) and one still queued.
    await addPhoto(eventA, 'a-complete.jpg', UPLOAD_A, 'complete');
    await addPhoto(eventA, 'a-failed.jpg', UPLOAD_A, 'failed');
    await addPhoto(eventA, 'a-pending.jpg', UPLOAD_A2, 'pending');
    await addPhoto(eventA, 'a-processing.jpg', UPLOAD_A2, 'processing');
    // Row written without an explicit status — takes the column default.
    await addPhoto(eventA, 'a-legacy.jpg', UPLOAD_A2, undefined);

    // Gallery B: the group a guest of A must never be able to read.
    await addPhoto(eventB, 'b-pending.jpg', UPLOAD_B, 'pending');

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 180000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  describe('B7 — processing status', () => {
    it('summarises the caller\'s own upload group', async () => {
      const res = await status(SLUG_A, galleryToken(eventA, SLUG_A), { ids: UPLOAD_A });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ total: 2, pending: 0, processing: 0, complete: 1, failed: 1 });
    });

    it('reports a batch of upload ids in one request', async () => {
      const res = await status(SLUG_A, galleryToken(eventA, SLUG_A), {
        ids: `${UPLOAD_A},${UPLOAD_A2}`,
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ total: 5, pending: 1, processing: 1, complete: 2, failed: 1 });
    });

    it('rejects a missing, malformed or oversized id list', async () => {
      const token = galleryToken(eventA, SLUG_A);
      expect((await status(SLUG_A, token, {})).status).toBe(400);
      expect((await status(SLUG_A, token, { ids: '' })).status).toBe(400);
      expect((await status(SLUG_A, token, { ids: 'not a valid id' })).status).toBe(400);
      expect((await status(SLUG_A, token, { ids: `${UPLOAD_A},oops!` })).status).toBe(400);
      // 51 well-formed ids — one over the cap that bounds the IN-list.
      const tooMany = Array.from({ length: 51 }, (_, i) => UPLOAD_A.slice(0, 30) + String(i % 10) + '0').join(',');
      expect((await status(SLUG_A, token, { ids: tooMany })).status).toBe(400);
    });

    it('never reports on another gallery\'s upload group', async () => {
      // A valid guest of gallery B, asking about gallery A's upload id.
      const res = await status(SLUG_B, galleryToken(eventB, SLUG_B), { ids: UPLOAD_A });
      expect(res.status).toBe(200);
      // Filtered on event_id, so the rows simply do not exist for this caller —
      // no counts, and no "this id exists elsewhere" oracle either.
      expect(res.body).toEqual({ total: 0, pending: 0, processing: 0, complete: 0, failed: 0 });
    });

    it('cannot be reached by pointing a gallery-B token at gallery A\'s slug', async () => {
      const res = await status(SLUG_A, galleryToken(eventB, SLUG_B), { ids: UPLOAD_A });
      expect(res.status).toBe(403);
    });

    it('requires a gallery token and refuses display-only slideshow tokens', async () => {
      const anon = await request(app)
        .get(`/api/gallery/${SLUG_A}/uploads/status`)
        .query({ ids: UPLOAD_A });
      expect(anon.status).toBe(401);

      const kiosk = await status(SLUG_A, galleryToken(eventA, SLUG_A, { accessLevel: 'slideshow' }), {
        ids: UPLOAD_A,
      });
      expect(kiosk.status).toBe(403);
    });
  });

  describe('B6 — cache headers', () => {
    const noStore = (res) => {
      expect(res.headers['cache-control']).toBe('no-store, no-cache, must-revalidate, private');
      expect(res.headers.pragma).toBe('no-cache');
    };

    it('marks the private per-guest JSON routes no-store', async () => {
      const token = galleryToken(eventA, SLUG_A);
      noStore(await status(SLUG_A, token, { ids: UPLOAD_A }));

      const photos = await request(app)
        .get(`/api/gallery/${SLUG_A}/photos`)
        .set('Authorization', `Bearer ${token}`);
      expect(photos.status).toBe(200);
      noStore(photos);

      const stats = await request(app)
        .get(`/api/gallery/${SLUG_A}/stats`)
        .set('Authorization', `Bearer ${token}`);
      expect(stats.status).toBe(200);
      noStore(stats);

      const people = await request(app)
        .get(`/api/gallery/${SLUG_A}/people`)
        .set('Authorization', `Bearer ${token}`);
      expect(people.status).toBe(200);
      noStore(people);
    });

    it('still lets /photos answer a conditional request with a 304', async () => {
      // The post-upload poll depends on revalidation staying correct: no-store
      // stops the browser retaining the body, it must not stop express from
      // agreeing that an unchanged payload is unchanged.
      const token = galleryToken(eventA, SLUG_A);
      const first = await request(app)
        .get(`/api/gallery/${SLUG_A}/photos`)
        .set('Authorization', `Bearer ${token}`);
      expect(first.headers.etag).toBeTruthy();

      const second = await request(app)
        .get(`/api/gallery/${SLUG_A}/photos`)
        .set('Authorization', `Bearer ${token}`)
        .set('If-None-Match', first.headers.etag);
      expect(second.status).toBe(304);
    });

    it('leaves the cacheable routes alone', async () => {
      // noStoreCache is mounted per route, not on the router, precisely so the
      // media/asset routes keep their own long-lived caching.
      await db('events').where({ id: eventA }).update({ css_template_id: null });
      const css = await request(app).get(`/api/gallery/${SLUG_A}/css-template`);
      expect(css.headers['cache-control']).toBeUndefined();

      const [tpl] = await db('css_templates').insert({
        name: 'Upload Status Test',
        slot_number: 99,
        css_content: 'body { color: red; }',
        is_enabled: 1,
      }).returning('id');
      await db('events').where({ id: eventA }).update({ css_template_id: tpl?.id ?? tpl });

      const cached = await request(app).get(`/api/gallery/${SLUG_A}/css-template`);
      expect(cached.status).toBe(200);
      expect(cached.headers['cache-control']).toBe('public, max-age=3600');
    });
  });
});
