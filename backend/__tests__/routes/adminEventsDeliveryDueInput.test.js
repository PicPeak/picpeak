/**
 * The promised delivery date (delivery_due_at) is a calendar day stored at
 * noon UTC. The settings PUT parsed its input with new Date(), which reads a
 * date-time without a zone in the server's zone: on a Europe/Berlin server
 * '2026-10-20T00:00' became 22:00 UTC on the 19th, a day early everywhere
 * the date is read back as its UTC day.
 */
process.env.JWT_SECRET = 'delivery-due-input-secret-at-least-32-characters';
process.env.NODE_ENV = 'test';

const os = require('os');
const path = require('path');
const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');

const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-due-'));
process.env.STORAGE_PATH = storageDir;

let db, cleanup, app, adminId, token;

const auth = (req) => req.set('Authorization', `Bearer ${token}`);

async function insertEvent() {
  const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inserted = await db('events').insert({
    slug: `delivery-due-${key}`,
    event_type: 'wedding', event_name: 'Delivery', event_date: '2026-10-10',
    customer_name: 'Anna', customer_email: 'anna@example.com', host_name: 'Anna', host_email: 'anna@example.com',
    admin_email: 'admin@example.com', password_hash: 'x',
    share_link: `/gallery/delivery-due-${key}/tok`, share_token: `tok-${key}`,
    expires_at: '2026-12-20T00:00:00.000Z',
    is_active: 1, is_archived: 0, is_draft: 0, created_by: adminId,
    created_at: new Date().toISOString(),
  }).returning('id');
  return inserted[0]?.id ?? inserted[0];
}

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

afterAll(async () => {
  await cleanup();
  fs.rmSync(storageDir, { recursive: true, force: true });
});

describe('delivery_due_at on the settings PUT', () => {
  const put = async (value) => {
    const id = await insertEvent();
    const res = await auth(request(app).put(`/api/admin/events/${id}`)).send({ delivery_due_at: value });
    expect(res.status).toBe(200);
    return (await db('events').where({ id }).first('delivery_due_at')).delivery_due_at;
  };

  it('stores a bare date as that day at noon UTC', async () => {
    expect(new Date(await put('2026-10-20')).toISOString()).toBe('2026-10-20T12:00:00.000Z');
  });

  it('stores a date-time without a zone as its calendar day, not an instant in the server zone', async () => {
    expect(new Date(await put('2026-10-20T00:00')).toISOString()).toBe('2026-10-20T12:00:00.000Z');
  });

  it('rejects a day the calendar does not have', async () => {
    const id = await insertEvent();
    for (const value of ['2026-02-31', '2026-02-30T00:00']) {
      const res = await auth(request(app).put(`/api/admin/events/${id}`)).send({ delivery_due_at: value });
      expect(res.status).toBe(400);
    }
    expect((await db('events').where({ id }).first('delivery_due_at')).delivery_due_at).toBeNull();
  });

  it('keeps a full instant as given', async () => {
    expect(new Date(await put('2026-10-20T12:00:00.000Z')).toISOString()).toBe('2026-10-20T12:00:00.000Z');
    expect(new Date(await put('2026-10-20T08:30:00+02:00')).toISOString()).toBe('2026-10-20T06:30:00.000Z');
  });
});
