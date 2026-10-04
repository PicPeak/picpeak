/**
 * An event's customer name and email could not be cleared (issue 1733): the
 * update validator rejected an empty email and the handler dropped an empty
 * name or email from the write, so the save reported success and the stored
 * value stayed. An empty value now clears the field — and its legacy host_*
 * mirror — unless Settings require it, in which case the update answers 400
 * with the create path's error shape and keeps the stored value.
 *
 * With the email optional, "resend creation email" could queue a row with no
 * recipient and still toast success; it now answers 400 and queues nothing.
 */
process.env.JWT_SECRET = 'clear-customer-contact-secret-at-least-32-characters';
process.env.NODE_ENV = 'test';

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');

let db, cleanup, app, adminId, token;

const auth = (req) => req.set('Authorization', `Bearer ${token}`);
const put = (id, body) => auth(request(app).put(`/api/admin/events/${id}`)).send(body);
const resend = (id) => auth(request(app).post(`/api/admin/events/${id}/resend-email`)).send({});
const resetPassword = (id, body) => auth(request(app).post(`/api/admin/events/${id}/reset-password`)).send(body);
const row = (id) => db('events').where({ id }).first('customer_name', 'customer_email', 'host_name', 'host_email');
const setRequirement = (key, value) => db('app_settings')
  .insert({ setting_key: key, setting_value: JSON.stringify(value), setting_type: 'boolean' })
  .onConflict('setting_key').merge({ setting_value: JSON.stringify(value) });

