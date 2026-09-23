/**
 * Guest registration rate limit (issue 1561).
 *
 * With uploader names required, every guest who uploads registers once. A
 * venue's wifi is one network key, and phones on the same OS version send the
 * same User-Agent, so at 20 an hour the 21st guest there could not upload.
 * The limit is now 400 an hour per network key. Its own file: the counters
 * are module state, and jest gives each file fresh modules.
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'guest-registration-rate-secret';

const SLUG = 'registration-rate';

describe('guest registration rate (issue 1561)', () => {
  let db; let cleanup; let app; let token;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    const [ev] = await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Registration Rate',
      event_date: '2026-08-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'registration-rate-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0,
      allow_user_uploads: 1,
      guest_name_mode: 'required',
      created_at: new Date().toISOString(),
    }).returning('id');
    const eventId = typeof ev === 'object' ? ev.id : ev;
    token = jwt.sign({ eventId, eventSlug: SLUG, type: 'gallery' }, process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' });

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/galleryGuests'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  const register = (userAgent, name = 'Guest') => request(app)
    .post(`/api/gallery/${SLUG}/guest`)
    .set('Authorization', `Bearer ${token}`)
    .set('User-Agent', userAgent)
    .send({ name });

  it('lets a room of identical phones on one network register, up to 400 an hour', async () => {
    for (let i = 0; i < 400; i += 1) {
      const res = await register('iPhone Safari', `Guest ${i}`);
      expect(res.status).toBe(200);
    }
    expect((await register('iPhone Safari')).status).toBe(429);
    // Rotating the User-Agent buys nothing.
    expect((await register('Another browser')).status).toBe(429);
  }, 120000);
});
