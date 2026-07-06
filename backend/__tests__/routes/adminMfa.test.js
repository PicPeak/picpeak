/**
 * HTTP-level tests for the admin TOTP MFA feature (#738).
 *
 * Two surfaces:
 *   1. Enrollment (adminAuth-gated) — POST /mfa/setup, /mfa/enable,
 *      GET /mfa/status, POST /mfa/disable — mounted like server.js at
 *      /api/admin/auth (src/routes/adminAuth.js).
 *   2. Login challenge — POST /admin/login + POST /admin/login/mfa
 *      (src/routes/auth.js, mounted /api/auth).
 *
 * Uses the same real-SQLite harness as the CRM route tests
 * (bootCrmDb + seedMinimal + mintAdminToken). Valid TOTP codes are
 * generated in-test via otplib's authenticator against the secret the
 * /setup endpoint returns in plaintext.
 *
 * NOTE: env (TEST_DATABASE_PATH / JWT_SECRET) must be set BEFORE the
 * first require of db.js — mirror adminCrmAuth.test.js exactly.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-adminmfa-test-'));
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'db.sqlite');
process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
fs.mkdirSync(process.env.STORAGE_PATH, { recursive: true });
process.env.JWT_SECRET = process.env.JWT_SECRET || 'mfa-route-test-secret';
// reCAPTCHA disabled (default) → verifyRecaptcha returns true, so login
// tests don't need a token. Be explicit so a leaked env can't flip it on.
delete process.env.RECAPTCHA_SECRET_KEY;

const request = require('supertest');
const bcrypt = require('bcrypt');
const { authenticator } = require('otplib');

const {
  bootCrmDb, mintAdminToken, buildRouteApp,
} = require('../integration/helpers/crmDb');

jest.setTimeout(60000);

let db;
let cleanup;
let adminApp; // /api/admin/auth  (enrollment)
let authApp; // /api/auth        (login challenge)

/**
 * Seed a bare admin (password known) and return its id + login creds.
 * seedMinimal always creates username 'tester'; we need distinct rows per
 * scenario, so insert directly with a unique username/email.
 */
async function seedAdmin({ username, superAdmin = false } = {}) {
  const password = 'correct-horse';
  const passwordHash = await bcrypt.hash(password, 4);
  const uname = username || `admin-${Math.random().toString(36).slice(2, 8)}`;
  const row = {
    username: uname,
    email: `${uname}@example.com`,
    password_hash: passwordHash,
    must_change_password: false,
    is_active: true,
    created_at: new Date(),
  };
  if (superAdmin) {
    const role = await db('roles').where({ name: 'super_admin' }).first();
    if (!role) throw new Error('super_admin role not seeded');
    row.role_id = role.id;
  }
  const inserted = await db('admin_users').insert(row).returning('id');
  const id = inserted[0]?.id ?? inserted[0];
  return { id, username: uname, password };
}

/** Run the full setup→enable enrollment against the live app. Returns
 * the plaintext TOTP secret (for later login codes) and recovery codes. */
async function enroll(adminId) {
  const token = mintAdminToken(adminId);
  const setup = await request(adminApp)
    .post('/api/admin/auth/mfa/setup')
    .set('Authorization', `Bearer ${token}`);
  expect(setup.status).toBe(200);
  const secret = setup.body.secret;

  const enable = await request(adminApp)
    .post('/api/admin/auth/mfa/enable')
    .set('Authorization', `Bearer ${token}`)
    .send({ code: authenticator.generate(secret) });
  expect(enable.status).toBe(200);
  return { secret, recoveryCodes: enable.body.recoveryCodes, token };
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  adminApp = buildRouteApp('/api/admin/auth', require('../../src/routes/adminAuth'));
  authApp = buildRouteApp('/api/auth', require('../../src/routes/auth'));
}, 60000);

afterAll(async () => {
  if (cleanup) await cleanup();
});

