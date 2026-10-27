/** Real routes + migrated SQLite: the same session policy protects lists and media. */
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');

let db, cleanup, app, adminId, customerId, foreignId, cutoff, revokeToken;
const eventId = 70001, photoId = 70002, slug = 'policy-test';
const token = (claims = {}) => jwt.sign({ type: 'gallery', eventId, eventSlug: slug,
  iat: Math.floor(Date.now() / 1000) - 60, jti: crypto.randomUUID(), ...claims },
process.env.JWT_SECRET, { issuer: 'picpeak-auth', expiresIn: '1h' });
const get = (url, bearer) => {
  const req = request(app).get(url);
  return bearer ? req.set('Authorization', `Bearer ${bearer}`) : req;
};
const endpoints = [`/api/gallery/${slug}/photos`, `/api/gallery/${slug}/photo/${photoId}`,
  `/api/gallery/${slug}/thumbnail/${photoId}`, `/api/gallery/${slug}/download/${photoId}`];
const expectDirect = async (bearer, status, suffix = '') => {
  for (const url of endpoints) expect((await get(url + suffix, bearer)).status).toBe(status);
};

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId);
  const [row] = await db('admin_users').insert({ username: 'foreign', email: 'foreign@example.test', password_hash: 'unused', is_active: 1 }).returning('id');
  foreignId = row.id ?? row;
  await assignAdminRole(db, foreignId, 'viewer');
  await db('events').insert({ id: eventId, slug, event_type: 'wedding', event_name: 'Policy test',
    event_date: '2026-01-01', host_email: 'h@example.test', admin_email: 'a@example.test', password_hash: 'unused',
    share_link: '/gallery/policy-test', created_by: adminId });
  const file = path.join(process.env.STORAGE_PATH, `events/active/${slug}/individual/fixture.jpg`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await require('sharp')({ create: { width: 8, height: 8, channels: 3, background: '#228844' } }).jpeg().toFile(file);
  await db('photos').insert({ id: photoId, event_id: eventId, filename: 'fixture.jpg', path: `${slug}/individual/fixture.jpg`,
    type: 'individual', mime_type: 'image/jpeg', processing_status: 'complete', size_bytes: (await fs.stat(file)).size });
  await db('event_customer_assignments').insert({ event_id: eventId, customer_account_id: customerId });
  cutoff = require('../../src/utils/sessionCutoff');
  ({ revokeToken } = require('../../src/utils/tokenRevocation'));
  app = express(); app.use(express.json()); app.use(cookieParser());
  app.use('/api', require('../../src/middleware/csrf'));
  app.use('/api/admin/events', require('../../src/routes/adminEvents'));
  app.use('/api/gallery', require('../../src/routes/gallery'));
  app.use('/api/auth', require('../../src/routes/auth'));
  app.use('/api/customer', require('../../src/routes/customer'));
  app.use((err, req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message, code: err.code }));
}, 120000);

beforeEach(async () => {
  await db('events').where({ id: eventId }).update({ is_active: 1, is_archived: 0, is_draft: 0, temporarily_disabled: 0, require_password: 1,
    expires_at: new Date(Date.now() + 86400000).toISOString(), reveal_mode: 0, gallery_password_changed_at: null });
  await db('customer_accounts').where({ id: customerId }).update({ is_active: 1, password_changed_at: null });
  if (!await db('event_customer_assignments').where({ event_id: eventId, customer_account_id: customerId }).first()) {
    await db('event_customer_assignments').insert({ event_id: eventId, customer_account_id: customerId });
  }
  await cutoff.setSessionsValidAfter(0);
});
afterAll(async () => { if (cleanup) await cleanup(); });

