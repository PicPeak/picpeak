/**
 * The notification bell sends timestamps a browser reads the same in every
 * timezone (issue 1815).
 *
 * activity_logs.created_at is filled by the column default. On SQLite that is
 * CURRENT_TIMESTAMP: UTC, written as 'YYYY-MM-DD HH:MM:SS' with no zone
 * marker. The route passed the string through, the browser parsed it as local
 * time, and in US Eastern every entry read "in about 4 hours".
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-notif-tz-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'notif-tz-test-secret';

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('../integration/helpers/crmDb');

describe('admin notifications — timestamps carry their zone', () => {
  let db; let cleanup; let app; let token;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId, 'super_admin');
    token = mintAdminToken(adminId);
    app = buildRouteApp('/api/admin/notifications', require('../../src/routes/adminNotifications'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(async () => { await db('activity_logs').del(); });

  const list = () => request(app).get('/api/admin/notifications?includeRead=true')
    .set('Authorization', `Bearer ${token}`);

  it('sends the column default (zone-less UTC) as an ISO string ending in Z', async () => {
    // No created_at: the database fills it, exactly as logActivity leaves it.
    await db('activity_logs').insert({ activity_type: 'gallery_viewed', actor_type: 'guest', actor_name: 'g' });
    const stored = (await db('activity_logs').first('created_at')).created_at;
    expect(String(stored)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    const res = await list();
    expect(res.status).toBe(200);
    const [entry] = res.body.notifications;
    expect(entry.createdAt).toBe(`${String(stored).replace(' ', 'T')}.000Z`);
    // A moment ago, not hours ahead: what the bell's "x ago" is computed from.
    expect(Math.abs(Date.now() - new Date(entry.createdAt).getTime())).toBeLessThan(60 * 1000);
  });

  it('normalises every stored shape, and leaves an unread row\'s readAt null', async () => {
    await db('activity_logs').insert([
      { activity_type: 'a', actor_type: 'admin', actor_name: 'naive', created_at: '2026-10-05 14:00:00' },
      { activity_type: 'b', actor_type: 'admin', actor_name: 'iso', created_at: '2026-10-05T14:00:00.000Z' },
      { activity_type: 'c', actor_type: 'admin', actor_name: 'ms', created_at: Date.UTC(2026, 9, 5, 14, 0, 0), read_at: Date.UTC(2026, 9, 5, 15, 0, 0) },
    ]);
    const res = await list();
    const byActor = Object.fromEntries(res.body.notifications.map((n) => [n.actorName, n]));
    for (const actor of ['naive', 'iso', 'ms']) {
      expect(byActor[actor].createdAt).toBe('2026-10-05T14:00:00.000Z');
    }
    expect(byActor.ms.readAt).toBe('2026-10-05T15:00:00.000Z');
    expect(byActor.ms.isRead).toBe(true);
    expect(byActor.naive.readAt).toBeNull();
    expect(byActor.naive.isRead).toBe(false);
  });
});
