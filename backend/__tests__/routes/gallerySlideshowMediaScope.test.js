/**
 * What a slideshow session may fetch from the media routes.
 *
 * The slideshow photo list is filtered to the event's show_category_id on the
 * server, but the JWT carried no category scope and /photo, /thumbnail, /hero,
 * /preview and the view beacon authorized on event membership and visibility
 * alone, so a link holder could request every other category's visible photos
 * by id. And /photo, which answers with the stored original or the source
 * video, accepted a display-only slideshow session at all, unlike the download
 * routes. The media routes now share one grant check and /photo refuses
 * slideshow sessions.
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'slideshow-media-scope-secret';

const SLUG = 'slideshow-media-scope';
const LINK = 'c'.repeat(64);

describe('slideshow session media scope', () => {
  let db; let cleanup; let app; let eventId;
  let shownPhoto; let otherPhoto; let slideshowToken;

  const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);

  const guestToken = () => jwt.sign(
    { eventId, eventSlug: SLUG, type: 'gallery' },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' },
  );
  const get = (url, token) => request(app).get(`/api/gallery/${SLUG}${url}`).set('Authorization', `Bearer ${token}`).redirects(0);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    const { invalidateFeatureFlagCache } = require('../../src/middleware/requireFeatureFlag');
    await db('feature_flags').where({ key: 'slideshow' }).del();
    await db('feature_flags').insert({ key: 'slideshow', value: true });
    invalidateFeatureFlagCache();

    eventId = unwrap(await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Slideshow Media Scope',
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'slideshow-media-scope-share',
      show_share_token: LINK,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id'));

    const addCategory = async (name) => unwrap(await db('photo_categories').insert({
      name, slug: name, is_global: 0, event_id: eventId, display_order: 0,
    }).returning('id'));
    const shownCategory = await addCategory('ceremony');
    const otherCategory = await addCategory('party');
    await db('events').where({ id: eventId }).update({ show_category_id: shownCategory });

    const addPhoto = async (filename, categoryId) => unwrap(await db('photos').insert({
      event_id: eventId,
      filename,
      path: `events/${SLUG}/${filename}`,
      type: 'individual',
      category_id: categoryId,
      uploaded_at: new Date().toISOString(),
    }).returning('id'));
    shownPhoto = await addPhoto('ceremony.jpg', shownCategory);
    otherPhoto = await addPhoto('party.jpg', otherCategory);

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));

    const session = await request(app).get(`/api/gallery/${SLUG}/show/${LINK}/session`);
    expect(session.status).toBe(200);
    slideshowToken = session.body.token;
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it.each(['thumbnail', 'hero', 'preview'])(
    'answers 403 to a slideshow session for a photo outside the shown category on /%s',
    async (route) => {
      const res = await get(`/${route}/${otherPhoto}`, slideshowToken);
      expect(res.status).toBe(403);
    },
  );

  it('answers 403 to the view beacon for a photo outside the shown category', async () => {
    const res = await request(app)
      .post(`/api/gallery/${SLUG}/photo/${otherPhoto}/view`)
      .set('Authorization', `Bearer ${slideshowToken}`);
    expect(res.status).toBe(403);
    const row = await db('photos').where({ id: otherPhoto }).first('view_count');
    expect(Number(row.view_count) || 0).toBe(0);
  });

  it.each(['thumbnail', 'hero', 'preview'])(
    'lets a slideshow session past the grant check for a photo in the shown category on /%s',
    async (route) => {
      // No image bytes exist in this fixture, so the route fails later on
      // rendition generation; what matters is that it is not the grant.
      const res = await get(`/${route}/${shownPhoto}`, slideshowToken);
      expect(res.status).not.toBe(403);
    },
  );

  it('refuses a slideshow session the original on /photo, shown category or not', async () => {
    for (const id of [shownPhoto, otherPhoto]) {
      const res = await get(`/photo/${id}`, slideshowToken);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Slideshow tokens are display-only');
    }
  });

  it('never falls back from /preview to the original for a slideshow session', async () => {
    // Preview generation cannot succeed here (no source bytes), which is the
    // fallback path; it used to redirect to /photo.
    const res = await get(`/preview/${shownPhoto}`, slideshowToken);
    expect(res.status).toBe(404);
    expect(res.headers.location).toBeUndefined();
  });

  it('leaves an ordinary guest session unscoped by the slideshow category', async () => {
    const res = await get(`/thumbnail/${otherPhoto}`, guestToken());
    expect(res.status).not.toBe(403);
    const original = await get(`/photo/${otherPhoto}`, guestToken());
    expect(original.status).not.toBe(403);
  });
});