it('shows an assigned portal customer a temporary pause without minting a token or publishing a draft', async () => {
  const portalToken = jwt.sign({ type: 'customer', customerId }, process.env.JWT_SECRET,
    { issuer: 'picpeak-auth', expiresIn: '1h' });
  const open = () => request(app).get(`/api/customer/events/${slug}/access-token`)
    .set('Cookie', `customer_token=${portalToken}`);
  const portal = require('../../src/services/customerPortalService');
  const readStatus = async () => (await portal.getDashboard(customerId)).galleries.active.find((entry) => entry.id === eventId)?.availability;

  await db('events').where({ id: eventId }).update({ temporarily_disabled: true });
  expect(await readStatus()).toBe('paused');
  expect((await portal.getEventOverview(customerId, slug)).event.availability).toBe('paused');
  const refused = await open();
  expect(refused.status).toBe(403);
  expect(refused.body).toMatchObject({ code: 'GALLERY_TEMPORARILY_DISABLED' });
  expect(refused.body.token).toBeUndefined();

  await db('event_customer_assignments').where({ event_id: eventId, customer_account_id: customerId }).del();
  expect((await open()).status).toBe(404);
  await db('event_customer_assignments').insert({ event_id: eventId, customer_account_id: customerId });
  await db('events').where({ id: eventId }).update({ is_draft: true });
  expect(await readStatus()).toBe('unavailable');
  expect((await open()).status).toBe(404);

  await db('events').where({ id: eventId }).update({ is_draft: false, temporarily_disabled: false });
  expect(await readStatus()).toBe('active');
  expect((await open()).status).toBe(200);
});

it('temporarily blocks public access and existing guest/client sessions, preserving admin access and credentials', async () => {
  const bearer = token();
  const clientBearer = token({ accessLevel: 'client', via: 'customer', customerId });
  const adminBearer = mintAdminToken(adminId);
  const setDisabled = (disabled) => request(app).put(`/api/admin/events/${eventId}`)
    .set('Authorization', `Bearer ${adminBearer}`).send({ temporarily_disabled: disabled });
  const original = await db('events').where({ id: eventId }).first();
  expect((await setDisabled(true)).status).toBe(200);
  await expectDirect(bearer, 403);
  await expectDirect(clientBearer, 403);
  await expectDirect(adminBearer, 200, '?admin_preview=1');
  const info = await get(`/api/gallery/${slug}/info`);
  expect(info.status).toBe(403);
  expect(info.body).toMatchObject({ code: 'GALLERY_TEMPORARILY_DISABLED', error: 'This gallery is temporarily unavailable.' });
  const adminInfo = await get(`/api/gallery/${slug}/info?admin_preview=1`, adminBearer);
  expect(adminInfo.status).toBe(200);
  const adminRead = await get(`/api/admin/events/${eventId}`, adminBearer);
  expect(adminRead.status).toBe(200);
  expect(adminRead.body.temporarily_disabled).toBeTruthy();
  await db('events').where({ id: eventId }).update({ require_password: 0 });
  await expectDirect(undefined, 403);
  const login = await request(app).post('/api/auth/gallery/verify').send({ slug, password: '' });
  expect(login.status).not.toBe(200);
  expect((await setDisabled(false)).status).toBe(200);
  await expectDirect(undefined, 200);
  await db('events').where({ id: eventId }).update({ require_password: original.require_password });
  await expectDirect(bearer, 200);
  await expectDirect(clientBearer, 200);
  const restored = await db('events').where({ id: eventId }).first();
  for (const key of ['is_active', 'is_draft', 'is_archived', 'expires_at', 'password_hash', 'share_link', 'share_token']) {
    expect(restored[key]).toEqual(original[key]);
  }
});

