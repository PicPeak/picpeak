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
const enter = (bearer, password = pin, ip) => {
  const req = request(app).post(`${path}/client-elevate`).send({ password });
  if (ip) req.set('X-Forwarded-For', ip);
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
  app.set('trust proxy', 1);
  app.use('/api', require('../../src/middleware/csrf'));
  app.use('/api/auth', require('../../src/routes/auth'));
  app.use('/api/gallery', require('../../src/routes/gallery'));
  app.use('/api/admin/events', require('../../src/routes/adminEvents'));
  app.use('/api/admin/notifications', require('../../src/routes/adminNotifications'));
});

beforeEach(async () => {
  await db('login_attempts').del();
  await db('revoked_tokens').del();
  await db('activity_logs').where({ activity_type: 'gallery_pin_entry_paused', event_id: eventId }).del();
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
  expect((await photos(guest)).status).toBe(401);
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

it('caps failed PIN guesses across rotating addresses without locking the private client link', async () => {
  for (let i = 0; i < 5; i += 1) expect((await enter(token(), 'wrong-pin', `203.0.113.${i + 1}`)).status).toBe(401);
  expect((await enter(token())).status).toBe(423);
  expect((await request(app).post(`${path}/client-login`).send({ password: pin, token: privateLink })).status).toBe(200);
  const notices = await db('activity_logs').where({ activity_type: 'gallery_pin_entry_paused', event_id: eventId });
  expect(notices).toHaveLength(1);
  expect(JSON.stringify(notices)).not.toContain(pin);
  const bell = await request(app).get('/api/admin/notifications').set('Authorization', `Bearer ${mintAdminToken(adminId)}`);
  expect(bell.status).toBe(200);
  expect(bell.body.notifications).toContainEqual(expect.objectContaining({ type: 'gallery_pin_entry_paused', eventId, eventName: 'PIN entry gallery' }));
});

it('reserves the gallery budget before checking concurrent guesses', async () => {
  const bcrypt = require('bcrypt');
  let release;
  let ready;
  const blocked = new Promise((resolve) => { release = resolve; });
  const allStarted = new Promise((resolve) => { ready = resolve; });
  let started = 0;
  const compare = jest.spyOn(bcrypt, 'compare').mockImplementation(async () => {
    started += 1;
    if (started === 5) ready();
    await blocked;
    return false;
  });
  const requests = Array.from({ length: 5 }, (_, i) => enter(token(), 'wrong-pin', `198.51.100.${i + 1}`).then((res) => res));
  let timer;
  try {
    await Promise.race([allStarted, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Concurrent checks did not start')), 5000); })]);
    const overflow = await enter(token(), 'wrong-pin', '198.51.100.99');
    expect(overflow.status).toBe(429);
    expect(overflow.body.code).toBe('CLIENT_PIN_ENTRY_BUSY');
    expect(compare).toHaveBeenCalledTimes(5);
  } finally {
    clearTimeout(timer);
    release();
    const results = await Promise.all(requests);
    compare.mockRestore();
    expect(results.map((res) => res.status)).toEqual([401, 401, 401, 401, 401]);
  }
  const locked = await enter(token());
  expect(locked.status).toBe(423);
  expect(Number(locked.headers['retry-after'])).toBeGreaterThan(1700);
  expect(await db('activity_logs').where({ activity_type: 'gallery_pin_entry_paused', event_id: eventId })).toHaveLength(1);
});

// Inject storage failures at the database boundary so the route and its real
// transaction/revocation handling still run on both supported engines.
async function failInserts(table, run) {
  const pg = db.client.config.client === 'pg';
  if (pg) {
    await db.raw("CREATE FUNCTION pin_test_refuse_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test storage failure'; END $$");
    await db.raw(`CREATE TRIGGER pin_test_failure BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION pin_test_refuse_insert()`);
  } else await db.raw(`CREATE TRIGGER pin_test_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'test storage failure'); END`);
  try { await run(); }
  finally {
    await db.raw(`DROP TRIGGER pin_test_failure${pg ? ` ON ${table}` : ''}`);
    if (pg) await db.raw('DROP FUNCTION pin_test_refuse_insert()');
  }
}

it.each(['login_attempts', 'revoked_tokens'])('fails closed when %s cannot be written, without stranding the visitor', async (table) => {
  const guest = token();
  await failInserts(table, async () => {
    const response = await enter(guest);
    expect(response.status).toBe(503);
    expect(response.body.token).toBeUndefined();
    expect(response.headers['set-cookie']).toBeUndefined();
  });
  expect((await photos(guest)).status).toBe(200);
});

it('retains PIN-entry provenance in media grants and refuses them immediately after opt-out', async () => {
  const elevated = await enter(token());
  expect(elevated.status).toBe(200);
  const access = require('../../src/services/galleryAccessService');
  const event = await db('events').where({ id: eventId }).first();
  const grant = access.grant(event, 'gallery', jwt.decode(elevated.body.token));
  expect(grant.session.clientPinEntry).toEqual(expect.any(String));
  await expect(access.authorize(event, grant)).resolves.toBe(grant);
  expect((await update({ client_pin_entry_enabled: false })).status).toBe(200);
  await expect(access.authorize(await db('events').where({ id: eventId }).first(), grant))
    .rejects.toMatchObject({ code: 'CLIENT_PIN_ENTRY_ENDED' });
});

it('does not issue client access if the owner opts out during a PIN check', async () => {
  const bcrypt = require('bcrypt');
  const originalCompare = bcrypt.compare.bind(bcrypt);
  const compare = jest.spyOn(bcrypt, 'compare').mockImplementationOnce(async (...args) => {
    await db('events').where({ id: eventId }).update({ client_pin_entry_enabled: 0 });
    return originalCompare(...args);
  });
  const guest = token();
  try {
    const response = await enter(guest);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('CLIENT_ACCESS_UNAVAILABLE');
    expect(response.body.token).toBeUndefined();
    expect(response.headers['set-cookie']).toBeUndefined();
  } finally { compare.mockRestore(); }
  expect((await photos(guest)).status).toBe(200);
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
  const res = await enter(guest, 'wrong-pin');
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

it('requires fresh strong PIN enrollment, including for a gallery with a legacy short PIN', async () => {
  await db('events').where({ id: eventId }).update({ client_pin_entry_enabled: 0,
    client_password_hash: await require('bcrypt').hash('1234', 4) });
  for (const password of [undefined, '123456', '1234567', '        ']) {
    const res = await update({ client_pin_entry_enabled: true, ...(password === undefined ? {} : { client_password: password }) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CLIENT_PIN_ENTRY_PASSWORD_REQUIRED');
    expect(Boolean((await db('events').where({ id: eventId }).first()).client_pin_entry_enabled)).toBe(false);
  }
  expect((await update({ client_pin_entry_enabled: true, client_password: '12345678' })).status).toBe(200);
  expect((await enter(token(), '12345678')).status).toBe(200);
  expect((await update({ client_password: '123456' })).status).toBe(400);
  expect((await update({ client_pin_entry_enabled: false, client_password: '123456' })).status).toBe(200);
});

it('validates PIN entry in the shared creation service before writing a gallery', async () => {
  const create = (password) => request(app).post('/api/admin/events').set('Authorization', `Bearer ${mintAdminToken(adminId)}`)
    .send({ event_type: 'wedding', event_name: `PIN enrollment ${crypto.randomUUID()}`, event_date: '2026-11-01',
      customer_name: 'Review client', customer_email: 'client@example.test', admin_email: 'owner@example.test', require_password: false,
      client_access_enabled: true, client_pin_entry_enabled: true, client_password: password });
  expect((await create('123456')).status).toBe(400);
  const response = await create('12345678');
  expect(response.status).toBe(200);
  const created = await db('events').where({ id: response.body.event?.id ?? response.body.id }).first();
  expect(Boolean(created.client_pin_entry_enabled)).toBe(true);
});

it('ends PIN-entry access immediately on opt-out without ending a private-link client session, and prevents revival', async () => {
  const privateSession = await request(app).post(`${path}/client-login`).send({ password: pin, token: privateLink });
  const elevated = await enter(token());
  expect(elevated.status).toBe(200);
  expect(elevated.body.viaClientPin).toBe(true);
  const auth = (bearer) => request(app).get('/api/auth/session').set('Authorization', `Bearer ${bearer}`)
    .set('X-Gallery-Slug', slug);
  expect((await auth(elevated.body.token)).body.viaClientPin).toBe(true);
  expect((await update({ client_pin_entry_enabled: false })).status).toBe(200);
  expect((await photos(elevated.body.token)).status).toBe(401);
  expect((await auth(elevated.body.token)).body.valid).toBe(false);
  expect((await photos(privateSession.body.token)).status).toBe(200);
  // Reconfirming the SAME PIN still replaces this enrollment's hash. This
  // stays safe within the same second, unlike a second-resolution iat cutoff.
  expect((await update({ client_pin_entry_enabled: true })).status).toBe(400);
  expect((await update({ client_pin_entry_enabled: true, client_password: pin })).status).toBe(200);
  expect((await photos(elevated.body.token)).status).toBe(401);
  expect((await photos(privateSession.body.token)).status).toBe(200);
  const replacement = await enter(token());
  expect(replacement.status).toBe(200);
  expect(jwt.decode(replacement.body.token).clientPinEntry).not.toBe(jwt.decode(elevated.body.token).clientPinEntry);
});

it('does not restore PIN entry silently when Client Access is disabled and enabled again', async () => {
  const elevated = await enter(token());
  expect((await update({ client_access_enabled: false })).status).toBe(200);
  const disabled = await db('events').where({ id: eventId }).first();
  expect(Boolean(disabled.client_pin_entry_enabled)).toBe(false);
  expect((await photos(elevated.body.token)).status).toBe(401);
  expect((await update({ client_access_enabled: true })).status).toBe(200);
  expect((await enter(token())).status).toBe(403);
});

it('refuses a stale enrollment save when another owner edit disables Client Access', async () => {
  await db('events').where({ id: eventId }).update({ client_pin_entry_enabled: 0 });
  const bcrypt = require('bcrypt');
  const originalCompare = bcrypt.compare.bind(bcrypt);
  const compare = jest.spyOn(bcrypt, 'compare').mockImplementationOnce(async (...args) => {
    // sameAsStored runs after the edit route has loaded its event snapshot.
    await db('events').where({ id: eventId }).update({ client_access_enabled: 0, client_pin_entry_enabled: 0 });
    return originalCompare(...args);
  });
  try {
    const response = await update({ client_pin_entry_enabled: true, client_password: pin });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('CLIENT_ACCESS_CHANGED');
  } finally { compare.mockRestore(); }
  const event = await db('events').where({ id: eventId }).first();
  expect(Boolean(event.client_access_enabled)).toBe(false);
  expect(Boolean(event.client_pin_entry_enabled)).toBe(false);
});

it('revokes the previous client token when an existing client session re-enters PIN mode', async () => {
  const first = await enter(token());
  const second = await enter(first.body.token);
  expect(second.status).toBe(200);
  expect((await photos(first.body.token)).status).toBe(401);
  expect((await photos(second.body.token)).status).toBe(200);
});

it('keeps the private-link failure bucket separate in both directions', async () => {
  for (let i = 0; i < 5; i += 1) {
    expect((await request(app).post(`${path}/client-login`).send({ password: crypto.randomUUID(), token: privateLink })).status).toBe(401);
  }
  expect((await request(app).post(`${path}/client-login`).send({ password: pin, token: privateLink })).status).toBe(423);
  expect((await enter(token())).status).toBe(200);
});

it('keeps the gallery pause for its full configured duration and emits one owner notice', async () => {
  for (let i = 0; i < 5; i += 1) await enter(token(), 'wrong-pin', `203.0.113.${i + 1}`);
  // The failures are outside the 15m attempt window, but the 30m pause still
  // has 10m remaining. Restarting a process cannot erase the persisted pause.
  await db('login_attempts').where('identifier', 'like', `client-pin%:${eventId}`)
    .update({ attempt_time: new Date(Date.now() - 20 * 60 * 1000).toISOString() });
  const locked = await enter(token());
  expect(locked.status).toBe(423);
  expect(locked.body.retryAfter).toBeGreaterThan(9 * 60);
  expect(locked.headers['retry-after']).toBe(String(locked.body.retryAfter));
  expect(await db('activity_logs').where({ activity_type: 'gallery_pin_entry_paused', event_id: eventId })).toHaveLength(1);
  await db('login_attempts').where({ identifier: `client-pin-lock:${eventId}` })
    .update({ attempt_time: new Date(Date.now() - 31 * 60 * 1000).toISOString() });
  expect((await enter(token())).status).toBe(200);
});

it('successful PIN entry does not erase failures from other visitors', async () => {
  for (let i = 0; i < 4; i += 1) await enter(token(), 'wrong-pin', `203.0.113.${i + 1}`);
  expect((await enter(token())).status).toBe(200);
  expect((await enter(token(), 'wrong-pin', '203.0.113.9')).status).toBe(401);
  expect((await enter(token())).status).toBe(423);
});
