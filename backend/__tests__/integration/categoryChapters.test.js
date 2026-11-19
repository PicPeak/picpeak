/**
 * Chapter markers for categories (issue 2548).
 *
 *  - PUT /admin/categories/event/:eventId/:id/chapter validates, caps and
 *    stores the marker per (event, category); an empty marker removes it
 *  - a shared global category carries a different marker in each event
 *  - GET /admin/categories/event/:eventId returns the marker and suggests
 *    the time from the earliest capture
 *  - the public gallery payload carries the markers as text, only when the
 *    gallery shows them, never for the guest-upload category
 *  - migration 369 is idempotent and reversible
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'chapter-markers-secret-at-least-32-characters';

const os = require('os');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('./helpers/crmDb');

const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chapter-markers-'));
process.env.STORAGE_PATH = storageDir;

jest.setTimeout(120000);

describe('category chapter markers (issue 2548)', () => {
  let db; let cleanup; let app; let adminId; let adminToken; let counter = 0;

  const admin = (req) => req.set('Authorization', `Bearer ${adminToken}`);
  const idOf = (r) => Number(r[0]?.id ?? r[0]);

  async function makeEvent(overrides = {}) {
    counter += 1;
    const slug = `chapters-${counter}`;
    const id = idOf(await db('events').insert({
      slug, event_type: 'wedding', event_name: `Chapters ${counter}`, event_date: '2026-08-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `/gallery/${slug}/share`, share_token: `chapters-share-${counter}`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_by: adminId, created_at: new Date().toISOString(),
      ...overrides,
    }).returning('id'));
    const token = jwt.sign({ eventId: id, eventSlug: slug, type: 'gallery' }, process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' });
    return { id, slug, token };
  }

  async function makeCategory(name, eventId) {
    return idOf(await db('photo_categories').insert({
      name, slug: `${name.toLowerCase()}-${eventId || 'global'}-${counter}`,
      event_id: eventId || null, is_global: eventId ? 0 : 1,
    }).returning('id'));
  }

  async function addPhoto(eventId, categoryId, filename, capturedAt) {
    await db('photos').insert({
      event_id: eventId, path: `chapters/${eventId}/${filename}`, filename, original_filename: filename,
      type: 'individual', processing_status: 'complete', media_type: 'image', mime_type: 'image/jpeg',
      category_id: categoryId, uploaded_at: '2026-08-01T20:00:00.000Z', captured_at: capturedAt,
    });
  }

  const putChapter = (eventId, categoryId, body) =>
    admin(request(app).put(`/api/admin/categories/event/${eventId}/${categoryId}/chapter`)).send(body);

  const gallery = async ({ slug, token }) => {
    const res = await request(app).get(`/api/gallery/${slug}/photos`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body;
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId } = await seedMinimal(db));
    await assignAdminRole(db, adminId, 'super_admin');
    adminToken = mintAdminToken(adminId);
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
    app.use('/api/admin/events', require('../../src/routes/adminEvents'));
    app.use('/api/admin/categories', require('../../src/routes/adminCategories'));
  }, 180000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it('stores a trimmed marker and returns it with the event categories', async () => {
    const event = await makeEvent();
    const ceremony = await makeCategory('Trauung', event.id);
    const res = await putChapter(event.id, ceremony, {
      chapter_heading: '  Trauung  ',
      chapter_subheading: 'Treffen mit den\nJa-Sagern',
      chapter_time: '12:00',
      chapter_location: 'Standesamt Hintertupfingen',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      chapter_heading: 'Trauung',
      chapter_subheading: 'Treffen mit den Ja-Sagern',
      chapter_time: '12:00',
      chapter_location: 'Standesamt Hintertupfingen',
    });

    const list = (await admin(request(app).get(`/api/admin/categories/event/${event.id}`)).expect(200)).body;
    const row = list.find((c) => c.id === ceremony);
    expect(row.chapter_time).toBe('12:00');
    expect(row.chapter_heading).toBe('Trauung');
    expect(row.chapter_available).toBe(true);
  });

  it('patches only the fields sent; clearing every field removes the row', async () => {
    const event = await makeEvent();
    const cat = await makeCategory('Party', event.id);
    await putChapter(event.id, cat, { chapter_time: '21:30', chapter_location: 'Scheune' }).expect(200);
    const patched = await putChapter(event.id, cat, { chapter_location: '' });
    expect(patched.status).toBe(200);
    expect(patched.body.chapter_time).toBe('21:30');
    expect(patched.body.chapter_location).toBeNull();

    await putChapter(event.id, cat, { chapter_time: null }).expect(200);
    expect(await db('event_category_chapters').where({ event_id: event.id, category_id: cat }).first()).toBeUndefined();
  });

  it('refuses over-long text, a malformed time and non-text values', async () => {
    const event = await makeEvent();
    const cat = await makeCategory('Dinner', event.id);
    expect((await putChapter(event.id, cat, { chapter_heading: 'x'.repeat(101) })).status).toBe(400);
    expect((await putChapter(event.id, cat, { chapter_subheading: 'x'.repeat(201) })).status).toBe(400);
    expect((await putChapter(event.id, cat, { chapter_location: 'x'.repeat(121) })).status).toBe(400);
    expect((await putChapter(event.id, cat, { chapter_time: '25:00' })).status).toBe(400);
    expect((await putChapter(event.id, cat, { chapter_time: '12:00:00' })).status).toBe(400);
    expect((await putChapter(event.id, cat, { chapter_heading: ['a'] })).status).toBe(400);
    expect(await db('event_category_chapters').where({ event_id: event.id }).first()).toBeUndefined();
  });

  it('keeps a global category\'s marker per event and refuses a foreign event\'s category', async () => {
    const a = await makeEvent();
    const b = await makeEvent();
    const shared = await makeCategory('Ceremony', null);
    await putChapter(a.id, shared, { chapter_location: 'Kirche A' }).expect(200);
    await putChapter(b.id, shared, { chapter_location: 'Kirche B' }).expect(200);
    const rows = await db('event_category_chapters').where({ category_id: shared }).orderBy('event_id');
    expect(rows.map((r) => r.chapter_location)).toEqual(['Kirche A', 'Kirche B']);

    const foreign = await makeCategory('Other', b.id);
    expect((await putChapter(a.id, foreign, { chapter_location: 'x' })).status).toBe(404);
    expect((await putChapter(a.id, 999999, { chapter_location: 'x' })).status).toBe(404);
  });

  it('refuses the guest-upload category', async () => {
    const event = await makeEvent();
    const uploads = await makeCategory('Guests', event.id);
    await db('events').where({ id: event.id }).update({ upload_category_id: uploads });
    expect((await putChapter(event.id, uploads, { chapter_heading: 'x' })).status).toBe(400);
    const list = (await admin(request(app).get(`/api/admin/categories/event/${event.id}`)).expect(200)).body;
    expect(list.find((c) => c.id === uploads).chapter_available).toBe(false);
  });

  it('suggests the time from the earliest capture in the category', async () => {
    const event = await makeEvent();
    const cat = await makeCategory('Getting ready', event.id);
    const local = (h, m) => new Date(2026, 7, 1, h, m).toISOString();
    await addPhoto(event.id, cat, 'b.jpg', local(10, 45));
    await addPhoto(event.id, cat, 'a.jpg', local(9, 5));
    const empty = await makeCategory('Empty', event.id);
    const list = (await admin(request(app).get(`/api/admin/categories/event/${event.id}`)).expect(200)).body;
    expect(list.find((c) => c.id === cat).chapter_time_suggestion).toBe('09:05');
    expect(list.find((c) => c.id === empty).chapter_time_suggestion).toBeNull();
  });

  it('serves no markers while the gallery shows none (the default)', async () => {
    const event = await makeEvent();
    const cat = await makeCategory('Ceremony', event.id);
    await addPhoto(event.id, cat, 'c.jpg', null);
    await putChapter(event.id, cat, { chapter_heading: 'Trauung' }).expect(200);
    const body = await gallery(event);
    expect(body.event.chapter_marker_style).toBe('off');
    expect(body.categories.find((c) => c.id === cat).chapter).toBeUndefined();
  });

  it('serves markers as text when the gallery shows them, never for guest uploads', async () => {
    const event = await makeEvent();
    const cat = await makeCategory('Ceremony', event.id);
    const plain = await makeCategory('Details', event.id);
    const uploads = await makeCategory('Guests', event.id);
    await addPhoto(event.id, cat, 'c.jpg', null);
    await addPhoto(event.id, plain, 'd.jpg', null);
    await addPhoto(event.id, uploads, 'g.jpg', null);
    await putChapter(event.id, cat, {
      chapter_heading: '<img src=x onerror=alert(1)>', chapter_time: '12:00', chapter_location: 'Standesamt',
    }).expect(200);

    const bad = await admin(request(app).put(`/api/admin/events/${event.id}`)).send({ chapter_marker_style: 'banner' });
    expect(bad.status).toBe(400);
    await admin(request(app).put(`/api/admin/events/${event.id}`))
      .send({ chapter_marker_style: 'hero', upload_category_id: uploads }).expect(200);

    const body = await gallery(event);
    expect(body.event.chapter_marker_style).toBe('hero');
    // Stored and served verbatim as text; the client renders a text node.
    expect(body.categories.find((c) => c.id === cat).chapter).toEqual({
      heading: '<img src=x onerror=alert(1)>', subheading: null, time: '12:00', location: 'Standesamt',
    });
    // No row: an empty marker, the client falls back to the category name.
    expect(body.categories.find((c) => c.id === plain).chapter)
      .toEqual({ heading: null, subheading: null, time: null, location: null });
    expect(body.categories.find((c) => c.id === uploads).chapter).toBeUndefined();
  });

  it('migration 369 is idempotent and reversible', async () => {
    const migration = require('../../migrations/core/369_category_chapter_markers');
    await migration.up(db);
    await migration.down(db);
    expect(await db.schema.hasTable('event_category_chapters')).toBe(false);
    expect(await db.schema.hasColumn('events', 'chapter_marker_style')).toBe(false);
    await migration.down(db);
    await migration.up(db);
    await migration.up(db);
    expect(await db.schema.hasTable('event_category_chapters')).toBe(true);
    const event = await makeEvent();
    expect((await db('events').where({ id: event.id }).first()).chapter_marker_style).toBe('off');
  });
});