it('blocks share links while disabled and restores them unchanged', async () => {
  const shareToken = 'd'.repeat(32);
  await db('events').where({ id: eventId }).update({ share_token: shareToken, temporarily_disabled: 1 });
  for (const url of [`/api/gallery/resolve/${slug}`, `/api/gallery/resolve/${shareToken}`,
    `/api/gallery/${slug}/verify-token/${shareToken}`]) {
    const denied = await get(url);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('GALLERY_TEMPORARILY_DISABLED');
    expect((await get(`${url}?admin_preview=1`, mintAdminToken(adminId))).status).toBe(200);
    expect((await get(`${url}?admin_preview=1`, mintAdminToken(foreignId))).status).toBe(403);
  }
  await db('events').where({ id: eventId }).update({ temporarily_disabled: 0 });
  expect((await get(`/api/gallery/resolve/${shareToken}`)).status).toBe(200);
  expect((await get(`/api/gallery/${slug}/verify-token/${shareToken}`)).status).toBe(200);
});

it('checks credentials before reporting a pause, without recording a valid login as a failure', async () => {
  const password = crypto.randomBytes(16).toString('hex');
  const pin = String(crypto.randomInt(100000, 1000000));
  const share = crypto.randomBytes(16).toString('hex'), clientShare = crypto.randomBytes(32).toString('hex');
  await db('events').where({ id: eventId }).update({ temporarily_disabled: true,
    password_hash: await require('bcrypt').hash(password, 4), share_token: share,
    client_access_enabled: true, client_password_hash: await require('bcrypt').hash(pin, 4), client_share_token: clientShare });
  const before = await db('login_attempts').count('* as count').first();
  for (const [url, body] of [
    ['/api/auth/gallery/verify', { slug, password }],
    [`/api/auth/gallery/${slug}/client-login`, { password: pin, token: clientShare }],
  ]) {
    const response = await request(app).post(url).send(body);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('GALLERY_TEMPORARILY_DISABLED');
    expect(response.headers['set-cookie']).toBeUndefined();
  }
  // A private share link still asks for the gallery password first.
  expect((await request(app).post('/api/auth/gallery/share-login').send({ slug, token: share })).body)
    .toEqual({ requires_password: true });
  await db('events').where({ id: eventId }).update({ require_password: false });
  const shared = await request(app).post('/api/auth/gallery/share-login').send({ slug, token: share });
  expect(shared.status).toBe(403);
  expect(shared.body.code).toBe('GALLERY_TEMPORARILY_DISABLED');
  expect(await db('login_attempts').count('* as count').first()).toEqual(before);
  await db('events').where({ id: eventId }).update({ require_password: true });
  for (const [url, body] of [
    ['/api/auth/gallery/verify', { slug, password: crypto.randomBytes(16).toString('hex') }],
    [`/api/auth/gallery/${slug}/client-login`, { password: crypto.randomBytes(16).toString('hex'), token: clientShare }],
    ['/api/auth/gallery/share-login', { slug, token: crypto.randomBytes(32).toString('hex') }],
  ]) {
    const response = await request(app).post(url).send(body);
    expect(response.status).toBe(401);
    expect(response.body.code).not.toBe('GALLERY_TEMPORARILY_DISABLED');
  }
});

it.each(['revoked', 'rotated', 'unassigned'])('refuses a %s gallery grant before exposing its pause', async (reason) => {
  const bearer = token(reason === 'unassigned' ? { via: 'customer', customerId } : {});
  await db('events').where({ id: eventId }).update({ temporarily_disabled: true });
  if (reason === 'revoked') await revokeToken(bearer, 'pause-order-test');
  else if (reason === 'rotated') await db('events').where({ id: eventId }).update({ gallery_password_changed_at: new Date().toISOString() });
  else await db('event_customer_assignments').where({ event_id: eventId, customer_account_id: customerId }).del();
  const response = await get(`/api/gallery/${slug}/photos`, bearer);
  expect(response.status).toBe(reason === 'unassigned' ? 403 : 401);
  expect(response.body.code).not.toBe('GALLERY_TEMPORARILY_DISABLED');
});

