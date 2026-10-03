/**
 * Notification bell — owner scope and the shared audit table.
 *
 * The bell reads activity_logs, the same table that carries contract audit
 * trails, customer timelines and every other admin's actions. A scoped role
 * (anything but super_admin / the roles that see all events) must only see,
 * count and mark rows on its own events — the scope the dashboard activity
 * feed already applies — and "Clear all" must never delete audit rows: it
 * marks the caller's visible rows read instead.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-notif-scope-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'notif-scope-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-notif-scope-storage-'));

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('../integration/helpers/crmDb');
const svc = require('../../src/services/userManagementService');
const { clearPermissionCache } = require('../../src/middleware/permissions');

describe('admin notifications — owner scope and audit retention', () => {
  let db; let cleanup; let app;
  let superId; let superTok; let scopedId; let scopedTok;
  let ownEventId; let foreignEventId;

  const auth = (req, tok) => req.set('Authorization', `Bearer ${tok}`);
  const insertId = async (table, row) => {
    const ins = await db(table).insert(row).returning('id');
    return ins[0]?.id ?? ins[0];
  };
  const mkEvent = (slug, createdBy) => insertId('events', {
    slug, event_type: 'wedding', event_name: `Event ${slug}`, event_date: '2026-08-01',
    host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
    share_link: `/gallery/${slug}/share`, share_token: `${slug}-share`,
    expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
    is_active: 1, is_archived: 0, is_draft: 0, created_by: createdBy,
    created_at: new Date().toISOString(),
  });
  const mkLog = (activity_type, event_id, metadata = {}) => insertId('activity_logs', {
    activity_type, actor_type: 'admin', actor_id: superId, actor_name: 'tester',
    metadata: JSON.stringify(metadata), event_id, created_at: new Date().toISOString(),
  });
  const unreadIds = async () => {
    const rows = await db('activity_logs').whereNull('read_at').select('id');
    return rows.map((r) => r.id).sort((a, b) => a - b);
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId: superId } = await seedMinimal(db));
    await assignAdminRole(db, superId, 'super_admin');
    superTok = mintAdminToken(superId);

    // A delegated bell manager: may read and manage notifications, sees only
    // its own events.
    const role = await svc.createRole(
      { name: 'bell_manager', permissions: ['notifications.view', 'notifications.manage'] },
      superId,
    );
    scopedId = await insertId('admin_users', {
      username: 'bell', email: 'bell@example.com', password_hash: 'x',
      role_id: role.id, must_change_password: false, created_at: new Date().toISOString(),
    });
    scopedTok = mintAdminToken(scopedId);
    clearPermissionCache();

    ownEventId = await mkEvent('own-ev', scopedId);
    foreignEventId = await mkEvent('foreign-ev', superId);

    app = buildRouteApp('/api/admin/notifications', require('../../src/routes/adminNotifications'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(async () => { await db('activity_logs').del(); });

  it('lists and counts only rows on the caller\'s own events', async () => {
    const own = await mkLog('photos_uploaded', ownEventId, { count: 3 });
    await mkLog('photos_uploaded', foreignEventId, { count: 5, originalFilename: 'private.jpg' });
    await mkLog('settings_updated', null, { type: 'branding' });

    const scoped = await auth(request(app).get('/api/admin/notifications'), scopedTok);
    expect(scoped.status).toBe(200);
    expect(scoped.body.notifications.map((n) => n.id)).toEqual([own]);
    expect(Number(scoped.body.unreadCount)).toBe(1);

    const sup = await auth(request(app).get('/api/admin/notifications'), superTok);
    expect(sup.status).toBe(200);
    expect(sup.body.notifications).toHaveLength(3);
    expect(Number(sup.body.unreadCount)).toBe(3);
  });

  it('does not mark a foreign row read', async () => {
    const foreign = await mkLog('photos_uploaded', foreignEventId);
    const res = await auth(request(app).put(`/api/admin/notifications/${foreign}/read`), scopedTok);
    expect(res.status).toBe(200);
    expect(await unreadIds()).toEqual([foreign]);

    const own = await mkLog('photos_uploaded', ownEventId);
    await auth(request(app).put(`/api/admin/notifications/${own}/read`), scopedTok).expect(200);
    expect(await unreadIds()).toEqual([foreign]);
  });

  it('read-all touches only the caller\'s visible rows', async () => {
    await mkLog('photos_uploaded', ownEventId);
    const foreign = await mkLog('photos_uploaded', foreignEventId);
    const system = await mkLog('settings_updated', null);

    await auth(request(app).put('/api/admin/notifications/read-all'), scopedTok).expect(200);
    expect(await unreadIds()).toEqual([foreign, system].sort((a, b) => a - b));
  });

  it('clear-all deletes no audit rows and only dismisses the caller\'s visible ones', async () => {
    await mkLog('photos_uploaded', ownEventId);
    const foreign = await mkLog('photos_uploaded', foreignEventId);
    const contractAudit = await mkLog('contract_signed', null, { contractId: 7 });
    const before = Number((await db('activity_logs').count('id as c').first()).c);

    const res = await auth(request(app).delete('/api/admin/notifications/clear-all'), scopedTok);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: expect.any(String), deletedCount: 1 });

    const after = Number((await db('activity_logs').count('id as c').first()).c);
    expect(after).toBe(before);
    expect(await unreadIds()).toEqual([foreign, contractAudit].sort((a, b) => a - b));

    const scoped = await auth(request(app).get('/api/admin/notifications'), scopedTok);
    expect(scoped.body.notifications).toEqual([]);
  });

  it('clear-all by a super_admin keeps every row as well', async () => {
    await mkLog('photos_uploaded', ownEventId);
    await mkLog('contract_signed', null, { contractId: 7 });
    const before = Number((await db('activity_logs').count('id as c').first()).c);

    const res = await auth(request(app).delete('/api/admin/notifications/clear-all'), superTok);
    expect(res.status).toBe(200);
    expect(res.body.deletedCount).toBe(2);
    expect(Number((await db('activity_logs').count('id as c').first()).c)).toBe(before);
    expect(await unreadIds()).toEqual([]);
  });
});
