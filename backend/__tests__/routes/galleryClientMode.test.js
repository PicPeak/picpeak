const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');

process.env.JWT_SECRET = 'gallery-client-mode-test-secret-at-least-32-characters';
let db, cleanup, app, adminId, customerId, pinHash;
const eventId = 71993;
const slug = 'pin-entry-gallery';
const pin = 'Client-Entry-2026!';
const privateLink = 'a'.repeat(64);
const path = `/api/auth/gallery/${slug}`;
const token = (claims = {}) => jwt.sign({
  type: 'gallery', eventId, eventSlug: slug, jti: crypto.randomUUID(),
  iat: Math.floor(Date.now() / 1000) - 60, ...claims,
}, process.env.JWT_SECRET, { issuer: 'picpeak-auth', expiresIn: '1h' });
const enter = (bearer, password = pin) => {
  const req = request(app).post(`${path}/client-elevate`).send({ password });
  return bearer ? req.set('Authorization', `Bearer ${bearer}`) : req;
};
const photos = (bearer) => request(app).get(`/api/gallery/${slug}/photos`).set('Authorization', `Bearer ${bearer}`);
const update = (body, bearer = mintAdminToken(adminId)) => request(app).put(`/api/admin/events/${eventId}`)
  .set('Authorization', `Bearer ${bearer}`).send(body);

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId);
  pinHash = await require('bcrypt').hash(pin, 4);
  await db('events').insert({
    id: eventId, slug, event_type: 'wedding', event_name: 'PIN entry gallery', event_date: '2026-01-01',
    host_email: 'host@example.test', admin_email: 'admin@example.test', password_hash: 'unused',
    share_token: crypto.randomBytes(16).toString('hex'), share_link: `/gallery/${slug}`, created_by: adminId,
  });
  await db('event_customer_assignments').insert({ event_id: eventId, customer_account_id: customerId });
  await db('photos').insert([
    { id: 719931, event_id: eventId, filename: 'visible.jpg', path: 'visible.jpg', type: 'individual', visibility: 'visible', size_bytes: 100 },
    { id: 719932, event_id: eventId, filename: 'hidden.jpg', path: 'hidden.jpg', type: 'individual', visibility: 'hidden', size_bytes: 100 },
    { id: 719933, event_id: eventId, filename: 'pending.jpg', path: 'pending.jpg', type: 'individual', visibility: 'hidden', moderation_status: 'pending', size_bytes: 100 },
  ]);
  app = express(); app.use(express.json()); app.use(cookieParser());
  app.use('/api', require('../../src/middleware/csrf'));
  app.use('/api/auth', require('../../src/routes/auth'));
  app.use('/api/gallery', require('../../src/routes/gallery'));
  app.use('/api/admin/events', require('../../src/routes/adminEvents'));
});

beforeEach(async () => {
  await db('login_attempts').del();
  await db('revoked_tokens').del();
  await db('events').where({ id: eventId }).update({
    is_active: 1, is_archived: 0, is_draft: 0, require_password: 1, expires_at: null,
    client_access_enabled: 1, client_pin_entry_enabled: 1, client_password_hash: pinHash,
    client_share_token: privateLink, gallery_password_changed_at: null, client_password_changed_at: null,
  });
  await db('customer_accounts').where({ id: customerId }).update({ is_active: 1, password_changed_at: null });
});
afterAll(async () => { await cleanup?.(); });

it('defaults the migration to opt-out and is safe to re-run', async () => {
  const migration = require('../../migrations/core/319_gallery_client_pin_entry');
  await migration.up(db);
  const [row] = await db('events').insert({
    slug: 'default-pin-entry', event_type: 'wedding', event_name: 'Default',
    host_email: 'h@example.test', admin_email: 'a@example.test', password_hash: 'unused', share_link: '/gallery/default-pin-entry',
  }).returning('*');
  expect(Boolean(row.client_pin_entry_enabled)).toBe(false);
});

