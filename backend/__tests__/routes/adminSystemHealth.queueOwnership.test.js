/**
 * The System Health mail panel follows the same rule as the Messages and
 * project mail routes (middleware/emailQueueOwnership): an admin who is not a
 * Super Admin sees, retries and dismisses only the mail it sent and the mail
 * of galleries it may act on. Other rows answer 404 and stay out of the lists.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-healthqueue-')), 'db.sqlite');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'healthqueue-test-secret';

const request = require('supertest');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp } = require('../integration/helpers/crmDb');
const { clearPermissionCache } = require('../../src/middleware/permissions');

const byId = (a, b) => a - b;

describe('System Health mail actions, senders and galleries', () => {
  let db; let cleanup; let app;
  let superTok; let opsTok;
  let opsId; let otherId;

  const insertAdmin = async (username, roleId) => {
    const [row] = await db('admin_users').insert({
      username, email: `${username}@example.com`, password_hash: 'x', role_id: roleId,
      must_change_password: false, is_active: true, created_at: new Date(),
    }).returning('id');
    return row?.id ?? row;
  };
  const insertRole = async (name, permissions) => {
    const [row] = await db('roles').insert({ name, display_name: name, priority: 10 }).returning('id');
    const roleId = row?.id ?? row;
    const perms = await db('permissions').whereIn('name', permissions).select('id');
    await db('role_permissions').insert(perms.map((p) => ({ role_id: roleId, permission_id: p.id })));
    return roleId;
  };
  const insertEvent = async (slug, createdBy) => {
    const [row] = await db('events').insert({
      slug, event_name: slug, event_type: 'wedding', event_date: '2026-06-01',
      share_link: `/gallery/${slug}`, share_token: `${slug}-token`.padEnd(32, 'x'), password_hash: 'x',
      expires_at: '2027-01-01', created_by: createdBy, created_at: new Date().toISOString(),
    }).returning('id');
    return row?.id ?? row;
  };
  // A failed row: listed under stuckEmails and offered retry / dismiss.
  const insertFailed = async (eventId, extra = {}) => {
    const [row] = await db('email_queue').insert({
      event_id: eventId, recipient_email: 'client@example.com',
      email_type: eventId ? 'gallery_created' : 'invoice_sent',
      status: 'failed', retry_count: 3, error_message: 'smtp down',
      created_at: new Date().toISOString(), email_data: JSON.stringify({}), ...extra,
    }).returning('id');
    return row?.id ?? row;
  };
  const as = (req, tok) => req.set('Authorization', `Bearer ${tok}`);
  const stuckIds = async (tok) => {
    const res = await as(request(app).get('/admin/system-health/failures'), tok);
    expect(res.status).toBe(200);
    const data = res.body.data || res.body;
    return data.stuckEmails.map((r) => r.id).sort(byId);
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId: superId } = await seedMinimal(db);
    await assignAdminRole(db, superId, 'super_admin');
    superTok = mintAdminToken(superId);

    const opsRole = await insertRole('health_ops', ['system.view', 'system.manage', 'events.view']);
    opsId = await insertAdmin('health_ops_admin', opsRole);
    opsTok = mintAdminToken(opsId);
    otherId = await insertAdmin('health_other_admin', opsRole);

    clearPermissionCache();
    app = buildRouteApp('/admin/system-health', require('../../src/routes/adminSystemHealth'));
  }, 120000);
  afterAll(async () => { if (cleanup) await cleanup(); });

  it('lists an ops admin only the failed mail it may reach', async () => {
    const ownEvent = await insertEvent('ops-own', opsId);
    const otherEvent = await insertEvent('ops-other', otherId);
    const own = await insertFailed(ownEvent);
    const other = await insertFailed(otherEvent);
    const crm = await insertFailed(null);

    const opsSees = await stuckIds(opsTok);
    expect(opsSees).toContain(own);
    expect(opsSees).not.toContain(other);
    expect(opsSees).not.toContain(crm);
    expect(await stuckIds(superTok)).toEqual(expect.arrayContaining([own, other, crm]));
  });

  it('lists an ops admin only the waiting mail it may reach', async () => {
    const ownEvent = await insertEvent('wait-own', opsId);
    const otherEvent = await insertEvent('wait-other', otherId);
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const waiting = { status: 'pending', retry_count: 0, error_message: null, created_at: old, scheduled_at: old };
    const own = await insertFailed(ownEvent, waiting);
    const other = await insertFailed(otherEvent, waiting);

    const res = await as(request(app).get('/admin/system-health/failures'), opsTok);
    const ids = (res.body.data || res.body).waitingEmails.map((r) => r.id);
    expect(ids).toContain(own);
    expect(ids).not.toContain(other);
  });

  it('retries and dismisses mail of a gallery the admin may act on', async () => {
    const event = await insertEvent('act-own', opsId);
    const id = await insertFailed(event);
    const retry = await as(request(app).post(`/admin/system-health/failures/email/${id}/retry`), opsTok);
    expect(retry.status).toBe(200);
    expect((await db('email_queue').where({ id }).first()).status).toBe('pending');

    const dismiss = await as(request(app).delete(`/admin/system-health/failures/email/${id}`), opsTok);
    expect(dismiss.status).toBe(200);
    expect(await db('email_queue').where({ id }).first()).toBeUndefined();
  });

  it('answers 404 for another owner\'s gallery mail and for mail with no gallery', async () => {
    const otherEvent = await insertEvent('act-other', otherId);
    for (const id of [await insertFailed(otherEvent), await insertFailed(null)]) {
      const retry = await as(request(app).post(`/admin/system-health/failures/email/${id}/retry`), opsTok);
      expect(retry.status).toBe(404);
      const dismiss = await as(request(app).delete(`/admin/system-health/failures/email/${id}`), opsTok);
      expect(dismiss.status).toBe(404);
      const row = await db('email_queue').where({ id }).first();
      expect(row.status).toBe('failed');
      expect(Number(row.retry_count)).toBe(3);
    }
  });

  it('lets a Super Admin retry and dismiss any row', async () => {
    const otherEvent = await insertEvent('super-other', otherId);
    const id = await insertFailed(otherEvent);
    expect((await as(request(app).post(`/admin/system-health/failures/email/${id}/retry`), superTok)).status).toBe(200);
    expect((await as(request(app).delete(`/admin/system-health/failures/email/${id}`), superTok)).status).toBe(200);
    expect(await db('email_queue').where({ id }).first()).toBeUndefined();
  });
});
