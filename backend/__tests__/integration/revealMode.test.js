/**
 * Reveal mode integration tests (#838).
 *
 * Pins the contract:
 *  - effective visibility is computed at request time (isGalleryHidden):
 *    reveal_at in the past opens the gate even before the scheduler stamps
 *  - /photos returns the event shell with photos: [] + hidden_until_reveal
 *    for plain guests; slideshow / client / admin-preview see everything
 *  - image + download endpoints 403 with GALLERY_HIDDEN for plain guests
 *  - the guest upload route is NOT gated (uploading while hidden is the point)
 *  - the scheduler stamps revealed_at for due events, exactly once
 *  - POST /events/:id/reveal stamps revealed_at (idempotent, 400 when the
 *    mode is off); re-enabling reveal_mode clears revealed_at (re-hide)
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'reveal-test-secret';

const SLUG = 'reveal-test-event';

describe('Reveal mode (#838)', () => {
  let db;
  let cleanup;
  let app;
  let eventId;
  let photoIds;
  let adminToken;
  const { isGalleryHidden } = require('../../src/utils/revealMode');

  const galleryToken = (extra = {}) => jwt.sign(
    { eventId, eventSlug: SLUG, type: 'gallery', ...extra },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' }
  );

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const inserted = await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Reveal Test',
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'reveal-test-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      allow_user_uploads: 1,
      reveal_mode: 1,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = inserted[0]?.id ?? inserted[0];

    photoIds = [];
    for (let i = 0; i < 2; i++) {
      const p = await db('photos').insert({
        event_id: eventId,
        filename: `photo-${i}.jpg`,
        path: `events/reveal/${i}.jpg`,
        type: 'individual',
        uploaded_at: new Date().toISOString(),
      }).returning('id');
      photoIds.push(p[0]?.id ?? p[0]);
    }

    // Super admin for the admin routes.
    const superRole = await db('roles').where({ name: 'super_admin' }).first();
    const [rootId] = await db('admin_users').insert({
      username: 'reveal-admin',
      email: 'reveal-admin@example.com',
      password_hash: await bcrypt.hash('RevealAdmin123', 4),
      role_id: superRole.id,
      is_active: 1,
      created_at: new Date(),
      updated_at: new Date(),
    }).returning('id').then((r) => [r[0]?.id || r[0]]);
    adminToken = jwt.sign(
      { id: rootId, username: 'reveal-admin', type: 'admin', role: 'super_admin', loginTime: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' }
    );

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
    app.use('/api/secure-images', require('../../src/routes/secureImages'));
    app.use('/api/images', require('../../src/routes/protectedImages'));
    app.use('/api/gallery', require('../../src/routes/galleryFeedback'));
    app.use('/api/admin/events', require('../../src/routes/adminEvents'));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  describe('effective visibility math (isGalleryHidden)', () => {
    const base = { reveal_mode: true, revealed_at: null, reveal_at: null };
    it('is hidden while armed and unrevealed, visible otherwise', () => {
      expect(isGalleryHidden({ ...base })).toBe(true);
      expect(isGalleryHidden({ ...base, reveal_mode: false })).toBe(false);
      expect(isGalleryHidden({ ...base, revealed_at: new Date() })).toBe(false);
      // reveal_at in the past opens the gate WITHOUT any stamp — time-exact.
      expect(isGalleryHidden({ ...base, reveal_at: new Date(Date.now() - 60_000) })).toBe(false);
      expect(isGalleryHidden({ ...base, reveal_at: new Date(Date.now() + 60_000) })).toBe(true);
      // SQLite 0/1 booleans
      expect(isGalleryHidden({ reveal_mode: 1, revealed_at: null, reveal_at: null })).toBe(true);
      expect(isGalleryHidden({ reveal_mode: 0, revealed_at: null, reveal_at: null })).toBe(false);
    });
  });

  describe('gallery routes while hidden', () => {
    it('/photos gives plain guests the shell with no photos and the flag', async () => {
      const res = await request(app)
        .get(`/api/gallery/${SLUG}/photos`)
        .set('Authorization', `Bearer ${galleryToken()}`);
      expect(res.status).toBe(200);
      expect(res.body.hidden_until_reveal).toBe(true);
      expect(res.body.photos).toEqual([]);
      expect(res.body.categories).toEqual([]);
      expect(res.body.event.event_name).toBe('Reveal Test');
    });

    it('/photos serves the slideshow token everything (surprise beamer)', async () => {
      const res = await request(app)
        .get(`/api/gallery/${SLUG}/photos`)
        .set('Authorization', `Bearer ${galleryToken({ accessLevel: 'slideshow' })}`);
      expect(res.status).toBe(200);
      expect(res.body.hidden_until_reveal).toBe(false);
      expect(res.body.photos).toHaveLength(2);
    });

    it('/photos serves client access everything (host review)', async () => {
      const res = await request(app)
        .get(`/api/gallery/${SLUG}/photos`)
        .set('Authorization', `Bearer ${galleryToken({ accessLevel: 'client' })}`);
      expect(res.status).toBe(200);
      expect(res.body.hidden_until_reveal).toBe(false);
      expect(res.body.photos).toHaveLength(2);
    });

    it('/photos serves the admin preview everything', async () => {
      const res = await request(app)
        .get(`/api/gallery/${SLUG}/photos?preview=${encodeURIComponent(adminToken)}`)
        .set('Authorization', `Bearer ${galleryToken()}`);
      expect(res.status).toBe(200);
      expect(res.body.hidden_until_reveal).toBe(false);
      expect(res.body.photos).toHaveLength(2);
    });

    it('image and download endpoints 403 with GALLERY_HIDDEN for plain guests', async () => {
      for (const url of [
        `/api/gallery/${SLUG}/thumbnail/${photoIds[0]}`,
        `/api/gallery/${SLUG}/photo/${photoIds[0]}`,
        `/api/gallery/${SLUG}/download/${photoIds[0]}`,
        `/api/gallery/${SLUG}/download-all`,
        `/api/gallery/${SLUG}/stats`,
        `/api/gallery/${SLUG}/hero/${photoIds[0]}`,
      ]) {
        const res = await request(app).get(url).set('Authorization', `Bearer ${galleryToken()}`);
        expect(`${url}:${res.status}`).toBe(`${url}:403`);
        expect(res.body.code).toBe('GALLERY_HIDDEN');
      }
    });

    it('image endpoints are NOT reveal-blocked for the slideshow token', async () => {
      const res = await request(app)
        .get(`/api/gallery/${SLUG}/thumbnail/${photoIds[0]}`)
        .set('Authorization', `Bearer ${galleryToken({ accessLevel: 'slideshow' })}`);
      // The seeded file doesn't exist on disk, so anything but the reveal
      // gate's 403 is fine here.
      expect(res.body.code).not.toBe('GALLERY_HIDDEN');
    });

    it('/info exposes the effective hidden state without auth', async () => {
      const res = await request(app).get(`/api/gallery/${SLUG}/info`);
      expect(res.status).toBe(200);
      expect(res.body.hidden_until_reveal).toBe(true);
    });

    it('the guest upload route is not gated', async () => {
      const res = await request(app)
        .post(`/api/gallery/${eventId}/upload`)
        .set('Authorization', `Bearer ${galleryToken()}`)
        .send({});
      // Fails later for other reasons (no multipart body) — but never on the
      // reveal gate.
      expect(res.body.code).not.toBe('GALLERY_HIDDEN');
    });

    it('legacy protected-image routes are reveal-gated for plain guests', async () => {
      for (const [method, url] of [
        ['get', `/api/images/${SLUG}/photo/${photoIds[0]}/view`],
        ['post', `/api/images/${SLUG}/photo/${photoIds[0]}/generate-secure-token`],
        ['post', `/api/images/${SLUG}/photo/${photoIds[0]}/generate-url`],
      ]) {
        const res = await request(app)[method](url).set('Authorization', `Bearer ${galleryToken()}`);
        expect(`${url}:${res.status}`).toBe(`${url}:403`);
        expect(res.body.code).toBe('GALLERY_HIDDEN');
      }
    });

    it('feedback endpoints are reveal-gated; my-feedback degrades to empty', async () => {
      // Feedback must be enabled for the routes to get past their own gate.
      await db('event_feedback_settings').insert({
        event_id: eventId, feedback_enabled: 1, allow_likes: 1,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
      const getRes = await request(app)
        .get(`/api/gallery/${SLUG}/photos/${photoIds[0]}/feedback`)
        .set('Authorization', `Bearer ${galleryToken()}`);
      expect(getRes.status).toBe(403);
      expect(getRes.body.code).toBe('GALLERY_HIDDEN');

      const postRes = await request(app)
        .post(`/api/gallery/${SLUG}/photos/${photoIds[0]}/feedback`)
        .set('Authorization', `Bearer ${galleryToken()}`)
        .send({ feedback_type: 'like' });
      expect(postRes.status).toBe(403);
      expect(postRes.body.code).toBe('GALLERY_HIDDEN');

      const mine = await request(app)
        .get(`/api/gallery/${SLUG}/my-feedback`)
        .set('Authorization', `Bearer ${galleryToken()}`);
      expect(mine.status).toBe(200);
      expect(mine.body).toEqual([]);
    });

    it('secure-image token minting is reveal-gated for plain guests', async () => {
      const res = await request(app)
        .post(`/api/secure-images/${SLUG}/generate-token`)
        .set('Authorization', `Bearer ${galleryToken()}`)
        .send({ photoId: photoIds[0] });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('GALLERY_HIDDEN');
    });

    it('customer-portal tokens (via:customer, no accessLevel) bypass reveal mode', async () => {
      const acct = await db('customer_accounts').insert({
        email: 'portal-customer@example.com',
        password_hash: 'x',
        is_active: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).returning('id');
      const customerId = acct[0]?.id ?? acct[0];
      await db('event_customer_assignments').insert({
        event_id: eventId,
        customer_account_id: customerId,
      });

      const res = await request(app)
        .get(`/api/gallery/${SLUG}/photos`)
        .set('Authorization', `Bearer ${galleryToken({ via: 'customer', customerId })}`);
      expect(res.status).toBe(200);
      expect(res.body.hidden_until_reveal).toBe(false);
      expect(res.body.photos).toHaveLength(2);
    });

    it('a reveal_at in the past opens the gate without any stamp', async () => {
      await db('events').where('id', eventId).update({ reveal_at: new Date(Date.now() - 60_000).toISOString() });
      const res = await request(app)
        .get(`/api/gallery/${SLUG}/photos`)
        .set('Authorization', `Bearer ${galleryToken()}`);
      expect(res.body.hidden_until_reveal).toBe(false);
      expect(res.body.photos).toHaveLength(2);
      await db('events').where('id', eventId).update({ reveal_at: null });
    });
  });

  describe('scheduler and admin reveal', () => {
    it('the scheduler stamps revealed_at for due events exactly once', async () => {
      const revealAt = new Date(Date.now() - 5 * 60_000);
      await db('events').where('id', eventId).update({ reveal_at: revealAt.toISOString(), revealed_at: null });

      const { checkScheduledReveals } = require('../../src/services/revealScheduler');
      await checkScheduledReveals();

      const asMs = (v) => new Date(v).getTime();
      const row = await db('events').where('id', eventId).first();
      expect(row.revealed_at).not.toBeNull();
      expect(asMs(row.revealed_at)).toBe(revealAt.getTime());
      expect(row.reveal_at).toBeNull(); // schedule consumed, like "Reveal now"

      // Second pass no-ops (revealed_at already set).
      await checkScheduledReveals();
      const again = await db('events').where('id', eventId).first();
      expect(asMs(again.revealed_at)).toBe(revealAt.getTime());

      await db('events').where('id', eventId).update({ reveal_at: null, revealed_at: null });
    });

    it('POST /:id/reveal stamps revealed_at, clears the schedule, and is idempotent', async () => {
      await db('events').where('id', eventId).update({ reveal_at: new Date(Date.now() + 3600_000).toISOString() });
      const res = await request(app)
        .post(`/api/admin/events/${eventId}/reveal`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.revealed_at).toBeTruthy();
      // "Reveal now" consumes the pending schedule.
      const cleared = await db('events').where('id', eventId).first();
      expect(cleared.reveal_at).toBeNull();

      const first = res.body.revealed_at;
      const res2 = await request(app)
        .post(`/api/admin/events/${eventId}/reveal`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res2.status).toBe(200);
      expect(res2.body.revealed_at).toBe(first);

      // Guests see photos now.
      const gallery = await request(app)
        .get(`/api/gallery/${SLUG}/photos`)
        .set('Authorization', `Bearer ${galleryToken()}`);
      expect(gallery.body.hidden_until_reveal).toBe(false);
      expect(gallery.body.photos).toHaveLength(2);
    });

    it('re-enabling reveal_mode clears revealed_at (re-hide)', async () => {
      await db('events').where('id', eventId).update({ reveal_mode: 0 });
      const res = await request(app)
        .put(`/api/admin/events/${eventId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reveal_mode: true });
      expect(res.status).toBe(200);

      const row = await db('events').where('id', eventId).first();
      expect(row.revealed_at).toBeNull();

      const gallery = await request(app)
        .get(`/api/gallery/${SLUG}/photos`)
        .set('Authorization', `Bearer ${galleryToken()}`);
      expect(gallery.body.hidden_until_reveal).toBe(true);
    });

    it('scheduling a FUTURE reveal on a revealed gallery re-arms hiding', async () => {
      // State: revealed (previous tests). Saving a future schedule re-hides.
      await db('events').where('id', eventId).update({ revealed_at: new Date().toISOString() });
      const res = await request(app)
        .put(`/api/admin/events/${eventId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reveal_mode: true, reveal_at: new Date(Date.now() + 3600_000).toISOString() });
      expect(res.status).toBe(200);
      const row = await db('events').where('id', eventId).first();
      expect(row.revealed_at).toBeNull();

      const gallery = await request(app)
        .get(`/api/gallery/${SLUG}/photos`)
        .set('Authorization', `Bearer ${galleryToken()}`);
      expect(gallery.body.hidden_until_reveal).toBe(true);
      await db('events').where('id', eventId).update({ reveal_at: null });
    });

    it('re-arming without a schedule clears a stale PAST reveal_at', async () => {
      // Legacy/partial-API state: revealed with the old past schedule still
      // stored. {reveal_mode:false} then {reveal_mode:true} without
      // reveal_at must re-hide, not instantly re-open via the stale date.
      await db('events').where('id', eventId).update({
        reveal_mode: 0,
        revealed_at: new Date().toISOString(),
        reveal_at: new Date(Date.now() - 3600_000).toISOString(),
      });
      const res = await request(app)
        .put(`/api/admin/events/${eventId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reveal_mode: true });
      expect(res.status).toBe(200);

      const row = await db('events').where('id', eventId).first();
      expect(row.revealed_at).toBeNull();
      expect(row.reveal_at).toBeNull();

      const gallery = await request(app)
        .get(`/api/gallery/${SLUG}/photos`)
        .set('Authorization', `Bearer ${galleryToken()}`);
      expect(gallery.body.hidden_until_reveal).toBe(true);
      expect(gallery.body.photos).toEqual([]);
    });

    it('POST /:id/reveal 400s while reveal mode is off', async () => {
      await db('events').where('id', eventId).update({ reveal_mode: 0, revealed_at: null });
      const res = await request(app)
        .post(`/api/admin/events/${eventId}/reveal`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(400);
      await db('events').where('id', eventId).update({ reveal_mode: 1 });
    });
  });
});
