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
      // A HEAD answer has no body: the header is what the gallery reads.
      expect(res.headers['x-error-code']).toBe(CODE);
    });

    it('names the refusal in a header the browser may read cross-origin', () => {
      const source = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
      const exposed = source.match(/exposedHeaders:\s*\[([^\]]*)\]/);
      expect(exposed && exposed[1]).toContain('X-Error-Code');
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
      // Written once the archive finished, after the guest is looked up
      // again (loggedGuestId), so it may land just after the response.
      let log;
      for (let i = 0; i < 50 && !log; i += 1) {
        log = await lastLog('download_all');
        if (!log) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(Number(log.guest_id)).toBe(Number(guestId));
    });

    it('reports a pre-built archive to the admin even when it finishes before the guest lookup', async () => {
      // The cached archive streams before its access log row looks the guest
      // up again; a small one can finish first, and its completion listener
      // must already be in place.
      const { Readable } = require('stream');
      const downloadZipService = require('../../src/services/downloadZipService');
      const body = Buffer.from('cached-zip-bytes');
      const zipInfo = jest.spyOn(downloadZipService, 'getZipInfo').mockResolvedValue({ key: 'cached.zip', size: body.length });
      mockStorage.get.mockImplementation(async () => Readable.from([body]));
      await db('activity_logs').where({ event_id: eventId, activity_type: 'gallery_downloaded' }).del();
      try {
        const res = await request(app).get(`/api/gallery/${SLUG}/download-all`).set('x-guest-token', guestToken);
        expect(res.status).toBe(200);
        let reported; let log;
        for (let i = 0; i < 50 && !(reported && log); i += 1) {
          reported = await db('activity_logs').where({ event_id: eventId, activity_type: 'gallery_downloaded' }).first();
          log = await lastLog('download_all');
          if (!(reported && log)) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(reported).toBeTruthy();
        expect(Number(log.guest_id)).toBe(Number(guestId));
      } finally {
        zipInfo.mockRestore();
        mockStorage.get.mockReset();
      }
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

    it('issues no ticket without a guest identity, with a code apart from an expired session', async () => {
      const res = await request(app).post(`/api/gallery/${SLUG}/guest/download-ticket`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe(CODE);
      // A guest removed since, and a guest of another gallery, the same way.
      const gone = await addGuest(eventId, 'Hanna');
      const { signGuestToken } = require('../../src/middleware/guestAuth');
      const goneToken = signGuestToken({ guestId: gone, eventId, identifier: 'Hanna-identifier', name: 'Hanna' });
      await db('gallery_guests').where({ id: gone }).update({ is_deleted: true });
      for (const token of [goneToken, otherGuestToken]) {
        const refused = await request(app).post(`/api/gallery/${SLUG}/guest/download-ticket`).set('x-guest-token', token);
        expect(refused.status).toBe(403);
        expect(refused.body.code).toBe(CODE);
      }
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

  describe('a log row written while the guest is being removed', () => {
    // The removal anonymises the guest's access_logs rows and marks the guest
    // deleted; a view or download resolves the guest and inserts its row.
    // Both orders of the two must leave no row naming the removed guest.
    // Required lazily: db.js binds its file on first load, after bootCrmDb.
    const feedbackService = () => require('../../src/services/feedbackService');
    const deferred = () => {
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      return { promise, resolve };
    };
    const until = async (check) => {
      for (let i = 0; i < 200; i += 1) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('condition not reached');
    };
    const newGuest = async (name) => {
      const id = await addGuest(eventId, name);
      const { signGuestToken } = require('../../src/middleware/guestAuth');
      return { id, token: signGuestToken({ guestId: id, eventId, identifier: `${name}-identifier`, name }) };
    };

    beforeAll(() => setRequired(true));
    afterEach(() => jest.restoreAllMocks());

    it('clears a download written after the anonymisation but before the guest is marked removed', async () => {
      const guest = await newGuest('Ida');
      const anonymised = deferred();
      const release = deferred();
      const service = feedbackService();
      const original = service.anonymizeGuestFeedback.bind(service);
      jest.spyOn(service, 'anonymizeGuestFeedback').mockImplementation(async (id) => {
        const result = await original(id);
        anonymised.resolve();
        await release.promise;
        return result;
      });

      const removal = request(app).delete(`/api/gallery/${SLUG}/guest/me`).set('x-guest-token', guest.token).then((r) => r);
      await anonymised.promise;
      // The guest is not marked removed yet: the download is let through
      // and logged under the guest.
      const dl = await request(app).get(`/api/gallery/${SLUG}/download/${photoId}`).set('x-guest-token', guest.token);
      expect(dl.status).toBe(200);
      expect(await db('access_logs').where({ guest_id: guest.id })).toHaveLength(1);

      release.resolve();
      expect((await removal).status).toBe(200);
      expect(await db('access_logs').where({ guest_id: guest.id })).toHaveLength(0);
      expect(await db('access_logs').where({ event_id: eventId, action: 'download' })).toHaveLength(1);
    });

    it('clears a view resolved before the removal and written after it', async () => {
      const guest = await newGuest('Jana');
      const resolved = deferred();
      const release = deferred();
      const service = feedbackService();
      const original = service.getEventFeedbackSettings.bind(service);
      jest.spyOn(service, 'getEventFeedbackSettings').mockImplementation(async (...args) => {
        const settings = await original(...args);
        // Hold only the lookup that names the guest of the view's row.
        if (new Error().stack.includes('viewGuestId')) {
          resolved.resolve();
          await release.promise;
        }
        return settings;
      });

      const view = request(app).get(`/api/gallery/${SLUG}/photos`).set('x-guest-token', guest.token).then((r) => r);
      await resolved.promise;
      const removal = await request(app).delete(`/api/gallery/${SLUG}/guest/me`).set('x-guest-token', guest.token);
      expect(removal.status).toBe(200);

      release.resolve();
      expect((await view).status).toBe(200);
      await until(async () => (await db('access_logs').where({ event_id: eventId, action: 'view' })).length === 1);
      expect(await db('access_logs').where({ guest_id: guest.id })).toHaveLength(0);
    });

    it('moves a row written under a guest merged meanwhile to the guest that is left', async () => {
      const { settleLoggedGuest } = require('../../src/middleware/guestAuth');
      const kept = await addGuest(eventId, 'Karl');
      const merged = await addGuest(eventId, 'Lena');
      await db('activity_logs').insert({
        activity_type: 'guest_merged',
        actor_type: 'admin',
        metadata: JSON.stringify({ event_id: String(eventId), keep_id: kept, merged_ids: [merged] }),
        event_id: eventId,
      });
      await db('gallery_guests').where({ id: merged }).update({ is_deleted: true });
      await db('access_logs').insert({ event_id: eventId, action: 'download', guest_id: merged });

      await settleLoggedGuest(merged, eventId);
      expect(await db('access_logs').where({ guest_id: merged })).toHaveLength(0);
      expect(await db('access_logs').where({ guest_id: kept })).toHaveLength(1);

      // A live guest's rows stay as they are.
      await settleLoggedGuest(kept, eventId);
      expect(await db('access_logs').where({ guest_id: kept })).toHaveLength(1);
    });
  });

  describe('the guest an archive is logged under once it finished', () => {
    // An archive logs on completion; the guest the request named may have
    // been removed or merged while it streamed.
    // Required lazily: db.js binds its file on first load, after bootCrmDb.
    const loggedGuestId = (...args) => require('../../src/middleware/guestAuth').loggedGuestId(...args);
    const recordMerge = (keepId, mergedIds) => db('activity_logs').insert({
      activity_type: 'guest_merged',
      actor_type: 'admin',
      metadata: JSON.stringify({ event_id: String(eventId), keep_id: keepId, merged_ids: mergedIds }),
      event_id: eventId,
    });
    const softDelete = (id) => db('gallery_guests').where({ id }).update({ is_deleted: true });

    it('keeps a guest that is still there', async () => {
      expect(Number(await loggedGuestId(guestId, eventId))).toBe(Number(guestId));
    });

    it('logs no guest for a removed one, nor for one of another gallery', async () => {
      const removed = await addGuest(eventId, 'Dora');
      await softDelete(removed);
      expect(await loggedGuestId(removed, eventId)).toBeNull();
      expect(await loggedGuestId(guestId, otherEventId)).toBeNull();
    });

    it('follows a merge, and a merge of the survivor, to the guest that is left', async () => {
      const first = await addGuest(eventId, 'Emil');
      const second = await addGuest(eventId, 'Fritz');
      const third = await addGuest(eventId, 'Greta');
      await recordMerge(second, [first]);
      await softDelete(first);
      expect(Number(await loggedGuestId(first, eventId))).toBe(Number(second));

      await recordMerge(third, [second]);
      await softDelete(second);
      expect(Number(await loggedGuestId(first, eventId))).toBe(Number(third));

      // A survivor removed since names nobody.
      await softDelete(third);
      expect(await loggedGuestId(first, eventId)).toBeNull();
    });
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
