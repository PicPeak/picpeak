/**
 * Highlights (issue 2549).
 *
 *  - migration 370 adds photos.highlight_pin and events.highlights_mode /
 *    highlights_threshold; mode defaults off
 *  - selection: a pin always wins (on or off), 'rating' mode adds photos at or
 *    above the threshold, at most one in eight per category with the pins
 *    counted against it, highest rating then lowest id; deterministic
 *  - the public payload carries only is_highlight, never an admin rating
 *  - PUT /api/admin/photos/:eventId/photos/:photoId/highlight sets the pin
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'photo-highlights-secret-at-least-32-characters';

const os = require('os');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('./helpers/crmDb');

const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-highlights-'));
process.env.STORAGE_PATH = storageDir;

// Booted before anything requires the service: it loads database/db, which
// must see the test database path first.
let db; let cleanup; let selectHighlights; let highlightSettingsOf;
beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ selectHighlights, highlightSettingsOf } = require('../../src/services/photoHighlights'));
}, 180000);

afterAll(async () => {
  if (cleanup) await cleanup();
  fs.rmSync(storageDir, { recursive: true, force: true });
});

describe('selectHighlights (issue 2549)', () => {
  const rows = (count, extra = () => ({})) => Array.from({ length: count }, (_, index) => ({
    id: index + 1, folder_id: null, category_id: null, highlight_pin: null, rating: null, ...extra(index + 1),
  }));
  const ids = (set) => [...set].sort((a, b) => a - b);

  it('picks nothing while the mode is off, pins included', () => {
    const photos = rows(16, (id) => ({ rating: 5, highlight_pin: id === 3 ? 1 : null }));
    expect(ids(selectHighlights(photos, { mode: 'off', threshold: 4 }))).toEqual([]);
    expect(highlightSettingsOf({})).toEqual({ mode: 'off', threshold: 4 });
    expect(highlightSettingsOf({ highlights_mode: 'bogus', highlights_threshold: 9 })).toEqual({ mode: 'off', threshold: 4 });
  });

  it('manual mode takes the pins only, uncapped, and ignores ratings', () => {
    const photos = rows(8, (id) => ({ rating: 5, highlight_pin: id <= 3 ? true : null }));
    expect(ids(selectHighlights(photos, { mode: 'manual', threshold: 4 }))).toEqual([1, 2, 3]);
  });

  it('rating mode takes photos at or above the threshold, one in eight', () => {
    // 16 photos: budget 2. Ratings 3 (below), 4, 5, 4.
    const photos = rows(16, (id) => ({ rating: { 2: 3, 5: 4, 9: 5, 12: 4 }[id] ?? null }));
    // Highest first (9), then the earlier of the two fours (5).
    expect(ids(selectHighlights(photos, { mode: 'rating', threshold: 4 }))).toEqual([5, 9]);
    expect(ids(selectHighlights(photos, { mode: 'rating', threshold: 5 }))).toEqual([9]);
    expect(ids(selectHighlights(photos, { mode: 'rating', threshold: 3 }))).toEqual([5, 9]);
  });

  it('a category under eight photos gets no automatic highlight', () => {
    expect(ids(selectHighlights(rows(7, () => ({ rating: 5 })), { mode: 'rating', threshold: 4 }))).toEqual([]);
  });

  it('caps per category: folder, filter category and root count apart', () => {
    const photos = [
      ...rows(8, (id) => ({ id, folder_id: 10, rating: 5 })),
      ...rows(8, (id) => ({ id: id + 100, category_id: 20, rating: 5 })),
      ...rows(8, (id) => ({ id: id + 200, rating: 5 })),
    ];
    expect(ids(selectHighlights(photos, { mode: 'rating', threshold: 4 }))).toEqual([1, 101, 201]);
  });

  it('a pin wins either way: on always, off never; pins use up the automatic budget', () => {
    // 16 photos, budget 2, all rated 5.
    const pinnedOff = rows(16, (id) => ({ rating: 5, highlight_pin: id === 1 ? 0 : null }));
    expect(ids(selectHighlights(pinnedOff, { mode: 'rating', threshold: 4 }))).toEqual([2, 3]);
    // An unrated photo pinned on is a highlight, and takes one of the two slots.
    const pinnedOn = rows(16, (id) => ({ rating: id === 16 ? null : 5, highlight_pin: id === 16 ? true : null }));
    expect(ids(selectHighlights(pinnedOn, { mode: 'rating', threshold: 4 }))).toEqual([1, 16]);
    // Pins beyond the budget all stay; no automatic pick is added.
    const manyPins = rows(16, (id) => ({ rating: 5, highlight_pin: id >= 13 ? 1 : null }));
    expect(ids(selectHighlights(manyPins, { mode: 'rating', threshold: 4 }))).toEqual([13, 14, 15, 16]);
  });

  it('is deterministic: the input order does not change the pick', () => {
    const photos = rows(24, (id) => ({ rating: (id * 7) % 5 + 1 }));
    const forward = ids(selectHighlights(photos, { mode: 'rating', threshold: 3 }));
    const backward = ids(selectHighlights([...photos].reverse(), { mode: 'rating', threshold: 3 }));
    expect(forward).toEqual(backward);
    expect(forward).toHaveLength(3);
  });

  it('reads ratings that arrive as strings (PostgreSQL aggregates)', () => {
    const photos = rows(8, (id) => ({ rating: id === 4 ? '5' : null }));
    expect(ids(selectHighlights(photos, { mode: 'rating', threshold: 4 }))).toEqual([4]);
  });
});

describe('highlights in the gallery and the admin (issue 2549)', () => {
  let app; let adminId; let adminToken; let counter = 0;

  const admin = (req) => req.set('Authorization', `Bearer ${adminToken}`);
  const idOf = (r) => Number(r[0]?.id ?? r[0]);

  async function makeEvent(overrides = {}, count = 16) {
    counter += 1;
    const slug = `highlights-${counter}`;
    const id = idOf(await db('events').insert({
      slug, event_type: 'wedding', event_name: `Highlights ${counter}`, event_date: '2026-08-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `/gallery/${slug}/share`, share_token: `highlights-share-${counter}`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_by: adminId, created_at: new Date().toISOString(),
      ...overrides,
    }).returning('id'));
    const photoIds = [];
    for (let i = 1; i <= count; i += 1) {
      photoIds.push(idOf(await db('photos').insert({
        event_id: id, filename: `p${String(i).padStart(2, '0')}.jpg`, path: `${slug}/p${i}.jpg`,
        type: 'individual', processing_status: 'complete', media_type: 'image', mime_type: 'image/jpeg',
        uploaded_at: `2026-08-01T12:00:${String(i).padStart(2, '0')}.000Z`,
      }).returning('id')));
    }
    const token = jwt.sign({ eventId: id, eventSlug: slug, type: 'gallery' }, process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' });
    return { id, slug, token, photoIds };
  }

  const rate = async (event, photoId, rating, markAdmin = adminId) => {
    const now = new Date().toISOString();
    await db('photo_admin_marks').insert({
      photo_id: photoId, event_id: event.id, admin_id: markAdmin, rating, created_at: now, updated_at: now,
    });
  };

  const list = async ({ slug, token }, query = {}) => {
    const res = await request(app).get(`/api/gallery/${slug}/photos`).query(query).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body;
  };
  const highlighted = (body) => body.photos.filter((p) => p.is_highlight).map((p) => p.id).sort((a, b) => a - b);

  beforeAll(async () => {
    ({ adminId } = await seedMinimal(db));
    await assignAdminRole(db, adminId, 'super_admin');
    adminToken = mintAdminToken(adminId);
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
    app.use('/api/admin/events', require('../../src/routes/adminEvents'));
    app.use('/api/admin/photos', require('../../src/routes/adminPhotos'));
  }, 180000);

  it('is off for an existing gallery: no highlight, pins and ratings notwithstanding', async () => {
    const event = await makeEvent();
    const row = await db('events').where({ id: event.id }).first();
    expect(row.highlights_mode).toBe('off');
    expect(Number(row.highlights_threshold)).toBe(4);
    await rate(event, event.photoIds[0], 5);
    await db('photos').where({ id: event.photoIds[1] }).update({ highlight_pin: 1 });
    const body = await list(event);
    expect(body.photos.every((p) => p.is_highlight === false)).toBe(true);
  });

  it('rating mode highlights the top-rated photos, capped, and pages agree', async () => {
    const event = await makeEvent({ highlights_mode: 'rating' });
    const [a, b, c] = [event.photoIds[3], event.photoIds[7], event.photoIds[11]];
    await rate(event, a, 4);
    await rate(event, b, 5);
    await rate(event, c, 4);
    // A second admin's higher star counts: the highest any admin gave.
    const otherAdmin = idOf(await db('admin_users').insert({
      username: 'second', email: 'second@example.com', password_hash: 'x', is_active: 1,
      created_at: new Date().toISOString(),
    }).returning('id'));
    await rate(event, c, 5, otherAdmin);
    expect(highlighted(await list(event))).toEqual([b, c]);
    // The same pick whatever the sort or page.
    const paged = [];
    for (let page = 1; page <= 4; page += 1) {
      paged.push(...highlighted(await list(event, { sort: 'filename', order: 'asc', limit: 4, page })));
    }
    expect(paged.sort((x, y) => x - y)).toEqual([b, c]);
  });

  it('never sends an admin rating or a count to the guest', async () => {
    const event = await makeEvent({ highlights_mode: 'rating' });
    await rate(event, event.photoIds[0], 5);
    const body = await list(event);
    const photo = body.photos.find((p) => p.id === event.photoIds[0]);
    expect(photo.is_highlight).toBe(true);
    const text = JSON.stringify(body);
    for (const key of ['highlight_pin', 'my_rating_admin', 'admin_rating', 'highlights_threshold', 'highlights_mode']) {
      expect(text).not.toContain(`"${key}"`);
    }
    // my_rating is the viewer's own guest rating, null here: not the admin's 5.
    expect(photo.my_rating).toBeNull();
  });

  it('the admin pins and unpins through the highlight route, and the pin wins', async () => {
    const event = await makeEvent({ highlights_mode: 'rating' });
    const [rated, plain] = [event.photoIds[0], event.photoIds[5]];
    await rate(event, rated, 5);
    expect(highlighted(await list(event))).toEqual([rated]);

    const off = await admin(request(app).put(`/api/admin/photos/${event.id}/photos/${rated}/highlight`)).send({ highlight: false });
    expect(off.status).toBe(200);
    expect(off.body.highlight_pin).toBe(false);
    const on = await admin(request(app).put(`/api/admin/photos/${event.id}/photos/${plain}/highlight`)).send({ highlight: true });
    expect(on.status).toBe(200);
    expect(highlighted(await list(event))).toEqual([plain]);

    const adminList = await admin(request(app).get(`/api/admin/photos/${event.id}/photos`));
    expect(adminList.status).toBe(200);
    const pins = Object.fromEntries(adminList.body.photos.map((p) => [p.id, p.highlight_pin]));
    expect(pins[rated]).toBe(false);
    expect(pins[plain]).toBe(true);
    expect(pins[event.photoIds[1]]).toBeNull();

    const cleared = await admin(request(app).put(`/api/admin/photos/${event.id}/photos/${rated}/highlight`)).send({ highlight: null });
    expect(cleared.status).toBe(200);
    // Unset again, the rated photo takes the second of the two slots.
    expect(highlighted(await list(event))).toEqual([rated, plain].sort((x, y) => x - y));
  });

  it('the highlight route validates its input and the photo', async () => {
    const event = await makeEvent();
    const other = await makeEvent();
    const url = (photoId, eventId = event.id) => `/api/admin/photos/${eventId}/photos/${photoId}/highlight`;
    expect((await admin(request(app).put(url(event.photoIds[0]))).send({ highlight: 'yes' })).status).toBe(400);
    expect((await admin(request(app).put(url(event.photoIds[0]))).send({})).status).toBe(400);
    expect((await admin(request(app).put(url('abc'))).send({ highlight: true })).status).toBe(404);
    // A photo of another gallery cannot be pinned through this one.
    expect((await admin(request(app).put(url(other.photoIds[0]))).send({ highlight: true })).status).toBe(404);
    expect((await request(app).put(url(event.photoIds[0])).send({ highlight: true })).status).toBe(401);
  });

  it('manual mode shows only the pins', async () => {
    const event = await makeEvent({ highlights_mode: 'manual' });
    await rate(event, event.photoIds[0], 5);
    await db('photos').where({ id: event.photoIds[2] }).update({ highlight_pin: 1 });
    expect(highlighted(await list(event))).toEqual([event.photoIds[2]]);
  });

  it('the event update validates and stores the mode and threshold', async () => {
    const event = await makeEvent();
    const put = (body) => admin(request(app).put(`/api/admin/events/${event.id}`)).send(body);
    expect((await put({ highlights_mode: 'sometimes' })).status).toBe(400);
    expect((await put({ highlights_threshold: 6 })).status).toBe(400);
    expect((await put({ highlights_mode: 'rating', highlights_threshold: '5' })).status).toBe(200);
    const row = await db('events').where({ id: event.id }).first();
    expect(row.highlights_mode).toBe('rating');
    expect(Number(row.highlights_threshold)).toBe(5);
  });

  it('migration 370 defaults off, is idempotent and reversible', async () => {
    const migration = require('../../migrations/core/370_photo_highlights');
    await migration.up(db);
    await migration.down(db);
    expect(await db.schema.hasColumn('photos', 'highlight_pin')).toBe(false);
    expect(await db.schema.hasColumn('events', 'highlights_mode')).toBe(false);
    await migration.down(db);
    await migration.up(db);
    await migration.up(db);
    expect(await db.schema.hasColumn('photos', 'highlight_pin')).toBe(true);
    expect(await db.schema.hasColumn('events', 'highlights_threshold')).toBe(true);
    const event = await makeEvent({}, 1);
    expect((await db('events').where({ id: event.id }).first()).highlights_mode).toBe('off');
  });
});