it('elevates the same-gallery guest without a private link, with bounded expiry and no secret fields', async () => {
  const guest = token();
  const res = await enter(guest);
  expect(res.status).toBe(200);
  const decoded = jwt.verify(res.body.token, process.env.JWT_SECRET, { issuer: 'picpeak-auth' });
  expect(decoded).toMatchObject({ type: 'gallery', eventId, eventSlug: slug, accessLevel: 'client' });
  expect(decoded.exp).toBeLessThanOrEqual(jwt.decode(guest).exp);
  expect(decoded.jti).not.toBe(jwt.decode(guest).jti);
  expect(res.headers['set-cookie'].join(';')).toMatch(/HttpOnly/);
  expect(JSON.stringify(res.body)).not.toContain(pinHash);
  expect(JSON.stringify(res.body)).not.toContain(privateLink);
  expect((await photos(guest)).body.photos.map((p) => p.id)).toEqual([719931]);
  const clientPhotos = await photos(res.body.token);
  expect(clientPhotos.status).toBe(200);
  expect(clientPhotos.body.photos.map((p) => p.id).sort()).toEqual([719931, 719932]);
  expect(clientPhotos.body.event.client_pin_entry_available).toBe(true);
});

it.each([
  ['client_pin_entry_enabled', 0], ['client_access_enabled', 0], ['client_password_hash', null],
])('requires %s for the new entry point', async (field, value) => {
  await db('events').where({ id: eventId }).update({ [field]: value });
  const res = await enter(token());
  expect(res.status).toBe(403);
  expect(res.body.code).toBe('CLIENT_ACCESS_UNAVAILABLE');
  expect((await photos(token())).body.event.client_pin_entry_available).toBe(false);
});

it('retains private-link-plus-PIN login even when gallery PIN entry is disabled', async () => {
  await db('events').where({ id: eventId }).update({ client_pin_entry_enabled: 0 });
  expect((await request(app).post(`${path}/client-login`).send({ password: pin })).status).toBe(401);
  expect((await request(app).post(`${path}/client-login`).send({ password: pin, token: privateLink })).status).toBe(200);
});

it('shares the failed-PIN lockout with the existing private-link login', async () => {
  for (let i = 0; i < 4; i += 1) expect((await enter(token(), 'wrong')).status).toBe(401);
  expect((await request(app).post(`${path}/client-login`).send({ password: 'wrong', token: privateLink })).status).toBe(401);
  expect((await enter(token())).status).toBe(423);
  expect((await request(app).post(`${path}/client-login`).send({ password: pin, token: privateLink })).status).toBe(423);
});

it.each([
  ['anonymous', null], ['another gallery', { eventId: eventId + 1 }],
  ['slideshow', { accessLevel: 'slideshow' }], ['expired', { iat: 1 }],
])('refuses %s as an elevation credential', async (_name, claims) => {
  const res = await enter(claims === null ? null : token(claims));
  expect([401, 403]).toContain(res.status);
});

it('does not treat public access without a session as authentication', async () => {
  await db('events').where({ id: eventId }).update({ require_password: 0 });
  expect((await enter(null)).status).toBe(403);
  expect((await enter(token())).status).toBe(200);
});

it('rejects a revoked source session and gallery-password cutoff', async () => {
  const guest = token();
  await require('../../src/utils/tokenRevocation').revokeToken(guest, 'test');
  expect((await enter(guest)).status).toBe(401);
  await db('events').where({ id: eventId }).update({ gallery_password_changed_at: new Date().toISOString() });
  expect((await enter(token())).status).toBe(401);
});

it.each([
  ['is_active', 0], ['is_archived', 1], ['is_draft', 1], ['expires_at', '2000-01-01T00:00:00Z'],
])('refuses an unavailable gallery (%s)', async (field, value) => {
  await db('events').where({ id: eventId }).update({ [field]: value });
  expect((await enter(token())).status).toBe(404);
});

it('rejects a cross-site PIN request through the existing origin guard', async () => {
  const res = await enter(token()).set('Origin', 'https://untrusted.example');
  expect(res.status).toBe(403);
});

it('does not substitute an admin preview for a gallery session', async () => {
  const res = await enter(mintAdminToken(adminId)).query({ admin_preview: 1 });
  expect(res.status).toBe(403);
  expect(res.body.code).toBe('GALLERY_SESSION_REQUIRED');
});

it('leaves the current guest session valid after an incorrect PIN', async () => {
  const guest = token();
  const res = await enter(guest, 'wrong');
  expect(res.status).toBe(401);
  expect(res.headers['set-cookie']).toBeUndefined();
  expect((await photos(guest)).status).toBe(200);
});

