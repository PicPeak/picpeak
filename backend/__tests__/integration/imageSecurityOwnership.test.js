const request = require('supertest');
const knex = require('knex');
const { randomUUID } = require('crypto');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp } = require('./helpers/crmDb');

let db; let cleanup; let app; let superId; let actorId; let owner; let schema;
const events = {};
const pgUrl = process.env.PICPEAK_PG_TEST_URL;
beforeAll(async () => {
  if (pgUrl) {
    schema = `image_security_${randomUUID().replace(/-/g, '')}`;
    owner = knex({ client: 'pg', connection: pgUrl });
    await owner.schema.createSchema(schema);
    process.env.DATABASE_CLIENT = 'pg';
    jest.doMock('../../knexfile', () => ({ client: 'pg', connection: pgUrl, searchPath: [schema] }));
  }
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId: superId } = await seedMinimal(db));
  await assignAdminRole(db, superId);
  const role = await require('../../src/services/userManagementService').createRole({
    name: 'image_monitor', permissions: ['image_security.view']
  }, superId);
  const [actor] = await db('admin_users').insert({ username: 'monitor', email: 'monitor@example.test',
    password_hash: 'unused', role_id: role.id, is_active: true, must_change_password: false }).returning('id');
  actorId = actor.id ?? actor;
  for (const [name, createdBy] of [['own', actorId], ['foreign', superId], ['legacy', null]]) {
    const [event] = await db('events').insert({ slug: name, event_type: 'wedding', event_name: name,
      event_date: '2026-09-16', host_email: 'h@example.test', admin_email: 'a@example.test',
      password_hash: 'unused', share_link: `/gallery/${name}/share`, created_by: createdBy }).returning('id');
    const eventId = event.id ?? event; events[name] = eventId;
    const [photo] = await db('photos').insert({ event_id: eventId, filename: `${name}.jpg`,
      original_filename: `${name}.jpg`, path: `${name}.jpg`, type: 'individual', mime_type: 'image/jpeg' }).returning('id');
    await db('image_access_logs').insert({ event_id: eventId, photo_id: photo.id ?? photo,
      client_ip: '192.0.2.1', client_fingerprint: name, user_agent: name, access_type: 'view',
      metadata: JSON.stringify({ fixture: name }), accessed_at: new Date().toISOString() });
  }
  await db('security_logs').insert({ event_type: 'suspicious_activity', client_ip: '192.0.2.99',
    details: JSON.stringify({ private: 'GLOBAL INCIDENT' }), timestamp: new Date().toISOString() });
  require('../../src/middleware/permissions').clearPermissionCache();
  app = buildRouteApp('/security', require('../../src/routes/adminImageSecurity'));
});
afterAll(async () => {
  if (cleanup) await cleanup();
  if (owner) { await owner.schema.dropSchema(schema, true); await owner.destroy(); }
});
const get = (path, id = actorId) => request(app).get(`/security${path}`)
  .set('Authorization', `Bearer ${mintAdminToken(id)}`);

test('foreign event logs are forbidden while owned and ownerless event logs work', async () => {
  await get(`/events/${events.foreign}/access-logs`).expect(403);
  for (const name of ['own', 'legacy']) {
    const res = await get(`/events/${events[name]}/access-logs`).expect(200);
    expect(res.body.logs.map(row => row.filename)).toEqual([`${name}.jpg`]);
    expect(res.body.logs[0].metadata).toEqual({ fixture: name });
  }
});
test('dashboard aggregates, photo names, and visitor counts use the same ownership scope', async () => {
  const res = await get('/dashboard').expect(200);
  expect(res.body.summary).toEqual({ totalAccess: 2, uniqueVisitors: 2, totalSecurityEvents: 0, suspiciousIPsCount: 0 });
  expect(res.body.topPhotos.map(p => p.filename).sort()).toEqual(['legacy.jpg', 'own.jpg']);
  expect(res.body.middlewareStatus).toBeNull();
  expect(res.body.suspiciousIPs).toEqual([]);
});
test('global logs and their pagination do not disclose incidents to scoped users', async () => {
  const res = await get('/logs').expect(200);
  expect(res.body.logs).toEqual([]);
  expect(res.body.pagination.total).toBe(0);
});
test('JSON and CSV exports omit foreign and system records', async () => {
  const res = await get('/export').expect(200);
  expect(res.body.accessLogs.map(row => row.event_id).sort()).toEqual([events.own, events.legacy].sort());
  expect(res.body.securityLogs).toEqual([]);
  const csv = await get('/export?format=csv').expect(200);
  expect(csv.text).not.toContain('GLOBAL INCIDENT');
  expect(csv.text).not.toContain('192.0.2.99');
});
test('super admins retain the global dashboard, logs, and exports on both database formats', async () => {
  const dashboard = await get('/dashboard', superId).expect(200);
  expect(dashboard.body.summary.totalAccess).toBe(3);
  expect(dashboard.body.summary.totalSecurityEvents).toBe(1);
  const logs = await get('/logs', superId).expect(200);
  expect(logs.body.logs[0].details).toEqual({ private: 'GLOBAL INCIDENT' });
  const exported = await get('/export', superId).expect(200);
  expect(exported.body.accessLogs).toHaveLength(3);
  expect(exported.body.securityLogs).toHaveLength(1);
});