async function insertEvent(over = {}) {
  const inserted = await db('events').insert({
    slug: `clear-contact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    event_type: 'wedding', event_name: 'Clear Contact', event_date: '2026-09-01',
    customer_name: 'Anna', customer_email: 'anna@example.com', host_name: 'Anna', host_email: 'anna@example.com',
    admin_email: 'admin@example.com', password_hash: 'x',
    share_link: '/gallery/clear-contact/tok', share_token: 'tok-clear-contact',
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    is_active: 1, is_archived: 0, is_draft: 0, created_by: adminId,
    created_at: new Date().toISOString(),
    ...over,
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

afterAll(async () => { await cleanup(); });
beforeEach(async () => { await db('email_queue').del(); await db('events').del(); });

describe('PUT /api/admin/events/:id — clearing the customer contact', () => {
  describe('when Settings do not require the fields', () => {
    beforeAll(async () => {
      await setRequirement('event_require_customer_name', false);
      await setRequirement('event_require_customer_email', false);
    });

    it('an empty name clears customer_name and its host_name mirror', async () => {
      const id = await insertEvent();
      const res = await put(id, { customer_name: '' });
      expect(res.status).toBe(200);
      const stored = await row(id);
      expect(stored.customer_name).toBeNull();
      expect(stored.host_name).toBeNull();
      expect(stored.customer_email).toBe('anna@example.com');
    });

    it('an empty email clears customer_email and its host_email mirror', async () => {
      const id = await insertEvent();
      const res = await put(id, { customer_email: '' });
      expect(res.status).toBe(200);
      const stored = await row(id);
      expect(stored.customer_email).toBeNull();
      expect(stored.host_email).toBeNull();
      expect(stored.customer_name).toBe('Anna');
    });

    it('null clears the email as well', async () => {
      const id = await insertEvent();
      expect((await put(id, { customer_email: null })).status).toBe(200);
      expect((await row(id)).customer_email).toBeNull();
    });

    it('a non-empty value still saves to both columns', async () => {
      const id = await insertEvent();
      const res = await put(id, { customer_name: 'Bea', customer_email: 'bea@example.com' });
      expect(res.status).toBe(200);
      expect(await row(id)).toEqual({
        customer_name: 'Bea', customer_email: 'bea@example.com', host_name: 'Bea', host_email: 'bea@example.com',
      });
    });

    it('still rejects a malformed email', async () => {
      const id = await insertEvent();
      expect((await put(id, { customer_email: 'not-an-address' })).status).toBe(400);
      expect((await row(id)).customer_email).toBe('anna@example.com');
    });

    it('rejects false and 0, which the clearing exception must not wave through', async () => {
      const id = await insertEvent();
      for (const value of [false, 0]) {
        expect((await put(id, { customer_email: value })).status).toBe(400);
      }
      expect((await row(id)).customer_email).toBe('anna@example.com');
    });
  });

  describe('when Settings require the fields', () => {
    beforeAll(async () => {
      await setRequirement('event_require_customer_name', true);
      await setRequirement('event_require_customer_email', true);
    });

    it('refuses to clear the email with the create path\'s error shape and keeps the value', async () => {
      const id = await insertEvent();
      const res = await put(id, { customer_email: '' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ errors: [{ path: 'customer_email', msg: 'Customer email is required' }] });
      const stored = await row(id);
      expect(stored.customer_email).toBe('anna@example.com');
      expect(stored.host_email).toBe('anna@example.com');
    });

    it('refuses to clear the name and keeps the value', async () => {
      const id = await insertEvent();
      const res = await put(id, { customer_name: '' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ errors: [{ path: 'customer_name', msg: 'Customer name is required' }] });
      expect((await row(id)).customer_name).toBe('Anna');
    });

    it('still accepts a change to a non-empty value', async () => {
      const id = await insertEvent();
      expect((await put(id, { customer_email: 'bea@example.com' })).status).toBe(200);
      expect((await row(id)).customer_email).toBe('bea@example.com');
    });
  });
});

describe('POST /api/admin/events/:id/resend-email', () => {
  it('answers 400 and queues nothing when the event has no recipient', async () => {
    const id = await insertEvent({ customer_email: null, host_email: null });
    const res = await resend(id);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no customer email/);
    expect(await db('email_queue').count('id as n').first()).toMatchObject({ n: 0 });
  });

  it('still queues the creation email when the event has a recipient', async () => {
    const id = await insertEvent();
    const res = await resend(id);
    expect(res.status).toBe(200);
    const mail = await db('email_queue').where({ event_id: id, email_type: 'gallery_created' }).first();
    expect(mail.recipient_email).toBe('anna@example.com');
  });
});

describe('POST /api/admin/events/:id/reset-password — emailSent tells the truth', () => {
  it('reports emailSent: false and queues nothing when the event has no address', async () => {
    const id = await insertEvent({ customer_email: null, host_email: null });
    const res = await resetPassword(id, { sendEmail: true });
    expect(res.status).toBe(200);
    expect(res.body.emailSent).toBe(false);
    expect(await db('email_queue').where({ event_id: id }).count('* as n').first()).toMatchObject({ n: 0 });
  });

  it('keeps the reset and its audit row when the queue write fails', async () => {
    const id = await insertEvent();
    const before = (await db('events').where({ id }).first()).password_hash;
    // email_queue gone for one request: the insert throws after the new
    // password is already persisted.
    await db.schema.renameTable('email_queue', 'email_queue_offline');
    let res;
    try {
      res = await resetPassword(id, { sendEmail: true });
    } finally {
      await db.schema.renameTable('email_queue_offline', 'email_queue');
    }
    expect(res.status).toBe(200);
    expect(res.body.emailSent).toBe(false);
    expect((await db('events').where({ id }).first()).password_hash).not.toBe(before);
    const audit = await db('activity_logs').where({ event_id: id, activity_type: 'password_reset' });
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0].metadata).emailSent).toBe(false);
  });

  it('reports emailSent: true once the mail is queued', async () => {
    const id = await insertEvent();
    const res = await resetPassword(id, { sendEmail: true });
    expect(res.status).toBe(200);
    expect(res.body.emailSent).toBe(true);
    expect(await db('email_queue').where({ event_id: id }).count('* as n').first()).toMatchObject({ n: 1 });
  });
});
