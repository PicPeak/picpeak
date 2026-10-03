/**
 * Guest-facing aggregates do not reveal client-hidden photos.
 *
 * GET /gallery/:slug/stats counted every photo in the event and returned the
 * event-wide view, download and unique-visitor totals to anyone with gallery
 * access (no token at all on a passwordless gallery). /feedback-summary
 * filtered hidden photos out of its top-rated list but summed its totals over
 * every photo, and /my-feedback returned the id and filename of a photo the
 * client had since hidden. Each now applies the viewer's visibility scope.
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'hidden-photo-aggregates-secret';

const SLUG = 'hidden-aggregates';

describe('gallery aggregates and client-hidden photos', () => {
  let db; let cleanup; let app;
  let eventId; let visiblePhoto; let hiddenPhoto;

  const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);

  const token = (extra = {}) => jwt.sign(
    { eventId, eventSlug: SLUG, type: 'gallery', ...extra },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' },
  );
  const guest = () => token();
  const client = () => token({ accessLevel: 'client' });

  const get = (url, tok) => request(app).get(`/api/gallery/${SLUG}${url}`).set('Authorization', `Bearer ${tok}`);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    eventId = unwrap(await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Hidden Aggregates',
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'hidden-aggregates-share',
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
      download_count: 3,
      ...extra,
    }).returning('id'));
    visiblePhoto = await addPhoto('visible.jpg', { average_rating: 4 });
    hiddenPhoto = await addPhoto('client-only-secret.jpg', { visibility: 'hidden', average_rating: 5 });

    // One rating per photo from another device, and one like per photo from
    // the device under test (guest_identifier is the device hash the route
    // derives; the my-feedback test looks the row up by guest id instead).
    const row = (photoId, type, extra) => ({
      photo_id: photoId,
      event_id: eventId,
      feedback_type: type,
      guest_identifier: 'someone-else',
      is_approved: true,
      is_hidden: false,
      created_at: new Date().toISOString(),
      ...extra,
    });
    await db('photo_feedback').insert([
      row(visiblePhoto, 'rating', { rating: 4 }),
      row(hiddenPhoto, 'rating', { rating: 5 }),
      row(visiblePhoto, 'like'),
      row(hiddenPhoto, 'like'),
    ]);

    await db('access_logs').insert([
      { event_id: eventId, ip_address: '10.0.0.1', user_agent: 'x', action: 'view' },
      { event_id: eventId, ip_address: '10.0.0.2', user_agent: 'x', action: 'view' },
    ]);

    await db('event_feedback_settings').insert({
      event_id: eventId,
      feedback_enabled: true,
      allow_likes: true,
      allow_comments: true,
      allow_ratings: true,
      allow_favorites: true,
      moderate_comments: false,
      show_feedback_to_guests: true,
      identity_mode: 'guest',
    });

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
    app.use('/api/gallery', require('../../src/routes/galleryFeedback'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  describe('/stats', () => {
    it('counts only the photos a guest may see and sends no audience analytics', async () => {
      const res = await get('/stats', guest());
      expect(res.status).toBe(200);
      expect(Number(res.body.total_photos)).toBe(1);
      expect(res.body).not.toHaveProperty('total_views');
      expect(res.body).not.toHaveProperty('total_downloads');
      expect(res.body).not.toHaveProperty('unique_visitors');
    });

    it('counts hidden photos for the client', async () => {
      const res = await get('/stats', client());
      expect(res.status).toBe(200);
      expect(Number(res.body.total_photos)).toBe(2);
    });
  });

  describe('/feedback-summary', () => {
    it('leaves feedback on hidden photos out of a guest\'s totals', async () => {
      const res = await get('/feedback-summary', guest());
      expect(res.status).toBe(200);
      expect(Number(res.body.summary.stats.total_ratings)).toBe(1);
      expect(Number(res.body.summary.stats.total_likes)).toBe(1);
    });

    it('counts it for the client', async () => {
      const res = await get('/feedback-summary', client());
      expect(res.status).toBe(200);
      expect(Number(res.body.summary.stats.total_ratings)).toBe(2);
      expect(Number(res.body.summary.stats.total_likes)).toBe(2);
    });

    it('keeps the unscoped totals for the service\'s other callers', async () => {
      const feedbackService = require('../../src/services/feedbackService');
      const summary = await feedbackService.getEventFeedbackSummary(eventId);
      expect(Number(summary.stats.total_ratings)).toBe(2);
    });
  });

  describe('/my-feedback', () => {
    let guestId; let guestToken;

    beforeAll(async () => {
      guestId = unwrap(await db('gallery_guests').insert({
        event_id: eventId,
        name: 'Rater',
        identifier: 'rater-identifier',
        is_deleted: false,
        created_at: new Date().toISOString(),
      }).returning('id'));
      const { signGuestToken } = require('../../src/middleware/guestAuth');
      guestToken = signGuestToken({ guestId, eventId, identifier: 'rater-identifier', name: 'Rater' });
      const mine = (photoId) => ({
        photo_id: photoId,
        event_id: eventId,
        feedback_type: 'favorite',
        guest_identifier: 'rater-identifier',
        guest_id: guestId,
        is_approved: true,
        is_hidden: false,
        created_at: new Date().toISOString(),
      });
      await db('photo_feedback').insert([mine(visiblePhoto), mine(hiddenPhoto)]);
    });

    it('omits the id and filename of a photo hidden since the guest rated it', async () => {
      const res = await get('/my-feedback', guest()).set('x-guest-token', guestToken);
      expect(res.status).toBe(200);
      expect(res.body.map((r) => r.photo_id)).toEqual([visiblePhoto]);
      expect(JSON.stringify(res.body)).not.toContain('client-only-secret');
    });

    it('still lists it for the client', async () => {
      const res = await get('/my-feedback', client()).set('x-guest-token', guestToken);
      expect(res.status).toBe(200);
      expect(res.body.map((r) => r.photo_id).sort()).toEqual([visiblePhoto, hiddenPhoto].sort());
    });
  });
});
