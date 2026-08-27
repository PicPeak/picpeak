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

  it('groups duplicates under a shared key', async () => {
    const first = await addGuest('Tina', 'tina@example.com');
    const second = await addGuest('Tina', 'tina@example.com');
    const other = await addGuest('Marc', 'marc@example.com');

    const body = await listGuests();

    // A shared group key rather than a list of sibling ids: the payload stays
    // linear in the number of guests, and the case/whitespace folding lives in
    // one place instead of being reimplemented on the client.
    expect(byId(body, first).duplicate_group).toBe('tina@example.com');
    expect(byId(body, second).duplicate_group).toBe('tina@example.com');
    expect(byId(body, other).duplicate_group).toBeNull();
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
    expect(byId(body, a).duplicate_group).toBe('tina@example.com');
    expect(byId(body, b).duplicate_group).toBe('tina@example.com');
    expect(body.duplicates).toEqual({ groups: 1, guests: 2 });
  });

  it('does not treat two guests without an email as the same person', async () => {
    // require_name_email is off by default, so a shared gallery link produces
    // plenty of these. Grouping them would merge strangers.
    const a = await addGuest('Anon', null);
    const b = await addGuest('Anon', null);

    const body = await listGuests();
    expect(byId(body, a).duplicate_group).toBeNull();
    expect(byId(body, b).duplicate_group).toBeNull();
    expect(body.duplicates).toEqual({ groups: 0, guests: 0 });
  });

  it('does not treat a shared name as evidence of anything', async () => {
    const a = await addGuest('Anna', 'anna.k@example.com');
    const b = await addGuest('Anna', 'anna.m@example.com');

    const body = await listGuests();
    expect(byId(body, a).duplicate_group).toBeNull();
    expect(byId(body, b).duplicate_group).toBeNull();
  });

  it('moves a pending invite to the survivor instead of stranding it', async () => {
    // Creating an invite inserts a real gallery_guests row, so an admin who
    // pre-mints one and then sees the guest self-register has two rows — and
    // this feature now points that pair out and offers the merge. Redemption
    // resolves guest_invites.guest_id with `is_deleted: false`, so merging
    // without moving the invite leaves the emailed link returning 404
    // guest_missing while the invite dialog still shows it as Pending.
    const placeholder = await addGuest('Tina', 'tina@example.com');
    const selfRegistered = await addGuest('Tina', 'tina@example.com');
    const [inv] = await db('guest_invites').insert({
      event_id: eventId, guest_id: placeholder, token: 'invite-token-1',
      created_by_admin_id: 1, created_at: new Date().toISOString(),
    }).returning('id');
    const inviteId = typeof inv === 'object' ? inv.id : inv;

    const res = await request(app)
      .post(`/api/admin/events/${eventId}/guests/${selfRegistered}/merge`)
      .send({ mergeIds: [placeholder] });
    expect(res.status).toBe(200);

    const invite = await db('guest_invites').where({ id: inviteId }).first();
    expect(invite.guest_id).toBe(selfRegistered);
    // And it still resolves: the survivor is not soft-deleted.
    const target = await db('gallery_guests').where({ id: invite.guest_id }).first();
    expect(Boolean(target.is_deleted)).toBe(false);
  });

  it('leaves a spent invite pointing at what it actually redeemed', async () => {
    // A redeemed invite is a record of who redeemed what. Retargeting it would
    // rewrite that history to name a guest who was never on the other end.
    const old = await addGuest('Tina', 'tina@example.com');
    const kept = await addGuest('Tina', 'tina@example.com');
    const [inv] = await db('guest_invites').insert({
      event_id: eventId, guest_id: old, token: 'invite-token-2',
      created_by_admin_id: 1, redeemed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    }).returning('id');
    const inviteId = typeof inv === 'object' ? inv.id : inv;

    await request(app)
      .post(`/api/admin/events/${eventId}/guests/${kept}/merge`)
      .send({ mergeIds: [old] });

    expect((await db('guest_invites').where({ id: inviteId }).first()).guest_id).toBe(old);
  });

  it('canonicalises the survivor\'s address so recovery can still find them', async () => {
    // Grouping folds case and whitespace, so a merge can be proposed between a
    // clean address and a legacy one that is not. /guest/recover lowercases
    // what the guest types and matches on equality, so a survivor left holding
    // the raw value becomes permanently unrecoverable by email.
    const legacy = await addGuest('Tina', 'Tina@Example.com ');
    const other = await addGuest('Tina', 'tina@example.com');

    const res = await request(app)
      .post(`/api/admin/events/${eventId}/guests/${legacy}/merge`)
      .send({ mergeIds: [other] });
    expect(res.status).toBe(200);

    expect((await db('gallery_guests').where({ id: legacy }).first()).email).toBe('tina@example.com');
  });

  it('leaves an already-canonical survivor untouched', async () => {
    const kept = await addGuest('Tina', 'tina@example.com');
    const dupe = await addGuest('Tina', 'Tina@Example.com');

    await request(app)
      .post(`/api/admin/events/${eventId}/guests/${kept}/merge`)
      .send({ mergeIds: [dupe] });

    expect((await db('gallery_guests').where({ id: kept }).first()).email).toBe('tina@example.com');
  });

  it('ignores a removed guest', async () => {
    const kept = await addGuest('Tina', 'tina@example.com');
    await addGuest('Tina', 'tina@example.com', { is_deleted: true });

    const body = await listGuests();
    // The deleted row is not listed at all, so the survivor is not a duplicate
    // of something the admin cannot see or merge.
    expect(body.guests.map((g) => g.id)).toEqual([kept]);
    expect(byId(body, kept).duplicate_group).toBeNull();
    expect(body.duplicates).toEqual({ groups: 0, guests: 0 });
  });
});
