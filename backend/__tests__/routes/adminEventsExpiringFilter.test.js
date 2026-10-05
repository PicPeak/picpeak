/**
 * GET /api/admin/events?status=expiring on SQLite, whatever shape expires_at
 * was stored in (issue 1733). The filter used to bind ISO strings, which
 * compared the extend path's epoch-ms rows lexicographically — the mirror
 * image of the expiry checker's bug.
 */
process.env.JWT_SECRET = 'expiring-filter-secret-at-least-32-characters-long';
process.env.NODE_ENV = 'test';
// A non-UTC server zone: a zone-less expires_at must still be stored as the
// UTC instant julianday() reads it as.
// (Not forced here: process.env.TZ does not re-bind inside a running jest
// process. The non-UTC server zone is proven in a child process in
// __tests__/utils/expiresAtText.test.js; these cases hold in every zone.)

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');

let db, cleanup, app, adminId, token;
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const naive = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

// Plain numbers and strings only: a Date written from inside jest lands as
// "[object Object]" (CLAUDE.md).
const FIXTURES = [
  ['iso-soon', new Date(now + 3 * DAY).toISOString(), true],
  ['ms-soon', now + 3 * DAY, true],
  ['naive-soon', naive(now + 3 * DAY), true],
  ['iso-far', new Date(now + 30 * DAY).toISOString(), false],
  ['ms-far', now + 30 * DAY, false],
  ['iso-past', new Date(now - DAY).toISOString(), false],
  ['ms-past', now - DAY, false],
  ['never', null, false],
];

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  app = express(); app.use(express.json()); app.use(cookieParser());
  app.use('/api/admin/events', require('../../src/routes/adminEvents'));
  await db('events').del();
  for (const [slug, expires_at] of FIXTURES) {
    await db('events').insert({
      slug, event_type: 'other', event_name: slug, event_date: '2026-09-01',
      customer_name: 'A', customer_email: 'a@example.com', host_name: 'A', host_email: 'a@example.com',
      admin_email: 'admin@example.com', password_hash: 'x',
      share_link: `/gallery/${slug}/tok`, share_token: `tok-${slug}`,
      expires_at, is_active: 1, is_archived: 0, is_draft: 0, created_by: adminId,
      created_at: new Date().toISOString(),
    });
  }
}, 120000);

afterAll(async () => { await cleanup(); });

test('status=expiring lists every gallery expiring within seven days, in any stored shape', async () => {
  const res = await request(app).get('/api/admin/events?status=expiring&limit=50')
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  const slugs = (res.body.events || res.body).map((e) => e.slug).sort();
  expect(slugs).toEqual(FIXTURES.filter(([, , soon]) => soon).map(([slug]) => slug).sort());
});

test('PUT stores a client-supplied expires_at in the canonical ISO form', async () => {
  // isISO8601() accepts `+0200`, which SQLite's strftime() cannot read; the
  // row would otherwise fall out of every expiry comparison above.
  const { id } = await db('events').where({ slug: 'iso-far' }).first('id');
  const res = await request(app).put(`/api/admin/events/${id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ expires_at: '2026-10-06T12:00:00+0200' });
  expect(res.status).toBe(200);
  const row = await db('events').where({ id }).first('expires_at');
  expect(row.expires_at).toBe('2026-10-06T10:00:00.000Z');
});

test('PUT refuses an ISO 8601 form the stored shape could not carry', async () => {
  const { id } = await db('events').where({ slug: 'iso-far' }).first('id');
  const res = await request(app).put(`/api/admin/events/${id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ expires_at: '20261006T120000Z' });
  expect(res.status).toBe(400);
  expect(JSON.stringify(res.body)).toContain('expires_at');
});

test('PUT reads a zone-less expires_at as UTC, like julianday() reads the stored rows', async () => {
  const { id } = await db('events').where({ slug: 'iso-far' }).first('id');
  const res = await request(app).put(`/api/admin/events/${id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ expires_at: '2026-10-06T12:00:00' });
  expect(res.status).toBe(200);
  expect((await db('events').where({ id }).first('expires_at')).expires_at).toBe('2026-10-06T12:00:00.000Z');
});

test('POST and PUT store the same instant for the same zone-less expires_at', async () => {
  // Both go through parseExpiresAtText; `new Date()` on the create path read
  // the value in the server's zone (TZ above) and stored a different instant.
  const created = await request(app).post('/api/admin/events')
    .set('Authorization', `Bearer ${token}`)
    .send({
      event_type: 'wedding', event_name: `Zoneless ${Date.now()}`, event_date: '2026-09-01',
      customer_name: 'A', customer_email: 'a@example.com', admin_email: 'admin@example.com',
      password: 'ZonelessPass!1', expires_at: '2026-10-06T12:00:00',
    });
  expect(created.status).toBeLessThan(300);
  const createdRow = await db('events').where({ id: created.body.id }).first('expires_at');
  expect(createdRow.expires_at).toBe('2026-10-06T12:00:00.000Z');

  const { id } = await db('events').where({ slug: 'iso-far' }).first('id');
  await request(app).put(`/api/admin/events/${id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ expires_at: '2026-10-06T12:00:00' }).expect(200);
  expect((await db('events').where({ id }).first('expires_at')).expires_at).toBe(createdRow.expires_at);
});

test('POST refuses an expires_at it cannot read instead of failing on it', async () => {
  const res = await request(app).post('/api/admin/events')
    .set('Authorization', `Bearer ${token}`)
    .send({
      event_type: 'wedding', event_name: `Unreadable ${Date.now()}`, event_date: '2026-09-01',
      customer_name: 'A', customer_email: 'a@example.com', admin_email: 'admin@example.com',
      password: 'ZonelessPass!1', expires_at: '20261006T120000Z',
    });
  expect(res.status).toBe(400);
});
