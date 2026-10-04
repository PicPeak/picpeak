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
const mfaService = require('../../src/services/mfaService');

jest.setTimeout(120000);

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
}, 120000);

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

  // Concurrency regression: a plain UPDATE with no conditional guard let two
  // requests carrying the same captured code both read the same
  // two_factor_last_used_step and both persist, defeating replay protection.
  // The guarded UPDATE (mfaService.persistTotpStep) makes only the first
  // writer's affected-row count > 0; the loser must be rejected.
  it('two concurrent disable requests with the SAME captured code: only one succeeds', async () => {
    const admin = await seedAdmin();
    const { secret, token } = await enroll(admin.id);
    const code = authenticator.generate(secret);

    const [r1, r2] = await Promise.all([
      request(adminApp)
        .post('/api/admin/auth/mfa/disable')
        .set('Authorization', `Bearer ${token}`)
        .send({ code }),
      request(adminApp)
        .post('/api/admin/auth/mfa/disable')
        .set('Authorization', `Bearer ${token}`)
        .send({ code }),
    ]);

    expect([r1.status, r2.status].sort()).toEqual([200, 400]);

    const status = await request(adminApp)
      .get('/api/admin/auth/mfa/status')
      .set('Authorization', `Bearer ${token}`);
    expect(status.body.enabled).toBe(false);
  });
});

describe('MFA regenerate recovery codes — /api/admin/auth/mfa/recovery-codes', () => {
  it('a valid TOTP regenerates the recovery codes and persists the step', async () => {
    const admin = await seedAdmin();
    const { secret, token } = await enroll(admin.id);

    const res = await request(adminApp)
      .post('/api/admin/auth/mfa/recovery-codes')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: authenticator.generate(secret) });

    expect(res.status).toBe(200);
    expect(res.body.recoveryCodes).toHaveLength(10);
  });

  it('a wrong code is rejected (400)', async () => {
    const admin = await seedAdmin();
    const { secret, token } = await enroll(admin.id);
    const valid = authenticator.generate(secret);
    const wrong = valid === '000000' ? '111111' : '000000';

    const res = await request(adminApp)
      .post('/api/admin/auth/mfa/recovery-codes')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: wrong });
    expect(res.status).toBe(400);
  });

  // Concurrency regression (see the disable test above for the mechanism):
  // this is the endpoint called out as the worst lost-update case, since it
  // both rotates the recovery codes and (previously) persisted the step in
  // one unconditional UPDATE.
  it('two concurrent regenerations with the SAME captured code: only one succeeds', async () => {
    const admin = await seedAdmin();
    const { secret, token } = await enroll(admin.id);
    const code = authenticator.generate(secret);

    const [r1, r2] = await Promise.all([
      request(adminApp)
        .post('/api/admin/auth/mfa/recovery-codes')
        .set('Authorization', `Bearer ${token}`)
        .send({ code }),
      request(adminApp)
        .post('/api/admin/auth/mfa/recovery-codes')
        .set('Authorization', `Bearer ${token}`)
        .send({ code }),
    ]);

    expect([r1.status, r2.status].sort()).toEqual([200, 400]);
    const winner = r1.status === 200 ? r1 : r2;
    expect(winner.body.recoveryCodes).toHaveLength(10);

    const row = await db('admin_users').where({ id: admin.id }).first();
    expect(row.two_factor_last_used_step).not.toBeNull();
  });
});