it('requires a token for password-protected media before reporting a pause, while public metadata retains its notice', async () => {
  await db('events').where({ id: eventId }).update({ temporarily_disabled: true });
  for (const url of endpoints) {
    const response = await get(url);
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('NO_TOKEN');
  }
  const metadata = await get(`/api/gallery/${slug}/info`);
  expect(metadata.status).toBe(403);
  expect(metadata.body.code).toBe('GALLERY_TEMPORARILY_DISABLED');
  await db('events').where({ id: eventId }).update({ require_password: false });
  for (const url of endpoints) {
    const response = await get(url);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('GALLERY_TEMPORARILY_DISABLED');
  }
});

it.each([null, 'invalid', {}, [true]])('rejects an invalid disabled flag: %p', async (value) => {
  const response = await request(app).put(`/api/admin/events/${eventId}`)
    .set('Authorization', `Bearer ${mintAdminToken(adminId)}`).send({ temporarily_disabled: value });
  expect(response.status).toBe(400);
  expect((await db('events').where({ id: eventId }).first()).temporarily_disabled).toBeFalsy();
});

it('scopes availability changes to admins allowed to edit this gallery', async () => {
  const response = await request(app).put(`/api/admin/events/${eventId}`)
    .set('Authorization', `Bearer ${mintAdminToken(foreignId)}`).send({ temporarily_disabled: true });
  expect(response.status).toBe(403);
});

it('includes disabled galleries in their own list filter and excludes them from active galleries', async () => {
  await db('events').where({ id: eventId }).update({ temporarily_disabled: 1 });
  const bearer = mintAdminToken(adminId);
  const disabled = await get('/api/admin/events?status=disabled&sortBy=status&sortOrder=asc', bearer);
  expect(disabled.status).toBe(200);
  expect(disabled.body.events.map((row) => row.id)).toContain(eventId);
  const active = await get('/api/admin/events?status=active', bearer);
  expect(active.status).toBe(200);
  expect(active.body.events.map((row) => row.id)).not.toContain(eventId);
});

it('does not revive an expired gallery when temporary disabling is cleared', async () => {
  await db('events').where({ id: eventId }).update({ temporarily_disabled: 1, expires_at: new Date(Date.now() - 1000).toISOString() });
  const response = await request(app).put(`/api/admin/events/${eventId}`)
    .set('Authorization', `Bearer ${mintAdminToken(adminId)}`).send({ temporarily_disabled: false });
  expect(response.status).toBe(200);
  await expectDirect(token(), 404);
});

it('reports a pause on session restoration without revoking the original session', async () => {
  const bearer = token({ accessLevel: 'client' });
  await db('events').where({ id: eventId }).update({ temporarily_disabled: true });
  const paused = await get(`/api/auth/session?slug=${slug}`, bearer);
  expect(paused.status).toBe(403);
  expect(paused.body).toMatchObject({ valid: false, code: 'GALLERY_TEMPORARILY_DISABLED' });
  await db('events').where({ id: eventId }).update({ temporarily_disabled: false });
  expect((await get(`/api/auth/session?slug=${slug}`, bearer)).body).toMatchObject({ valid: true, accessLevel: 'client' });
});

it.each([{ is_draft: true }, { is_archived: true }, { is_active: false }, { expires_at: '2020-01-01T00:00:00Z' }])(
  'keeps the normal lifecycle refusal when a paused gallery is also %p', async (change) => {
    await db('events').where({ id: eventId }).update({ temporarily_disabled: true, ...change });
    for (const url of endpoints) {
      const response = await get(url, token());
      expect(response.status).toBe(404);
      expect(response.body.code).not.toBe('GALLERY_TEMPORARILY_DISABLED');
      expect((await get(url)).status).toBe(404);
    }
  });

