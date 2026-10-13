/**
 * The photo trash (issue 1733, item D2; migration 294).
 *
 * Pins the contract of the flag model:
 *  - an admin's delete (single and bulk) flags the row; id, file, thumbnail
 *    and every child row stay, and a restore clears the flag again
 *  - while trashed, every guest route answers for the photo as for an id
 *    that does not exist, and the admin grid and its counts leave it out
 *  - photo.deleted fires once, on trash; restore and purge announce nothing
 *  - trashed photos do not count toward the photo cap; a restore over the
 *    cap is refused with 409
 *  - the folder watcher still finds the row of a trashed photo's file
 *  - purge and the sweep delete row and files; a restore racing a purge and
 *    two sweeps at once handle each photo exactly once
 *  - deleting the gallery deletes trashed photos' files too
 *  - retention 0 deletes at once, as before the trash
 *  - the trash routes are scoped to the gallery like delete is
 */
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(24).toString('hex');

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('./helpers/crmDb');

describe('photo trash (issue 1733)', () => {
  let db; let cleanup; let app;
  let storage; let photoTrash; let webhookFire; let jpeg; let apiToken;
  const tok = {};
  const id = {};
  let seq = 0;

  const as = (req, who) => req.set('Authorization', `Bearer ${tok[who]}`);
  const now = () => new Date().toISOString();
  const firstId = (rows) => rows[0]?.id ?? rows[0];
  const count = async (table, where) => Number((await db(table).where(where).count('* as c').first()).c);
  const row = (photo) => db('photos').where({ id: photo.id }).first();

  async function mkAdmin(name, roleName) {
    const adminId = firstId(await db('admin_users').insert({
      username: `trash-${name}`, email: `trash-${name}@example.com`, password_hash: 'x',
      must_change_password: false, created_at: now(),
    }).returning('id'));
    await assignAdminRole(db, adminId, roleName);
    tok[name] = mintAdminToken(adminId);
    return adminId;
  }

  async function mkEvent(overrides = {}) {
    seq += 1;
    const slug = `trash-event-${seq}`;
    const eventId = firstId(await db('events').insert({
      slug, event_type: 'wedding', event_name: `Trash ${seq}`, event_date: '2026-08-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `/gallery/${slug}/t`, share_token: crypto.randomBytes(8).toString('hex'),
      expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_by: id.owner, created_at: now(),
      ...overrides,
    }).returning('id'));
    return db('events').where({ id: eventId }).first();
  }

  /** A managed photo with its original, a thumbnail and a preview in storage. */
  async function mkPhoto(event, fields = {}) {
    seq += 1;
    const filename = `IMG_${seq}.jpg`;
    const key = `events/active/${event.slug}/${filename}`;
    const thumb = `thumbnails/thumb_${filename}`;
    const preview = `previews/preview_${filename}`;
    for (const k of [key, thumb, preview]) await storage.put(k, jpeg);
    const photoId = firstId(await db('photos').insert({
      event_id: event.id, filename, original_filename: `Original ${seq}.jpg`, path: `${event.slug}/${filename}`,
      thumbnail_path: thumb, preview_path: preview, type: 'individual', media_type: 'image', mime_type: 'image/jpeg',
      size_bytes: jpeg.length, uploaded_at: now(), processing_status: 'complete', visibility: 'visible',
      ...fields,
    }).returning('id'));
    return { id: photoId, key, thumb, preview, filename, files: [key, thumb, preview] };
  }

  const filesExist = async (photo) => (await Promise.all(photo.files.map((k) => storage.exists(k)))).every(Boolean);
  const filesGone = async (photo) => (await Promise.all(photo.files.map((k) => storage.exists(k)))).every((x) => !x);

  const setRetention = async (days) => {
    await db('app_settings').where({ setting_key: 'general_photo_trash_retention_days' }).del();
    if (days !== undefined) {
      await db('app_settings').insert({
        setting_key: 'general_photo_trash_retention_days', setting_value: JSON.stringify(days), setting_type: 'general',
      });
    }
  };

  const base = (event) => `/api/admin/events/${event.id}/photos`;
  const del = (event, photo, who = 'owner') => as(request(app).delete(`${base(event)}/${photo.id}`), who);
  const bulkDel = (event, photoIds, who = 'owner') => as(request(app).post(`${base(event)}/bulk-delete`), who).send({ photoIds });
  const trash = (event, who = 'owner') => as(request(app).get(`${base(event)}/trash`), who);
  const restore = (event, ids, who = 'owner') => as(request(app).post(`${base(event)}/trash/restore`), who).send({ ids });
  const purge = (event, ids, who = 'owner') => as(request(app).post(`${base(event)}/trash/purge`), who).send({ ids });
  const grid = async (event) => (await as(request(app).get(base(event)), 'owner')).body;

  const guest = (event, method, url, accessLevel) => request(app)[method](`/api/gallery/${event.slug}${url}`)
    .set('Authorization', `Bearer ${jwt.sign(
      { eventId: event.id, eventSlug: event.slug, type: 'gallery', ...(accessLevel ? { accessLevel } : {}) },
      process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' })}`);
  const guestPhotos = async (event) => {
    const res = await guest(event, 'get', '/photos');
    expect(res.status).toBe(200);
    return Array.isArray(res.body) ? res.body : res.body.photos;
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    id.owner = await mkAdmin('owner', 'solo_photographer');
    id.other = await mkAdmin('other', 'solo_photographer');
    jpeg = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#778899' } }).jpeg().toBuffer();

    storage = require('../../src/services/storage').getStorage();
    photoTrash = require('../../src/services/photoTrash');
    webhookFire = jest.spyOn(require('../../src/services/webhookService'), 'fire').mockResolvedValue();
    const issued = require('../../src/middleware/apiTokenAuth').generateApiToken();
    await db('api_tokens').insert({ name: 'Trash test', hashed_token: issued.hashed, scopes: 'read', created_by: id.owner });
    apiToken = issued.plaintext;

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/events', require('../../src/routes/adminPhotos'));
    app.use('/api/admin/photos', require('../../src/routes/adminPhotos'));
    app.use('/api/admin', require('../../src/routes/adminGuests'));
    app.use('/api/gallery', require('../../src/routes/gallery'));
    app.use('/api/gallery', require('../../src/routes/galleryFeedback'));
    app.use('/api/v1', require('../../src/routes/v1/events'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(async () => {
    await setRetention(undefined);
    webhookFire.mockClear();
  });

  describe('trash and restore', () => {
    it('keeps the id, the files and every child row', async () => {
      const event = await mkEvent();
      const guestId = firstId(await db('gallery_guests').insert({
        event_id: event.id, name: 'Anna', identifier: crypto.randomUUID(), created_at: now(),
      }).returning('id'));
      const categoryId = firstId(await db('photo_categories').insert({
        name: 'Ceremony', slug: `ceremony-${seq}`, event_id: event.id,
      }).returning('id'));
      const photo = await mkPhoto(event, { category_id: categoryId, like_count: 1, average_rating: 4 });
      await db('events').where({ id: event.id }).update({ hero_photo_id: photo.id });
      await db('photo_categories').where({ id: categoryId }).update({ hero_photo_id: photo.id });
      await db('photo_feedback').insert([
        { photo_id: photo.id, event_id: event.id, feedback_type: 'like', guest_identifier: 'anna', guest_id: guestId },
        { photo_id: photo.id, event_id: event.id, feedback_type: 'rating', rating: 4, guest_identifier: 'anna', guest_id: guestId },
      ]);
      await db('photo_admin_marks').insert({ photo_id: photo.id, event_id: event.id, admin_id: id.owner, rating: 4, color_label: 'red' });
      await db('event_download_grants').insert({ event_id: event.id, photo_id: photo.id, granted_at: now() });
      await db('photo_faces').insert({ photo_id: photo.id, event_id: event.id, bbox_x: 0, bbox_y: 0, bbox_w: 1, bbox_h: 1 });
      const children = async () => Promise.all(['photo_feedback', 'photo_admin_marks', 'event_download_grants', 'photo_faces']
        .map((table) => count(table, { photo_id: photo.id })));
      const before = await row(photo);
      const childrenBefore = await children();
      expect(childrenBefore).toEqual([2, 1, 1, 1]);

      const res = await del(event, photo);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ trashed: 1, deleted: 0, retention_days: 30 });

      const trashed = await row(photo);
      expect(trashed.deleted_at).not.toBeNull();
      expect(new Date(trashed.purge_after) - new Date(trashed.deleted_at)).toBe(30 * 86400000);
      expect(Number(trashed.deleted_by_admin_id)).toBe(id.owner);
      expect(await filesExist(photo)).toBe(true);
      expect(await children()).toEqual(childrenBefore);
      expect((await db('events').where({ id: event.id }).first()).hero_photo_id).toBe(photo.id);
      expect(webhookFire).toHaveBeenCalledTimes(1);
      expect(webhookFire).toHaveBeenCalledWith('photo.deleted', expect.objectContaining({
        photo: { id: photo.id, filename: photo.filename },
      }));

      const list = await trash(event);
      expect(list.status).toBe(200);
      expect(list.body.retention_days).toBe(30);
      expect(list.body.items).toEqual([expect.objectContaining({
        id: photo.id, filename: photo.filename, media_type: 'image', deleted_by_name: 'trash-owner', held: false,
        thumbnail_url: `/admin/events/${event.id}/photos/trash/${photo.id}/thumbnail`,
      })]);
      const thumb = await as(request(app).get(`${base(event)}/trash/${photo.id}/thumbnail`), 'owner');
      expect(thumb.status).toBe(200);
      expect(thumb.headers['content-type']).toMatch(/image\/jpeg/);

      webhookFire.mockClear();
      const back = await restore(event, [photo.id]);
      expect(back.status).toBe(200);
      expect(back.body).toEqual({ restored: 1, photo_ids: [photo.id], failed: [] });
      expect(webhookFire).not.toHaveBeenCalled();
      expect(await row(photo)).toEqual(before);
      expect(await filesExist(photo)).toBe(true);
      expect(await children()).toEqual(childrenBefore);
      expect((await trash(event)).body.items).toEqual([]);
      const seen = (await guestPhotos(event)).find((p) => p.id === photo.id);
      expect(seen).toMatchObject({ like_count: 1 });
      expect(Number(seen.average_rating)).toBe(4);
    });

    it('a second delete, restore or purge of the same photo changes nothing', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      expect((await del(event, photo)).status).toBe(200);
      expect((await del(event, photo)).status).toBe(404);
      expect(webhookFire).toHaveBeenCalledTimes(1);

      expect((await restore(event, [photo.id])).status).toBe(200);
      const again = await restore(event, [photo.id]);
      expect(again.status).toBe(409);
      expect(again.body.failed).toEqual([expect.objectContaining({ id: photo.id, code: 'NOT_IN_TRASH', filename: photo.filename })]);
      // A photo in the gallery cannot be purged through the trash.
      expect((await purge(event, [photo.id])).body).toEqual({ purged: 0, failed: [] });
      expect(await row(photo)).toBeDefined();
      expect(await filesExist(photo)).toBe(true);
    });

    it('bulk delete trashes each photo and announces each once', async () => {
      const event = await mkEvent();
      const a = await mkPhoto(event); const b = await mkPhoto(event); const kept = await mkPhoto(event);
      const res = await bulkDel(event, [a.id, b.id]);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ trashed: 2, deleted: 0, failed: [], retention_days: 30 });
      expect(webhookFire.mock.calls.map((c) => c[1].photo.id).sort()).toEqual([a.id, b.id].sort());
      expect((await grid(event)).photos.map((p) => p.id)).toEqual([kept.id]);
      expect((await trash(event)).body.items.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
      // Already trashed: nothing left to delete.
      expect((await bulkDel(event, [a.id])).status).toBe(404);
    });

    it('a photo held for review comes back held', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event, { moderation_status: 'pending', visibility: 'hidden' });
      await del(event, photo);
      expect((await trash(event)).body.items[0]).toMatchObject({ id: photo.id, held: true });
      await restore(event, [photo.id]);
      expect(await row(photo)).toMatchObject({ moderation_status: 'pending', visibility: 'hidden', deleted_at: null });
      expect((await guestPhotos(event)).map((p) => p.id)).not.toContain(photo.id);
    });

    it('the retention is fixed when the photo is trashed', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      await setRetention(7);
      expect((await del(event, photo)).body.retention_days).toBe(7);
      await setRetention(90);
      const trashed = await row(photo);
      expect(new Date(trashed.purge_after) - new Date(trashed.deleted_at)).toBe(7 * 86400000);
    });
  });

  describe('while trashed', () => {
    let event; let photo; let live;
    const UNKNOWN = 987654;

    beforeAll(async () => {
      event = await mkEvent({ allow_downloads: 1 });
      await db('event_feedback_settings').insert({
        event_id: event.id, feedback_enabled: true, allow_likes: true, allow_ratings: true,
        moderate_comments: false, show_feedback_to_guests: true, identity_mode: 'simple',
      });
      photo = await mkPhoto(event, { like_count: 1, feedback_count: 1 });
      live = await mkPhoto(event);
      await db('photo_feedback').insert({ photo_id: photo.id, event_id: event.id, feedback_type: 'like', guest_identifier: 'g1' });
      await db('events').where({ id: event.id }).update({ hero_photo_id: photo.id, og_image_share_enabled: 1 });
      // Sanity, before the delete: the guest routes do serve this photo.
      expect((await guest(event, 'get', `/thumbnail/${photo.id}`)).status).toBe(200);
      expect((await guest(event, 'get', `/photos/${photo.id}/feedback`)).status).toBe(200);
      expect((await del(event, photo)).status).toBe(200);
    });

    it.each([
      ['get', (pid) => `/photo/${pid}`],
      ['get', (pid) => `/thumbnail/${pid}`],
      ['get', (pid) => `/preview/${pid}`],
      ['get', (pid) => `/hero/${pid}`],
      ['get', (pid) => `/download/${pid}`],
      ['post', (pid) => `/photo/${pid}/view`],
      ['get', (pid) => `/photos/${pid}/feedback`],
    ])('guest %s %s answers as for an unknown id', async (method, url) => {
      const unknown = await guest(event, method, url(UNKNOWN));
      const trashed = await guest(event, method, url(photo.id));
      expect([403, 404]).toContain(unknown.status);
      expect(trashed.status).toBe(unknown.status);
      expect(trashed.body).toEqual(unknown.body);
    });

    it('guest feedback cannot be written', async () => {
      const send = (pid) => guest(event, 'post', `/photos/${pid}/feedback`).send({ feedback_type: 'like' });
      const unknown = await send(UNKNOWN);
      const trashed = await send(photo.id);
      expect(unknown.status).toBe(404);
      expect(trashed.status).toBe(404);
      expect(await count('photo_feedback', { photo_id: photo.id })).toBe(1);
    });

    it('the guest list, stats, selected download and feedback summary leave it out', async () => {
      expect((await guestPhotos(event)).map((p) => p.id)).toEqual([live.id]);
      expect(Number((await guest(event, 'get', '/stats')).body.total_photos ?? (await guest(event, 'get', '/stats')).body.totalPhotos)).toBe(1);

      const unknown = await guest(event, 'post', '/download-selected').send({ photo_ids: [UNKNOWN] });
      const trashed = await guest(event, 'post', '/download-selected').send({ photo_ids: [photo.id] });
      expect(unknown.status).not.toBe(200);
      expect(trashed.status).toBe(unknown.status);

      const summary = await guest(event, 'get', '/feedback-summary');
      expect(summary.status).toBe(200);
      expect(Number(summary.body.summary.stats.total_likes)).toBe(0);
    });

    it('the ZIP of the gallery, the slideshow and the link preview leave it out', async () => {
      const zip = await guest(event, 'get', '/download-all').buffer(true)
        .parse((res, done) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => done(null, Buffer.concat(chunks))); });
      expect(zip.status).toBe(200);
      expect(zip.body.includes(live.filename)).toBe(true);
      expect(zip.body.includes(photo.filename)).toBe(false);

      await db('events').where({ id: event.id }).update({ show_share_token: 'show-' + crypto.randomBytes(6).toString('hex') });
      await db('feature_flags').where({ key: 'slideshow' }).del();
      await db('feature_flags').insert({ key: 'slideshow', value: true });
      require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
      const show = (await db('events').where({ id: event.id }).first()).show_share_token;
      const state = await request(app).get(`/api/gallery/${event.slug}/show/${show}/state`);
      expect(state.status).toBe(200);
      expect(state.body.photo_count).toBe(1);

      // The hero is in the trash: the preview falls back to no cover.
      const meta = await require('../../src/services/galleryOgService').buildOgMetadata(event.slug, `/gallery/${event.slug}`);
      expect(JSON.stringify(meta)).not.toContain(`/${photo.id}`);
    });

    it('the public API leaves it out', async () => {
      const api = (url) => request(app).get(`/api/v1/events/${event.id}${url}`).set('Authorization', `Bearer ${apiToken}`);
      const list = await api('/photos');
      expect(list.status).toBe(200);
      expect((list.body.photos || list.body.data || list.body.items).map((p) => p.id)).toEqual([live.id]);
      expect((await api(`/photos/${photo.id}/download`)).status).toBe(404);
      expect((await api(`/photos/${photo.id}/preview`)).status).toBe(404);
    });

    it('the admin grid, its counts and the photo routes leave it out', async () => {
      const body = await grid(event);
      expect(body.photos.map((p) => p.id)).toEqual([live.id]);
      expect(await require('../../src/services/photoCap').countEventPhotos(event.id)).toBe(1);
      expect((await as(request(app).get(`/api/admin/photos/${event.id}/thumbnail/${photo.id}`), 'owner')).status).toBe(404);
      expect((await as(request(app).patch(`${base(event)}/${photo.id}`), 'owner').send({ visibility: 'hidden' })).status).toBe(404);
      expect((await row(photo)).visibility).toBe('visible');
      // Renaming an upload after the trashed one's name does not replace it.
      const { findReplacementCandidate } = require('../../src/services/photoReplacementService');
      expect(await findReplacementCandidate(event.id, (await row(photo)).original_filename, { matchMode: 'exact' })).toBeFalsy();
    });

    it('the folder watcher still knows the file belongs to a photo', async () => {
      const { findExistingPhoto } = require('../../src/services/fileWatcher');
      const existing = await findExistingPhoto(event.id, photo.filename, `${event.slug}/${photo.filename}`);
      expect(existing).toMatchObject({ id: photo.id });
    });

    it('queued processing leaves it alone and picks it up after a restore', async () => {
      const queued = await mkPhoto(event, { processing_status: 'pending' });
      await del(event, queued);
      const mediaAttempts = require('../../src/services/mediaAttemptService');
      expect(await mediaAttempts.claimNext('processing', queued.id)).toBeFalsy();
      await restore(event, [queued.id]);
      const claimed = await mediaAttempts.claimNext('processing', queued.id);
      expect(claimed).toMatchObject({ id: queued.id });
    });

    it('watermark and thumbnail regeneration still cover it, so a restore brings back nothing stale', async () => {
      const watermarkService = require('../../src/services/watermarkService');
      const generator = require('../../src/services/watermarkGeneratorService');
      const settings = jest.spyOn(watermarkService, 'getWatermarkSettings').mockResolvedValue({ enabled: true });
      try {
        const before = await generator.getPendingCount();
        const fresh = await mkPhoto(event);
        expect(await generator.getPendingCount()).toBe(before + 1);
        await del(event, fresh);
        expect(await generator.getPendingCount()).toBe(before + 1);
      } finally {
        settings.mockRestore();
      }
    });

    it('the guest list counts no feedback on it, and keeps the guest', async () => {
      const guestId = firstId(await db('gallery_guests').insert({
        event_id: event.id, name: 'Cara', identifier: crypto.randomUUID(), created_at: now(),
      }).returning('id'));
      await db('photo_feedback').insert([
        { photo_id: photo.id, event_id: event.id, feedback_type: 'favorite', guest_identifier: 'cara', guest_id: guestId },
        { photo_id: live.id, event_id: event.id, feedback_type: 'like', guest_identifier: 'cara', guest_id: guestId },
      ]);
      const res = await as(request(app).get(`/api/admin/events/${event.id}/guests`), 'owner');
      expect(res.status).toBe(200);
      expect(res.body.guests.find((g) => g.id === guestId).stats).toMatchObject({ likes: 1, favorites: 0, distinct_photos: 1 });
      await db('photo_feedback').where({ guest_id: guestId, photo_id: live.id }).del();
      const none = await as(request(app).get(`/api/admin/events/${event.id}/guests`), 'owner');
      expect(none.body.guests.find((g) => g.id === guestId).stats).toMatchObject({ likes: 0, favorites: 0, distinct_photos: 0 });
    });

    it('feedback and marks on it count toward nothing: like cap, colour chips', async () => {
      const feedbackService = require('../../src/services/feedbackService');
      const marks = require('../../src/services/photoAdminMarksService');
      // g1 liked only the trashed photo (seeded above).
      expect(await feedbackService.countGuestFeedback(event.id, 'like', null, 'g1')).toBe(0);
      await db('photo_feedback').insert({ photo_id: live.id, event_id: event.id, feedback_type: 'like', guest_identifier: 'g1' });
      expect(await feedbackService.countGuestFeedback(event.id, 'like', null, 'g1')).toBe(1);
      await db('photo_feedback').where({ photo_id: live.id, guest_identifier: 'g1' }).del();

      await db('photo_admin_marks').insert([
        { photo_id: photo.id, event_id: event.id, admin_id: id.owner, color_label: 'red' },
        { photo_id: live.id, event_id: event.id, admin_id: id.owner, color_label: 'green' },
      ]);
      const chips = JSON.stringify(await marks.getEventMarkColorCounts(event.id, id.owner));
      expect(chips).toContain('green');
      expect(chips).not.toContain('red');

      await db('photo_feedback').insert([
        { photo_id: photo.id, event_id: event.id, feedback_type: 'color_label', color_label: 'blue', guest_identifier: 'g2' },
        { photo_id: live.id, event_id: event.id, feedback_type: 'color_label', color_label: 'yellow', guest_identifier: 'g2' },
      ]);
      const { PhotoFilterBuilder } = require('../../src/utils/photoFilterBuilder');
      const summary = await (PhotoFilterBuilder || require('../../src/utils/photoFilterBuilder')).getSummary(db, event.id);
      expect(summary.colorLabelCounts).toMatchObject({ yellow: 1, blue: 0 });
      await db('photo_feedback').where({ event_id: event.id, feedback_type: 'color_label' }).del();
    });

    it('a queued guest upload in the trash no longer holds upload capacity', async () => {
      const queued = await mkPhoto(event, { processing_status: 'pending', uploaded_by: 'guest' });
      const waiting = await mkPhoto(event, { processing_status: 'pending', uploaded_by: 'guest' });
      const hold = (ref) => ({
        id: crypto.randomUUID(), request_id: crypto.randomUUID(), event_id: event.id, bytes: 10, files: 1,
        object_key: `hold-${ref}`, state: 'stored', pending: 1, reference_type: 'photo', reference_id: ref,
      });
      await db('public_upload_objects').insert([hold(queued.id), hold(waiting.id)]);
      await del(event, queued);
      await require('../../src/services/publicUploadQuota').reconcilePending();
      const pendingOf = async (ref) => Number((await db('public_upload_objects').where({ reference_id: ref }).first()).pending);
      expect(await pendingOf(queued.id)).toBe(0);
      expect(await pendingOf(waiting.id)).toBe(1);
    });

    it('a thumbnail that vanishes under the trash dialog is a 404, not a crash', async () => {
      const gone = await mkPhoto(event);
      await del(event, gone);
      const get = jest.spyOn(storage, 'get').mockImplementation(async () => require('fs').createReadStream(`/nonexistent/${crypto.randomUUID()}`));
      try {
        const res = await as(request(app).get(`${base(event)}/trash/${gone.id}/thumbnail`), 'owner');
        expect(res.status).toBe(404);
      } finally {
        get.mockRestore();
      }
    });

    it('erasing a guest clears their name on a trashed upload too', async () => {
      const guestId = firstId(await db('gallery_guests').insert({
        event_id: event.id, name: 'Ben', identifier: crypto.randomUUID(), created_at: now(),
      }).returning('id'));
      const upload = await mkPhoto(event, { uploaded_by: 'guest', uploader_guest_id: guestId, credit_name: 'Ben', credit_source: 'guest' });
      await del(event, upload);
      await require('../../src/services/photoCredit').clearGuestCredits(guestId);
      expect(await row(upload)).toMatchObject({ uploader_guest_id: null, credit_name: null, credit_source: null });
      expect((await row(upload)).deleted_at).not.toBeNull();
    });
  });

  describe('photo cap', () => {
    it('trashed photos do not count, and a restore over the cap is refused', async () => {
      const event = await mkEvent({ photo_cap: 2 });
      const a = await mkPhoto(event); await mkPhoto(event);
      const photoCap = require('../../src/services/photoCap');
      expect(await photoCap.isPhotoCapReached(event)).toBe(true);
      await del(event, a);
      expect(await photoCap.isPhotoCapReached(event)).toBe(false);
      // The freed place is taken by a new upload.
      const inserted = await photoCap.insertPhotoWithinCap({
        event_id: event.id, filename: 'new.jpg', path: `${event.slug}/new.jpg`, type: 'individual', uploaded_at: now(),
      }, 2);
      expect(inserted).not.toBeNull();

      const refused = await restore(event, [a.id]);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ restored: 0, failed: [{ id: a.id, code: 'PHOTO_CAP_REACHED', filename: a.filename }] });
      expect(refused.body.failed[0].error).toMatch(/limit of 2 photos/);
      expect((await row(a)).deleted_at).not.toBeNull();

      // With room again it comes back; two more would not both fit.
      await db('photos').where({ event_id: event.id, filename: 'new.jpg' }).del();
      const b = await mkPhoto(event); await del(event, b);
      const partial = await restore(event, [a.id, b.id]);
      expect(partial.status).toBe(200);
      expect(partial.body.photo_ids).toEqual([a.id]);
      expect(partial.body.failed).toEqual([expect.objectContaining({ id: b.id, code: 'PHOTO_CAP_REACHED' })]);
    });
  });

  describe('delete for good', () => {
    it('purge removes the row, its children and its files without a second webhook', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      await db('photo_faces').insert({ photo_id: photo.id, event_id: event.id, bbox_x: 0, bbox_y: 0, bbox_w: 1, bbox_h: 1 });
      await del(event, photo);
      webhookFire.mockClear();

      const res = await purge(event, [photo.id]);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ purged: 1, failed: [] });
      expect(await row(photo)).toBeUndefined();
      expect(await count('photo_faces', { photo_id: photo.id })).toBe(0);
      expect(await filesGone(photo)).toBe(true);
      expect(webhookFire).not.toHaveBeenCalled();
      expect(await count('activity_logs', { event_id: event.id, activity_type: 'photos_trash_purged' })).toBe(1);
      expect((await restore(event, [photo.id])).status).toBe(409);
    });

    it('the sweep purges what is past its retention and nothing else', async () => {
      const event = await mkEvent();
      const due = await mkPhoto(event); const fresh = await mkPhoto(event); const inGallery = await mkPhoto(event);
      await del(event, due); await del(event, fresh);
      await db('photos').where({ id: due.id }).update({ purge_after: new Date(Date.now() - 1000).toISOString() });

      expect(await photoTrash.purgeExpired()).toBe(1);
      expect(await row(due)).toBeUndefined();
      expect(await filesGone(due)).toBe(true);
      expect((await row(fresh)).deleted_at).not.toBeNull();
      expect(await filesExist(fresh)).toBe(true);
      expect(await filesExist(inGallery)).toBe(true);
      expect(await photoTrash.purgeExpired()).toBe(0);
    });

    it('two sweeps at once purge each photo once', async () => {
      const event = await mkEvent();
      const photos = [];
      for (let i = 0; i < 6; i += 1) photos.push(await mkPhoto(event));
      await bulkDel(event, photos.map((p) => p.id));
      await db('photos').where({ event_id: event.id }).update({ purge_after: new Date(Date.now() - 1000).toISOString() });
      const results = await Promise.all([photoTrash.purgeExpired(), photoTrash.purgeExpired()]);
      expect(results[0] + results[1]).toBe(6);
      expect(await count('photos', { event_id: event.id })).toBe(0);
    });

    it('a restore racing a purge leaves the photo either whole or gone', async () => {
      const event = await mkEvent();
      for (let round = 0; round < 6; round += 1) {
        const photo = await mkPhoto(event);
        await del(event, photo);
        const calls = [restore(event, [photo.id]), purge(event, [photo.id])];
        const [restored, purged] = await Promise.all(round % 2 ? calls : calls.reverse()).then((r) => (round % 2 ? r : r.reverse()));
        const left = await row(photo);
        if (left) {
          expect(restored.body.restored).toBe(1);
          expect(purged.body.purged).toBe(0);
          expect(left.deleted_at).toBeNull();
          expect(await filesExist(photo)).toBe(true);
        } else {
          expect(restored.status).toBe(409);
          expect(purged.body.purged).toBe(1);
          expect(await filesGone(photo)).toBe(true);
        }
      }
    });

    it('a purge under way cannot be restored, and the sweep finishes one a crash left', async () => {
      const event = await mkEvent();
      const crashed = await mkPhoto(event); const running = await mkPhoto(event);
      await del(event, crashed); await del(event, running);
      // The claim of a purge: purge_after cleared, deleted_at is the claim time.
      await db('photos').where({ id: crashed.id }).update({ purge_after: null, deleted_at: new Date(Date.now() - 3600000).toISOString() });
      await db('photos').where({ id: running.id }).update({ purge_after: null, deleted_at: now() });

      expect((await trash(event)).body.items).toEqual([]);
      expect((await restore(event, [crashed.id, running.id])).status).toBe(409);
      expect((await guestPhotos(event)).length).toBe(0);

      expect(await photoTrash.purgeExpired()).toBe(1);
      expect(await row(crashed)).toBeUndefined();
      expect(await filesGone(crashed)).toBe(true);
      expect(await row(running)).toBeDefined();
    });

    it('an original that cannot be deleted keeps the row for the sweep, instead of orphaning the file', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      await del(event, photo);
      const realDelete = storage.delete.bind(storage);
      const failing = jest.spyOn(storage, 'delete').mockImplementation(async (key) => {
        if (key === photo.key) throw new Error('storage unavailable');
        return realDelete(key);
      });
      let res;
      try {
        res = await purge(event, [photo.id]);
      } finally {
        failing.mockRestore();
      }
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ purged: 0, failed: [photo.id] });
      // Claimed and kept: not restorable, not listed, and not gone either.
      expect(await row(photo)).toMatchObject({ purge_after: null });
      expect((await row(photo)).deleted_at).not.toBeNull();
      expect(await storage.exists(photo.key)).toBe(true);

      await db('photos').where({ id: photo.id }).update({ deleted_at: new Date(Date.now() - 3600000).toISOString() });
      expect(await photoTrash.purgeExpired()).toBe(1);
      expect(await row(photo)).toBeUndefined();
      expect(await filesGone(photo)).toBe(true);
    });

    it('the folder watcher leaves the row of a purge under way alone', async () => {
      const event = await mkEvent();
      const purging = await mkPhoto(event); const trashed = await mkPhoto(event);
      await del(event, purging); await del(event, trashed);
      await db('photos').where({ id: purging.id }).update({ purge_after: null });
      const fileWatcher = require('../../src/services/fileWatcher');
      const root = require('path').join(process.env.STORAGE_PATH, 'events/active');
      webhookFire.mockClear();
      await fileWatcher.removePhoto(require('path').join(root, event.slug, purging.filename));
      expect(await row(purging)).toBeDefined();
      // A trashed photo whose file disappears goes as before, without a second webhook.
      await fileWatcher.removePhoto(require('path').join(root, event.slug, trashed.filename));
      expect(await row(trashed)).toBeUndefined();
      expect(webhookFire).not.toHaveBeenCalled();
    });

    it('retention 0 deletes at once', async () => {
      await setRetention(0);
      const event = await mkEvent();
      const photo = await mkPhoto(event); const other = await mkPhoto(event);
      const res = await del(event, photo);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ trashed: 0, deleted: 1, retention_days: 0 });
      expect(await row(photo)).toBeUndefined();
      expect(await filesGone(photo)).toBe(true);
      expect(webhookFire).toHaveBeenCalledTimes(1);

      const bulk = await bulkDel(event, [other.id]);
      expect(bulk.body).toMatchObject({ trashed: 0, deleted: 1 });
      expect(await row(other)).toBeUndefined();
      expect((await trash(event)).body).toEqual({ items: [], retention_days: 0 });
    });

    it('deleting the gallery deletes trashed photos and their files', async () => {
      const event = await mkEvent();
      const trashed = await mkPhoto(event); const kept = await mkPhoto(event);
      await del(event, trashed);
      await require('../../src/routes/adminEvents/helpers').deleteEventCascade(event.id, { id: id.owner, username: 'trash-owner' });
      expect(await count('photos', { event_id: event.id })).toBe(0);
      expect(await filesGone(trashed)).toBe(true);
      expect(await filesGone(kept)).toBe(true);
    });

    it('archiving empties the trash first, whatever is left of the retention', async () => {
      const event = await mkEvent();
      const trashed = await mkPhoto(event); const kept = await mkPhoto(event);
      await del(event, trashed);
      expect(await photoTrash.purgeEventTrash(event)).toBe(1);
      expect(await row(trashed)).toBeUndefined();
      expect(await filesGone(trashed)).toBe(true);
      expect(await filesExist(kept)).toBe(true);
    });

    it('deleting the admin who trashed a photo is not blocked by it', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      const goneId = await mkAdmin(`gone-${seq}`, 'solo_photographer');
      await photoTrash.trashPhoto({ id: photo.id, event_id: event.id }, goneId, 30);
      await require('../../src/services/userManagementService').deleteAdminUser(goneId, id.owner);
      expect(await db('admin_users').where({ id: goneId }).first()).toBeUndefined();
      expect((await row(photo)).deleted_by_admin_id).toBeNull();
      expect((await trash(event)).body.items[0]).toMatchObject({ id: photo.id, deleted_by_name: null });
    });
  });

  describe('scope', () => {
    it('another admin gets 403 on the trash of a gallery that is not theirs', async () => {
      const event = await mkEvent();
      const photo = await mkPhoto(event);
      await del(event, photo);
      expect((await trash(event, 'other')).status).toBe(403);
      expect((await restore(event, [photo.id], 'other')).status).toBe(403);
      expect((await purge(event, [photo.id], 'other')).status).toBe(403);
      expect((await as(request(app).get(`${base(event)}/trash/${photo.id}/thumbnail`), 'other')).status).toBe(403);
      expect((await row(photo)).deleted_at).not.toBeNull();
    });

    it('a photo of another gallery cannot be restored or purged through this one', async () => {
      const mine = await mkEvent(); const theirs = await mkEvent();
      const photo = await mkPhoto(theirs);
      await del(theirs, photo);
      expect((await restore(mine, [photo.id])).status).toBe(409);
      expect((await purge(mine, [photo.id])).body).toEqual({ purged: 0, failed: [] });
      expect((await as(request(app).get(`${base(mine)}/trash/${photo.id}/thumbnail`), 'owner')).status).toBe(404);
      expect((await row(photo)).deleted_at).not.toBeNull();
    });

    it('rejects malformed id lists', async () => {
      const event = await mkEvent();
      for (const ids of [undefined, [], ['1'], [0], [1.5]]) {
        expect((await restore(event, ids)).status).toBe(400);
        expect((await purge(event, ids)).status).toBe(400);
      }
      expect((await restore(event, Array.from({ length: 501 }, (_, i) => i + 1))).status).toBe(400);
    });
  });
});
