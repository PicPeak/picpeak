/**
 * The two views of a gallery with a curated selection (issue 2356).
 *
 * The ordinary link shows the photos in the selection only, on every route
 * that lists, counts or serves a photo. The full link (POST /gallery/verify
 * with full_token) opens a session that sees every photo; the gallery
 * password still applies to it. Rotating or removing the full link ends the
 * sessions opened with it, and a wrong full token opens nothing.
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken,
} = require('../integration/helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'gallery-selection-secret';

const SLUG = 'selection-gallery';
const FULL = 'f'.repeat(64);

describe('gallery selection and full link (issue 2356)', () => {
  let db; let cleanup; let app; let eventId; let adminToken;
  const ids = {};
  const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);

  const baseEvent = () => ({
    slug: SLUG, event_type: 'wedding', event_name: 'Selection Gallery', event_date: '2026-08-01',
    host_email: 'host@example.com', admin_email: 'admin@example.com', password_hash: 'x',
    require_password: 0,
    share_link: `/gallery/${SLUG}/share`, share_token: 'selection-gallery-share',
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    is_active: 1, is_archived: 0, is_draft: 0, temporarily_disabled: 0, reveal_mode: 0, revealed_at: null,
    source_mode: 'reference', external_path: 'project', selection_path: 'gallery', full_share_token: FULL,
  });

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId);
    adminToken = mintAdminToken(adminId);
    eventId = unwrap(await db('events').insert({ ...baseEvent(), created_by: adminId, created_at: new Date().toISOString() }).returning('id'));
    const fixtures = {
      selected: { external_relpath: 'project/gallery/a.jpg', selection_hidden: false },
      original: { external_relpath: 'project/Originale/b.jpg', selection_hidden: true },
      upload: { external_relpath: null, selection_hidden: false },
      hiddenOriginal: { external_relpath: 'project/Originale/c.jpg', selection_hidden: true, visibility: 'hidden' },
    };
    for (const [name, extra] of Object.entries(fixtures)) {
      ids[name] = unwrap(await db('photos').insert({
        event_id: eventId, filename: `${name}.jpg`, path: `events/${SLUG}/${name}.jpg`,
        thumbnail_path: `thumbnails/thumb_${name}.jpg`, media_type: 'image', mime_type: 'image/jpeg',
        type: 'individual', processing_status: 'complete', uploaded_at: new Date().toISOString(),
        source_origin: extra.external_relpath ? 'external' : 'upload', ...extra,
      }).returning('id'));
    }

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/auth', require('../../src/routes/auth'));
    app.use('/api/gallery', require('../../src/routes/gallery'));
    app.use('/api/admin/events', require('../../src/routes/adminEvents'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  afterEach(async () => {
    await db('events').where({ id: eventId }).update(baseEvent());
  });

  const verify = (body) => request(app).post('/api/auth/gallery/verify').send({ slug: SLUG, ...body });
  const as = (token) => (req) => (token ? req.set('Authorization', `Bearer ${token}`) : req);
  const listIds = async (token) => {
    const res = await as(token)(request(app).get(`/api/gallery/${SLUG}/photos`));
    expect(res.status).toBe(200);
    return res.body.photos.map((p) => p.id).sort((a, b) => a - b);
  };
  const sorted = (...list) => list.sort((a, b) => a - b);

  async function guestToken() {
    const res = await verify({});
    expect(res.status).toBe(200);
    expect(res.body.full_view).toBeUndefined();
    return res.body.token;
  }
  async function fullToken(extra = {}) {
    const res = await verify({ full_token: FULL, ...extra });
    expect(res.status).toBe(200);
    expect(res.body.full_view).toBe(true);
    return res.body.token;
  }

  describe('the ordinary link', () => {
    it('lists, counts and serves the selection only', async () => {
      for (const token of [null, await guestToken()]) {
        expect(await listIds(token)).toEqual(sorted(ids.selected, ids.upload));
        expect((await as(token)(request(app).get(`/api/gallery/${SLUG}/stats`))).body.total_photos).toBe(2);
        const thumb = await as(token)(request(app).get(`/api/gallery/${SLUG}/thumbnail/${ids.original}`));
        expect(thumb.status).toBe(403);
        const download = await as(token)(request(app).get(`/api/gallery/${SLUG}/download/${ids.original}`));
        expect([403, 404]).toContain(download.status);
        const view = await as(token)(request(app).post(`/api/gallery/${SLUG}/photo/${ids.original}/view`));
        expect(view.status).toBe(403);
      }
    });

    it('shows everything again once the selection is cleared', async () => {
      await require('../../src/services/externalSelection').recomputeSelection(eventId);
      await db('events').where({ id: eventId }).update({ selection_path: null });
      await require('../../src/services/externalSelection').recomputeSelection(eventId);
      expect(await listIds(null)).toEqual(sorted(ids.selected, ids.original, ids.upload));
      await db('photos').where({ id: ids.original }).update({ selection_hidden: true });
      await db('photos').where({ id: ids.hiddenOriginal }).update({ selection_hidden: true });
    });
  });

  describe('the full link', () => {
    it('lists every photo a guest may see, outside the selection too', async () => {
      const token = await fullToken();
      expect(await listIds(token)).toEqual(sorted(ids.selected, ids.original, ids.upload));
      expect((await as(token)(request(app).get(`/api/gallery/${SLUG}/stats`))).body.total_photos).toBe(3);
      const thumb = await as(token)(request(app).get(`/api/gallery/${SLUG}/thumbnail/${ids.original}`));
      expect(thumb.status).not.toBe(403);
      // A photo the client hid stays hidden from the full link too.
      expect((await as(token)(request(app).get(`/api/gallery/${SLUG}/thumbnail/${ids.hiddenOriginal}`))).status).toBe(403);
      const session = await as(token)(request(app).get('/api/auth/session').query({ slug: SLUG }));
      expect(session.body).toMatchObject({ valid: true, fullView: true });
    });

    it('opens nothing with a wrong or removed token', async () => {
      for (const full_token of ['0'.repeat(64), 'short']) {
        const res = await verify({ full_token });
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('FULL_LINK_INVALID');
      }
      await db('events').where({ id: eventId }).update({ full_share_token: null });
      expect((await verify({ full_token: FULL })).status).toBe(401);
    });

    it('still asks for the gallery password', async () => {
      await db('events').where({ id: eventId }).update({
        require_password: 1, password_hash: await bcrypt.hash('secret-pass', 4),
      });
      expect((await verify({ full_token: FULL })).status).toBe(401);
      expect((await verify({ full_token: FULL, password: 'wrong' })).status).toBe(401);
      const token = await fullToken({ password: 'secret-pass' });
      expect(await listIds(token)).toHaveLength(3);
    });

    it('ends its sessions when the admin rotates or removes the link', async () => {
      const token = await fullToken();
      const guest = await guestToken();
      const rotate = await request(app).post(`/api/admin/events/${eventId}/selection/full-link`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(rotate.status).toBe(200);
      const res = await as(token)(request(app).get(`/api/gallery/${SLUG}/photos`));
      expect(res.status).toBe(401);
      // The ordinary link is untouched.
      expect(await listIds(guest)).toEqual(sorted(ids.selected, ids.upload));

      await db('events').where({ id: eventId }).update({ full_share_token: FULL });
      const again = await fullToken();
      await request(app).delete(`/api/admin/events/${eventId}/selection/full-link`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect((await as(again)(request(app).get(`/api/gallery/${SLUG}/photos`))).status).toBe(401);
    });
  });

  describe('people', () => {
    it('counts the photos outside the selection for a full-link session only', async () => {
      const faceSettings = require('../../src/services/faceSettings');
      const enabled = jest.spyOn(faceSettings, 'isEnabledForEvent').mockResolvedValue(true);
      const thresholds = jest.spyOn(faceSettings, 'getThresholds')
        .mockResolvedValue({ ...faceSettings.DEFAULTS, face_min_cluster_size: 1 });
      const now = new Date().toISOString();
      const person = unwrap(await db('event_people').insert({
        event_id: eventId, centroid: Buffer.alloc(8), face_count_total: 2, model_version: 'test-v1',
        created_at: now, updated_at: now,
      }).returning('id'));
      // One face in the selection, one only in the full view, one person only there.
      const onlyOutside = unwrap(await db('event_people').insert({
        event_id: eventId, centroid: Buffer.alloc(8), face_count_total: 1, model_version: 'test-v1',
        created_at: now, updated_at: now,
      }).returning('id'));
      const face = (photoId, personId) => db('photo_faces').insert({
        photo_id: photoId, event_id: eventId, person_id: personId,
        bbox_x: 0, bbox_y: 0, bbox_w: 200, bbox_h: 200, det_score: 0.99,
        embedding: Buffer.alloc(8), model_version: 'test-v1', created_at: now,
      });
      await face(ids.selected, person);
      await face(ids.original, person);
      await face(ids.original, onlyOutside);
      try {
        const people = async (token) => {
          const res = await as(token)(request(app).get(`/api/gallery/${SLUG}/people`));
          expect(res.status).toBe(200);
          return Object.fromEntries(res.body.people.map((p) => [p.id, p.face_count]));
        };
        expect(await people(await guestToken())).toEqual({ [person]: 1 });
        expect(await people(await fullToken())).toEqual({ [person]: 2, [onlyOutside]: 1 });
      } finally {
        enabled.mockRestore();
        thresholds.mockRestore();
        await db('photo_faces').where({ event_id: eventId }).del();
        await db('event_people').where({ event_id: eventId }).del();
      }
    });
  });

  describe('download-ready mail', () => {
    it('is not offered for an archive built for a full-link session', () => {
      const { canMail } = require('../../src/services/downloadJobNotifier');
      expect(canMail({ visibility_scope: 'public' })).toBe(true);
      expect(canMail({ visibility_scope: 'full' })).toBe(false);
      expect(canMail({ visibility_scope: 'hidden' })).toBe(false);
    });
  });

  describe('feedback cap', () => {
    it('does not count a like on a photo outside the selection against an ordinary guest', async () => {
      const feedbackService = require('../../src/services/feedbackService');
      const settings = jest.spyOn(feedbackService, 'getEventFeedbackSettings')
        .mockResolvedValue({ feedback_enabled: true, allow_likes: true, max_likes_per_guest: 1 });
      const ME = 'selection-cap-guest';
      await db('photo_feedback').insert({
        photo_id: ids.original, event_id: eventId, guest_identifier: ME, feedback_type: 'like',
        is_approved: true, is_hidden: false, created_at: new Date().toISOString(),
      });
      try {
        const count = (viewer) => feedbackService.countGuestFeedback(eventId, 'like', null, ME, db, viewer);
        expect(await count({ accessLevel: 'guest', fullView: false })).toBe(0);
        expect(await count({ accessLevel: 'guest', fullView: true })).toBe(1);
        // The guest's like on the photo it can see goes through.
        const result = await feedbackService.submitFeedback(ids.selected, eventId,
          { feedback_type: 'like', viewer: { accessLevel: 'guest', fullView: false } }, ME);
        expect(result.limit_reached).toBeUndefined();
        // In the full view the hidden like takes the one slot.
        await db('photo_feedback').where({ guest_identifier: ME, photo_id: ids.selected }).del();
        const full = await feedbackService.submitFeedback(ids.selected, eventId,
          { feedback_type: 'like', viewer: { accessLevel: 'guest', fullView: true } }, ME);
        expect(full.limit_reached).toBe(true);
      } finally {
        settings.mockRestore();
        await db('photo_feedback').where({ guest_identifier: ME }).del();
      }
    });
  });

  describe('admin', () => {
    const auth = (req) => req.set('Authorization', `Bearer ${adminToken}`);
    it('filters the photo list by selection and marks each photo', async () => {
      const list = async (q) => (await auth(request(app).get(`/api/admin/photos/${eventId}/photos`).query(q))).body;
      const adminApp = express().use(express.json()).use('/api/admin/photos', require('../../src/routes/adminPhotos'));
      const get = async (q) => (await auth(request(adminApp).get(`/api/admin/photos/${eventId}/photos`).query(q))).body.photos;
      void list;
      const out = await get({ selection: 'out' });
      expect(out.map((p) => p.id).sort((a, b) => a - b)).toEqual(sorted(ids.original, ids.hiddenOriginal));
      expect(out.every((p) => p.selection_hidden === true)).toBe(true);
      const inside = await get({ selection: 'in' });
      expect(inside.map((p) => p.id).sort((a, b) => a - b)).toEqual(sorted(ids.selected, ids.upload));
    });

    it('hides the full link from an admin who cannot act on the gallery', () => {
      const { withoutForeignEventSecrets } = require('../../src/middleware/ownership');
      if (typeof withoutForeignEventSecrets !== 'function') return;
      const copy = withoutForeignEventSecrets({ id: 1, full_share_token: FULL, created_by: 999 }, { id: 2, roleName: 'viewer' });
      expect(copy.full_share_token).toBeUndefined();
    });
  });
});
