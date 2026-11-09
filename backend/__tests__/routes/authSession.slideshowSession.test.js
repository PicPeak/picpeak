/**
 * A Live Slideshow session and a guest session live side by side (issue 2438).
 *
 * GET /gallery/:slug/show/:token/session minted a display-only gallery JWT
 * (accessLevel 'slideshow') into the same per-slug cookie a guest login uses,
 * and /auth/session reported it as a valid gallery session. A browser that
 * had opened the show link kept it on the normal share link, and every
 * rating, comment, favourite and download was refused until it expired.
 *
 * Now the slideshow keeps its own cookie, picked only by image URLs that
 * carry the slideshow marker, and /auth/session never reports a slideshow
 * session as valid (a browser may still hold one in the guest cookie from
 * before this change).
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'slideshow-session-auth-secret-with-32-chars';

const SLUG = 'slideshow-auth-session';
const SHOW_LINK = 'c'.repeat(64);
const SHARE_TOKEN = 'slideshow-auth-session-share';
const GUEST_COOKIE = `gallery_token_${SLUG}`;
const SHOW_COOKIE = `gallery_show_token_${SLUG}`;

describe('slideshow session next to a guest session', () => {
  let db; let cleanup; let app; let eventId;

  const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);
  const setCookies = (res) => res.headers['set-cookie'] || [];
  const cookieValue = (res, name) => {
    const header = setCookies(res).find((c) => c.startsWith(`${name}=`));
    return header ? header.split(';')[0].slice(name.length + 1) : null;
  };
  const guestToken = () => jwt.sign(
    { eventId, eventSlug: SLUG, type: 'gallery' },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' },
  );

  const openSlideshow = async () => {
    const res = await request(app).get(`/api/gallery/${SLUG}/show/${SHOW_LINK}/session`);
    expect(res.status).toBe(200);
    return res;
  };
  const session = (cookie) => request(app).get(`/api/auth/session?slug=${SLUG}`).set('Cookie', cookie);
  const firstPhotoUrl = async (cookie, query = '') => {
    const res = await request(app).get(`/api/gallery/${SLUG}/photos${query}`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.body.photos[0].slideshow_url;
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    const { invalidateFeatureFlagCache } = require('../../src/middleware/requireFeatureFlag');

    eventId = unwrap(await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Slideshow Auth Session',
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      require_password: false,
      share_link: `/gallery/${SLUG}/${SHARE_TOKEN}`,
      share_token: SHARE_TOKEN,
      show_share_token: SHOW_LINK,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id'));
    await db('photos').insert({
      event_id: eventId,
      filename: 'slide.jpg',
      path: `events/${SLUG}/slide.jpg`,
      type: 'individual',
      uploaded_at: new Date().toISOString(),
    });
    await db('feature_flags').where({ key: 'slideshow' }).del();
    await db('feature_flags').insert({ key: 'slideshow', value: true });
    invalidateFeatureFlagCache();

    app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
    app.use('/api/auth', require('../../src/routes/auth'));
  }, 180000);

  afterAll(async () => {
    await require('../../src/services/serviceShutdown').stopServices();
    if (cleanup) await cleanup();
  });

  it('keeps the slideshow session in its own cookie, never the guest cookies', async () => {
    const show = await openSlideshow();
    expect(cookieValue(show, SHOW_COOKIE)).toBe(show.body.token);
    expect(cookieValue(show, GUEST_COOKIE)).toBeNull();
    expect(cookieValue(show, 'gallery_token')).toBeNull();
    // Same lifetime as the 12-hour JWT.
    const header = setCookies(show).find((c) => c.startsWith(`${SHOW_COOKIE}=`));
    expect(header).toMatch(/Max-Age=43200/);
  });

  it('marks the image URLs handed to a slideshow session, and only those', async () => {
    const show = await openSlideshow();
    const slideshowList = await request(app)
      .get(`/api/gallery/${SLUG}/photos`).set('Authorization', `Bearer ${show.body.token}`);
    expect(slideshowList.body.photos[0].slideshow_url).toMatch(/[?&]slideshow=1(&|$)/);

    const guestList = await request(app)
      .get(`/api/gallery/${SLUG}/photos`).set('Authorization', `Bearer ${guestToken()}`);
    expect(guestList.body.photos[0].slideshow_url).not.toMatch(/slideshow=1/);
  });

  it('serves each session from its own cookie when the browser holds both', async () => {
    const show = await openSlideshow();
    const both = `${GUEST_COOKIE}=${guestToken()}; ${SHOW_COOKIE}=${cookieValue(show, SHOW_COOKIE)}`;

    // The gallery page restores the guest login; the slideshow cookie is not consulted.
    expect((await session(both)).body).toMatchObject({ valid: true, accessLevel: 'guest' });
    // A plain request is the guest's ...
    expect(await firstPhotoUrl(both)).not.toMatch(/slideshow=1/);
    // ... a marked one the kiosk's.
    expect(await firstPhotoUrl(both, '?slideshow=1')).toMatch(/slideshow=1/);
  });

  it('falls back to the guest cookie for a marked request without a slideshow cookie', async () => {
    const show = await openSlideshow();
    // A kiosk opened before the slideshow had its own cookie.
    expect(await firstPhotoUrl(`${GUEST_COOKIE}=${show.body.token}`, '?slideshow=1')).toMatch(/slideshow=1/);
  });

  it('reports a slideshow token sent as a Bearer as invalid', async () => {
    const { body } = await openSlideshow();
    const res = await request(app)
      .get(`/api/auth/session?slug=${SLUG}`)
      .set('Authorization', `Bearer ${body.token}`);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
  });

  it('reports a slideshow session left in the guest cookie as invalid, and the share-link login replaces it', async () => {
    const { body } = await openSlideshow();
    expect((await session(`${GUEST_COOKIE}=${body.token}`)).body.valid).toBe(false);

    const login = await request(app)
      .post('/api/auth/gallery/share-login')
      .set('X-Forwarded-For', '203.0.113.71')
      .send({ slug: SLUG, token: SHARE_TOKEN });
    expect(login.status).toBe(200);
    const guestCookie = cookieValue(login, GUEST_COOKIE);
    expect(guestCookie).toBeTruthy();
    expect(guestCookie).not.toBe(body.token);

    expect((await session(`${GUEST_COOKIE}=${guestCookie}`)).body)
      .toMatchObject({ valid: true, type: 'gallery', accessLevel: 'guest' });
  });

  it('still restores an ordinary guest session', async () => {
    const res = await request(app)
      .get(`/api/auth/session?slug=${SLUG}`)
      .set('Authorization', `Bearer ${guestToken()}`);
    expect(res.body).toMatchObject({ valid: true, accessLevel: 'guest' });
  });
});
