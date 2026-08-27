/**
 * Spotting one person registered twice (#1210).
 *
 * Guest registration always inserts. A client whose token expired, or who
 * opens the gallery on a second device, becomes a new gallery_guests row and
 * their likes and favourites split across the copies — so the photographer's
 * "final selection" is only trustworthy after someone notices two Tinas with
 * half the picks each and merges them.
 *
 * Merging already worked. This is the half that was missing: saying which rows
 * are the same person, so the admin does not have to find them by eye.
 *
 * Detection only — the registration path is deliberately untouched. Reusing a
 * row because someone typed a matching email would let anyone who knows that
 * email inherit the identity and its selections, and answering differently for
 * a known email would leak which addresses are in the gallery, which is
 * exactly what /guest/recover goes out of its way to avoid.
 */

const request = require('supertest');
const express = require('express');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

describe('duplicate guest detection (#1210)', () => {
  let db; let cleanup; let app; let eventId;

  const listGuests = async () => {
    const res = await request(app).get(`/api/admin/events/${eventId}/guests`);
    expect(res.status).toBe(200);
    return res.body;
  };

  const addGuest = async (name, email, extra = {}) => {
    const [g] = await db('gallery_guests').insert({
      event_id: eventId, name, email,
      identifier: `id-${name}-${Math.random()}`,
      created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      is_deleted: false,
      ...extra,
    }).returning('id');
    return typeof g === 'object' ? g.id : g;
  };

  const byId = (body, id) => body.guests.find((g) => g.id === id);

  beforeAll(async () => {
    jest.resetModules();
    jest.doMock('../../src/middleware/auth', () => ({
      adminAuth: (req, _res, next) => { req.admin = { id: 1, username: 'tester' }; next(); },
    }));
    jest.doMock('../../src/middleware/permissions', () => ({
      requirePermission: () => (_req, _res, next) => next(),
    }));
    jest.doMock('../../src/middleware/ownership', () => ({
      requireEventOwnership: (_req, _res, next) => next(),
    }));
    jest.doMock('../../src/utils/logger', () => ({
      debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    }));

    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const [ev] = await db('events').insert({
      slug: 'dupe-guests', event_type: 'wedding', event_name: 'Dupe Guests',
      event_date: '2026-08-01', host_email: 'h@example.com', admin_email: 'a@example.com',
      password_hash: 'x', share_link: '/gallery/dupe-guests/share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_at: new Date().toISOString(),
    }).returning('id');
    eventId = typeof ev === 'object' ? ev.id : ev;

    app = express();
    app.use(express.json());
    app.use('/api/admin', require('../../src/routes/adminGuests'));
  }, 180000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(async () => {
    await db('gallery_guests').where({ event_id: eventId }).del();
  });

  it('points each duplicate at the other rows that share its email', async () => {
    const first = await addGuest('Tina', 'tina@example.com');
    const second = await addGuest('Tina', 'tina@example.com');
    const other = await addGuest('Marc', 'marc@example.com');

    const body = await listGuests();

    expect(byId(body, first).duplicate_of).toEqual([second]);
    expect(byId(body, second).duplicate_of).toEqual([first]);
    expect(byId(body, other).duplicate_of).toEqual([]);
  });

  it('counts the groups and the rows in them', async () => {
    await addGuest('Tina', 'tina@example.com');
    await addGuest('Tina', 'tina@example.com');
    await addGuest('Ben', 'ben@example.com');
    await addGuest('Ben', 'ben@example.com');
    await addGuest('Ben', 'ben@example.com');
    await addGuest('Marc', 'marc@example.com');

    expect((await listGuests()).duplicates).toEqual({ groups: 2, guests: 5 });
  });

  it('matches the same address typed with different capitals or a stray space', async () => {
    // The same person on a different day. Both read as distinct rows in the
    // admin list, which is precisely why they need catching here.
    const a = await addGuest('Tina', 'tina@example.com');
    const b = await addGuest('Tina', 'Tina@Example.com ');

    const body = await listGuests();
    expect(byId(body, a).duplicate_of).toEqual([b]);
    expect(body.duplicates).toEqual({ groups: 1, guests: 2 });
  });

  it('does not treat two guests without an email as the same person', async () => {
    // require_name_email is off by default, so a shared gallery link produces
    // plenty of these. Grouping them would merge strangers.
    const a = await addGuest('Anon', null);
    const b = await addGuest('Anon', null);

    const body = await listGuests();
    expect(byId(body, a).duplicate_of).toEqual([]);
    expect(byId(body, b).duplicate_of).toEqual([]);
    expect(body.duplicates).toEqual({ groups: 0, guests: 0 });
  });

  it('does not treat a shared name as evidence of anything', async () => {
    const a = await addGuest('Anna', 'anna.k@example.com');
    const b = await addGuest('Anna', 'anna.m@example.com');

    const body = await listGuests();
    expect(byId(body, a).duplicate_of).toEqual([]);
    expect(byId(body, b).duplicate_of).toEqual([]);
  });

  it('ignores a removed guest', async () => {
    const kept = await addGuest('Tina', 'tina@example.com');
    await addGuest('Tina', 'tina@example.com', { is_deleted: true });

    const body = await listGuests();
    // The deleted row is not listed at all, so the survivor is not a duplicate
    // of something the admin cannot see or merge.
    expect(body.guests.map((g) => g.id)).toEqual([kept]);
    expect(byId(body, kept).duplicate_of).toEqual([]);
    expect(body.duplicates).toEqual({ groups: 0, guests: 0 });
  });
});
