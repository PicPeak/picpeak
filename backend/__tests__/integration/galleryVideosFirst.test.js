/**
 * Videos first (issue 2263).
 *
 *  - migration 325 adds events.videos_first, off by default
 *  - when on, the guest list puts every video ahead of the photos and keeps
 *    the requested sort inside each group, across pages; off leaves the
 *    order alone; the slideshow keeps its own order
 *  - the event update validates and stores it; a duplicate copies it
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'videos-first-secret-at-least-32-characters';

const os = require('os');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('./helpers/crmDb');

const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videos-first-'));
process.env.STORAGE_PATH = storageDir;

describe('videos first (issue 2263)', () => {
  let db; let cleanup; let app; let adminId; let adminToken; let counter = 0;

  const admin = (req) => req.set('Authorization', `Bearer ${adminToken}`);
  const idOf = (r) => Number(r[0]?.id ?? r[0]);
  const iso = (day) => `2026-08-${String(day).padStart(2, '0')}T12:00:00.000Z`;

  // Uploaded on days 1..5; captured in a different order; one video has no
  // capture date (the separate captured_at fix has not landed for it), so the
  // capture sort falls back to its upload date.
  const MEDIA = [
    { filename: 'c_photo.jpg', media_type: 'image', mime_type: 'image/jpeg', uploaded_at: iso(1), captured_at: iso(3) },
    { filename: 'a_video.mp4', media_type: 'video', mime_type: 'video/mp4', uploaded_at: iso(2), captured_at: null },
    { filename: 'e_photo.jpg', media_type: 'image', mime_type: 'image/jpeg', uploaded_at: iso(3), captured_at: iso(1) },
    // A video recognised by its MIME type alone, as the frontend does.
    { filename: 'd_video.mov', media_type: 'image', mime_type: 'video/quicktime', uploaded_at: iso(4), captured_at: iso(5) },
    { filename: 'b_photo.jpg', media_type: 'image', mime_type: 'image/jpeg', uploaded_at: iso(5), captured_at: iso(4) },
  ];

  async function makeEvent(overrides = {}) {
    counter += 1;
    const slug = `videos-first-${counter}`;
    const id = idOf(await db('events').insert({
      slug, event_type: 'wedding', event_name: `Videos First ${counter}`, event_date: '2026-08-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `/gallery/${slug}/share`, share_token: `videos-first-share-${counter}`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_by: adminId, created_at: new Date().toISOString(),
      ...overrides,
    }).returning('id'));
    for (const media of MEDIA) {
      await db('photos').insert({
        event_id: id, path: `${slug}/${media.filename}`, original_filename: media.filename,
        type: 'individual', processing_status: 'complete', ...media,
      });
    }
    const token = jwt.sign({ eventId: id, eventSlug: slug, type: 'gallery' }, process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' });
    return { id, slug, token };
  }

  const list = async ({ slug, token }, query = {}) => {
    const res = await request(app).get(`/api/gallery/${slug}/photos`).query(query).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body;
  };
  const names = (body) => body.photos.map((p) => p.filename);

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
  }, 180000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it('is off for an existing gallery, and the order is unchanged', async () => {
    const event = await makeEvent();
    expect(Boolean((await db('events').where({ id: event.id }).first()).videos_first)).toBe(false);
    const body = await list(event);
    expect(body.event.videos_first).toBe(false);
    expect(names(body)).toEqual(['b_photo.jpg', 'd_video.mov', 'e_photo.jpg', 'a_video.mp4', 'c_photo.jpg']);
    expect(names(await list(event, { sort: 'filename', order: 'asc' })))
      .toEqual(['a_video.mp4', 'b_photo.jpg', 'c_photo.jpg', 'd_video.mov', 'e_photo.jpg']);
  });

  it('puts videos first under the default upload-date sort', async () => {
    const event = await makeEvent({ videos_first: 1 });
    const body = await list(event);
    expect(body.event.videos_first).toBe(true);
    expect(names(body)).toEqual(['d_video.mov', 'a_video.mp4', 'b_photo.jpg', 'e_photo.jpg', 'c_photo.jpg']);
  });

  it('keeps the capture-date sort within each group, a missing capture date falling back to upload', async () => {
    const event = await makeEvent({ videos_first: 1 });
    // a_video: no capture date, uploaded day 2; d_video captured day 5.
    expect(names(await list(event, { sort: 'capture_date', order: 'asc' })))
      .toEqual(['a_video.mp4', 'd_video.mov', 'e_photo.jpg', 'c_photo.jpg', 'b_photo.jpg']);
    expect(names(await list(event, { sort: 'capture_date', order: 'desc' })))
      .toEqual(['d_video.mov', 'a_video.mp4', 'b_photo.jpg', 'c_photo.jpg', 'e_photo.jpg']);
  });

  it('keeps the filename sort within each group', async () => {
    const event = await makeEvent({ videos_first: 1 });
    expect(names(await list(event, { sort: 'filename', order: 'asc' })))
      .toEqual(['a_video.mp4', 'd_video.mov', 'b_photo.jpg', 'c_photo.jpg', 'e_photo.jpg']);
    expect(names(await list(event, { sort: 'filename', order: 'desc' })))
      .toEqual(['d_video.mov', 'a_video.mp4', 'e_photo.jpg', 'c_photo.jpg', 'b_photo.jpg']);
  });

  it('pages arrive in the same order', async () => {
    const event = await makeEvent({ videos_first: 1 });
    const pages = [];
    for (let page = 1; page <= 3; page += 1) {
      pages.push(...names(await list(event, { sort: 'filename', order: 'asc', limit: 2, page })));
    }
    expect(pages).toEqual(['a_video.mp4', 'd_video.mov', 'b_photo.jpg', 'c_photo.jpg', 'e_photo.jpg']);
  });

  it('applies inside a category: the category narrows the ordered list', async () => {
    const event = await makeEvent({ videos_first: 1 });
    const categoryId = idOf(await db('photo_categories').insert({
      name: 'Party', slug: `party-${event.id}`, event_id: event.id, is_global: 0,
    }).returning('id'));
    await db('photos').where({ event_id: event.id }).whereIn('filename', ['b_photo.jpg', 'a_video.mp4', 'c_photo.jpg'])
      .update({ category_id: categoryId });
    const body = await list(event, { sort: 'filename', order: 'desc' });
    // The guest's category filter is client-side over this list; inside it
    // the video still leads.
    expect(body.photos.filter((p) => p.category_id === categoryId).map((p) => p.filename))
      .toEqual(['a_video.mp4', 'c_photo.jpg', 'b_photo.jpg']);
  });

  it('leaves the slideshow order alone', async () => {
    const event = await makeEvent({ videos_first: 1 });
    const service = require('../../src/services/galleryQueryService');
    const body = await service.getGalleryPhotos({
      event: await db('events').where({ id: event.id }).first(), slug: event.slug,
      query: { sort: 'filename', order: 'asc' }, identity: { guestIdentifier: 'x' }, accessLevel: 'slideshow',
    });
    expect(body.photos.map((p) => p.filename))
      .toEqual(['a_video.mp4', 'b_photo.jpg', 'c_photo.jpg', 'd_video.mov', 'e_photo.jpg']);
  });

  it('is validated and stored through the event update', async () => {
    const event = await makeEvent();
    const bad = await admin(request(app).put(`/api/admin/events/${event.id}`)).send({ videos_first: 'sometimes' });
    expect(bad.status).toBe(400);
    const ok = await admin(request(app).put(`/api/admin/events/${event.id}`)).send({ videos_first: true });
    expect(ok.status).toBe(200);
    expect(Boolean((await db('events').where({ id: event.id }).first()).videos_first)).toBe(true);
    expect((await list(event)).event.videos_first).toBe(true);
    const off = await admin(request(app).put(`/api/admin/events/${event.id}`)).send({ videos_first: false });
    expect(off.status).toBe(200);
    expect((await list(event)).event.videos_first).toBe(false);
  });

  it('travels with a duplicated gallery', async () => {
    const event = await makeEvent({ videos_first: 1 });
    const res = await admin(request(app).post(`/api/admin/events/${event.id}/duplicate`)).send({ event_name: 'Videos copy' });
    expect(res.status).toBe(200);
    expect(Boolean((await db('events').where({ id: res.body.id }).first()).videos_first)).toBe(true);
    const plain = await makeEvent();
    const copy = await admin(request(app).post(`/api/admin/events/${plain.id}/duplicate`)).send({ event_name: 'Plain copy' });
    expect(copy.status).toBe(200);
    expect(Boolean((await db('events').where({ id: copy.body.id }).first()).videos_first)).toBe(false);
  });

  it('migration 325 defaults off, is idempotent and reversible', async () => {
    const migration = require('../../migrations/core/325_add_event_videos_first');
    await migration.up(db);
    expect(await db.schema.hasColumn('events', 'videos_first')).toBe(true);
    await migration.down(db);
    expect(await db.schema.hasColumn('events', 'videos_first')).toBe(false);
    await migration.down(db);
    await migration.up(db);
    await migration.up(db);
    expect(await db.schema.hasColumn('events', 'videos_first')).toBe(true);
    const event = await makeEvent();
    expect(Boolean((await db('events').where({ id: event.id }).first()).videos_first)).toBe(false);
  });
});
