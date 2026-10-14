/**
 * An admin-created guest invite stores the name through the same sanitiser
 * as the guest's own registration and the photo credit made from it, so a
 * decomposed "Jörg" is not stored in a second Unicode form.
 */
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('./helpers/crmDb');

jest.mock('../../src/utils/logger', () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

describe('admin guest invite name', () => {
  let db; let cleanup; let app; let eventId; let adminId;
  const slug = 'guest-invite-name';

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId } = await seedMinimal(db));
    await assignAdminRole(db, adminId);
    const [event] = await db('events').insert({
      slug, event_type: 'wedding', event_name: 'Guest invite name',
      event_date: '2026-09-15', host_email: 'host@example.com', admin_email: 'admin@example.com',
      password_hash: 'x', share_link: `/gallery/${slug}/share`,
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      is_active: true, is_archived: false, is_draft: false,
    }).returning('id');
    eventId = event.id ?? event;
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin', require('../../src/routes/adminGuests'));
  }, 180000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  const invite = (name) => request(app)
    .post(`/api/admin/events/${eventId}/guests/invites`)
    .set('Authorization', `Bearer ${mintAdminToken(adminId)}`)
    .send({ name });

  it('stores a decomposed name in its precomposed form', async () => {
    const res = await invite('  Jörg​  Müller ');
    expect(res.status).toBe(200);
    const row = await db('gallery_guests').where({ event_id: eventId }).orderBy('id', 'desc').first();
    expect(row.name).toBe('Jörg Müller');
  });

  it('refuses a name that is empty once sanitised', async () => {
    const res = await invite('​‮ ');
    expect(res.status).toBe(400);
  });
});
