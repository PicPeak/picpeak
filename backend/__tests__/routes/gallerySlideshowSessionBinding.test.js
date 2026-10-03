/**
 * A slideshow session dies with the link it was opened with.
 *
 * GET /gallery/:slug/show/:token/session exchanged a slideshow link for a
 * 12-hour gallery JWT. Rotating or disabling the link, or turning the
 * slideshow feature off, killed the /show/ endpoints but not that JWT, so a
 * link holder kept listing and viewing the gallery's photos until it expired.
 * The JWT now carries a digest of the link, assertGalleryCredentialCurrent
 * compares it with the event's current show_share_token on every request, and
 * galleryAccessService re-checks the feature flag.
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'slideshow-session-binding-secret';

const SLUG = 'slideshow-binding';
const LINK = 'a'.repeat(64);
const ROTATED = 'b'.repeat(64);

describe('slideshow session binding', () => {
  let db; let cleanup; let app; let eventId; let photoId;
  let invalidateFeatureFlagCache;

  const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);

  const setFlag = async (on) => {
    await db('feature_flags').where({ key: 'slideshow' }).del();
    await db('feature_flags').insert({ key: 'slideshow', value: on });
    invalidateFeatureFlagCache();
  };
  const setLink = (token) => db('events').where({ id: eventId }).update({ show_share_token: token });

  const openSession = async (link = LINK) => {
    const res = await request(app).get(`/api/gallery/${SLUG}/show/${link}/session`);
    expect(res.status).toBe(200);
    return res.body.token;
  };
  const listPhotos = (token) => request(app)
    .get(`/api/gallery/${SLUG}/photos`).set('Authorization', `Bearer ${token}`);
  const viewPhoto = (token) => request(app)
    .get(`/api/gallery/${SLUG}/photo/${photoId}`).set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    ({ invalidateFeatureFlagCache } = require('../../src/middleware/requireFeatureFlag'));

    eventId = unwrap(await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Slideshow Binding',
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'slideshow-binding-share',
      show_share_token: LINK,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id'));
    photoId = unwrap(await db('photos').insert({
      event_id: eventId,
      filename: 'slide.jpg',
      path: `events/${SLUG}/slide.jpg`,
      type: 'individual',
      uploaded_at: new Date().toISOString(),
    }).returning('id'));
    await setFlag(true);

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 180000);

  afterEach(async () => {
    await setLink(LINK);
    await setFlag(true);
  });

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('lists photos with a freshly opened session', async () => {
    const token = await openSession();
    expect((await listPhotos(token)).status).toBe(200);
  });

  it('rejects the session once the link is rotated, and accepts one opened with the new link', async () => {
    const old = await openSession();
    await setLink(ROTATED);

    const refused = await listPhotos(old);
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe('SLIDESHOW_LINK_CHANGED');
    // The photo bytes are no more reachable than the list.
    expect((await viewPhoto(old)).status).toBe(401);

    expect((await listPhotos(await openSession(ROTATED))).status).toBe(200);
  });

  it('rejects the session once the link is disabled', async () => {
    const old = await openSession();
    await setLink(null);

    const refused = await listPhotos(old);
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe('SLIDESHOW_LINK_CHANGED');
  });

  it('rejects the session once the slideshow feature is turned off', async () => {
    const old = await openSession();
    await setFlag(false);

    const refused = await listPhotos(old);
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe('SLIDESHOW_DISABLED');
  });

  it('leaves ordinary gallery sessions alone when the link rotates', async () => {
    const guest = jwt.sign(
      { eventId, eventSlug: SLUG, type: 'gallery' },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' },
    );
    await setLink(ROTATED);
    expect((await listPhotos(guest)).status).toBe(200);
  });
});
