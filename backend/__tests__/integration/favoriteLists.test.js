/**
 * Named favourite lists per guest per gallery (issue 2303, migration 339).
 *
 * A guest sorts their favourites into lists they name. NULL on the favourite
 * row is the default list. photos.favorite_count stays "distinct guests who
 * saved it", the cap is per list, and with the gallery toggle off nothing
 * changes for the guest.
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('./helpers/crmDb');

jest.mock('../../src/utils/logger', () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

process.env.JWT_SECRET = process.env.JWT_SECRET || 'favorite-lists-secret';

const SLUG = 'favorite-lists';

describe('named favourite lists (issue 2303)', () => {
  let db; let cleanup; let app; let adminId; let feedbackService;
  let eventId; let photoIds; let guests;

  const galleryToken = () => jwt.sign(
    { eventId, eventSlug: SLUG, type: 'gallery' },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' }
  );
  const guestToken = (guest) => jwt.sign(
    { eventId, guestId: guest.id, type: 'guest' },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' }
  );
  const devices = new Map();
  const device = (name) => {
    if (!devices.has(name)) devices.set(name, request.agent(app));
    return devices.get(name);
  };
  // `who` is a device name (anonymous viewer) or a registered guest row.
  const as = (who, method, path) => {
    const agent = typeof who === 'string' ? device(who) : request(app);
    const req = agent[method](`/api/gallery/${SLUG}${path}`).set('Authorization', `Bearer ${galleryToken()}`);
    return typeof who === 'string' ? req : req.set('x-guest-token', guestToken(who));
  };
  const favorite = (who, photoId, listId) => as(who, 'post', `/photos/${photoId}/feedback`)
    .send({ feedback_type: 'favorite', ...(listId !== undefined ? { favorite_list_id: listId } : {}) });
  const createList = (who, name) => as(who, 'post', '/favorite-lists').send({ name });
  const admin = (method, path) => request(app)[method](`/api/admin${path}`)
    .set('Authorization', `Bearer ${mintAdminToken(adminId)}`);
  const setSettings = (patch) => db('event_feedback_settings').where({ event_id: eventId }).update(patch);
  const favorites = () => db('photo_feedback').where({ event_id: eventId, feedback_type: 'favorite' });
  const favoriteCount = async (photoId) => Number((await db('photos').where({ id: photoId }).first()).favorite_count);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId } = await seedMinimal(db));
    await assignAdminRole(db, adminId);
    feedbackService = require('../../src/services/feedbackService');

    const [ev] = await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Favourite Lists',
      event_date: '2026-10-01',
      host_email: 'h@example.com',
      admin_email: 'studio@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'favorite-lists-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = typeof ev === 'object' ? ev.id : ev;

    const inserted = await db('photos').insert([1, 2, 3].map((n) => ({
      event_id: eventId, filename: `p${n}.jpg`, original_filename: `IMG_${n}.jpg`, path: `events/lists/p${n}.jpg`,
      type: 'individual', uploaded_at: new Date().toISOString(),
    }))).returning('id');
    photoIds = inserted.map((row) => (typeof row === 'object' ? row.id : row));

    await db('event_feedback_settings').insert({ event_id: eventId, feedback_enabled: true });

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/galleryFeedback'));
    app.use('/api/admin', require('../../src/routes/adminGuests'));
    app.use('/api/admin/feedback', require('../../src/routes/adminFeedback'));
    app.use('/api/admin/photos', require('../../src/routes/adminPhotoExport'));
    app.use('/api/admin/photos', require('../../src/routes/adminPhotos'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(async () => {
    devices.clear();
    for (const table of ['selection_submissions', 'photo_feedback', 'favorite_lists', 'feedback_rate_limits', 'activity_logs', 'gallery_guests']) {
      await db(table).where({ event_id: eventId }).del();
    }
    await db('photos').where({ event_id: eventId }).update({ favorite_count: 0 });
    await setSettings({
      feedback_enabled: true, identity_mode: 'guest', moderate_comments: false,
      allow_likes: true, allow_favorites: true, allow_ratings: true, allow_comments: true,
      allow_favorite_lists: true, allow_selection_submit: true, show_feedback_to_guests: true,
      max_likes_per_guest: null, max_favorites_per_guest: null,
    });
    guests = await db('gallery_guests').insert(['anna', 'ben'].map((name) => ({
      event_id: eventId, name, identifier: `guest-${name}`, email: `${name}@example.com`, is_deleted: false,
    }))).returning('*');
  });

  describe('with the toggle off', () => {
    beforeEach(() => setSettings({ allow_favorite_lists: false }));

    it('refuses every list route and a favourite naming a list', async () => {
      expect((await as(guests[0], 'get', '/favorite-lists')).body.code).toBe('FAVORITE_LISTS_DISABLED');
      const created = await createList(guests[0], 'Print');
      expect(created.status).toBe(403);
      expect(created.body.code).toBe('FAVORITE_LISTS_DISABLED');
      expect(await db('favorite_lists').where({ event_id: eventId })).toHaveLength(0);
      expect((await as(guests[0], 'patch', '/favorite-lists/1').send({ name: 'x' })).status).toBe(403);
      expect((await as(guests[0], 'delete', '/favorite-lists/1')).status).toBe(403);

      const refused = await favorite(guests[0], photoIds[0], 1);
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('FAVORITE_LISTS_DISABLED');
      expect(await favorites()).toHaveLength(0);
    });

    it('answers favourites as before: no list fields, and one click clears every copy', async () => {
      expect((await as(guests[0], 'get', '/feedback-settings')).body.allow_favorite_lists).toBe(false);
      expect((await favorite(guests[0], photoIds[0])).body).toMatchObject({ created: true });

      const mine = await as(guests[0], 'get', '/my-feedback');
      expect(mine.body).toHaveLength(1);
      expect(mine.body[0]).not.toHaveProperty('favorite_list_id');
      const photo = await as(guests[0], 'get', `/photos/${photoIds[0]}/feedback`);
      expect(photo.body.my_feedback.favorited).toBe(true);
      expect(photo.body.my_feedback).not.toHaveProperty('favorite_list_ids');

      // A copy left in a list from when lists were on still reads as saved,
      // and the bookmark still clears the photo in one click.
      const [list] = await db('favorite_lists').insert({
        event_id: eventId, guest_id: guests[0].id, guest_identifier: guests[0].identifier, name: 'Old',
      }).returning('id');
      await db('photo_feedback').insert({
        event_id: eventId, photo_id: photoIds[0], guest_id: guests[0].id, guest_identifier: guests[0].identifier,
        feedback_type: 'favorite', favorite_list_id: list.id ?? list, is_hidden: false, is_approved: true,
      });
      expect((await favorite(guests[0], photoIds[0])).body).toMatchObject({ removed: true });
      expect(await favorites()).toHaveLength(0);
    });
  });

  describe('the list routes', () => {
    it('creates, renames and lists a guest\'s lists with their counts', async () => {
      const created = await createList(guests[0], '  Print   album ');
      expect(created.status).toBe(201);
      expect(created.body.list).toMatchObject({ name: 'Print album' });
      const listId = created.body.list.id;

      await favorite(guests[0], photoIds[0], listId);
      await favorite(guests[0], photoIds[1], listId);
      await favorite(guests[0], photoIds[2]);

      const renamed = await as(guests[0], 'patch', `/favorite-lists/${listId}`).send({ name: 'Print' });
      expect(renamed.body.list).toMatchObject({ id: listId, name: 'Print' });

      const listed = await as(guests[0], 'get', '/favorite-lists');
      expect(listed.status).toBe(200);
      expect(listed.body).toMatchObject({
        default_count: 1,
        lists: [{ id: listId, name: 'Print', count: 2 }],
        max_lists: 20,
        max_name_length: 60,
      });
      // Another guest sees none of them.
      expect((await as(guests[1], 'get', '/favorite-lists')).body.lists).toEqual([]);
    });

    it('refuses an empty, an over-long and a case-folded duplicate name', async () => {
      expect((await createList(guests[0], '   ')).body.code).toBe('INVALID_FAVORITE_LIST_NAME');
      expect((await createList(guests[0], 'x'.repeat(61))).body.code).toBe('INVALID_FAVORITE_LIST_NAME');
      expect((await createList(guests[0], 'Print')).status).toBe(201);
      const duplicate = await createList(guests[0], 'PRINT');
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.code).toBe('FAVORITE_LIST_NAME_TAKEN');
      // The same name is another guest's to use.
      expect((await createList(guests[1], 'Print')).status).toBe(201);
    });

    it('caps the lists per guest', async () => {
      await db('favorite_lists').insert(Array.from({ length: 20 }, (_, i) => ({
        event_id: eventId, guest_id: guests[0].id, guest_identifier: guests[0].identifier, name: `L${i}`,
      })));
      const refused = await createList(guests[0], 'One more');
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ code: 'FAVORITE_LIST_LIMIT_REACHED', limit: 20 });
    });

    it('deletes a list together with the favourites in it, and recounts', async () => {
      const listId = (await createList(guests[0], 'Print')).body.list.id;
      await favorite(guests[0], photoIds[0], listId);
      await favorite(guests[0], photoIds[1], listId);
      await favorite(guests[0], photoIds[1]);
      expect(await favoriteCount(photoIds[0])).toBe(1);

      const deleted = await as(guests[0], 'delete', `/favorite-lists/${listId}`);
      expect(deleted.body).toMatchObject({ success: true, removed: 2 });
      expect(await db('favorite_lists').where({ id: listId })).toHaveLength(0);
      const left = await favorites();
      expect(left).toHaveLength(1);
      expect(left[0]).toMatchObject({ photo_id: photoIds[1], favorite_list_id: null });
      expect(await favoriteCount(photoIds[0])).toBe(0);
      expect(await favoriteCount(photoIds[1])).toBe(1);
    });

    it('keeps one guest out of another guest\'s lists', async () => {
      const listId = (await createList(guests[0], 'Anna only')).body.list.id;

      const saved = await favorite(guests[1], photoIds[0], listId);
      expect(saved.status).toBe(404);
      expect(saved.body.code).toBe('FAVORITE_LIST_NOT_FOUND');
      expect(await favorites()).toHaveLength(0);
      expect((await as(guests[1], 'patch', `/favorite-lists/${listId}`).send({ name: 'Mine' })).status).toBe(404);
      expect((await as(guests[1], 'delete', `/favorite-lists/${listId}`)).status).toBe(404);
      expect(await db('favorite_lists').where({ id: listId }).first()).toMatchObject({ name: 'Anna only' });
    });

    it('freezes the lists with the selection once it is handed in', async () => {
      const listId = (await createList(guests[0], 'Print')).body.list.id;
      await favorite(guests[0], photoIds[0], listId);
      expect((await as(guests[0], 'post', '/selection/submit').send({ kind: 'selection' })).status).toBe(201);

      for (const res of [
        await createList(guests[0], 'Second'),
        await as(guests[0], 'patch', `/favorite-lists/${listId}`).send({ name: 'Renamed' }),
        await as(guests[0], 'delete', `/favorite-lists/${listId}`),
        await favorite(guests[0], photoIds[1], listId),
      ]) {
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('SELECTION_LOCKED');
      }
      expect(await db('favorite_lists').where({ event_id: eventId })).toHaveLength(1);
    });

    it('works for an anonymous viewer in shared mode, by their browser identity', async () => {
      await setSettings({ identity_mode: 'shared' });
      const listId = (await createList('device-A', 'Print')).body.list.id;
      expect((await favorite('device-A', photoIds[0], listId)).body).toMatchObject({ created: true });
      // Another browser is another viewer.
      expect((await favorite('device-B', photoIds[0], listId)).status).toBe(404);
      expect((await as('device-A', 'get', '/favorite-lists')).body.lists).toMatchObject([{ id: listId, count: 1 }]);
      const mine = await as('device-A', 'get', '/my-feedback');
      expect(mine.body.map((row) => row.favorite_list_id)).toEqual([listId]);
    });
  });

  describe('favourites per list', () => {
    it('keeps the same photo in two lists, and the bookmark toggles one list only', async () => {
      const listId = (await createList(guests[0], 'Print')).body.list.id;
      expect((await favorite(guests[0], photoIds[0])).body).toMatchObject({ created: true });
      expect((await favorite(guests[0], photoIds[0], listId)).body).toMatchObject({ created: true });
      expect(await favorites()).toHaveLength(2);

      const photo = await as(guests[0], 'get', `/photos/${photoIds[0]}/feedback`);
      expect(photo.body.my_feedback.favorite_list_ids.sort()).toEqual([listId, null].sort());

      expect((await favorite(guests[0], photoIds[0], null)).body).toMatchObject({ removed: true });
      const left = await favorites();
      expect(left).toHaveLength(1);
      expect(Number(left[0].favorite_list_id)).toBe(listId);
    });

    it('counts a photo in two lists of one guest once everywhere', async () => {
      const listId = (await createList(guests[0], 'Print')).body.list.id;
      await favorite(guests[0], photoIds[0]);
      await favorite(guests[0], photoIds[0], listId);
      await favorite(guests[1], photoIds[0]);

      expect(await favoriteCount(photoIds[0])).toBe(2);
      const summary = await feedbackService.getEventFeedbackSummary(eventId);
      expect(Number(summary.stats.total_favorites)).toBe(2);

      const list = await admin('get', `/events/${eventId}/guests`);
      expect(list.body.guests.find((g) => g.id === guests[0].id).stats.favorites).toBe(1);
      const detail = await admin('get', `/events/${eventId}/guests/${guests[0].id}`);
      expect(detail.body.guest.stats.favorites).toBe(1);

      const state = await as(guests[0], 'get', '/selection');
      expect(state.body.selection.used).toBe(1);
    });

    it('applies the favourites cap per list', async () => {
      await setSettings({ max_favorites_per_guest: 1 });
      const listId = (await createList(guests[0], 'Print')).body.list.id;
      expect((await favorite(guests[0], photoIds[0])).status).toBe(200);
      const capped = await favorite(guests[0], photoIds[1]);
      expect(capped.status).toBe(403);
      expect(capped.body.code).toBe('FAVORITE_LIMIT_REACHED');
      expect((await favorite(guests[0], photoIds[1], listId)).body).toMatchObject({ created: true });
      expect((await favorite(guests[0], photoIds[2], listId)).body.code).toBe('FAVORITE_LIMIT_REACHED');
    });
  });

  describe('guest erasure and merge', () => {
    it('keeps an erased guest\'s lists with the favourites, detached from the person', async () => {
      const listId = (await createList(guests[0], 'Print')).body.list.id;
      await favorite(guests[0], photoIds[0], listId);
      expect((await admin('delete', `/events/${eventId}/guests/${guests[0].id}`)).status).toBe(200);

      expect(await db('favorite_lists').where({ id: listId }).first()).toMatchObject({ guest_id: null });
      const [row] = await favorites();
      expect(row).toMatchObject({ guest_id: null, favorite_list_id: listId });
    });

    it('moves the lists on a merge, folding same-named lists and their duplicate favourites', async () => {
      const keptPrint = (await createList(guests[0], 'Print')).body.list.id;
      const sourcePrint = (await createList(guests[1], 'print')).body.list.id;
      const sourceAlbum = (await createList(guests[1], 'Album')).body.list.id;
      await favorite(guests[0], photoIds[0], keptPrint);
      await favorite(guests[1], photoIds[0], sourcePrint);
      await favorite(guests[1], photoIds[1], sourcePrint);
      await favorite(guests[1], photoIds[2], sourceAlbum);

      const merged = await admin('post', `/events/${eventId}/guests/${guests[0].id}/merge`)
        .send({ mergeIds: [guests[1].id] });
      expect(merged.status).toBe(200);

      const lists = await db('favorite_lists').where({ event_id: eventId }).orderBy('id');
      expect(lists.map((l) => [Number(l.id), l.name, Number(l.guest_id)])).toEqual([
        [keptPrint, 'Print', guests[0].id],
        [sourceAlbum, 'Album', guests[0].id],
      ]);
      const rows = (await favorites()).map((r) => [Number(r.photo_id), Number(r.favorite_list_id)]).sort();
      expect(rows).toEqual([
        [photoIds[0], keptPrint],
        [photoIds[1], keptPrint],
        [photoIds[2], sourceAlbum],
      ].sort());
    });
  });

  describe('admin exports and filters', () => {
    let listId;
    beforeEach(async () => {
      listId = (await createList(guests[0], 'Print')).body.list.id;
      await favorite(guests[0], photoIds[0]);
      await favorite(guests[0], photoIds[1], listId);
      await favorite(guests[0], photoIds[0], listId);
    });

    it('names the list in the per-guest and the feedback exports', async () => {
      const csv = await admin('get', `/events/${eventId}/guests/${guests[0].id}/export?format=csv`);
      const lines = csv.text.split('\n');
      expect(lines[0]).toBe('filename,original_filename,feedback_type,list');
      expect(lines.slice(1).sort()).toEqual([
        'p1.jpg,IMG_1.jpg,favorite,Default',
        'p1.jpg,IMG_1.jpg,favorite,Print',
        'p2.jpg,IMG_2.jpg,favorite,Print',
      ]);
      // The plain list names each file once.
      const txt = await admin('get', `/events/${eventId}/guests/${guests[0].id}/export?format=txt`);
      expect(txt.text.split('\n').sort()).toEqual(['IMG_1.jpg', 'IMG_2.jpg']);

      const long = await admin('get', `/feedback/events/${eventId}/feedback/export?format=json`);
      expect(long.body.map((r) => `${r.filename}:${r.favorite_list}`).sort())
        .toEqual(['p1.jpg:Default', 'p1.jpg:Print', 'p2.jpg:Print']);
      const pivot = await admin('get', `/feedback/events/${eventId}/feedback/export?format=json&shape=pivot`);
      expect(pivot.body.find((r) => r.filename === 'p1.jpg').favorite_lists).toBe('Default; Print');
    });

    it('shows each list in the guest detail', async () => {
      const detail = await admin('get', `/events/${eventId}/guests/${guests[0].id}`);
      expect(detail.body.favorite_lists).toMatchObject([
        { id: null, name: null, count: 1 },
        { id: listId, name: 'Print', count: 2 },
      ]);
      expect(detail.body.favorite_lists[1].updated_at).toBeTruthy();
      expect(detail.body.selections.favorited.map((p) => [p.id, p.favorite_list_id]).sort())
        .toEqual([[photoIds[0], null], [photoIds[0], listId], [photoIds[1], listId]].sort());
    });

    it('filters the admin photo list and the filtered view by list', async () => {
      const ids = (res) => res.body.photos.map((p) => p.id).sort();
      expect(ids(await admin('get', `/photos/${eventId}/photos?favorite_list=${listId}`)))
        .toEqual([photoIds[0], photoIds[1]].sort());
      expect(ids(await admin('get', `/photos/${eventId}/photos?favorite_list=default&favorite_guest=${guests[0].id}`)))
        .toEqual([photoIds[0]]);
      expect(ids(await admin('get', `/photos/${eventId}/photos?favorite_guest=${guests[1].id}`))).toEqual([]);
      // Unfiltered, all three.
      expect(ids(await admin('get', `/photos/${eventId}/photos`))).toHaveLength(3);

      const filtered = await admin('get', `/photos/${eventId}/filtered?sort=filename&favorite_list=${listId}`);
      expect(filtered.body.data.photos.map((p) => p.id).sort()).toEqual([photoIds[0], photoIds[1]].sort());
    });
  });
});
