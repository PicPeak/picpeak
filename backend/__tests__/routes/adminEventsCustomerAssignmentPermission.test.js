/**
 * Customer assignments on an event are customers.* data, not events.* data.
 *
 * The event detail route (events.view) returned the assigned customers' ids
 * and PII, and create / update (events.create / events.edit) accepted
 * customer_account_ids and rewrote the assignment set — all without the
 * dedicated customers.view / customers.events permissions the
 * /customers/:id/events route requires.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-ev-cust-perm-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'ev-cust-perm-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-ev-cust-perm-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken,
} = require('../integration/helpers/crmDb');
const { clearPermissionCache } = require('../../src/middleware/permissions');

describe('event routes — customer assignments need customers.* permissions', () => {
  let db; let cleanup; let app;
  let superId; let superTok; let editorId; let editorTok;
  let customerId; let eventId;

  const auth = (req, tok) => req.set('Authorization', `Bearer ${tok}`);
  const insertId = async (table, row) => {
    const ins = await db(table).insert(row).returning('id');
    return ins[0]?.id ?? ins[0];
  };
  const assignments = (evId) => db('event_customer_assignments').where({ event_id: evId }).pluck('customer_account_id');
  const createBody = (over = {}) => ({
    event_type: 'wedding', event_name: 'Perm Wedding', event_date: '2026-09-01',
    customer_name: 'Client Person', customer_email: 'client@example.com', admin_email: 'admin@example.com',
    require_password: false, is_draft: true, ...over,
  });

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId: superId, customerId } = await seedMinimal(db));
    await assignAdminRole(db, superId, 'super_admin');
    superTok = mintAdminToken(superId);

    // editor: events.view / events.create / events.edit, no customers.*
    editorId = await insertId('admin_users', {
      username: 'editor', email: 'editor@example.com', password_hash: 'x',
      must_change_password: false, created_at: new Date().toISOString(),
    });
    await assignAdminRole(db, editorId, 'editor');
    editorTok = mintAdminToken(editorId);
    clearPermissionCache();

    await db('feature_flags').insert({ key: 'customerPortal', value: true }).onConflict('key').merge({ value: true });

    eventId = await insertId('events', {
      slug: 'perm-ev', event_type: 'wedding', event_name: 'Perm Event', event_date: '2026-08-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: '/gallery/perm-ev/share', share_token: 'perm-ev-share',
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_by: editorId,
      created_at: new Date().toISOString(),
    });
    await db('event_customer_assignments').insert({
      event_id: eventId, customer_account_id: customerId, assigned_by_admin_id: superId,
      assigned_at: new Date().toISOString(),
    });

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/events', require('../../src/routes/adminEvents'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('event detail hides the assigned customers from a caller without customers.view', async () => {
    const res = await auth(request(app).get(`/api/admin/events/${eventId}`), editorTok);
    expect(res.status).toBe(200);
    expect(res.body.customer_accounts).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain('customer@example.com');

    const sup = await auth(request(app).get(`/api/admin/events/${eventId}`), superTok);
    expect(sup.status).toBe(200);
    expect(sup.body.customer_accounts.map((c) => c.id)).toEqual([customerId]);
  });

  it('event update refuses an assignment change without customers.events', async () => {
    const res = await auth(request(app).put(`/api/admin/events/${eventId}`), editorTok)
      .send({ event_name: 'Renamed', customer_account_ids: [] });
    expect(res.status).toBe(403);
    expect(await assignments(eventId)).toEqual([customerId]);
    expect((await db('events').where({ id: eventId }).first()).event_name).toBe('Perm Event');
  });

  it('event update that echoes the current assignments unchanged works for events.edit', async () => {
    // Older clients sent customer_account_ids on every save; an unchanged
    // set changes nothing and must not need customers.events.
    const res = await auth(request(app).put(`/api/admin/events/${eventId}`), editorTok)
      .send({ event_name: 'Renamed with echo', customer_account_ids: [String(customerId)] });
    expect(res.status).toBe(200);
    expect((await db('events').where({ id: eventId }).first()).event_name).toBe('Renamed with echo');
    expect(await assignments(eventId)).toEqual([customerId]);
  });

  it('the echo writes no assignments at all, so it cannot undo a change made in between', async () => {
    const service = require('../../src/services/customerAccountsService');
    const spy = jest.spyOn(service, 'setAssignmentsForEvent');
    try {
      const res = await auth(request(app).put(`/api/admin/events/${eventId}`), editorTok)
        .send({ event_name: 'Echo again', customer_account_ids: [customerId] });
      expect(res.status).toBe(200);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('event update without the field still works for events.edit', async () => {
    const res = await auth(request(app).put(`/api/admin/events/${eventId}`), editorTok)
      .send({ event_name: 'Renamed by editor' });
    expect(res.status).toBe(200);
    expect((await db('events').where({ id: eventId }).first()).event_name).toBe('Renamed by editor');
    expect(await assignments(eventId)).toEqual([customerId]);
  });

  it('event create refuses a non-empty assignment list without customers.events', async () => {
    const res = await auth(request(app).post('/api/admin/events'), editorTok)
      .send(createBody({ customer_account_ids: [customerId] }));
    expect(res.status).toBe(403);
    expect(await db('events').where({ event_name: 'Perm Wedding' }).first()).toBeUndefined();
  });

  it('event create accepts the empty list the form always sends', async () => {
    const res = await auth(request(app).post('/api/admin/events'), editorTok)
      .send(createBody({ event_name: 'Plain Wedding', customer_account_ids: [] }));
    expect(res.status).toBe(200);
    expect(await db('events').where({ event_name: 'Plain Wedding' }).first()).toBeDefined();
  });

  it('a caller with customers.events can change the assignments', async () => {
    const res = await auth(request(app).put(`/api/admin/events/${eventId}`), superTok)
      .send({ customer_account_ids: [] });
    expect(res.status).toBe(200);
    expect(await assignments(eventId)).toEqual([]);
  });
});
