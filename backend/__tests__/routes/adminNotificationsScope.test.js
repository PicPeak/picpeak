/**
 * Notification bell — owner scope and the shared audit table.
 *
 * The bell reads activity_logs, the same table that carries contract audit
 * trails, customer timelines and every other admin's actions. A scoped role
 * (anything but super_admin / the roles that see all events) must only see,
 * count and mark rows on its own events — the scope the dashboard activity
 * feed already applies — and "Clear all" must never delete audit rows: it
 * records per-admin dismissals (notification_dismissals) instead, which hide
 * the rows from that admin's bell and nothing else.
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

  beforeEach(async () => {
    await db('notification_dismissals').del();
    await db('activity_logs').del();
  });

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
    const own = await mkLog('photos_uploaded', ownEventId);
    const ownRead = await mkLog('photos_uploaded', ownEventId);
    await db('activity_logs').where({ id: ownRead }).update({ read_at: new Date().toISOString() });
    const foreign = await mkLog('photos_uploaded', foreignEventId);
    const contractAudit = await mkLog('contract_signed', null, { contractId: 7 });
    const before = Number((await db('activity_logs').count('id as c').first()).c);

    const res = await auth(request(app).delete('/api/admin/notifications/clear-all'), scopedTok);
    expect(res.status).toBe(200);
    // Read or unread, every visible row is dismissed; nothing else is.
    expect(res.body).toEqual({ message: expect.any(String), deletedCount: 2 });

    const after = Number((await db('activity_logs').count('id as c').first()).c);
    expect(after).toBe(before);
    // read_at is not what clearing writes.
    expect(await unreadIds()).toEqual([own, foreign, contractAudit].sort((a, b) => a - b));
    const dismissed = await db('notification_dismissals').where({ admin_id: scopedId }).pluck('activity_log_id');
    expect(Array.from(dismissed).sort((a, b) => a - b)).toEqual([own, ownRead]);

    // Gone from the caller's bell, including the includeRead view and the count …
    const scoped = await auth(request(app).get('/api/admin/notifications?includeRead=true'), scopedTok);
    expect(scoped.body.notifications).toEqual([]);
    expect(Number(scoped.body.unreadCount)).toBe(0);
    // … and still in the super_admin's.
    const sup = await auth(request(app).get('/api/admin/notifications'), superTok);
    expect(sup.body.notifications.map((n) => n.id).sort((a, b) => a - b))
      .toEqual([own, foreign, contractAudit].sort((a, b) => a - b));
    expect(Number(sup.body.unreadCount)).toBe(3);

    // A second clear has nothing left to dismiss.
    const again = await auth(request(app).delete('/api/admin/notifications/clear-all'), scopedTok);
    expect(again.body.deletedCount).toBe(0);
  });

  it('reports what the statement wrote: a row dismissed meanwhile is not counted twice', async () => {
    const a = await mkLog('photos_uploaded', ownEventId);
    await mkLog('photos_uploaded', ownEventId);
    // Another tab of the same admin has already dismissed one of the two.
    await db('notification_dismissals').insert({ admin_id: scopedId, activity_log_id: a, dismissed_at: new Date().toISOString() });
    const res = await auth(request(app).delete('/api/admin/notifications/clear-all'), scopedTok);
    expect(res.body.deletedCount).toBe(1);
  });

  it('a dismissal is bound to the admin and to the row', async () => {
    const own = await mkLog('photos_uploaded', ownEventId);
    await auth(request(app).delete('/api/admin/notifications/clear-all'), scopedTok).expect(200);
    expect(Number((await db('notification_dismissals').where({ activity_log_id: own }).count('id as c').first()).c)).toBe(1);

    // A new row after clearing shows up again.
    const later = await mkLog('photos_uploaded', ownEventId);
    const scoped = await auth(request(app).get('/api/admin/notifications'), scopedTok);
    expect(scoped.body.notifications.map((n) => n.id)).toEqual([later]);
  });

  it('read-all leaves the rows the caller dismissed alone', async () => {
    const dismissed = await mkLog('photos_uploaded', ownEventId);
    await auth(request(app).delete('/api/admin/notifications/clear-all'), scopedTok).expect(200);
    const fresh = await mkLog('photos_uploaded', ownEventId);

    await auth(request(app).put('/api/admin/notifications/read-all'), scopedTok).expect(200);
    // read_at is shared with every other admin's bell; only what this
    // caller could see is marked.
    expect(await unreadIds()).toEqual([dismissed]);
    expect(fresh).toBeGreaterThan(dismissed);
  });

  it('marking a single dismissed row read does nothing', async () => {
    const dismissed = await mkLog('photos_uploaded', ownEventId);
    await auth(request(app).delete('/api/admin/notifications/clear-all'), scopedTok).expect(200);
    await auth(request(app).put(`/api/admin/notifications/${dismissed}/read`), scopedTok).expect(200);
    expect(await unreadIds()).toEqual([dismissed]);
  });

  it('a download summary that grows again reappears for an admin who had cleared it', async () => {
    const { recordSingleDownload, SUMMARY_TYPE } = require('../../src/services/apiDownloadNotifications');
    const summary = await insertId('activity_logs', {
      activity_type: SUMMARY_TYPE, actor_type: 'system', actor_id: null, actor_name: 'api',
      metadata: JSON.stringify({ via: 'api_v1', token_id: 77, token_name: 't', count: 1, window_started_at: Date.now() }),
      event_id: ownEventId, created_at: new Date().toISOString(),
    });
    await auth(request(app).delete('/api/admin/notifications/clear-all'), scopedTok).expect(200);
    expect(Number((await db('notification_dismissals').where({ activity_log_id: summary }).count('id as c').first()).c)).toBe(1);

    await recordSingleDownload({ tokenId: 77, tokenName: 't', eventId: ownEventId, actor: { type: 'system' } });

    const row = await db('activity_logs').where({ id: summary }).first();
    expect(JSON.parse(row.metadata).count).toBe(2);
    expect(Number((await db('notification_dismissals').where({ activity_log_id: summary }).count('id as c').first()).c)).toBe(0);
    const scoped = await auth(request(app).get('/api/admin/notifications'), scopedTok);
    expect(scoped.body.notifications.map((n) => n.id)).toEqual([summary]);
  });

  it('clear-all dismisses more than one chunk in one go', async () => {
    const ids = [];
    for (let i = 0; i < 503; i += 1) ids.push(await mkLog('photos_uploaded', ownEventId));
    const res = await auth(request(app).delete('/api/admin/notifications/clear-all'), scopedTok);
    expect(res.body.deletedCount).toBe(503);
    expect(Number((await db('notification_dismissals').where({ admin_id: scopedId }).count('id as c').first()).c)).toBe(503);
  });

  it('clear-all by a super_admin keeps every row and every read_at as well', async () => {
    await mkLog('photos_uploaded', ownEventId);
    await mkLog('contract_signed', null, { contractId: 7 });
    const before = Number((await db('activity_logs').count('id as c').first()).c);

    const res = await auth(request(app).delete('/api/admin/notifications/clear-all'), superTok);
    expect(res.status).toBe(200);
    expect(res.body.deletedCount).toBe(2);
    expect(Number((await db('activity_logs').count('id as c').first()).c)).toBe(before);
    expect((await unreadIds()).length).toBe(2);
    const sup = await auth(request(app).get('/api/admin/notifications?includeRead=true'), superTok);
    expect(sup.body.notifications).toEqual([]);
  });

  describe('cleanup without PRAGMA foreign_keys (SQLite)', () => {
    // The FKs cascade on PostgreSQL only; these paths delete explicitly.
    it('deleting an event removes the dismissals of its audit rows', async () => {
      const victimEvent = await mkEvent('victim-ev', scopedId);
      const row = await mkLog('photos_uploaded', victimEvent);
      await auth(request(app).delete('/api/admin/notifications/clear-all'), scopedTok).expect(200);
      expect(Number((await db('notification_dismissals').where({ activity_log_id: row }).count('id as c').first()).c)).toBe(1);

      const { deleteEventCascade } = require('../../src/routes/adminEvents/helpers');
      await deleteEventCascade(victimEvent, { type: 'admin', id: superId, name: 'tester' });

      expect(Number((await db('notification_dismissals').where({ activity_log_id: row }).count('id as c').first()).c)).toBe(0);
    });

    it('deleting an admin removes the dismissals they recorded', async () => {
      // A disposable admin with the same role, so the scoped one survives
      // for the other tests.
      const role = await db('roles').where({ name: 'bell_manager' }).first();
      const goneId = await insertId('admin_users', {
        username: 'bell-gone', email: 'bell-gone@example.com', password_hash: 'x',
        role_id: role.id, must_change_password: false, created_at: new Date().toISOString(),
      });
      await db('notification_dismissals').insert({
        admin_id: goneId, activity_log_id: await mkLog('photos_uploaded', ownEventId), dismissed_at: new Date().toISOString(),
      });

      await svc.deleteAdminUser(goneId, superId);

      expect(Number((await db('notification_dismissals').where({ admin_id: goneId }).count('id as c').first()).c)).toBe(0);
    });

    it('keeps the dismissals when the account delete itself is refused', async () => {
      const role = await db('roles').where({ name: 'bell_manager' }).first();
      const stayId = await insertId('admin_users', {
        username: 'bell-stays', email: 'bell-stays@example.com', password_hash: 'x',
        role_id: role.id, must_change_password: false, created_at: new Date().toISOString(),
      });
      await db('notification_dismissals').insert({
        admin_id: stayId, activity_log_id: await mkLog('photos_uploaded', ownEventId), dismissed_at: new Date().toISOString(),
      });
      // The account delete fails after the dismissal cleanup ran (the table is
      // out of reach for exactly that statement): both roll back together.
      const realQuery = Object.getPrototypeOf(db.client).query;
      let armed = true;
      Object.getPrototypeOf(db.client).query = async function (conn, obj) {
        if (armed && /^delete from .admin_users./i.test(obj.sql || '')) {
          armed = false;
          throw new Error('still referenced');
        }
        return realQuery.call(this, conn, obj);
      };
      try {
        await expect(svc.deleteAdminUser(stayId, superId)).rejects.toThrow('still referenced');
      } finally {
        Object.getPrototypeOf(db.client).query = realQuery;
      }
      expect(Number((await db('notification_dismissals').where({ admin_id: stayId }).count('id as c').first()).c)).toBe(1);
      expect(await db('admin_users').where({ id: stayId }).first()).toBeTruthy();
    });
  });
});
