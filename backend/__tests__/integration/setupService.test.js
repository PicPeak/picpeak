'use strict';

// First-run bootstrap service. bootCrmDb() must run BEFORE requiring the service
// so setupService shares this test's db instance (see crmDb.js note).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { bootCrmDb, buildRouteApp } = require('./helpers/crmDb');

let db;
let cleanup;
let tmpDir;
let setupService;
let getAppSetting;
let upsertAppSetting;
let app;

const VALID_PW = 'Str0ng-Passw0rd!';

// bootCrmDb MUST run before any require of db.js (directly or transitively via a
// service/util), or db.js binds to the default path instead of the temp one.
beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.env.DATA_DIR = tmpDir; // isolate the SETUP_TOKEN file to the temp dir
  setupService = require('../../src/services/setupService');
  ({ getAppSetting, upsertAppSetting } = require('../../src/utils/appSettings'));
  app = buildRouteApp('/api/setup', require('../../src/routes/setup'));
}, 60000);

afterAll(async () => {
  await cleanup();
});

beforeEach(async () => {
  await db('admin_users').del();
  await db('app_settings').where({ setting_key: 'setup_token' }).del();
});

describe('setupService (first-run bootstrap)', () => {
  it('reports needsAdmin while no admin exists', async () => {
    expect(await setupService.getSetupStatus()).toEqual({ needsAdmin: true, complete: false });
  });

  it('generates and persists a one-time token while no admin exists', async () => {
    const token = await setupService.ensureSetupToken();
    expect(token).toEqual(expect.any(String));
    expect(token.length).toBeGreaterThan(20);
    expect(await getAppSetting('setup_token')).toBe(token);
    // Idempotent — a second call returns the same token, not a fresh one.
    expect(await setupService.ensureSetupToken()).toBe(token);
  });

  it('stores the token as valid JSON so the Postgres jsonb column accepts it', async () => {
    // Regression guard for the SQLite-only miss: a bare token string is rejected
    // by Postgres jsonb ("invalid input syntax for type json"). The raw column
    // value must be JSON-parseable and round-trip back to the token.
    const token = await setupService.ensureSetupToken();
    const row = await db('app_settings').where({ setting_key: 'setup_token' }).first();
    expect(() => JSON.parse(row.setting_value)).not.toThrow();
    expect(JSON.parse(row.setting_value)).toBe(token);
  });

  it('rejects a wrong token', async () => {
    await setupService.ensureSetupToken();
    await expect(
      setupService.createInitialAdmin({ token: 'nope', email: 'a@b.co', password: VALID_PW })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await setupService.getSetupStatus()).toEqual({ needsAdmin: true, complete: false });
  });

  it('rejects a weak password', async () => {
    const token = await setupService.ensureSetupToken();
    await expect(
      setupService.createInitialAdmin({ token, email: 'a@b.co', password: 'weak' })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('creates the first admin as super_admin, issues a token, and burns the setup token', async () => {
    const token = await setupService.ensureSetupToken();
    const result = await setupService.createInitialAdmin({
      token, email: 'Owner@Example.com', password: VALID_PW, ip: '203.0.113.7',
    });

    expect(result.user.email).toBe('owner@example.com'); // normalised
    expect(result.user.role.name).toBe('super_admin');
    expect(result.token).toEqual(expect.any(String));

    const row = await db('admin_users').first();
    const role = await db('roles').where({ name: 'super_admin' }).first();
    expect(row.role_id).toBe(role.id);
    expect(row.password_hash).not.toBe(VALID_PW); // hashed

    // One-time: token burned, status now complete.
    expect(await getAppSetting('setup_token')).toBeFalsy();
    expect(await setupService.getSetupStatus()).toEqual({ needsAdmin: false, complete: true });
  });

  it('writes the SETUP_TOKEN file while pending and removes it once setup completes', async () => {
    const tokenFile = path.join(tmpDir, 'SETUP_TOKEN');
    const token = await setupService.ensureSetupToken();
    expect(fs.readFileSync(tokenFile, 'utf8').trim()).toBe(token);
    await setupService.createInitialAdmin({ token, email: 'owner@example.com', password: VALID_PW });
    expect(fs.existsSync(tokenFile)).toBe(false); // burned in DB + file removed
  });

  it('refuses to create a second admin (setup already complete)', async () => {
    const token = await setupService.ensureSetupToken();
    await setupService.createInitialAdmin({ token, email: 'first@example.com', password: VALID_PW });
    await expect(
      setupService.createInitialAdmin({ token, email: 'second@example.com', password: VALID_PW })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('serialises a double-submit — two concurrent valid-token calls create only one admin', async () => {
    const token = await setupService.ensureSetupToken();
    const results = await Promise.allSettled([
      setupService.createInitialAdmin({ token, email: 'a@example.com', password: VALID_PW }),
      setupService.createInitialAdmin({ token, email: 'b@example.com', password: VALID_PW }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1); // the atomic token claim lets exactly one win
    const count = await db('admin_users').count({ c: '*' }).first();
    expect(Number(count.c)).toBe(1);
  });

  it('ensureSetupToken clears any stale token once an admin exists', async () => {
    const token = await setupService.ensureSetupToken();
    await setupService.createInitialAdmin({ token, email: 'first@example.com', password: VALID_PW });
    // Simulate a stale token left in settings, then re-run the boot hook.
    await upsertAppSetting('setup_token', JSON.stringify('stale'), 'string');
    expect(await setupService.ensureSetupToken()).toBeNull();
    expect(await getAppSetting('setup_token')).toBeFalsy();
  });
});

describe('setup routes', () => {
  it('GET /api/setup/status reports needsAdmin', async () => {
    const res = await request(app).get('/api/setup/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ needsAdmin: true, complete: false });
  });

  it('POST /api/setup/verify-token accepts the right token without burning it (200)', async () => {
    const token = await setupService.ensureSetupToken();
    const res = await request(app).post('/api/setup/verify-token').send({ token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: true });
    // Token is NOT consumed — it still works for the actual create.
    expect(await getAppSetting('setup_token')).toBe(token);
  });

  it('POST /api/setup/verify-token rejects a wrong token (400, field token)', async () => {
    await setupService.ensureSetupToken();
    const res = await request(app).post('/api/setup/verify-token').send({ token: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('token');
  });

  it('POST /api/setup/verify-token is closed once an admin exists (409)', async () => {
    const token = await setupService.ensureSetupToken();
    await setupService.createInitialAdmin({ token, email: 'first@example.com', password: VALID_PW });
    const res = await request(app).post('/api/setup/verify-token').send({ token });
    expect(res.status).toBe(409);
  });

  it('POST /api/setup/admin rejects a wrong token (400)', async () => {
    await setupService.ensureSetupToken();
    const res = await request(app)
      .post('/api/setup/admin')
      .send({ token: 'nope', email: 'a@b.co', password: VALID_PW });
    expect(res.status).toBe(400);
    expect(await setupService.getSetupStatus()).toMatchObject({ needsAdmin: true });
  });

  it('POST /api/setup/admin creates the first admin + sets the auth cookie (201)', async () => {
    const token = await setupService.ensureSetupToken();
    const res = await request(app)
      .post('/api/setup/admin')
      .send({ token, email: 'owner@example.com', password: VALID_PW });
    expect(res.status).toBe(201);
    expect(res.body.user.role.name).toBe('super_admin');
    expect((res.headers['set-cookie'] || []).join(';')).toMatch(/admin_token/);
    expect(await setupService.getSetupStatus()).toEqual({ needsAdmin: false, complete: true });
  });

  it('POST /api/setup/admin is closed once an admin exists (409)', async () => {
    const token = await setupService.ensureSetupToken();
    await setupService.createInitialAdmin({ token, email: 'first@example.com', password: VALID_PW });
    const res = await request(app)
      .post('/api/setup/admin')
      .send({ token, email: 'second@example.com', password: VALID_PW });
    expect(res.status).toBe(409);
  });
});
