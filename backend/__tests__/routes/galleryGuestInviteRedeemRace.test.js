/**
 * Guest-invite redemption is a single atomic state transition.
 *
 * POST /gallery/:slug/guest/redeem read the invite, checked revoked_at and
 * redeemed_at in JavaScript, then UPDATEd the row by id alone. Under READ
 * COMMITTED two redemptions could both read a pending invite and both mint a
 * 30-day guest session, and a redemption whose read preceded the admin's
 * revoke still minted one after the revoke committed. The UPDATE now claims
 * the row only while both columns are still NULL, and a token is minted only
 * when it changed exactly one row.
 *
 * The race is reproduced on SQLite by committing the revoke on the same
 * connection right after the route's SELECT returns — the state the second
 * statement of a PostgreSQL transaction would observe.
 */

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'guest-invite-redeem-race-secret';

const SLUG = 'invite-redeem-race';

describe('guest invite redemption race', () => {
  let db; let cleanup; let app;
  let eventId; let guestId;
  let origQuery; let clientProto;
  let afterInviteSelect = null;

  const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);

  const galleryToken = () => jwt.sign(
    { eventId, eventSlug: SLUG, type: 'gallery' },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' },
  );

  const mintInvite = async (token) => unwrap(await db('guest_invites').insert({
    event_id: eventId,
    guest_id: guestId,
    token,
    created_at: new Date().toISOString(),
  }).returning('id'));

  const redeem = (inviteToken) => request(app)
    .post(`/api/gallery/${SLUG}/guest/redeem`)
    .set('Authorization', `Bearer ${galleryToken()}`)
    .send({ inviteToken });

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    eventId = unwrap(await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Invite Redeem Race',
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'invite-redeem-race-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id'));

    guestId = unwrap(await db('gallery_guests').insert({
      event_id: eventId,
      name: 'Invited Guest',
      identifier: 'invited-guest-identifier',
      is_deleted: false,
      created_at: new Date().toISOString(),
    }).returning('id'));

    // Hook the dialect so a test can commit a concurrent write between the
    // route's invite SELECT and its UPDATE.
    clientProto = Object.getPrototypeOf(db.client);
    origQuery = clientProto._query;
    clientProto._query = async function patchedQuery(connection, obj) {
      const result = await origQuery.call(this, connection, obj);
      if (afterInviteSelect && /^select .* from `guest_invites` where `token`/i.test(obj.sql)) {
        const hook = afterInviteSelect;
        afterInviteSelect = null;
        await hook(connection);
      }
      return result;
    };

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/gallery', require('../../src/routes/gallery'));
    app.use('/api/gallery', require('../../src/routes/galleryGuests'));
  }, 180000);

  afterAll(async () => {
    if (clientProto && origQuery) clientProto._query = origQuery;
    if (cleanup) await cleanup();
  });

  const runOnConnection = (connection, sql, bindings) => new Promise((resolve, reject) => {
    connection.run(sql, bindings, (err) => (err ? reject(err) : resolve()));
  });

  it('redeems a pending invite once', async () => {
    const inviteId = await mintInvite('invite-plain-0000000000000000');

    const res = await redeem('invite-plain-0000000000000000');

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    const row = await db('guest_invites').where({ id: inviteId }).first();
    expect(row.redeemed_at).not.toBeNull();

    const again = await redeem('invite-plain-0000000000000000');
    expect(again.status).toBe(409);
    expect(again.body.token).toBeUndefined();
  });

  it('mints no session when the invite is revoked after the read and before the claim', async () => {
    const inviteId = await mintInvite('invite-revoke-race-00000000000');
    afterInviteSelect = (connection) => runOnConnection(
      connection,
      'update guest_invites set revoked_at = ? where id = ?',
      [new Date().toISOString(), inviteId],
    );

    const res = await redeem('invite-revoke-race-00000000000');

    expect(afterInviteSelect).toBeNull(); // the hook fired
    expect(res.status).toBe(410);
    expect(res.body).toEqual({ error: 'revoked', guest_id: guestId });
    expect(res.body.token).toBeUndefined();
    const row = await db('guest_invites').where({ id: inviteId }).first();
    expect(row.redeemed_at).toBeNull();
  });

  it('mints no second session when another redemption claims the invite after the read', async () => {
    const inviteId = await mintInvite('invite-redeem-race-00000000000');
    afterInviteSelect = (connection) => runOnConnection(
      connection,
      'update guest_invites set redeemed_at = ? where id = ?',
      [new Date().toISOString(), inviteId],
    );

    const res = await redeem('invite-redeem-race-00000000000');

    expect(afterInviteSelect).toBeNull();
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'already_redeemed', guest_id: guestId });
    expect(res.body.token).toBeUndefined();
  });
});
