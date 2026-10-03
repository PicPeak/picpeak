/**
 * A guest token is bound to the gallery it was issued for.
 *
 * resolveGuest verified a guest JWT against the guest row and event the token
 * names, but never against the gallery the request was authorized for. The
 * feedback route compared the two only in guest identity mode, so in simple
 * and shared mode a guest token from gallery A stayed attached on gallery B
 * and A's guest id, name and email were written into B's feedback, and B's
 * my-feedback was answered for A's guest id.
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'guest-token-event-binding-secret';

const SLUG_A = 'guest-binding-a';
const SLUG_B = 'guest-binding-b';

describe('guest token event binding', () => {
  let db; let cleanup; let app;
  let eventA; let eventB; let photoA; let photoB; let guestA; let guestTokenA;

  const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);

  const galleryToken = (eventId, slug) => jwt.sign(
    { eventId, eventSlug: slug, type: 'gallery' },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' },
  );

  const addEvent = async (slug, name) => unwrap(await db('events').insert({
    slug,
    event_type: 'wedding',
    event_name: name,
    event_date: '2026-08-01',
    host_email: 'host@example.com',
    admin_email: 'admin@example.com',
    password_hash: 'x',
    share_link: `/gallery/${slug}/share`,
    share_token: `${slug}-share`,
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    is_active: 1,
    is_archived: 0,
    is_draft: 0,
    created_at: new Date().toISOString(),
  }).returning('id'));

  const addPhoto = async (eventId, slug) => unwrap(await db('photos').insert({
    event_id: eventId,
    filename: 'photo.jpg',
    path: `events/${slug}/photo.jpg`,
    type: 'individual',
    uploaded_at: new Date().toISOString(),
  }).returning('id'));

  const addSettings = (eventId, identityMode) => db('event_feedback_settings').insert({
    event_id: eventId,
    feedback_enabled: true,
    allow_likes: true,
    allow_comments: true,
    allow_ratings: true,
    allow_favorites: true,
    moderate_comments: false,
    show_feedback_to_guests: true,
    identity_mode: identityMode,
    require_name_email: false,
  });

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    eventA = await addEvent(SLUG_A, 'Gallery A');
    eventB = await addEvent(SLUG_B, 'Gallery B');
    photoA = await addPhoto(eventA, SLUG_A);
    photoB = await addPhoto(eventB, SLUG_B);
    await addSettings(eventA, 'guest');
    await addSettings(eventB, 'simple');

    guestA = unwrap(await db('gallery_guests').insert({
      event_id: eventA,
      name: 'Guest Of A',
      email: 'guest-a@example.com',
      identifier: 'guest-a-identifier',
      is_deleted: false,
      created_at: new Date().toISOString(),
    }).returning('id'));

    const { signGuestToken } = require('../../src/middleware/guestAuth');
    guestTokenA = signGuestToken({ guestId: guestA, eventId: eventA, identifier: 'guest-a-identifier', name: 'Guest Of A' });

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
    app.use('/api/gallery', require('../../src/routes/galleryFeedback'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('writes no foreign guest identity into another gallery\'s feedback', async () => {
    const res = await request(app)
      .post(`/api/gallery/${SLUG_B}/photos/${photoB}/feedback`)
      .set('Authorization', `Bearer ${galleryToken(eventB, SLUG_B)}`)
      .set('x-guest-token', guestTokenA)
      .send({ feedback_type: 'like' });

    expect(res.status).toBe(200);
    const rows = await db('photo_feedback').where({ photo_id: photoB, feedback_type: 'like' });
    expect(rows).toHaveLength(1);
    expect(rows[0].guest_id).toBeNull();
    expect(rows[0].guest_name ?? null).not.toBe('Guest Of A');
    expect(rows[0].guest_email ?? null).not.toBe('guest-a@example.com');
  });

  it('does not answer my-feedback in another gallery for the foreign guest id', async () => {
    // A row that only the pre-fix code path could have written.
    await db('photo_feedback').insert({
      photo_id: photoB,
      event_id: eventB,
      feedback_type: 'favorite',
      guest_identifier: 'foreign-device',
      guest_id: guestA,
      is_approved: true,
      is_hidden: false,
      created_at: new Date().toISOString(),
    });

    const res = await request(app)
      .get(`/api/gallery/${SLUG_B}/my-feedback`)
      .set('Authorization', `Bearer ${galleryToken(eventB, SLUG_B)}`)
      .set('x-guest-token', guestTokenA);

    expect(res.status).toBe(200);
    expect(res.body.map((r) => r.feedback_type)).not.toContain('favorite');
  });

  it('keeps the same-gallery guest token working in guest identity mode', async () => {
    const res = await request(app)
      .post(`/api/gallery/${SLUG_A}/photos/${photoA}/feedback`)
      .set('Authorization', `Bearer ${galleryToken(eventA, SLUG_A)}`)
      .set('x-guest-token', guestTokenA)
      .send({ feedback_type: 'like' });

    expect(res.status).toBe(200);
    const rows = await db('photo_feedback').where({ photo_id: photoA, feedback_type: 'like' });
    expect(rows).toHaveLength(1);
    expect(rows[0].guest_id).toBe(guestA);
  });
});
