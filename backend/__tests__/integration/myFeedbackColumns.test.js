/**
 * /my-feedback returns what the gallery reads, not the whole feedback row.
 *
 * photo_feedback also stores guest_email, guest_name, ip_address and
 * user_agent. A guest merge moves rows to the surviving guest without
 * rewriting those columns, so returning photo_feedback.* handed the survivor
 * another person's email address and IP.
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'my-feedback-columns-secret';

const SLUG = 'my-feedback-columns';

describe('/my-feedback columns', () => {
  let db; let cleanup; let app; let eventId; let photoId; let guestId;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const [ev] = await db('events').insert({
      slug: SLUG, event_type: 'wedding', event_name: 'My feedback columns',
      event_date: '2026-09-16', host_email: 'h@example.com', admin_email: 'a@example.com',
      password_hash: 'x', share_link: `/gallery/${SLUG}/share`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_at: new Date().toISOString(),
    }).returning('id');
    eventId = typeof ev === 'object' ? ev.id : ev;

    const [p] = await db('photos').insert({
      event_id: eventId, filename: 'shot.jpg', path: 'events/columns/shot.jpg',
      type: 'individual', uploaded_at: new Date().toISOString(),
    }).returning('id');
    photoId = typeof p === 'object' ? p.id : p;

    const [g] = await db('gallery_guests').insert({
      event_id: eventId, name: 'Survivor', identifier: 'guest-survivor', is_deleted: false,
      created_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
    }).returning('id');
    guestId = typeof g === 'object' ? g.id : g;

    await db('event_feedback_settings').insert({
      event_id: eventId, feedback_enabled: true, identity_mode: 'guest', allow_likes: true,
    });

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/galleryFeedback'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('omits personal columns a merged row still carries from its source guest', async () => {
    // The shape a merge leaves behind: owned by this guest, personal
    // columns still describing the merged-away identity.
    await db('photo_feedback').insert({
      photo_id: photoId, event_id: eventId, guest_id: guestId, guest_identifier: 'guest-survivor',
      feedback_type: 'like', guest_name: 'Source', guest_email: 'source@example.com',
      ip_address: '203.0.113.7', user_agent: 'Source Browser',
      is_approved: true, is_hidden: false, created_at: new Date().toISOString(),
    });

    const res = await request(app)
      .get(`/api/gallery/${SLUG}/my-feedback`)
      .set('Authorization', `Bearer ${jwt.sign(
        { eventId, eventSlug: SLUG, type: 'gallery' }, process.env.JWT_SECRET,
        { expiresIn: '1h', issuer: 'picpeak-auth' },
      )}`)
      .set('x-guest-token', jwt.sign(
        { type: 'guest', guestId, eventId }, process.env.JWT_SECRET,
        { expiresIn: '1h', issuer: 'picpeak-auth' },
      ));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([expect.objectContaining({ photo_id: photoId, feedback_type: 'like' })]);
    for (const column of ['guest_name', 'guest_email', 'guest_identifier', 'guest_id', 'ip_address', 'user_agent', 'path']) {
      expect(res.body[0]).not.toHaveProperty(column);
    }
  });
});
