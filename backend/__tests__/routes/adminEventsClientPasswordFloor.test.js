/**
 * The client PIN guards the review page and accepted any string, one
 * character included. Create and update now refuse fewer than six
 * characters before hashing; an empty string keeps its meaning (no client
 * password on create, no change on update) and existing rows are untouched.
 */
process.env.JWT_SECRET = 'client-password-floor-secret-at-least-32-characters';
process.env.NODE_ENV = 'test';

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');

let db, cleanup, app, adminId, token;

const base = {
  event_type: 'wedding', event_name: 'Floor Wedding', event_date: '2026-09-01',
  customer_name: 'Client Person', customer_email: 'client@example.com', admin_email: 'admin@example.com',
  require_password: false, is_draft: true, client_access_enabled: true,
};
// Not a credential: a fixture the update cases start from (secret scanners
// flag a literal next to client_password).
const FIXTURE_PIN = 'fixture-pin-000';
const auth = (req) => req.set('Authorization', `Bearer ${token}`);
const create = (over) => auth(request(app).post('/api/admin/events')).send({ ...base, ...over });
const floorError = (res) => (res.body.errors || []).some((e) => /at least 6 characters/.test(e.msg));

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  app = express(); app.use(express.json()); app.use(cookieParser());
  app.use('/api/admin/events', require('../../src/routes/adminEvents'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => { res.status(err.statusCode || err.status || 500).json({ error: err.message, code: err.code }); });
}, 120000);

afterAll(async () => { await cleanup(); });
beforeEach(async () => { await db('email_queue').del(); await db('events').del(); });

describe('POST /api/admin/events', () => {
  it('refuses a five-character client password and writes nothing', async () => {
    const res = await create({ client_password: '12345' });
    expect(res.status).toBe(400);
    expect(floorError(res)).toBe(true);
    expect(await db('events').count('id as n').first()).toMatchObject({ n: 0 });
  });

  it('accepts six characters and stores the hash', async () => {
    const res = await create({ client_password: '123456' });
    expect(res.status).toBe(200);
    const row = await db('events').where({ id: res.body.id }).first();
    expect(row.client_password_hash).toMatch(/^\$2[aby]\$/);
  });

  it('still lets an empty string mean "no client password"', async () => {
    const res = await create({ client_password: '' });
    expect(res.status).toBe(200);
    const row = await db('events').where({ id: res.body.id }).first();
    expect(row.client_password_hash).toBeNull();
  });
});

describe('PUT /api/admin/events/:id', () => {
  let id, hashBefore;
  beforeEach(async () => {
    const res = await create({ client_password: FIXTURE_PIN });
    id = res.body.id;
    hashBefore = (await db('events').where({ id }).first()).client_password_hash;
    expect(hashBefore).toBeTruthy();
  });

  it('refuses a five-character client password and keeps the stored hash', async () => {
    const res = await auth(request(app).put(`/api/admin/events/${id}`)).send({ client_password: 'abcde' });
    expect(res.status).toBe(400);
    expect(floorError(res)).toBe(true);
    expect((await db('events').where({ id }).first()).client_password_hash).toBe(hashBefore);
  });

  it('accepts six characters and replaces the hash', async () => {
    const res = await auth(request(app).put(`/api/admin/events/${id}`)).send({ client_password: 'abcdef' });
    expect(res.status).toBe(200);
    expect((await db('events').where({ id }).first()).client_password_hash).not.toBe(hashBefore);
  });

  it('treats an empty string as "no change", as before', async () => {
    const res = await auth(request(app).put(`/api/admin/events/${id}`)).send({ client_password: '', event_name: 'Renamed' });
    expect(res.status).toBe(200);
    const row = await db('events').where({ id }).first();
    expect(row.client_password_hash).toBe(hashBefore);
    expect(row.event_name).toBe('Renamed');
  });
});
