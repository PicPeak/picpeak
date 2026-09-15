/**
 * Gallery feedback and what a guest may see.
 *
 * GET/POST /gallery/:slug/photos/:photoId/feedback looked a photo up by id and
 * event only, so a guest could read and add comments, ratings and likes on a
 * photo the client had hidden, by counting up photo ids. /feedback-summary
 * listed the filenames of hidden photos among the top rated. And with
 * show_feedback_to_guests off, the per-photo summary still returned the
 * average rating and the like, favourite and comment totals — other guests'
 * feedback that the photo list already hides.
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'gallery-feedback-visibility-secret';

const SLUG = 'feedback-visibility';

describe('gallery feedback visibility', () => {
  let db; let cleanup; let app;
  let eventId; let visiblePhoto; let hiddenPhoto;

  const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);

  const token = (extra = {}) => jwt.sign(
    { eventId, eventSlug: SLUG, type: 'gallery', ...extra },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' },
  );

  const setSharing = (on) => db('event_feedback_settings')
    .where({ event_id: eventId })
    .update({ show_feedback_to_guests: on });

  const getFeedback = (photoId, tok = token()) => request(app)
    .get(`/api/gallery/${SLUG}/photos/${photoId}/feedback`)
    .set('Authorization', `Bearer ${tok}`);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    eventId = unwrap(await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Feedback Visibility',
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'feedback-visibility-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id'));

    const addPhoto = async (filename, extra) => unwrap(await db('photos').insert({
      event_id: eventId,
      filename,
      path: `events/${SLUG}/${filename}`,
      type: 'individual',
      uploaded_at: new Date().toISOString(),
      ...extra,
    }).returning('id'));
    visiblePhoto = await addPhoto('visible.jpg', { like_count: 5, favorite_count: 2, average_rating: 4 });
    hiddenPhoto = await addPhoto('client-only-secret.jpg', { visibility: 'hidden', like_count: 3, average_rating: 5 });

    // Real rating rows, so a stats recount keeps both photos rated.
    const rating = (photoId, value) => ({
      photo_id: photoId,
      event_id: eventId,
      feedback_type: 'rating',
      rating: value,
      guest_identifier: 'someone-else',
      is_approved: true,
      is_hidden: false,
      created_at: new Date().toISOString(),
    });
    await db('photo_feedback').insert([rating(visiblePhoto, 4), rating(hiddenPhoto, 5)]);

    await db('event_feedback_settings').insert({
      event_id: eventId,
      feedback_enabled: true,
      allow_likes: true,
      allow_comments: true,
      allow_ratings: true,
      allow_favorites: true,
      moderate_comments: false,
      show_feedback_to_guests: true,
    });

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
    app.use('/api/gallery', require('../../src/routes/galleryFeedback'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  describe('client-hidden photos', () => {
    beforeAll(() => setSharing(true));

    it('answers 404 to a guest reading feedback on a hidden photo', async () => {
      const res = await getFeedback(hiddenPhoto);
      expect(res.status).toBe(404);
    });

    it('answers 404 to a guest liking a hidden photo, and records nothing', async () => {
      const res = await request(app)
        .post(`/api/gallery/${SLUG}/photos/${hiddenPhoto}/feedback`)
        .set('Authorization', `Bearer ${token()}`)
        .send({ feedback_type: 'like' });

      expect(res.status).toBe(404);
      expect(await db('photo_feedback').where({ photo_id: hiddenPhoto, feedback_type: 'like' })).toHaveLength(0);
    });

    it('still serves feedback on a visible photo', async () => {
      const res = await getFeedback(visiblePhoto);
      expect(res.status).toBe(200);
    });

    it('leaves hidden photos out of the top rated in the feedback summary', async () => {
      const res = await request(app)
        .get(`/api/gallery/${SLUG}/feedback-summary`)
        .set('Authorization', `Bearer ${token()}`);

      expect(res.status).toBe(200);
      const ids = res.body.summary.top_rated.map((p) => p.id);
      expect(ids).toContain(visiblePhoto);
      expect(ids).not.toContain(hiddenPhoto);
      expect(JSON.stringify(res.body)).not.toContain('client-only-secret');
    });
  });

  describe('aggregate counts with show_feedback_to_guests off', () => {
    afterAll(() => setSharing(true));

    it('returns no totals of other guests\' feedback', async () => {
      await setSharing(false);

      const res = await getFeedback(visiblePhoto);

      expect(res.status).toBe(200);
      expect(res.body.summary).toEqual(expect.objectContaining({
        average_rating: 0,
        total_ratings: 0,
        like_count: 0,
        favorite_count: 0,
        comment_count: 0,
      }));
    });

    it('returns the totals when sharing is on', async () => {
      await setSharing(true);

      const res = await getFeedback(visiblePhoto);

      expect(res.status).toBe(200);
      expect(res.body.summary.like_count).toBe(5);
      expect(res.body.summary.average_rating).toBe(4);
      expect(Number(res.body.summary.total_ratings)).toBe(1);
    });
  });
});