describe('MFA enrollment — /api/admin/auth/mfa/*', () => {
  it('setup returns a secret + otpauth URI + QR and does NOT enable yet', async () => {
    const admin = await seedAdmin();
    const token = mintAdminToken(admin.id);

    const res = await request(adminApp)
      .post('/api/admin/auth/mfa/setup')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.secret).toEqual(expect.any(String));
    expect(res.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(res.body.qr).toMatch(/^data:image\/png;base64,/);

    // Not yet enabled: status must still report disabled.
    const status = await request(adminApp)
      .get('/api/admin/auth/mfa/status')
      .set('Authorization', `Bearer ${token}`);
    expect(status.body.enabled).toBe(false);

    // And the row stores an encrypted secret (not the plaintext one).
    const row = await db('admin_users').where({ id: admin.id }).first();
    expect(row.two_factor_secret).toBeTruthy();
    expect(row.two_factor_secret).not.toBe(res.body.secret);
    expect(Number(row.two_factor_enabled)).toBe(0);
  });

  it('full flow: setup → enable(valid TOTP) → status shows enabled + 10 recovery codes', async () => {
    const admin = await seedAdmin();
    const { recoveryCodes, token } = await enroll(admin.id);

    expect(Array.isArray(recoveryCodes)).toBe(true);
    expect(recoveryCodes).toHaveLength(10);

    const status = await request(adminApp)
      .get('/api/admin/auth/mfa/status')
      .set('Authorization', `Bearer ${token}`);
    expect(status.status).toBe(200);
    expect(status.body.enabled).toBe(true);
    expect(status.body.recoveryCodesRemaining).toBe(10);
    expect(status.body.enrolledAt).toBeTruthy();
  });

  it('enable with a WRONG code is rejected (400) and MFA stays off', async () => {
    const admin = await seedAdmin();
    const token = mintAdminToken(admin.id);
    const setup = await request(adminApp)
      .post('/api/admin/auth/mfa/setup')
      .set('Authorization', `Bearer ${token}`);
    const valid = authenticator.generate(setup.body.secret);
    const wrong = valid === '000000' ? '111111' : '000000';

    const res = await request(adminApp)
      .post('/api/admin/auth/mfa/enable')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: wrong });
    expect(res.status).toBe(400);

    const status = await request(adminApp)
      .get('/api/admin/auth/mfa/status')
      .set('Authorization', `Bearer ${token}`);
    expect(status.body.enabled).toBe(false);
  });

  it('enable before setup is rejected', async () => {
    const admin = await seedAdmin();
    const token = mintAdminToken(admin.id);
    const res = await request(adminApp)
      .post('/api/admin/auth/mfa/enable')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: '123456' });
    // No provisional secret → ValidationError (400).
    expect(res.status).toBe(400);
  });

  it('all enrollment endpoints require a valid admin token (401 without one)', async () => {
    const noToken = await request(adminApp).get('/api/admin/auth/mfa/status');
    expect(noToken.status).toBe(401);
    const setup = await request(adminApp).post('/api/admin/auth/mfa/setup');
    expect(setup.status).toBe(401);
  });

  // Regression guard for #735: super_admin used to be blocked from enrolling.
  // Enrollment operates on req.admin.id and is role-agnostic — assert a
  // super_admin can complete the full setup→enable flow.
  it('#735 regression — a super_admin can enroll in MFA', async () => {
    const admin = await seedAdmin({ superAdmin: true });
    const { recoveryCodes, token } = await enroll(admin.id);
    expect(recoveryCodes).toHaveLength(10);

    const status = await request(adminApp)
      .get('/api/admin/auth/mfa/status')
      .set('Authorization', `Bearer ${token}`);
    expect(status.body.enabled).toBe(true);
  });
});

describe('MFA disable — /api/admin/auth/mfa/disable', () => {
  it('requires a valid code; a wrong code is rejected and state persists', async () => {
    const admin = await seedAdmin();
    const { token } = await enroll(admin.id);

    const bad = await request(adminApp)
      .post('/api/admin/auth/mfa/disable')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: '000000' });
    expect(bad.status).toBe(400);

    const stillOn = await request(adminApp)
      .get('/api/admin/auth/mfa/status')
      .set('Authorization', `Bearer ${token}`);
    expect(stillOn.body.enabled).toBe(true);
  });

  it('a valid TOTP disables MFA and clears the stored secret', async () => {
    const admin = await seedAdmin();
    const { secret, token } = await enroll(admin.id);

    const res = await request(adminApp)
      .post('/api/admin/auth/mfa/disable')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: authenticator.generate(secret) });
    expect(res.status).toBe(200);

    const status = await request(adminApp)
      .get('/api/admin/auth/mfa/status')
      .set('Authorization', `Bearer ${token}`);
    expect(status.body.enabled).toBe(false);
    expect(status.body.recoveryCodesRemaining).toBe(0);

    const row = await db('admin_users').where({ id: admin.id }).first();
    expect(row.two_factor_secret).toBeNull();
    expect(row.two_factor_recovery_codes).toBeNull();
  });
});

