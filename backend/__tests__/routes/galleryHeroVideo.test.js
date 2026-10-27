/**
 * A video's hero is its poster, never the clip (issue 2284).
 *
 * The Story hero renders `hero_url` as a full-bleed image. For a video the
 * hero route redirected to /photo, the clip itself, so a Story gallery whose
 * hero was a video fetched the whole file only to fail decoding it. The route
 * now sends a video to the thumbnail route, its poster frame. Images keep
 * their hero rendition.
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'gallery-hero-video-secret';

const SLUG = 'gallery-hero-video';

describe('gallery hero route and videos (issue 2284)', () => {
  let db; let cleanup; let app; let eventId;

  const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);
  const token = () => jwt.sign({ eventId, eventSlug: SLUG, type: 'gallery' }, process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' });
  const get = (url) => request(app).get(`/api/gallery/${SLUG}${url}`).set('Authorization', `Bearer ${token()}`).redirects(0);
  const addPhoto = async (fields) => unwrap(await db('photos').insert({
    event_id: eventId, type: 'individual', uploaded_at: new Date().toISOString(), ...fields,
  }).returning('id'));

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    eventId = unwrap(await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Gallery Hero Video',
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'gallery-hero-video-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id'));

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it.each([
    ['by media type', { media_type: 'video', mime_type: 'video/mp4' }],
    ['by MIME type alone', { media_type: 'image', mime_type: 'video/quicktime' }],
  ])('sends a video %s to its poster on the thumbnail route', async (_label, kind) => {
    const id = await addPhoto({ filename: `clip-${kind.mime_type.replace('/', '-')}`, path: `events/${SLUG}/clip`, ...kind });
    const res = await get(`/hero/${id}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/api/gallery/${SLUG}/thumbnail/${id}`);
  });

  it('does not send an image to the thumbnail route', async () => {
    const id = await addPhoto({ filename: 'still.jpg', path: `events/${SLUG}/still.jpg`, media_type: 'image', mime_type: 'image/jpeg' });
    const res = await get(`/hero/${id}`);
    // No source bytes here, so the hero cannot be generated; what matters is
    // that an image never lands on the poster route.
    expect(res.headers.location || '').not.toContain('/thumbnail/');
  });
});
