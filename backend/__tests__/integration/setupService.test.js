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
}, 120000);

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

  it('restores 0600 on a token file that already existed with looser permissions (#1218)', async () => {
    // fs.writeFileSync's `mode` applies only when the file is created, so
    // writing over a 0644 file left the first-admin credential group- and
    // world-readable while the code claimed otherwise. On a NAS the volume is
    // often a shared mount, which is exactly where that matters.
    const canonical = path.join(tmpDir, 'SETUP_TOKEN');
    fs.writeFileSync(canonical, 'stale\n', { mode: 0o644 });
    fs.chmodSync(canonical, 0o644);
    expect(fs.statSync(canonical).mode & 0o777).toBe(0o644);

    const token = await setupService.ensureSetupToken();

    expect(fs.readFileSync(canonical, 'utf8').trim()).toBe(token);
    expect(fs.statSync(canonical).mode & 0o777).toBe(0o600);
  });

  it('never publishes a token it cannot make private (#1218)', async () => {
    // The CIFS/SMB case this targets: the mount carries no Unix modes, so
    // chmod is a silent no-op. The check runs on the temporary file, before
    // the rename, so a credential that cannot be protected never reaches the
    // published path at all.
    const canonical = path.join(tmpDir, 'SETUP_TOKEN');
    try { fs.unlinkSync(canonical); } catch (_) { /* start clean */ }
    const chmodSpy = jest.spyOn(fs, 'chmodSync').mockImplementation(() => {});
    const realLstat = fs.lstatSync;
    const lstatSpy = jest.spyOn(fs, 'lstatSync').mockImplementation((target, ...rest) => {
      const st = realLstat(target, ...rest);
      return String(target).includes('SETUP_TOKEN')
        ? { ...st, mode: (st.mode & ~0o777) | 0o644 }
        : st;
    });

    try {
      const token = await setupService.ensureSetupToken();
      // Setup stays completable — server.js prints the token on stdout when no
      // file was written — but nothing readable was left on the volume.
      expect(token).toBeTruthy();
      expect(fs.existsSync(canonical)).toBe(false);
      expect(fs.readdirSync(tmpDir).filter((f) => f.includes('.tmp'))).toEqual([]);
    } finally {
      chmodSpy.mockRestore();
      lstatSpy.mockRestore();
    }
  });

  it('keeps the token out of the log files when no private copy is possible (#1218)', async () => {
    // LOG_DIR is on the same mount as the token in the all-in-one image, so
    // logging the credential would put it in combined.log — as readable as the
    // file we just refused to leave, and it outlives setup. stdout is the
    // fallback instead, which server.js prints.
    const logger = require('../../src/utils/logger');
    try { fs.unlinkSync(path.join(tmpDir, 'SETUP_TOKEN')); } catch (_) { /* start clean */ }
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const chmodSpy = jest.spyOn(fs, 'chmodSync').mockImplementation(() => {});
    const realStat = fs.lstatSync;
    const statSpy = jest.spyOn(fs, 'lstatSync').mockImplementation((target, ...rest) => {
      const st = realStat(target, ...rest);
      // The mode check runs on the temporary file, so match the prefix.
      return String(target).includes('SETUP_TOKEN')
        ? { ...st, mode: (st.mode & ~0o777) | 0o644 }
        : st;
    });

    try {
      const token = await setupService.ensureSetupToken();
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toMatch(/could not write a private setup token file/i);
      expect(logged).not.toContain(token);
    } finally {
      warnSpy.mockRestore();
      chmodSpy.mockRestore();
      statSpy.mockRestore();
    }
  });

  it('tells the startup banner where the token went, so it is never printed (#1218)', async () => {
    // server.js prints the token itself only when no file was written. If this
    // reports nothing after a successful write, the banner takes that failure
    // branch and puts the live credential into stdout and `docker logs` beside
    // a perfectly good 0600 file.
    const token = await setupService.ensureSetupToken();
    expect(token).toBeTruthy();

    expect(setupService.writtenSetupTokenFile()).toBe(path.join(tmpDir, 'SETUP_TOKEN'));
  });

  it('lets a second worker publish without disturbing the first (#1218)', async () => {
    // The shipped PM2 cluster config runs several workers against one DATA_DIR.
    // Publishing through rename means they simply overwrite the same value in
    // turn — no shared inode to race, and neither worker can end up reporting
    // nothing written and printing the live token to its own log.
    const canonical = path.join(tmpDir, 'SETUP_TOKEN');
    const first = await setupService.ensureSetupToken();
    expect(setupService.writtenSetupTokenFile()).toBe(canonical);

    const second = await setupService.ensureSetupToken();

    expect(second).toBe(first);
    expect(setupService.writtenSetupTokenFile()).toBe(canonical);
    expect(fs.readFileSync(canonical, 'utf8').trim()).toBe(first);
    expect(fs.statSync(canonical).mode & 0o777).toBe(0o600);
    // No temporary files left lying about.
    expect(fs.readdirSync(tmpDir).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('revokes the token when it cannot replace an exposed file (#1218)', async () => {
    // A restart reuses the token from the database, so a file left at the
    // token path may hold the live value. If it cannot be replaced — an
    // ACL-backed or read-only directory — that credential is out of our
    // control, and /setup/admin would go on accepting it.
    const canonical = path.join(tmpDir, 'SETUP_TOKEN');
    await setupService.ensureSetupToken();

    const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation(() => {
      const err = new Error('EACCES'); err.code = 'EACCES'; throw err;
    });
    try {
      expect(await setupService.ensureSetupToken()).toBeNull();
      expect(await getAppSetting('setup_token')).toBeFalsy();
      // And the temporary file did not survive the failure.
      expect(fs.readdirSync(tmpDir).filter((f) => f.includes('.tmp'))).toEqual([]);
    } finally {
      renameSpy.mockRestore();
      try { fs.unlinkSync(canonical); } catch (_) { /* may be gone */ }
    }
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
