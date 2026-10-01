/**
 * The hero route sends a URL whose `fp` is not the event's current focal
 * point to the URL for the current crop (issue 1737).
 *
 * The route caches for an hour under the requested URL. Without this, an open
 * tab holding a payload from before the admin moved the anchor would fetch
 * the centre URL, be served the off-centre crop, and keep it in the cache
 * under the centre URL after the admin moved the point back.
 */
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'hero-anchor-test-secret';

const SLUG = 'hero-anchor-event';

describe('hero route focal-point URL (issue 1737)', () => {
  let db;
  let cleanup;
  let app;
  let eventId;
  let photoId;

  const galleryToken = () => jwt.sign(
    { eventId, eventSlug: SLUG, type: 'gallery' },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' }
  );
  const setAnchor = (anchor) => db('events').where({ id: eventId }).update({ hero_image_anchor: anchor });
  const get = (query = '') => request(app)
    .get(`/api/gallery/${SLUG}/hero/${photoId}${query}`)
    .set('Authorization', `Bearer ${galleryToken()}`);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const inserted = await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Hero Anchor',
      event_date: '2026-09-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'hero-anchor-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      hero_image_anchor: 'center',
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = inserted[0]?.id ?? inserted[0];

    const p = await db('photos').insert({
      event_id: eventId,
      filename: 'hero.jpg',
      path: `events/${SLUG}/hero.jpg`,
      type: 'individual',
      uploaded_at: new Date().toISOString(),
    }).returning('id');
    photoId = p[0]?.id ?? p[0];

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  it('sends the centre URL to the current crop while the event is off-centre', async () => {
    await setAnchor('top');
    const res = await get();
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/api/gallery/${SLUG}/hero/${photoId}?fp=50-0`);
  });

  it('sends a stale off-centre URL back to the centre URL, keeping other parameters', async () => {
    await setAnchor('center');
    const res = await get('?fp=50-0&wm=2');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/api/gallery/${SLUG}/hero/${photoId}?wm=2`);
  });

  it('serves a URL that matches the current anchor', async () => {
    await setAnchor('50% 100%');
    const res = await get('?fp=50-100');
    // The seeded file is not on disk, so the route falls back to the original
    // photo; what matters here is that it did not bounce to another hero URL.
    expect(res.headers.location || '').not.toContain('/hero/');
  });
});