it('allows an assigned editor, but refuses a foreign editor, to change availability', async () => {
  await assignAdminRole(db, foreignId, 'editor');
  const write = () => request(app).put(`/api/admin/events/${eventId}`)
    .set('Authorization', `Bearer ${mintAdminToken(foreignId)}`).send({ temporarily_disabled: true });
  try {
    expect((await write()).status).toBe(403);
    await db('event_admin_assignments').insert({ event_id: eventId, admin_user_id: foreignId, assigned_by: adminId });
    expect((await write()).status).toBe(200);
  } finally {
    await db('event_admin_assignments').where({ event_id: eventId, admin_user_id: foreignId }).del();
    await assignAdminRole(db, foreignId, 'viewer');
  }
});

it('serves a valid session as a real list and JPEG', async () => {
  const bearer = token();
  const list = await get(endpoints[0], bearer);
  expect(list.status).toBe(200);
  expect(list.body.photos).toEqual(expect.arrayContaining([expect.objectContaining({ id: photoId })]));
  const image = await get(endpoints[1], bearer);
  expect(image.status).toBe(200); expect(image.headers['content-type']).toMatch(/image\/jpeg/);
  expect(image.body.length).toBeGreaterThan(100);
});
it('scopes draft previews to the owner and current read permissions', async () => {
  await db('events').where({ id: eventId }).update({ is_draft: 1 });
  await expectDirect(mintAdminToken(foreignId), 403, '?admin_preview=1');
  await expectDirect(mintAdminToken(adminId), 200, '?admin_preview=1');
  // Ownership alone does not grant a user without a role read access.
  const role = (await db('admin_users').where({ id: adminId }).first()).role_id;
  await db('admin_users').where({ id: adminId }).update({ role_id: null });
  try { await expectDirect(mintAdminToken(adminId), 403, '?admin_preview=1'); }
  finally { await db('admin_users').where({ id: adminId }).update({ role_id: role }); }
});
it.each(['revocation', 'restore'])('rejects gallery sessions after %s', async (reason) => {
  const bearer = token();
  if (reason === 'revocation') expect(await revokeToken(bearer, 'test')).toBe(true);
  else await cutoff.setSessionsValidAfter(Math.floor(Date.now() / 1000));
  await expectDirect(bearer, 401);
});
it.each(['deactivated', 'password changed'])('rejects an assigned customer when %s', async (reason) => {
  const bearer = token({ via: 'customer', customerId });
  await expectDirect(bearer, 200);
  await db('customer_accounts').where({ id: customerId }).update(reason === 'deactivated'
    ? { is_active: 0 } : { password_changed_at: new Date().toISOString() });
  await expectDirect(bearer, 401);
});
// Epoch values are a SQLite storage shape; PostgreSQL's timestamp column
// rejects them before the route can run.
it.each(process.env.DATABASE_CLIENT === 'pg' ? ['ISO'] : ['ISO', 'epoch'])('enforces expiry immediately for public and JWT access (%s)', async (format) => {
  const expiry = Date.now() - 1000;
  await db('events').where({ id: eventId }).update({ require_password: 0, expires_at: format === 'ISO' ? new Date(expiry).toISOString() : expiry });
  await expectDirect(undefined, 404); await expectDirect(token(), 404);
  await expectDirect(mintAdminToken(adminId), 200, '?admin_preview=1');
});
it('blocks an empty cross-site cookie POST before the reveal state changes', async () => {
  await db('events').where({ id: eventId }).update({ reveal_mode: 1, revealed_at: null });
  const cookie = `admin_token=${mintAdminToken(adminId)}`;
  const url = `/api/admin/events/${eventId}/reveal`;
  const blocked = await request(app).post(url).set('Cookie', cookie).set('Origin', 'https://attacker.example')
    .set('Sec-Fetch-Site', 'cross-site').set('Content-Type', 'application/x-www-form-urlencoded').send('');
  expect(blocked.status).toBe(403);
  expect((await db('events').where({ id: eventId }).first()).revealed_at).toBeNull();
  process.env.ADMIN_URL = 'https://admin.example.test';
  try {
    const allowed = await request(app).post(url).set('Cookie', cookie).set('Origin', process.env.ADMIN_URL)
      .set('Sec-Fetch-Site', 'cross-site').send({});
    expect(allowed.status).toBe(200);
    expect((await db('events').where({ id: eventId }).first()).revealed_at).not.toBeNull();
  } finally { delete process.env.ADMIN_URL; }
});

