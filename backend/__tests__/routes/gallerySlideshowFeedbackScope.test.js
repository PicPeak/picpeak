/**
 * What a Live Slideshow session may read besides photos.
 *
 * The kiosk only lists and shows photos; a show can be pinned to one category,
 * and the list and media routes keep to it. Feedback, the feedback summary,
 * the viewer's own feedback, the people list, the photo count, the selection
 * state and the favorite lists are not part of the show, so a slideshow
 * session is refused there, while a guest of the same gallery keeps reading
 * them.
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'slideshow-feedback-scope-secret';

const SLUG = 'slideshow-feedback-scope';
const LINK = 'd'.repeat(64);

describe('slideshow session outside the photo list', () => {
  let db; let cleanup; let app; let eventId; let otherPhoto; let slideshowToken;

  const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);
  const guestToken = () => jwt.sign(
    { eventId, eventSlug: SLUG, type: 'gallery' },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' },
  );
  const get = (url, token) => request(app).get(`/api/gallery/${SLUG}${url}`).set('Authorization', `Bearer ${token}`);

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
      event_name: 'Slideshow Feedback Scope',
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'slideshow-feedback-scope-share',
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
      average_rating: 4,
      uploaded_at: new Date().toISOString(),
    }).returning('id'));
    await addPhoto('ceremony.jpg', shownCategory);
    otherPhoto = await addPhoto('party-only.jpg', otherCategory);

    await db('photo_feedback').insert({
      photo_id: otherPhoto,
      event_id: eventId,
      feedback_type: 'comment',
      comment_text: 'Comment on a party photo',
      guest_name: 'Bob',
      guest_identifier: 'someone-else',
      is_approved: true,
      is_hidden: false,
      created_at: new Date().toISOString(),
    });
    await db('event_feedback_settings').insert({
      event_id: eventId,
      feedback_enabled: true,
      allow_likes: true,
      allow_comments: true,
      allow_ratings: true,
      allow_favorites: true,
      allow_favorite_lists: true,
      moderate_comments: false,
      show_feedback_to_guests: true,
    });

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
    app.use('/api/gallery', require('../../src/routes/galleryFeedback'));

    const session = await request(app).get(`/api/gallery/${SLUG}/show/${LINK}/session`);
    expect(session.status).toBe(200);
    slideshowToken = session.body.token;
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('keeps the slideshow photo list to the shown category', async () => {
    const res = await get('/photos', slideshowToken);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('party-only');
  });

  it.each([
    ['photo feedback', () => `/photos/${otherPhoto}/feedback`],
    ['feedback summary', () => '/feedback-summary'],
    ['own feedback', () => '/my-feedback'],
    ['people', () => '/people'],
    ['stats', () => '/stats'],
    ['selection', () => '/selection'],
    ['favorite lists', () => '/favorite-lists'],
  ])('refuses a slideshow session on the %s route', async (_name, url) => {
    const res = await get(url(), slideshowToken);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Slideshow tokens are display-only');
    expect(JSON.stringify(res.body)).not.toContain('party-only');
    expect(JSON.stringify(res.body)).not.toContain('Comment on a party photo');
  });

  it('still answers a guest of the gallery on the same routes', async () => {
    const feedback = await get(`/photos/${otherPhoto}/feedback`, guestToken());
    expect(feedback.status).toBe(200);
    expect(JSON.stringify(feedback.body)).toContain('Comment on a party photo');
    expect((await get('/feedback-summary', guestToken())).status).toBe(200);
    expect((await get('/my-feedback', guestToken())).status).toBe(200);
    expect((await get('/people', guestToken())).status).toBe(200);
    expect((await get('/stats', guestToken())).status).toBe(200);
    expect((await get('/selection', guestToken())).status).toBe(200);
    expect((await get('/favorite-lists', guestToken())).status).toBe(200);
  });

  it.each([
    ['creating', (r) => r.post(`/api/gallery/${SLUG}/favorite-lists`).send({ name: 'Mine' })],
    ['renaming', (r) => r.patch(`/api/gallery/${SLUG}/favorite-lists/1`).send({ name: 'Mine' })],
    ['deleting', (r) => r.delete(`/api/gallery/${SLUG}/favorite-lists/1`)],
  ])('refuses a slideshow session %s a favorite list', async (_name, call) => {
    const res = await call(request(app)).set('Authorization', `Bearer ${slideshowToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Slideshow tokens are display-only');
  });
});