describe('Admin login challenge — /api/auth/admin/login[/mfa]', () => {
  it('an enrolled admin gets mfaRequired + mfaToken, NO session cookie', async () => {
    const admin = await seedAdmin();
    await enroll(admin.id);

    const res = await request(authApp)
      .post('/api/auth/admin/login')
      .send({ username: admin.username, password: admin.password });

    expect(res.status).toBe(200);
    expect(res.body.mfaRequired).toBe(true);
    expect(res.body.mfaToken).toEqual(expect.any(String));
    expect(res.body.user).toBeUndefined(); // no completed session
    // No admin auth cookie should have been set on the challenge response.
    const cookies = res.headers['set-cookie'] || [];
    expect(cookies.join(';')).not.toMatch(/adminToken/i);
  });

  it('a NON-enrolled admin logs in directly (no mfaRequired)', async () => {
    const admin = await seedAdmin();
    const res = await request(authApp)
      .post('/api/auth/admin/login')
      .send({ username: admin.username, password: admin.password });
    expect(res.status).toBe(200);
    expect(res.body.mfaRequired).toBeUndefined();
    expect(res.body.user).toBeDefined();
    expect(res.body.user.username).toBe(admin.username);
  });

  it('login/mfa with a valid TOTP completes the session', async () => {
    const admin = await seedAdmin();
    const { secret } = await enroll(admin.id);

    const challenge = await request(authApp)
      .post('/api/auth/admin/login')
      .send({ username: admin.username, password: admin.password });
    const { mfaToken } = challenge.body;

    const res = await request(authApp)
      .post('/api/auth/admin/login/mfa')
      .send({ mfaToken, code: authenticator.generate(secret) });

    expect(res.status).toBe(200);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.id).toBe(admin.id);
  });

  it('login/mfa with a wrong code is 401 MFA_INVALID', async () => {
    const admin = await seedAdmin();
    const { secret } = await enroll(admin.id);
    const challenge = await request(authApp)
      .post('/api/auth/admin/login')
      .send({ username: admin.username, password: admin.password });

    const valid = authenticator.generate(secret);
    const wrong = valid === '000000' ? '111111' : '000000';
    const res = await request(authApp)
      .post('/api/auth/admin/login/mfa')
      .send({ mfaToken: challenge.body.mfaToken, code: wrong });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('MFA_INVALID');
    expect(res.body.user).toBeUndefined();
  });

  it('a recovery code logs in and is then single-use (second use fails)', async () => {
    const admin = await seedAdmin();
    const { recoveryCodes } = await enroll(admin.id);
    const recovery = recoveryCodes[0];

    // First challenge + recovery-code exchange succeeds.
    const c1 = await request(authApp)
      .post('/api/auth/admin/login')
      .send({ username: admin.username, password: admin.password });
    const first = await request(authApp)
      .post('/api/auth/admin/login/mfa')
      .send({ mfaToken: c1.body.mfaToken, code: recovery });
    expect(first.status).toBe(200);
    expect(first.body.user).toBeDefined();

    // recoveryCodesRemaining dropped by one.
    const status = await request(adminApp)
      .get('/api/admin/auth/mfa/status')
      .set('Authorization', `Bearer ${mintAdminToken(admin.id)}`);
    expect(status.body.recoveryCodesRemaining).toBe(9);

    // Second use of the SAME recovery code must fail.
    const c2 = await request(authApp)
      .post('/api/auth/admin/login')
      .send({ username: admin.username, password: admin.password });
    const second = await request(authApp)
      .post('/api/auth/admin/login/mfa')
      .send({ mfaToken: c2.body.mfaToken, code: recovery });
    expect(second.status).toBe(401);
    expect(second.body.code).toBe('MFA_INVALID');
  });

  it('login/mfa rejects a non-mfa_pending token (e.g. a normal admin JWT)', async () => {
    const admin = await seedAdmin();
    await enroll(admin.id);
    const res = await request(authApp)
      .post('/api/auth/admin/login/mfa')
      .send({ mfaToken: mintAdminToken(admin.id), code: '123456' });
    expect(res.status).toBe(401);
  });
});
