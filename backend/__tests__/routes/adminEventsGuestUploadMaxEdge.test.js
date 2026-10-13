/**
 * events.guest_upload_max_edge (issue 1733): the longest edge guest photos are
 * scaled to in the browser. The update accepts a whole pixel value in range
 * or null, and the admin read hands it back.
 */
process.env.JWT_SECRET = 'guest-upload-edge-secret-at-least-32-characters';
process.env.NODE_ENV = 'test';

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');

let db, cleanup, app, token, id;

const auth = (req) => req.set('Authorization', `Bearer ${token}`);
const put = (body) => auth(request(app).put(`/api/admin/events/${id}`)).send(body);
const stored = async () => (await db('events').where({ id }).first()).guest_upload_max_edge;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  const { adminId } = await seedMinimal(db);
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  app = express(); app.use(express.json()); app.use(cookieParser());
  app.use('/api/admin/events', require('../../src/routes/adminEvents'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => { res.status(err.statusCode || err.status || 500).json({ error: err.message, code: err.code }); });
  const created = await auth(request(app).post('/api/admin/events')).send({
    event_type: 'wedding', event_name: 'Edge Wedding', event_date: '2026-09-01',
    customer_name: 'Client Person', customer_email: 'client@example.com', admin_email: 'admin@example.com',
    require_password: false, is_draft: true, allow_user_uploads: true,
  });
  id = created.body.id;
}, 120000);

afterAll(async () => { await cleanup(); });

test('a new gallery uploads originals', async () => {
  expect(await stored()).toBeNull();
});

test('stores a pixel value, hands it back, and clears it with null', async () => {
  expect((await put({ guest_upload_max_edge: 2048 })).status).toBe(200);
  expect(Number(await stored())).toBe(2048);
  const read = await auth(request(app).get(`/api/admin/events/${id}`));
  expect(Number(read.body.guest_upload_max_edge)).toBe(2048);

  expect((await put({ guest_upload_max_edge: null })).status).toBe(200);
  expect(await stored()).toBeNull();
});

test.each([1023, 16385, 0, -2048, 2048.5, '2048px', '', true, [2048]])('refuses %p and keeps the stored value', async (value) => {
  await put({ guest_upload_max_edge: 4096 });
  const res = await put({ guest_upload_max_edge: value });
  expect(res.status).toBe(400);
  expect(Number(await stored())).toBe(4096);
});