it('toggles status on a fully migrated fresh database and records updated_at', async () => {
  const response = await request(app).post(`/api/admin/events/${eventId}/toggle-status`)
    .set('Authorization', `Bearer ${mintAdminToken(adminId)}`).send({});
  expect(response.status).toBe(200);
  const row = await db('events').where({ id: eventId }).first();
  expect([false, 0]).toContain(row.is_active);
  expect(Number.isFinite(require('../../src/utils/dateNormalize').toTimestamp(row.updated_at))).toBe(true);
});
it('paginates after feedback filtering, with a total independent of page size', async () => {
  const ids = [70003, 70004, 70005];
  await db('photos').insert(ids.map(id => ({ id, event_id: eventId, filename: `${id}.jpg`, path: 'unused',
    type: 'individual', like_count: 1, processing_status: 'complete' })));
  await db('event_feedback_settings').insert({ event_id: eventId, feedback_enabled: 1, show_feedback_to_guests: 1 });
  try {
    const bearer = token();
    const first = await get(`${endpoints[0]}?filter=liked&limit=2&page=1&sort=filename&order=asc`, bearer);
    const second = await get(`${endpoints[0]}?filter=liked&limit=2&page=2&sort=filename&order=asc`, bearer);
    expect(first.status).toBe(200); expect(second.status).toBe(200);
    expect(first.body.pagination).toMatchObject({ total: 3, has_more: true });
    expect(second.body.pagination).toMatchObject({ total: 3, has_more: false });
    expect([...first.body.photos, ...second.body.photos].map(photo => photo.id)).toEqual(ids);
  } finally {
    await db('photos').whereIn('id', ids).del();
    await db('event_feedback_settings').where({ event_id: eventId }).del();
  }
});

it.each(['assignment removed', 'anonymized'])('rejects an existing customer grant after %s', async reason => {
  const bearer = token({ via: 'customer', customerId });
  await expectDirect(bearer, 200);
  if (reason === 'assignment removed') await db('event_customer_assignments').where({ event_id: eventId, customer_account_id: customerId }).del();
  else await require('../../src/services/customerAccountsService').eraseCustomer(customerId, adminId);
  await expectDirect(bearer, reason === 'assignment removed' ? 403 : 401);
});
it('denies foreign editors and allows the editor who owns the gallery', async () => {
  await assignAdminRole(db, foreignId, 'editor');
  try {
    await expectDirect(mintAdminToken(foreignId), 403, '?admin_preview=1');
    await db('events').where({ id: eventId }).update({ created_by: foreignId });
    await expectDirect(mintAdminToken(foreignId), 200, '?admin_preview=1');
  } finally {
    await db('events').where({ id: eventId }).update({ created_by: adminId });
    await assignAdminRole(db, foreignId, 'viewer');
  }
});
it('bounds a large gallery response while retaining the complete count', async () => {
  const rows = Array.from({ length: 5000 }, (_, index) => ({ id: 80000 + index, event_id: eventId,
    filename: `large-${index}.jpg`, path: 'unused', type: 'individual', processing_status: 'complete' }));
  try {
    await db.batchInsert('photos', rows, 100);
    const response = await get(`${endpoints[0]}?limit=999999&page=1`, token());
    expect(response.status).toBe(200);
    expect(response.body.photos).toHaveLength(250);
    expect(response.body.pagination).toMatchObject({ total: 5001, limit: 250, has_more: true });
  } finally { await db('photos').where('id', '>=', 80000).where({ event_id: eventId }).del(); }
});