describe('mfaService.persistTotpStep — atomic replay-tracking persist', () => {
  // Deterministic simulation of the race: two "concurrent" requests that
  // read the SAME two_factor_last_used_step and computed the SAME totpStep
  // from the same captured code. Calling persistTotpStep twice in a row with
  // that identical totpStep reproduces exactly the DB-level outcome of a
  // true race, without relying on event-loop timing.
  it('the second writer with the same totpStep affects 0 rows and is rejected', async () => {
    const admin = await seedAdmin();
    const { secret } = await enroll(admin.id);
    const row = await db('admin_users').where({ id: admin.id }).first();
    const code = authenticator.generate(secret);
    const totpStep = mfaService.verifyTotpEncryptedStep(code, row.two_factor_secret, null);
    expect(totpStep).toEqual(expect.any(Number));

    const first = await mfaService.persistTotpStep(db, admin.id, totpStep, { updated_at: new Date() });
    expect(first).toBe(true);

    // The row's two_factor_last_used_step has now already advanced to
    // totpStep by the time this "losing" write runs — the guard condition
    // (whereNull OR < totpStep) is false, so 0 rows are affected.
    const second = await mfaService.persistTotpStep(db, admin.id, totpStep, { updated_at: new Date() });
    expect(second).toBe(false);

    const after = await db('admin_users').where({ id: admin.id }).first();
    expect(Number(after.two_factor_last_used_step)).toBe(totpStep);
  });

  it('succeeds when the new step advances past the current one', async () => {
    const admin = await seedAdmin();
    const { secret } = await enroll(admin.id);
    const row = await db('admin_users').where({ id: admin.id }).first();
    const code = authenticator.generate(secret);
    const totpStep = mfaService.verifyTotpEncryptedStep(code, row.two_factor_secret, null);

    const ok = await mfaService.persistTotpStep(db, admin.id, totpStep, {});
    expect(ok).toBe(true);

    const nextStepAuthenticator = authenticator.clone({ epoch: Date.now() + 30000 });
    const nextCode = nextStepAuthenticator.generate(secret);
    const nextStep = mfaService.verifyTotpEncryptedStep(nextCode, row.two_factor_secret, totpStep);
    expect(nextStep).toBeGreaterThan(totpStep);

    const advanced = await mfaService.persistTotpStep(db, admin.id, nextStep, {});
    expect(advanced).toBe(true);
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

  // GHSA-qcwx-r25m-j869: verifyTotp() was stateless, so otplib's window:1
  // tolerance let the same 6-digit code complete two independent logins
  // within its ~90s validity window. mfaService now tracks each admin's
  // last-consumed TOTP step and rejects a code that doesn't advance past it.
  it('#GHSA-qcwx-r25m-j869 — a TOTP code cannot be replayed into a second login', async () => {
    const admin = await seedAdmin();
    const { secret } = await enroll(admin.id);
    const code = authenticator.generate(secret);

    // First use of the code completes a login.
    const c1 = await request(authApp)
      .post('/api/auth/admin/login')
      .send({ username: admin.username, password: admin.password });
    const first = await request(authApp)
      .post('/api/auth/admin/login/mfa')
      .send({ mfaToken: c1.body.mfaToken, code });
    expect(first.status).toBe(200);
    expect(first.body.user).toBeDefined();

    // Replaying the SAME code for an independent second login must fail,
    // even though otplib's window:1 tolerance still considers it valid.
    const c2 = await request(authApp)
      .post('/api/auth/admin/login')
      .send({ username: admin.username, password: admin.password });
    const replay = await request(authApp)
      .post('/api/auth/admin/login/mfa')
      .send({ mfaToken: c2.body.mfaToken, code });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('MFA_INVALID');
    expect(replay.body.user).toBeUndefined();

    // A freshly generated code for the NEXT TOTP step is not a replay and
    // succeeds. Generated via a cloned authenticator with a future epoch
    // rather than mocking Date.now(), so mfaService's own step computation
    // (real Date.now()) still lands the match one step ahead.
    const nextStepAuthenticator = authenticator.clone({ epoch: Date.now() + 30000 });
    const nextCode = nextStepAuthenticator.generate(secret);
    const c3 = await request(authApp)
      .post('/api/auth/admin/login')
      .send({ username: admin.username, password: admin.password });
    const third = await request(authApp)
      .post('/api/auth/admin/login/mfa')
      .send({ mfaToken: c3.body.mfaToken, code: nextCode });
    expect(third.status).toBe(200);
    expect(third.body.user).toBeDefined();
    expect(third.body.user.id).toBe(admin.id);
  });

  // Concurrency regression: verifyTotpEncryptedStep()'s "does this advance"
  // check was read against a snapshot taken earlier in the request, then a
  // PLAIN update persisted the step — two concurrent requests carrying the
  // SAME captured code could both pass the check and both complete a login
  // before either write landed. The persist is now a conditional UPDATE
  // (mfaService.persistTotpStep), so only the first writer's affected-row
  // count is > 0 and the other is correctly treated as a replay.
  it('two concurrent login/mfa requests with the SAME captured code: only one completes', async () => {
    const admin = await seedAdmin();
    const { secret } = await enroll(admin.id);
    const code = authenticator.generate(secret);

    const c1 = await request(authApp)
      .post('/api/auth/admin/login')
      .send({ username: admin.username, password: admin.password });
    const c2 = await request(authApp)
      .post('/api/auth/admin/login')
      .send({ username: admin.username, password: admin.password });

    const [r1, r2] = await Promise.all([
      request(authApp).post('/api/auth/admin/login/mfa').send({ mfaToken: c1.body.mfaToken, code }),
      request(authApp).post('/api/auth/admin/login/mfa').send({ mfaToken: c2.body.mfaToken, code }),
    ]);

    expect([r1.status, r2.status].sort()).toEqual([200, 401]);
    const winner = r1.status === 200 ? r1 : r2;
    const loser = r1.status === 200 ? r2 : r1;
    expect(winner.body.user).toBeDefined();
    expect(loser.body.user).toBeUndefined();
    expect(loser.body.code).toBe('MFA_INVALID');
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
    // Counted in the second factor's own account-wide bucket, not in the
    // password step's (which anonymous callers can fill).
    const failed = await db('login_attempts').where({ success: false })
      .whereIn('identifier', [`mfa:${admin.id}`, admin.username]).select('identifier');
    expect(Array.from(failed).map((r) => r.identifier)).toEqual([`mfa:${admin.id}`]);
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
