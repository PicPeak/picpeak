/**
 * A Live Slideshow session is never restored as the guest session.
 *
 * GET /gallery/:slug/show/:token/session mints a display-only gallery JWT
 * (accessLevel 'slideshow') and puts it in the same per-slug cookie a guest
 * login uses. /auth/session reported it as a valid gallery session, so a
 * browser that had opened the show link kept it on the normal share link and
 * every rating, comment, favourite and download was refused until it expired.
 * /auth/session now reports it as invalid, the page logs in through the share
 * link, and that login replaces the cookie.
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

describe('/auth/session with a slideshow session', () => {
  let db; let cleanup; let app; let eventId;

  const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);
  const cookieValue = (res, name) => {
    const header = (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`));
    return header ? header.split(';')[0].slice(name.length + 1) : null;
  };

  const openSlideshow = async () => {
    const res = await request(app).get(`/api/gallery/${SLUG}/show/${SHOW_LINK}/session`);
    expect(res.status).toBe(200);
    return res;
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

  it('reports a slideshow token sent as a Bearer as invalid', async () => {
    const { body } = await openSlideshow();
    const res = await request(app)
      .get(`/api/auth/session?slug=${SLUG}`)
      .set('Authorization', `Bearer ${body.token}`);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
  });

  it('reports the slideshow cookie as invalid, and the share-link login replaces it', async () => {
    const show = await openSlideshow();
    const cookieName = `gallery_token_${SLUG}`;
    const showCookie = cookieValue(show, cookieName);
    expect(showCookie).toBeTruthy();

    const restored = await request(app)
      .get(`/api/auth/session?slug=${SLUG}`)
      .set('Cookie', `${cookieName}=${showCookie}`);
    expect(restored.body.valid).toBe(false);

    const login = await request(app)
      .post('/api/auth/gallery/share-login')
      .set('X-Forwarded-For', '203.0.113.71')
      .send({ slug: SLUG, token: SHARE_TOKEN });
    expect(login.status).toBe(200);
    const guestCookie = cookieValue(login, cookieName);
    expect(guestCookie).toBeTruthy();
    expect(guestCookie).not.toBe(showCookie);

    const after = await request(app)
      .get(`/api/auth/session?slug=${SLUG}`)
      .set('Cookie', `${cookieName}=${guestCookie}`);
    expect(after.body).toMatchObject({ valid: true, type: 'gallery', accessLevel: 'guest' });
  });

  it('still restores an ordinary guest session', async () => {
    const guest = jwt.sign(
      { eventId, eventSlug: SLUG, type: 'gallery' },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' },
    );
    const res = await request(app)
      .get(`/api/auth/session?slug=${SLUG}`)
      .set('Authorization', `Bearer ${guest}`);
    expect(res.body).toMatchObject({ valid: true, accessLevel: 'guest' });
  });
});
