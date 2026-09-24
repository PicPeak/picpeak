/** Real routes + migrated SQLite: the same session policy protects lists and media. */
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');
const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
process.env.JWT_SECRET = 'gallery-policy-regression-secret-at-least-32-characters';

jest.mock('../../src/middleware/secureImageMiddleware', () => ({
  secureImageAccess: (req, _res, next) => {
    req.clientInfo = { fingerprint: 'policy-test', ip: '127.0.0.1', userAgent: 'jest' };
    next();
  },
  getSecurityStatus: (_req, res) => res.json({}),
}));

let db, cleanup, app, adminId, customerId, foreignId, event, secure, cutoff, revokeToken;
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
  secure = require('../../src/services/secureImageService');
  jest.spyOn(secure, 'createClientFingerprint').mockReturnValue('policy-test');
  cutoff = require('../../src/utils/sessionCutoff');
  ({ revokeToken } = require('../../src/utils/tokenRevocation'));
  app = express(); app.use(express.json()); app.use(cookieParser());
  app.use('/api', require('../../src/middleware/csrf'));
  app.use('/api/admin/events', require('../../src/routes/adminEvents'));
  app.use('/api/gallery', require('../../src/routes/gallery'));
}, 120000);

beforeEach(async () => {
  await db('events').where({ id: eventId }).update({ is_active: 1, is_archived: 0, is_draft: 0, require_password: 1,
    expires_at: new Date(Date.now() + 86400000).toISOString(), reveal_mode: 0 });
  await db('customer_accounts').where({ id: customerId }).update({ is_active: 1, password_changed_at: null });
  if (!await db('event_customer_assignments').where({ event_id: eventId, customer_account_id: customerId }).first()) {
    await db('event_customer_assignments').insert({ event_id: eventId, customer_account_id: customerId });
  }
  await cutoff.setSessionsValidAfter(0);
  event = await db('events').where({ id: eventId }).first();
});
afterAll(async () => { secure?.dispose(); if (cleanup) await cleanup(); });

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
it.each(['ISO', 'epoch'])('enforces expiry immediately for public and JWT access (%s)', async (format) => {
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
