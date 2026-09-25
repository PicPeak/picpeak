'use strict';

// Completing the setup wizard permanently protects the seeded system event
// types, so it is a setup-class action: a super_admin may do it, a viewer or
// editor who logs in later may not.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

const request = require('supertest');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp } = require('../integration/helpers/crmDb');

let db, cleanup, app, superId, viewerId, getAppSetting;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId: superId } = await seedMinimal(db));
  await assignAdminRole(db, superId);
  const [row] = await db('admin_users').insert({ username: 'viewer', email: 'viewer@example.test', password_hash: 'unused', is_active: 1 }).returning('id');
  viewerId = row.id ?? row;
  await assignAdminRole(db, viewerId, 'viewer');
  ({ getAppSetting } = require('../../src/utils/appSettings'));
  app = buildRouteApp('/api/setup', require('../../src/routes/setup'));
}, 120000);

afterAll(async () => { if (cleanup) await cleanup(); });

const complete = (adminId) => request(app).post('/api/setup/complete').set('Authorization', `Bearer ${mintAdminToken(adminId)}`);

test('a viewer cannot mark the wizard complete', async () => {
  const res = await complete(viewerId);
  expect(res.status).toBe(403);
  expect(await getAppSetting('setup_wizard_completed', null)).toBeFalsy();
});

test('a super_admin still completes it', async () => {
  const res = await complete(superId);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ completed: true });
});
