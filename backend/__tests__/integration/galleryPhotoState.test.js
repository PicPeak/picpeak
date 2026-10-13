/**
 * Live refresh (issue 1733, C5): GET /api/gallery/:slug/photos/state.
 *
 * The numbers must describe exactly the list the same viewer gets from
 * GET /:slug/photos: a hidden photo, an upload held for review and a photo
 * still being processed never move them, and reveal mode empties both.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const request = require('supertest');

describe('gallery photo state', () => {
  let tmpDir; let db; let cleanup; let app; let eventId; let service;

  const idOf = (r) => Number(r[0]?.id ?? r[0]);

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-state-'));
    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'data', 'test.db');
    process.env.JWT_SECRET = 'photo-state-test';
    await fs.promises.mkdir(path.dirname(process.env.TEST_DATABASE_PATH), { recursive: true });

    jest.resetModules();
    ({ db, cleanup } = await require('./helpers/crmDb').bootCrmDb());
    service = require('../../src/services/galleryQueryService');

    eventId = idOf(await db('events').insert({
      slug: 'live', event_type: 'other', event_name: 'Live', event_date: '2026-07-03',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: '/gallery/live/s', share_token: 'live-share',
      expires_at: new Date(Date.now() + 30 * 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, require_password: 0,
      created_at: new Date().toISOString(), live_refresh: 1,
    }).returning('id'));

    app = express();
    app.use(express.json());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 180000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    await db('photos').where('event_id', eventId).del();
    await db('events').where('id', eventId).update({ live_refresh: 1, reveal_mode: 0 });
  });

  async function addPhoto(filename, columns = {}) {
    return idOf(await db('photos').insert({
      event_id: eventId, filename, path: `live/${filename}`, type: 'individual',
      uploaded_at: new Date().toISOString(), processing_status: 'complete', ...columns,
    }).returning('id'));
  }

  async function seed() {
    const first = await addPhoto('a.jpg');
    const second = await addPhoto('b.jpg');
    await addPhoto('hidden.jpg', { visibility: 'hidden' });
    await addPhoto('pending.jpg', { visibility: 'hidden', moderation_status: 'pending' });
    await addPhoto('rejected.jpg', { visibility: 'hidden', moderation_status: 'rejected' });
    await addPhoto('processing.jpg', { processing_status: 'pending' });
    return { first, second };
  }

  it('matches the guest list: hidden, held and processing photos are not counted', async () => {
    const { second } = await seed();
    const list = await request(app).get('/api/gallery/live/photos');
    const state = await request(app).get('/api/gallery/live/photos/state');
    expect(state.status).toBe(200);
    expect(list.body.photos.map((p) => p.filename).sort()).toEqual(['a.jpg', 'b.jpg']);
    expect(state.body).toEqual({
      count: list.body.photos.length,
      max_id: Math.max(...list.body.photos.map((p) => p.id)),
    });
    expect(state.body).toEqual({ count: 2, max_id: second });
    expect(list.body.event.live_refresh).toBe(true);
  });

  it('moves once a held photo is published', async () => {
    await seed();
    await db('photos').where({ event_id: eventId, filename: 'pending.jpg' })
      .update({ visibility: 'visible', moderation_status: null });
    const state = await request(app).get('/api/gallery/live/photos/state');
    expect(state.body.count).toBe(3);
  });

  it('matches the client list: hidden photos count, photos under review do not', async () => {
    await seed();
    const args = { event: await db('events').where('id', eventId).first(), identity: { guestIdentifier: 'x' }, accessLevel: 'client' };
    const list = await service.getGalleryPhotos({ ...args, slug: 'live' });
    const state = await service.getGalleryPhotoState(args);
    expect(list.photos.map((p) => p.filename).sort()).toEqual(['a.jpg', 'b.jpg', 'hidden.jpg']);
    expect(state).toEqual({ count: 3, max_id: Math.max(...list.photos.map((p) => p.id)) });
  });

  it('answers an empty gallery with a null max_id', async () => {
    const state = await request(app).get('/api/gallery/live/photos/state');
    expect(state.body).toEqual({ count: 0, max_id: null });
  });

  it('reports nothing while reveal mode hides the gallery', async () => {
    await seed();
    await db('events').where('id', eventId).update({ reveal_mode: 1, revealed_at: null, reveal_at: null });
    const state = await request(app).get('/api/gallery/live/photos/state');
    expect(state.body).toEqual({ count: 0, max_id: null });
  });

  it('is 404 while the gallery has live refresh off', async () => {
    await seed();
    await db('events').where('id', eventId).update({ live_refresh: 0 });
    const state = await request(app).get('/api/gallery/live/photos/state');
    expect(state.status).toBe(404);
    const list = await request(app).get('/api/gallery/live/photos');
    expect(list.body.event.live_refresh).toBe(false);
  });

  it('travels with a duplicated gallery', () => {
    // Source inspection: the duplicate route builds its insert row by hand,
    // and a column it does not name falls back to the default (off).
    const crud = fs.readFileSync(path.join(__dirname, '../../src/routes/adminEvents/crud.js'), 'utf8');
    const start = crud.indexOf('router.post(\'/:id/duplicate\'');
    const handler = crud.slice(start, crud.indexOf('logActivity(\'event_duplicated\'', start));
    expect(start).toBeGreaterThan(-1);
    expect(handler).toMatch(/live_refresh:\s*formatBoolean\(parseBooleanInput\(source\.live_refresh, false\)\)/);
  });

  it('counts against the gallery viewer budget, not a blanket exemption', () => {
    const jwt = require('jsonwebtoken');
    const { isOwnGalleryViewerRequest, isOwnGalleryImageRequest } = require('../../src/services/rateLimitService');
    const token = jwt.sign({ type: 'gallery', eventSlug: 'live' }, process.env.JWT_SECRET, { issuer: 'picpeak-auth' });
    const req = () => ({ method: 'GET', path: '/api/gallery/live/photos/state', headers: { authorization: `Bearer ${token}` }, cookies: {} });
    expect(isOwnGalleryViewerRequest(req())).toBe(true);
    expect(isOwnGalleryImageRequest(req())).toBe(false);
  });
});
