/**
 * Website embed (issue 1112, migration 359).
 *
 * Public side: /api/gallery/:slug/embed/:token answers only for a gallery that
 * is already public (no password, live, not hidden until a reveal, not waiting
 * for a booking payment) with the
 * `embed` flag on and the current token; its photo list holds the guest's
 * visible stills with the preview tier for the lightbox, and reading it logs
 * no visit. The frame policy nginx asks for names the allowed websites.
 * Admin side: create/rotate, remove, and the websites list.
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken,
} = require('../integration/helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'gallery-embed-secret';

const SLUG = 'embed-gallery';
const TOKEN = 'e'.repeat(64);

describe('gallery embed (issue 1112)', () => {
  let db; let cleanup; let app; let eventId; let adminToken;
  const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);
  // Required lazily: db.js must not load before bootCrmDb points it at the
  // test database.
  async function setFlag(value) {
    await db('feature_flags').where({ key: 'embed' }).del();
    await db('feature_flags').insert({ key: 'embed', value });
    require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
  }

  const baseEvent = () => ({
    slug: SLUG, event_type: 'wedding', event_name: 'Embed Gallery', event_date: '2026-08-01',
    host_email: 'host@example.com', admin_email: 'admin@example.com', password_hash: 'x',
    require_password: 0,
    share_link: `/gallery/${SLUG}/share`, share_token: 'embed-gallery-share',
    embed_token: TOKEN, embed_allowed_origins: null,
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    is_active: 1, is_archived: 0, is_draft: 0, temporarily_disabled: 0, reveal_mode: 0, revealed_at: null,
    videos_first: 0, payment_lock: null, payment_lock_request_id: null, payment_unlocked_at: null,
  });

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId);
    adminToken = mintAdminToken(adminId);
    await setFlag(true);

    eventId = unwrap(await db('events').insert({ ...baseEvent(), created_by: adminId, created_at: new Date().toISOString() }).returning('id'));
    const media = [
      { filename: 'visible.jpg', media_type: 'image', mime_type: 'image/jpeg' },
      { filename: 'hidden.jpg', media_type: 'image', mime_type: 'image/jpeg', visibility: 'hidden' },
      // Held for review, as uploadReviewService stores it.
      { filename: 'held.jpg', media_type: 'image', mime_type: 'image/jpeg', visibility: 'hidden', moderation_status: 'pending' },
      { filename: 'clip.mp4', media_type: 'video', mime_type: 'video/mp4' },
    ];
    for (const m of media) {
      await db('photos').insert({
        event_id: eventId, path: `events/${SLUG}/${m.filename}`, thumbnail_path: `thumbnails/thumb_${m.filename}.jpg`,
        type: 'individual', processing_status: 'complete', uploaded_at: new Date().toISOString(), ...m,
      });
    }

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
    app.use('/api/public/settings', require('../../src/routes/publicSettings'));
    app.use('/api/admin/events', require('../../src/routes/adminEvents'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  afterEach(async () => {
    await db('events').where({ id: eventId }).update(baseEvent());
    await setFlag(true);
  });

  const info = (token = TOKEN) => request(app).get(`/api/gallery/${SLUG}/embed/${token}`);
  const photos = () => request(app).get(`/api/gallery/${SLUG}/embed/${TOKEN}/photos`);
  const policy = (uri) => request(app).get('/api/public/settings/embed-frame-policy').set('X-Original-URI', uri);

  describe('public', () => {
    it('answers for a public gallery with the current token', async () => {
      const res = await info();
      expect(res.status).toBe(200);
      expect(res.body.event.event_name).toBe('Embed Gallery');
      expect(res.body.gallery_path).toBe(`/gallery/${SLUG}`);
      expect(res.headers['cache-control']).toMatch(/no-store/);
    });

    it('lists only the visible stills, with the preview tier for the lightbox, and logs no visit', async () => {
      const before = (await db('access_logs').where({ event_id: eventId })).length;
      const res = await photos();
      expect(res.status).toBe(200);
      expect(res.body.photos).toHaveLength(1);
      const [photo] = res.body.photos;
      expect(Object.keys(photo).sort()).toEqual(['height', 'id', 'preview_url', 'thumbnail_url', 'width']);
      expect(photo.thumbnail_url).toBe(`/api/gallery/${SLUG}/thumbnail/${photo.id}?embed=${TOKEN}`);
      expect(photo.preview_url).toMatch(new RegExp(`^/api/gallery/${SLUG}/preview/${photo.id}\\?.*embed=${TOKEN}$`));
      expect((await db('access_logs').where({ event_id: eventId })).length).toBe(before);
    });

    it.each([
      ['a wrong token', {}, 'f'.repeat(64)],
      ['a malformed token', {}, 'not-a-token'],
      ['a password', { require_password: 1 }],
      ['a draft', { is_draft: 1 }],
      ['an archived gallery', { is_archived: 1 }],
      ['an inactive gallery', { is_active: 0 }],
      ['a paused gallery', { temporarily_disabled: 1 }],
      ['an expired gallery', { expires_at: new Date(Date.now() - 3600 * 1000).toISOString() }],
      ['a gallery hidden until its reveal', { reveal_mode: 1 }],
      ['a removed embed', { embed_token: null }],
      ['a gallery waiting for its booking payment', { payment_lock: 'full_payment' }],
    ])('is a 404 with %s', async (_label, changes, token = TOKEN) => {
      if (Object.keys(changes).length > 0) await db('events').where({ id: eventId }).update(changes);
      expect((await info(token)).status).toBe(404);
      expect((await request(app).get(`/api/gallery/${SLUG}/embed/${token}/photos`)).status).toBe(404);
      expect((await policy(`/gallery/${SLUG}/embed/${token}`)).status).toBe(404);
    });

    it('pages stills only, so a videos-first gallery does not open on empty pages', async () => {
      await db('events').where({ id: eventId }).update({ videos_first: 1 });
      const rows = Array.from({ length: 61 }, (_, i) => ({
        event_id: eventId, filename: `extra-${i}.mp4`, path: `events/${SLUG}/extra-${i}.mp4`,
        thumbnail_path: `thumbnails/thumb_extra-${i}.jpg`, media_type: 'video', mime_type: 'video/mp4',
        type: 'individual', processing_status: 'complete', uploaded_at: new Date().toISOString(),
      }));
      try {
        await db('photos').insert(rows);
        const res = await photos();
        expect(res.status).toBe(200);
        expect(res.body.photos.map((p) => p.id)).toHaveLength(1);
        expect(res.body.pagination).toMatchObject({ total: 1, has_more: false });
      } finally {
        await db('photos').where({ event_id: eventId }).where('filename', 'like', 'extra-%').del();
      }
    });

    it('keeps a still whose thumbnail is not recorded yet, through the thumbnail route', async () => {
      const id = unwrap(await db('photos').insert({
        event_id: eventId, filename: 'fresh.jpg', path: `events/${SLUG}/fresh.jpg`, thumbnail_path: null,
        media_type: 'image', mime_type: 'image/jpeg', type: 'individual', processing_status: 'complete',
        uploaded_at: new Date().toISOString(),
      }).returning('id'));
      try {
        const res = await photos();
        const fresh = res.body.photos.find((p) => p.id === id);
        expect(fresh).toBeDefined();
        expect(fresh.thumbnail_url).toBe(`/api/gallery/${SLUG}/thumbnail/${id}?embed=${TOKEN}`);
      } finally {
        await db('photos').where({ id }).del();
      }
    });

    it('serves its images past a stale gallery cookie the browser sends along', async () => {
      const jwt = require('jsonwebtoken');
      const stale = jwt.sign({ type: 'gallery', eventId }, process.env.JWT_SECRET, { issuer: 'picpeak-auth', expiresIn: -10 });
      const [photo] = (await photos()).body.photos;
      const plain = await request(app).get(`/api/gallery/${SLUG}/thumbnail/${photo.id}`).set('Cookie', `gallery_token=${stale}`);
      expect([401, 403]).toContain(plain.status);
      const viaEmbed = await request(app).get(photo.thumbnail_url).set('Cookie', `gallery_token=${stale}`);
      expect([401, 403, 500]).not.toContain(viaEmbed.status);
      // A wrong embed token falls back to the ordinary check.
      const wrong = await request(app).get(`/api/gallery/${SLUG}/thumbnail/${photo.id}?embed=${'f'.repeat(64)}`).set('Cookie', `gallery_token=${stale}`);
      expect([401, 403]).toContain(wrong.status);
    });

    it('is a 404 with the embed flag off', async () => {
      await setFlag(false);
      expect((await info()).status).toBe(404);
      expect((await policy(`/gallery/${SLUG}/embed/${TOKEN}`)).status).toBe(404);
    });
  });

  describe('frame policy', () => {
    it('allows any website when no list is set', async () => {
      const res = await policy(`/gallery/${SLUG}/embed/${TOKEN}`);
      expect(res.status).toBe(204);
      expect(res.headers['x-picpeak-embed-ancestors']).toBe('https: http:');
    });

    it('names the allowed websites', async () => {
      await db('events').where({ id: eventId }).update({ embed_allowed_origins: JSON.stringify(['https://example.com', 'https://*.example.org']) });
      const res = await policy(`/gallery/${SLUG}/embed/${TOKEN}/`);
      expect(res.status).toBe(204);
      expect(res.headers['x-picpeak-embed-ancestors']).toBe('https://example.com https://*.example.org');
    });

    it('fails closed on a stored list that does not validate', async () => {
      await db('events').where({ id: eventId }).update({ embed_allowed_origins: JSON.stringify(['https://ok.com; script-src \'unsafe-inline\'']) });
      const res = await policy(`/gallery/${SLUG}/embed/${TOKEN}`);
      expect(res.headers['x-picpeak-embed-ancestors']).toBe('\'none\'');
    });

    it('is a 404 for any other page', async () => {
      for (const uri of [`/gallery/${SLUG}`, `/gallery/${SLUG}/show/${TOKEN}`, '/admin', '', `/gallery/${SLUG}/embed/${TOKEN}/x`]) {
        expect((await policy(uri)).status).toBe(404);
      }
    });
  });

  describe('admin', () => {
    const admin = (method, path, body) => request(app)[method](`/api/admin/events/${eventId}${path}`)
      .set('Authorization', `Bearer ${adminToken}`).send(body);

    it('creates, rotates and removes the embed link', async () => {
      const created = await admin('post', '/embed/generate');
      expect(created.status).toBe(200);
      expect(created.body.embed_token).toMatch(/^[a-f0-9]{64}$/);
      expect(created.body.embed_token).not.toBe(TOKEN);
      expect((await info()).status).toBe(404); // the old link is dead
      expect((await info(created.body.embed_token)).status).toBe(200);

      const removed = await admin('post', '/embed/disable');
      expect(removed.status).toBe(200);
      expect(removed.body.embed_token).toBeNull();
      expect((await db('events').where({ id: eventId }).first()).embed_token).toBeNull();
    });

    it('refuses an embed for a gallery with a password', async () => {
      await db('events').where({ id: eventId }).update({ require_password: 1 });
      const res = await admin('post', '/embed/generate');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('EMBED_REQUIRES_PUBLIC_GALLERY');
    });

    it('refuses creating an embed with the flag off, but still removes one', async () => {
      await setFlag(false);
      expect((await admin('post', '/embed/generate')).status).toBe(403);
      expect((await admin('post', '/embed/disable')).status).toBe(200);
    });

    it('stores normalised websites and clears them with an empty list', async () => {
      const saved = await admin('patch', '/embed', { allowed_origins: 'https://Example.com/\nhttps://*.example.org, https://example.com' });
      expect(saved.status).toBe(200);
      expect(saved.body.embed_allowed_origins).toEqual(['https://example.com', 'https://*.example.org']);
      expect(JSON.parse((await db('events').where({ id: eventId }).first()).embed_allowed_origins))
        .toEqual(['https://example.com', 'https://*.example.org']);

      const cleared = await admin('patch', '/embed', { allowed_origins: [] });
      expect(cleared.body.embed_allowed_origins).toEqual([]);
      expect((await db('events').where({ id: eventId }).first()).embed_allowed_origins).toBeNull();
    });

    it.each([
      'http://example.com',
      'https://example.com/path',
      'https://example.com; script-src \'unsafe-inline\'',
      'https://user@example.com',
      '*',
      'example.com',
    ])('refuses %s as a website', async (origin) => {
      const res = await admin('patch', '/embed', { allowed_origins: [origin] });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('EMBED_INVALID_ORIGIN');
    });

    it('keeps the embed columns out of the general event update', async () => {
      const res = await admin('put', '', { embed_token: 'a'.repeat(64), embed_allowed_origins: '["https://evil.com"]' });
      const row = await db('events').where({ id: eventId }).first();
      expect(row.embed_token).toBe(TOKEN);
      expect(row.embed_allowed_origins).toBeNull();
      expect([200, 400]).toContain(res.status);
    });
  });
});
