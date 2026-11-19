/**
 * Guest identity before downloading (issue 2503).
 *
 * A gallery in guest identity mode can ask guests for their name before any
 * download. The download routes enforce it: without a guest token (header)
 * or a download ticket (query, for browser-navigated downloads) they answer
 * 403 GUEST_IDENTITY_REQUIRED, which the gallery maps to its guest prompt.
 * Views and downloads are then logged under the guest. With the setting off
 * nothing changes: no refusal, and access_logs rows carry no guest.
 */

const path = require('path');
const fs = require('fs');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'guest-download-identity-secret';

const mockStorage = {
  kind: () => 'local',
  stat: jest.fn(),
  get: jest.fn(),
  getRange: jest.fn(),
  delete: jest.fn(async () => undefined),
  exists: jest.fn(async () => true),
};

jest.mock('../../src/services/storage', () => ({
  getStorage: () => mockStorage,
  initStorage: async () => mockStorage,
}));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const SLUG = 'guest-dl-identity';
const OTHER_SLUG = 'guest-dl-identity-other';
const FILENAME = 'original.jpg';
const CODE = 'GUEST_IDENTITY_REQUIRED';

describe('guest identity before downloading (issue 2503)', () => {
  let db; let cleanup; let app;
  let eventId; let otherEventId; let photoId; let guestId; let guestToken; let otherGuestToken;

  const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);

  const addEvent = async (slug) => unwrap(await db('events').insert({
    slug,
    event_type: 'wedding',
    event_name: slug,
    event_date: '2026-08-01',
    host_email: 'h@example.com',
    admin_email: 'a@example.com',
    password_hash: 'x',
    share_link: `/gallery/${slug}/s`,
    share_token: `${slug}-share`,
    expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
    is_active: 1,
    is_archived: 0,
    is_draft: 0,
    require_password: 0,
    allow_downloads: 1,
    created_at: new Date().toISOString(),
  }).returning('id'));

  const addGuest = async (event, name) => unwrap(await db('gallery_guests').insert({
    event_id: event,
    name,
    email: `${name.toLowerCase()}@example.com`,
    identifier: `${name}-identifier`,
    is_deleted: false,
    created_at: new Date().toISOString(),
  }).returning('id'));

  const setRequired = (on) => db('event_feedback_settings')
    .where({ event_id: eventId })
    .update({ require_guest_for_download: on });

  const lastLog = (action) => db('access_logs')
    .where({ event_id: eventId, action })
    .orderBy('id', 'desc')
    .first();

  const ticketFor = async (token, slug = SLUG) => {
    const res = await request(app)
      .post(`/api/gallery/${slug}/guest/download-ticket`)
      .set('x-guest-token', token);
    expect(res.status).toBe(200);
    return res.body.ticket;
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    eventId = await addEvent(SLUG);
    otherEventId = await addEvent(OTHER_SLUG);

    photoId = unwrap(await db('photos').insert({
      event_id: eventId,
      filename: FILENAME,
      path: `${SLUG}/${FILENAME}`,
      type: 'individual',
      source_origin: 'managed',
      mime_type: 'image/jpeg',
      uploaded_at: new Date().toISOString(),
    }).returning('id'));
    const abs = path.join(process.env.STORAGE_PATH, 'events/active', SLUG, FILENAME);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'local-disk-bytes');

    for (const id of [eventId, otherEventId]) {
      await db('event_feedback_settings').insert({
        event_id: id,
        feedback_enabled: true,
        allow_likes: true,
        allow_favorites: true,
        identity_mode: 'guest',
        require_name_email: false,
        require_guest_for_download: false,
      });
    }

    const { signGuestToken } = require('../../src/middleware/guestAuth');
    guestId = await addGuest(eventId, 'Anna');
    guestToken = signGuestToken({ guestId, eventId, identifier: 'Anna-identifier', name: 'Anna' });
    const otherGuestId = await addGuest(otherEventId, 'Ben');
    otherGuestToken = signGuestToken({ guestId: otherGuestId, eventId: otherEventId, identifier: 'Ben-identifier', name: 'Ben' });

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use((req, res, next) => {
      res.sendFile = (filePath, cb) => { res.end('bytes'); if (cb) cb(); };
      next();
    });
    app.use('/api/gallery', require('../../src/routes/gallery'));
    app.use('/api/gallery', require('../../src/routes/galleryGuests'));
    app.use('/api/gallery', require('../../src/routes/galleryFeedback'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(async () => {
    await db('access_logs').where({ event_id: eventId }).del();
  });

  describe('setting off (the default)', () => {
    beforeAll(() => setRequired(false));

    it('downloads a photo without a guest identity, logged anonymously', async () => {
      const res = await request(app).get(`/api/gallery/${SLUG}/download/${photoId}`);
      expect(res.status).toBe(200);
      const log = await lastLog('download');
      expect(log).toBeTruthy();
      expect(log.guest_id).toBeNull();
    });

    it('keeps an identified guest anonymous in the log', async () => {
      const res = await request(app).get(`/api/gallery/${SLUG}/download/${photoId}`).set('x-guest-token', guestToken);
      expect(res.status).toBe(200);
      expect((await lastLog('download')).guest_id).toBeNull();

      await request(app).get(`/api/gallery/${SLUG}/photos`).set('x-guest-token', guestToken);
      expect((await lastLog('view')).guest_id).toBeNull();
    });

    it('refuses none of the archive routes for a missing identity', async () => {
      const responses = [
        await request(app).post(`/api/gallery/${SLUG}/download-selected`).send({ photo_ids: [] }),
        await request(app).post(`/api/gallery/${SLUG}/download-jobs`).send({ photo_ids: [] }),
        await request(app).get(`/api/gallery/${SLUG}/download-jobs/no-such-token/file`),
      ];
      for (const res of responses) expect(res.body.code).not.toBe(CODE);
    });

    it('tells the gallery the setting is off', async () => {
      const res = await request(app).get(`/api/gallery/${SLUG}/feedback-settings`);
      expect(res.body.require_guest_for_download).toBe(false);
    });
  });

  describe('setting on', () => {
    beforeAll(() => setRequired(true));

    it('tells the gallery the setting is on', async () => {
      const res = await request(app).get(`/api/gallery/${SLUG}/feedback-settings`);
      expect(res.body.require_guest_for_download).toBe(true);
    });

    it('refuses every download route without a guest identity', async () => {
      const responses = [
        await request(app).get(`/api/gallery/${SLUG}/download/${photoId}`),
        await request(app).get(`/api/gallery/${SLUG}/download-all`),
        await request(app).post(`/api/gallery/${SLUG}/download-selected`).send({ photo_ids: [photoId] }),
        await request(app).post(`/api/gallery/${SLUG}/download-jobs`).send({}),
        await request(app).get(`/api/gallery/${SLUG}/download-jobs/no-such-token/file`),
      ];
      for (const res of responses) {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe(CODE);
      }
      expect(await db('access_logs').where({ event_id: eventId })).toHaveLength(0);
    });

    it('refuses the HEAD preflight of a direct download too', async () => {
      const res = await request(app).head(`/api/gallery/${SLUG}/download/${photoId}`);
      expect(res.status).toBe(403);
    });

    it('downloads for an identified guest and logs the guest', async () => {
      const res = await request(app).get(`/api/gallery/${SLUG}/download/${photoId}`).set('x-guest-token', guestToken);
      expect(res.status).toBe(200);
      const log = await lastLog('download');
      expect(Number(log.guest_id)).toBe(Number(guestId));
      expect(String(log.photo_id)).toBe(String(photoId));
    });

    it('logs a whole-gallery archive under the guest', async () => {
      const res = await request(app).get(`/api/gallery/${SLUG}/download-all`).set('x-guest-token', guestToken)
        .buffer(true).parse((r, cb) => { r.on('data', () => {}); r.on('end', () => cb(null, null)); });
      expect(res.status).toBe(200);
      expect(Number((await lastLog('download_all')).guest_id)).toBe(Number(guestId));
    });

    it('logs a gallery view under the guest', async () => {
      const res = await request(app).get(`/api/gallery/${SLUG}/photos`).set('x-guest-token', guestToken);
      expect(res.status).toBe(200);
      expect(Number((await lastLog('view')).guest_id)).toBe(Number(guestId));
    });

    it('lets an identified guest past the gate on the archive routes', async () => {
      const responses = [
        await request(app).post(`/api/gallery/${SLUG}/download-selected`).set('x-guest-token', guestToken).send({ photo_ids: [] }),
        await request(app).post(`/api/gallery/${SLUG}/download-jobs`).set('x-guest-token', guestToken).send({ photo_ids: [] }),
        await request(app).get(`/api/gallery/${SLUG}/download-jobs/no-such-token/file`).set('x-guest-token', guestToken),
      ];
      expect(responses.map((r) => r.status)).toEqual([400, 400, 404]);
    });

    it('accepts a download ticket on a browser-navigated download', async () => {
      const ticket = await ticketFor(guestToken);
      const res = await request(app).get(`/api/gallery/${SLUG}/download/${photoId}`).query({ guest_ticket: ticket });
      expect(res.status).toBe(200);
      expect(Number((await lastLog('download')).guest_id)).toBe(Number(guestId));

      const file = await request(app).get(`/api/gallery/${SLUG}/download-jobs/no-such-token/file`).query({ guest_ticket: ticket });
      expect(file.status).toBe(404);
    });

    it('refuses a ticket from another gallery, a forged one and a guest token in its place', async () => {
      const foreign = await ticketFor(otherGuestToken, OTHER_SLUG);
      const forged = jwt.sign({ type: 'guest_download', guestId, eventId }, 'not-the-secret', { issuer: 'picpeak-auth' });
      for (const ticket of [foreign, forged, guestToken]) {
        const res = await request(app).get(`/api/gallery/${SLUG}/download/${photoId}`).query({ guest_ticket: ticket });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe(CODE);
      }
    });

    it('refuses a guest token of another gallery', async () => {
      const res = await request(app).get(`/api/gallery/${SLUG}/download/${photoId}`).set('x-guest-token', otherGuestToken);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe(CODE);
    });

    it('does not ask a customer signed in by client link / PIN', async () => {
      const galleryToken = (extra) => jwt.sign(
        { eventId, eventSlug: SLUG, type: 'gallery', ...extra },
        process.env.JWT_SECRET,
        { expiresIn: '1h', issuer: 'picpeak-auth' },
      );
      const res = await request(app).get(`/api/gallery/${SLUG}/download/${photoId}`)
        .set('Authorization', `Bearer ${galleryToken({ accessLevel: 'client' })}`);
      expect(res.status).toBe(200);
      expect((await lastLog('download')).guest_id).toBeNull();
      // A plain guest session is still asked.
      const guest = await request(app).get(`/api/gallery/${SLUG}/download/${photoId}`)
        .set('Authorization', `Bearer ${galleryToken({})}`);
      expect(guest.status).toBe(403);
      expect(guest.body.code).toBe(CODE);
    });

    it('issues no ticket without a guest identity', async () => {
      const res = await request(app).post(`/api/gallery/${SLUG}/guest/download-ticket`);
      expect(res.status).toBe(401);
    });

    it('does not ask outside guest identity mode', async () => {
      await db('event_feedback_settings').where({ event_id: eventId }).update({ identity_mode: 'simple' });
      try {
        const res = await request(app).get(`/api/gallery/${SLUG}/download/${photoId}`);
        expect(res.status).toBe(200);
        expect((await lastLog('download')).guest_id).toBeNull();
      } finally {
        await db('event_feedback_settings').where({ event_id: eventId }).update({ identity_mode: 'guest' });
      }
    });
  });

  it('"remove me" keeps the guest\'s views and downloads, without the guest', async () => {
    await setRequired(true);
    const forgetter = await addGuest(eventId, 'Carla');
    const { signGuestToken } = require('../../src/middleware/guestAuth');
    const token = signGuestToken({ guestId: forgetter, eventId, identifier: 'Carla-identifier', name: 'Carla' });

    await request(app).get(`/api/gallery/${SLUG}/photos`).set('x-guest-token', token);
    await request(app).get(`/api/gallery/${SLUG}/download/${photoId}`).set('x-guest-token', token);
    expect(await db('access_logs').where({ guest_id: forgetter })).toHaveLength(2);

    const res = await request(app).delete(`/api/gallery/${SLUG}/guest/me`).set('x-guest-token', token);
    expect(res.status).toBe(200);

    expect(await db('access_logs').where({ guest_id: forgetter })).toHaveLength(0);
    // The gallery's totals stay as they were.
    expect(await db('access_logs').where({ event_id: eventId })).toHaveLength(2);
  });

  it('stores the guest prompt\'s privacy note as plain trimmed text and hands it to the gallery', async () => {
    const { validateFeedbackSettings, checkValidation } = require('../../src/utils/feedbackValidation');
    const feedbackService = require('../../src/services/feedbackService');
    const admin = express();
    admin.use(express.json());
    admin.put('/settings', validateFeedbackSettings, checkValidation, async (req, res) => {
      res.json(await feedbackService.updateEventFeedbackSettings(eventId, req.body));
    });

    const tooLong = await request(admin).put('/settings').send({ guest_privacy_text: 'x'.repeat(1001) });
    expect(tooLong.status).toBe(400);
    const notText = await request(admin).put('/settings').send({ guest_privacy_text: 42 });
    expect(notText.status).toBe(400);

    const saved = await request(admin).put('/settings')
      .send({ require_guest_for_download: true, guest_privacy_text: '  We only use your name for the album.  ' });
    expect(saved.status).toBe(200);
    expect(saved.body.guest_privacy_text).toBe('We only use your name for the album.');
    const shown = await request(app).get(`/api/gallery/${SLUG}/feedback-settings`);
    expect(shown.body.guest_privacy_text).toBe('We only use your name for the album.');

    const blank = await request(admin).put('/settings').send({ guest_privacy_text: '   ' });
    expect(blank.body.guest_privacy_text).toBeNull();
  });
});