it('downgrades to guest, revokes the client token, and makes hidden photos inaccessible', async () => {
  const elevated = await enter(token());
  const oldClient = elevated.body.token;
  const res = await request(app).post(`${path}/client-downgrade`).set('Authorization', `Bearer ${oldClient}`).send({});
  expect(res.status).toBe(200);
  expect(res.body.accessLevel).toBe('guest');
  expect(jwt.decode(res.body.token).exp).toBeLessThanOrEqual(jwt.decode(oldClient).exp);
  expect((await photos(oldClient)).status).toBe(401);
  expect((await photos(res.body.token)).body.photos.map((p) => p.id)).toEqual([719931]);
  const change = await request(app).patch(`/api/gallery/${slug}/photos/719932/visibility`)
    .set('Authorization', `Bearer ${res.body.token}`).send({ visibility: 'visible' });
  expect(change.status).toBe(403);
});

it('allows a private-link client to return to guest view even with PIN entry disabled', async () => {
  await db('events').where({ id: eventId }).update({ client_pin_entry_enabled: 0 });
  const res = await request(app).post(`${path}/client-downgrade`).set('Authorization', `Bearer ${token({ accessLevel: 'client' })}`).send({});
  expect(res.status).toBe(200);
  expect(res.body.accessLevel).toBe('guest');
});

it('preserves portal provenance, account restrictions and the client PIN cutoff', async () => {
  const source = token({ via: 'customer', customerId, parentIat: Math.floor(Date.now() / 1000) - 60, parentJti: crypto.randomUUID() });
  const res = await enter(source);
  expect(res.status).toBe(200);
  const elevated = jwt.decode(res.body.token);
  expect(elevated).toMatchObject({ via: 'customer', customerId, parentJti: jwt.decode(source).parentJti, accessLevel: 'client' });
  await db('events').where({ id: eventId }).update({ client_password_changed_at: new Date((elevated.iat + 1) * 1000).toISOString() });
  expect((await photos(res.body.token)).status).toBe(401);
  await db('events').where({ id: eventId }).update({ client_password_changed_at: null });
  await db('customer_accounts').where({ id: customerId }).update({ is_active: 0 });
  expect((await photos(res.body.token)).status).toBe(401);
});

it('keeps portal parent-session revocation effective after elevation', async () => {
  const parentJti = crypto.randomUUID();
  const parentIat = Math.floor(Date.now() / 1000) - 60;
  const res = await enter(token({ via: 'customer', customerId, parentIat, parentJti }));
  expect(res.status).toBe(200);
  const parent = jwt.sign({ type: 'customer', customerId, jti: parentJti, iat: parentIat },
    process.env.JWT_SECRET, { issuer: 'picpeak-auth', expiresIn: '1h' });
  await require('../../src/utils/tokenRevocation').revokeToken(parent, 'portal_logout');
  expect((await photos(res.body.token)).status).toBe(401);
});

it('returns an elevated portal visitor to their original guest access kind', async () => {
  const source = token({ via: 'customer', customerId, parentIat: Math.floor(Date.now() / 1000) - 60, parentJti: crypto.randomUUID() });
  const entered = await enter(source);
  const res = await request(app).post(`${path}/client-downgrade`).set('Authorization', `Bearer ${entered.body.token}`).send({});
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ accessLevel: 'guest', viaCustomer: true });
  expect(jwt.decode(res.body.token)).toMatchObject({ via: 'customer', customerId, parentJti: jwt.decode(source).parentJti });
  expect((await photos(res.body.token)).body.photos.map((p) => p.id)).toEqual([719931]);
});

it('permits only the owner to opt into the new credential path', async () => {
  const rows = await db('admin_users').insert({ username: 'pin-entry-team', email: 'pin-team@example.test', password_hash: 'x', must_change_password: false }).returning('id');
  const teamId = rows[0].id;
  await assignAdminRole(db, teamId, 'editor');
  await db('event_admin_assignments').insert({ event_id: eventId, admin_user_id: teamId, assigned_by: adminId });
  const denied = await update({ client_pin_entry_enabled: false }, mintAdminToken(teamId));
  expect(denied.status).toBe(403);
  expect(denied.body.code).toBe('EVENT_OWNER_REQUIRED');
  expect((await update({ client_pin_entry_enabled: false })).status).toBe(200);
  expect(Boolean((await db('events').where({ id: eventId }).first()).client_pin_entry_enabled)).toBe(false);
});

it('normalizes the string false accepted by boolean request validation', async () => {
  expect((await update({ client_pin_entry_enabled: 'false' })).status).toBe(200);
  expect(Boolean((await db('events').where({ id: eventId }).first()).client_pin_entry_enabled)).toBe(false);
});
