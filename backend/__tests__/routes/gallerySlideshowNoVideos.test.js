/**
 * The slideshow shows no videos (issue 2285).
 *
 * A video has no slideshow or preview tier, so the kiosk's slide fell back to
 * `url`, the /photo route, which refuses slideshow sessions: every video
 * rendered as a broken slide for its full duration. The slideshow list now
 * leaves videos out, recognised by media type or MIME type, and the /session
 * and /state counts the kiosk diffs against agree with it. A guest's list
 * keeps them.
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'slideshow-no-videos-secret';

const SLUG = 'slideshow-no-videos';
const LINK = 'd'.repeat(64);

describe('slideshow without videos (issue 2285)', () => {
  let db; let cleanup; let app; let eventId; let slideshowToken; let sessionCount;

  const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);
  const list = (token) => request(app).get(`/api/gallery/${SLUG}/photos`).set('Authorization', `Bearer ${token}`);
  const names = (res) => res.body.photos.map((p) => p.filename).sort();

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
      event_name: 'Slideshow No Videos',
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'slideshow-no-videos-share',
      show_share_token: LINK,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id'));

    const media = [
      { filename: 'photo.jpg', media_type: 'image', mime_type: 'image/jpeg' },
      { filename: 'legacy.jpg', media_type: null, mime_type: null },
      { filename: 'clip.mp4', media_type: 'video', mime_type: 'video/mp4' },
      // Recognised by its MIME type alone, as the frontend recognises it.
      { filename: 'clip.mov', media_type: 'image', mime_type: 'video/quicktime' },
    ];
    for (const m of media) {
      await db('photos').insert({
        event_id: eventId,
        path: `events/${SLUG}/${m.filename}`,
        type: 'individual',
        uploaded_at: new Date().toISOString(),
        ...m,
      });
    }

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));

    const session = await request(app).get(`/api/gallery/${SLUG}/show/${LINK}/session`);
    expect(session.status).toBe(200);
    slideshowToken = session.body.token;
    sessionCount = session.body.photo_count;
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('leaves videos out of the slideshow list, so no slide points at /photo', async () => {
    const res = await list(slideshowToken);
    expect(res.status).toBe(200);
    expect(names(res)).toEqual(['legacy.jpg', 'photo.jpg']);
    for (const p of res.body.photos) {
      expect(p.slideshow_url || p.preview_url).toBeTruthy();
    }
  });

  it('counts the same photos in /session and /state', async () => {
    expect(sessionCount).toBe(2);
    const state = await request(app).get(`/api/gallery/${SLUG}/show/${LINK}/state`);
    expect(state.status).toBe(200);
    expect(state.body.photo_count).toBe(2);
  });

  it('keeps the videos in a guest list', async () => {
    const guest = jwt.sign({ eventId, eventSlug: SLUG, type: 'gallery' }, process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' });
    const res = await list(guest);
    expect(res.status).toBe(200);
    expect(names(res)).toEqual(['clip.mov', 'clip.mp4', 'legacy.jpg', 'photo.jpg']);
  });
});
