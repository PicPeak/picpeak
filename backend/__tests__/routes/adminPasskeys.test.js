/**
 * HTTP-level tests for admin passkeys (issue 1733).
 *
 * Two surfaces, mounted like server.js:
 *   - /api/admin/auth/passkeys/*       management (src/routes/adminAuth.js)
 *   - /api/auth/admin/passkey/*        login       (src/routes/auth.js)
 *
 * @simplewebauthn/server is mocked at the VERIFY boundary only: the options
 * come from the real library, and what a test decides is what the library
 * says about a response (verified, rejected, which counter). Everything this
 * repo owns around that call runs for real against SQLite: the challenge
 * cookie, the gates, the lockout rows and the session.
 *
 * NOTE: env (TEST_DATABASE_PATH / JWT_SECRET) must be set BEFORE the first
 * require of db.js; mirrors adminMfa.test.js.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-passkeys-test-'));
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'db.sqlite');
process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
fs.mkdirSync(process.env.STORAGE_PATH, { recursive: true });
process.env.JWT_SECRET = process.env.JWT_SECRET || 'passkey-route-test-secret';
delete process.env.RECAPTCHA_SECRET_KEY;
delete process.env.OIDC_BREAK_GLASS;

const ORIGIN = 'https://photos.example.com';
process.env.FRONTEND_URL = ORIGIN;

const mockVerifyRegistration = jest.fn();
const mockVerifyAuthentication = jest.fn();
jest.mock('@simplewebauthn/server', () => ({
  ...jest.requireActual('@simplewebauthn/server'),
  verifyRegistrationResponse: (...args) => mockVerifyRegistration(...args),
  verifyAuthenticationResponse: (...args) => mockVerifyAuthentication(...args),
}));

const request = require('supertest');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { bootCrmDb, mintAdminToken, buildRouteApp } = require('../integration/helpers/crmDb');
const oidcService = require('../../src/services/oidcService');
const passkeyService = require('../../src/services/passkeyService');

jest.setTimeout(120000);

const PASSWORD = 'correct-horse';
const FAILED = { error: 'Passkey sign-in failed', code: 'PASSKEY_INVALID' };

let db;
let cleanup;
let adminApp;
let authApp;
let passwordHash;
let seq = 0;

async function seedAdmin(overrides = {}) {
  const uname = `pk-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
  const inserted = await db('admin_users').insert({
    username: uname,
    email: `${uname}@example.com`,
    password_hash: passwordHash,
    must_change_password: false,
    is_active: true,
    created_at: new Date().toISOString(),
    ...overrides,
  }).returning('id');
  const id = inserted[0]?.id ?? inserted[0];
  return { id, username: uname, token: mintAdminToken(id) };
}

const cookieOf = (res, name = passkeyService.CHALLENGE_COOKIE) => {
  const line = (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`));
  return line ? line.split(';')[0] : null;
};

const asAdmin = (req, admin) => req.set('Authorization', `Bearer ${admin.token}`).set('Origin', ORIGIN);

const registerOptions = (admin, body = { currentPassword: PASSWORD }) =>
  asAdmin(request(adminApp).post('/api/admin/auth/passkeys/register/options'), admin).send(body);

const registerVerify = (admin, cookie, body = {}) => {
  const req = asAdmin(request(adminApp).post('/api/admin/auth/passkeys/register/verify'), admin);
  if (cookie) req.set('Cookie', cookie);
  return req.send({ response: { id: 'ignored' }, name: 'Laptop', ...body });
};

/** Register a passkey through the routes; the library "accepts" credentialId. */
async function addPasskey(admin, credentialId, { counter = 0 } = {}) {
  const options = await registerOptions(admin);
  expect(options.status).toBe(200);
  mockVerifyRegistration.mockResolvedValueOnce({
    verified: true,
    registrationInfo: {
      aaguid: '00000000-0000-0000-0000-000000000000',
      credential: { id: credentialId, publicKey: new Uint8Array([1, 2, 3, 4]), counter, transports: ['internal'] },
    },
  });
  const verify = await registerVerify(admin, cookieOf(options));
  expect(verify.status).toBe(200);
  return verify.body.passkey;
}

const loginOptions = (body = {}) =>
  request(authApp).post('/api/auth/admin/passkey/options').set('Origin', ORIGIN).send(body);

const loginVerify = (cookie, body) => {
  const req = request(authApp).post('/api/auth/admin/passkey/verify').set('Origin', ORIGIN);
  if (cookie) req.set('Cookie', cookie);
  return req.send(body);
};

const accept = (newCounter = 0) => mockVerifyAuthentication.mockResolvedValueOnce({
  verified: true,
  authenticationInfo: { newCounter, userVerified: true },
});

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  passwordHash = await bcrypt.hash(PASSWORD, 4);
  adminApp = buildRouteApp('/api/admin/auth', require('../../src/routes/adminAuth'));
  authApp = buildRouteApp('/api/auth', require('../../src/routes/auth'));
}, 120000);

afterAll(async () => {
  if (cleanup) await cleanup();
});

beforeEach(() => {
  process.env.FRONTEND_URL = ORIGIN;
  mockVerifyRegistration.mockReset();
  mockVerifyAuthentication.mockReset();
  mockVerifyRegistration.mockRejectedValue(new Error('unexpected verifyRegistrationResponse call'));
  mockVerifyAuthentication.mockRejectedValue(new Error('unexpected verifyAuthenticationResponse call'));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('relying party', () => {
  it('is the configured address: hostname as RP ID, its origin as expected origin', async () => {
    const admin = await seedAdmin();
    const res = await asAdmin(request(adminApp).get('/api/admin/auth/passkeys'), admin);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      available: true, reason: null, rpId: 'photos.example.com', origin: ORIGIN, passkeys: [],
    });
  });

  it.each([
    ['http://192.168.1.20:3000', 'ip_address'],
    ['https://[2001:db8::1]', 'ip_address'],
    ['http://photos.example.com', 'insecure_origin'],
  ])('has none for %s (%s) and offers no fallback', async (url, reason) => {
    process.env.FRONTEND_URL = url;
    const admin = await seedAdmin();
    const res = await request(adminApp).get('/api/admin/auth/passkeys')
      .set('Authorization', `Bearer ${admin.token}`);
    expect(res.body).toMatchObject({ available: false, reason });

    const options = await request(adminApp).post('/api/admin/auth/passkeys/register/options')
      .set('Authorization', `Bearer ${admin.token}`).send({ currentPassword: PASSWORD });
    expect(options.status).toBe(400);
    expect(options.body).toMatchObject({ code: 'PASSKEY_UNAVAILABLE', reason });
    expect((await loginOptions()).body.code).toBe('PASSKEY_UNAVAILABLE');
  });

  it('refuses a request that arrives from another origin', async () => {
    const admin = await seedAdmin();
    const res = await request(adminApp).post('/api/admin/auth/passkeys/register/options')
      .set('Authorization', `Bearer ${admin.token}`)
      .set('Origin', 'https://other.example.com')
      .send({ currentPassword: PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'PASSKEY_UNAVAILABLE', reason: 'origin_mismatch' });
  });

  it('allows http on localhost', async () => {
    process.env.FRONTEND_URL = 'http://localhost:3000';
    expect(await passkeyService.getRelyingParty()).toEqual({
      available: true, rpID: 'localhost', origin: 'http://localhost:3000',
    });
  });
});

describe('registration', () => {
  it('asks for the current password before it issues a challenge', async () => {
    const admin = await seedAdmin();
    const wrong = await registerOptions(admin, { currentPassword: 'nope' });
    expect(wrong.status).toBe(400);
    expect(cookieOf(wrong)).toBeNull();
    expect((await registerOptions(admin, {})).status).toBe(400);
  });

  it('issues discoverable, user-verified options and an httpOnly challenge cookie', async () => {
    const admin = await seedAdmin();
    await addPasskey(admin, 'cred-existing');
    const res = await registerOptions(admin);
    expect(res.status).toBe(200);
    const { options } = res.body;
    expect(options.rp).toEqual({ name: 'PicPeak', id: 'photos.example.com' });
    expect(options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
    expect(options.excludeCredentials.map((c) => c.id)).toEqual(['cred-existing']);
    expect(options.attestation).toBe('none');

    const raw = (res.headers['set-cookie'] || []).find((c) => c.startsWith('passkey_challenge='));
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/Max-Age=300/i);
    const payload = jwt.decode(cookieOf(res).split('=')[1]);
    expect(payload).toMatchObject({ type: 'passkey_challenge', purpose: 'register', uid: admin.id, c: options.challenge });
  });

  // An authenticator keeps one discoverable credential per RP ID and user
  // handle, and a registration replaces it. A portable restore can move the
  // operator to another row and hand their old id to an archived account, so
  // the handle must not be the id alone: that account registering on the same
  // authenticator would overwrite the operator's preserved passkey.
  it('derives a user handle that is stable for an account and not reused with its id', async () => {
    const admin = await seedAdmin({ created_at: '2026-01-01T00:00:00.000Z' });
    const handleOf = async () => (await registerOptions(admin)).body.options.user.id;
    const first = await handleOf();
    expect(await handleOf()).toBe(first);

    await db('admin_users').where({ id: admin.id }).update({ created_at: '2026-02-02T00:00:00.000Z' });
    expect(await handleOf()).not.toBe(first);
  });

  it('stores the credential the library verified against this origin and RP ID', async () => {
    const admin = await seedAdmin();
    const options = await registerOptions(admin);
    mockVerifyRegistration.mockResolvedValueOnce({
      verified: true,
      registrationInfo: {
        aaguid: 'aaguid-1',
        credential: { id: 'cred-store', publicKey: new Uint8Array([9, 8, 7]), counter: 5, transports: ['usb'] },
      },
    });
    const res = await registerVerify(admin, cookieOf(options), { name: '  YubiKey  ' });
    expect(res.status).toBe(200);
    expect(res.body.passkey).toMatchObject({ name: 'YubiKey', lastUsedAt: null });
    expect(res.body.passkey.publicKey).toBeUndefined();

    expect(mockVerifyRegistration).toHaveBeenCalledWith(expect.objectContaining({
      expectedChallenge: options.body.options.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: 'photos.example.com',
      requireUserVerification: true,
    }));
    const row = await db('admin_webauthn_credentials').where({ credential_id: 'cred-store' }).first();
    expect(row).toMatchObject({ admin_user_id: admin.id, aaguid: 'aaguid-1', name: 'YubiKey' });
    expect(Number(row.counter)).toBe(5);
    expect(Buffer.from(row.public_key, 'base64url')).toEqual(Buffer.from([9, 8, 7]));
    expect(JSON.parse(row.transports)).toEqual(['usb']);
  });

  it('stores nothing when the library rejects the response (wrong origin or RP ID)', async () => {
    const admin = await seedAdmin();
    const options = await registerOptions(admin);
    mockVerifyRegistration.mockRejectedValueOnce(
      new Error('Unexpected registration response origin "https://evil.example", expected "https://photos.example.com"')
    );
    const res = await registerVerify(admin, cookieOf(options));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PASSKEY_VERIFICATION_FAILED');
    // The library's reason is logged, not echoed.
    expect(JSON.stringify(res.body)).not.toMatch(/evil/);
    expect(await passkeyService.countForAdmin(admin.id)).toBe(0);
  });

  it('spends the challenge on first use, successful or not', async () => {
    const admin = await seedAdmin();
    const options = await registerOptions(admin);
    const cookie = cookieOf(options);
    mockVerifyRegistration.mockRejectedValueOnce(new Error('bad signature'));
    expect((await registerVerify(admin, cookie)).body.code).toBe('PASSKEY_VERIFICATION_FAILED');

    const replay = await registerVerify(admin, cookie);
    expect(replay.status).toBe(400);
    expect(replay.body.code).toBe('PASSKEY_CHALLENGE_INVALID');
    expect(mockVerifyRegistration).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing challenge, another account\'s challenge and a login challenge', async () => {
    const admin = await seedAdmin();
    const other = await seedAdmin();
    expect((await registerVerify(admin, null)).body.code).toBe('PASSKEY_CHALLENGE_INVALID');

    const foreign = cookieOf(await registerOptions(other));
    expect((await registerVerify(admin, foreign)).body.code).toBe('PASSKEY_CHALLENGE_INVALID');

    const login = cookieOf(await loginOptions());
    expect(login).toBeTruthy();
    expect((await registerVerify(admin, login)).body.code).toBe('PASSKEY_CHALLENGE_INVALID');
    expect(mockVerifyRegistration).not.toHaveBeenCalled();
  });

  // A reset by somebody else removes the account's passkeys. A registration
  // that was authorized with the old password must not land after it.
  it('refuses to finish a registration when the password changed since the options step', async () => {
    const admin = await seedAdmin();
    const options = await registerOptions(admin);
    expect(options.status).toBe(200);
    await db('admin_users').where({ id: admin.id }).update({ password_hash: await bcrypt.hash('reset-by-operator', 4) });

    mockVerifyRegistration.mockResolvedValueOnce({
      verified: true,
      registrationInfo: {
        aaguid: '00000000-0000-0000-0000-000000000000',
        credential: { id: 'cred-after-reset', publicKey: new Uint8Array([1, 2, 3, 4]), counter: 0, transports: ['internal'] },
      },
    });
    const res = await registerVerify(admin, cookieOf(options));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PASSKEY_CHALLENGE_INVALID');
    expect(await passkeyService.countForAdmin(admin.id)).toBe(0);
    mockVerifyRegistration.mockReset();
  });

  it('refuses a credential that is already registered', async () => {
    const admin = await seedAdmin();
    const other = await seedAdmin();
    await addPasskey(admin, 'cred-dup');
    const options = await registerOptions(other);
    mockVerifyRegistration.mockResolvedValueOnce({
      verified: true,
      registrationInfo: { credential: { id: 'cred-dup', publicKey: new Uint8Array([1]), counter: 0 } },
    });
    const res = await registerVerify(other, cookieOf(options));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PASSKEY_ALREADY_REGISTERED');
  });

  it('caps the number of passkeys per account', async () => {
    const admin = await seedAdmin();
    const now = new Date().toISOString();
    await db('admin_webauthn_credentials').insert(
      Array.from({ length: passkeyService.MAX_PASSKEYS_PER_ADMIN }, (_, i) => ({
        admin_user_id: admin.id, credential_id: `cap-${admin.id}-${i}`, public_key: 'AQ', counter: 0, name: `k${i}`, created_at: now,
      }))
    );
    const res = await registerOptions(admin);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PASSKEY_LIMIT');
  });
});

// A passkey signs in without the password AND without the authenticator code.
// On an account with two-factor authentication, adding one therefore needs a
// fresh code as well, like switching the second factor off does: a stolen
// session plus the password must not be enough to mint a way around it.
describe('registration on an account with two-factor authentication', () => {
  const { authenticator } = require('otplib');
  const mfaService = require('../../src/services/mfaService');

  async function seedMfaAdmin() {
    const secret = mfaService.generateSecret();
    const { plain, hashed } = await mfaService.generateRecoveryCodes();
    const admin = await seedAdmin({
      two_factor_enabled: true,
      two_factor_secret: mfaService.encryptSecret(secret),
      two_factor_recovery_codes: JSON.stringify(hashed),
    });
    return { admin, secret, recoveryCodes: plain };
  }
  const recoveryCodesLeft = async (admin) => mfaService.parseRecoveryCodes(
    (await db('admin_users').where({ id: admin.id }).first()).two_factor_recovery_codes).length;

  it('says in the status whether a code will be asked for', async () => {
    const { admin } = await seedMfaAdmin();
    expect((await asAdmin(request(adminApp).get('/api/admin/auth/passkeys'), admin)).body.mfaEnabled).toBe(true);
    const plain = await seedAdmin();
    expect((await asAdmin(request(adminApp).get('/api/admin/auth/passkeys'), plain)).body.mfaEnabled).toBe(false);
  });

  it('issues no challenge for the password alone', async () => {
    const { admin } = await seedMfaAdmin();
    const res = await registerOptions(admin);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MFA_CODE_REQUIRED');
    expect(cookieOf(res)).toBeNull();
  });

  it('issues no challenge for a wrong code, and none for a right code with a wrong password', async () => {
    const { admin, secret } = await seedMfaAdmin();
    const wrong = await registerOptions(admin, { currentPassword: PASSWORD, code: '000000' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('MFA_INVALID');
    expect(cookieOf(wrong)).toBeNull();

    const code = authenticator.generate(secret);
    const wrongPassword = await registerOptions(admin, { currentPassword: 'nope', code });
    expect(wrongPassword.status).toBe(400);
    expect(wrongPassword.body.code).toBe('PASSWORD_INCORRECT');
    expect(cookieOf(wrongPassword)).toBeNull();
    // The code was not spent on the refused request.
    expect((await registerOptions(admin, { currentPassword: PASSWORD, code })).status).toBe(200);
  });

  it('accepts a current authenticator code once', async () => {
    const { admin, secret } = await seedMfaAdmin();
    const code = authenticator.generate(secret);
    const first = await registerOptions(admin, { currentPassword: PASSWORD, code });
    expect(first.status).toBe(200);
    expect(cookieOf(first)).toBeTruthy();

    const replay = await registerOptions(admin, { currentPassword: PASSWORD, code });
    expect(replay.status).toBe(400);
    expect(replay.body.code).toBe('MFA_INVALID');
    expect(cookieOf(replay)).toBeNull();
  });

  it('accepts a recovery code and spends it', async () => {
    const { admin, recoveryCodes } = await seedMfaAdmin();
    const before = await recoveryCodesLeft(admin);
    const first = await registerOptions(admin, { currentPassword: PASSWORD, code: recoveryCodes[0] });
    expect(first.status).toBe(200);
    expect(await recoveryCodesLeft(admin)).toBe(before - 1);

    const again = await registerOptions(admin, { currentPassword: PASSWORD, code: recoveryCodes[0] });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('MFA_INVALID');
    expect(await recoveryCodesLeft(admin)).toBe(before - 1);
  });

  it('does not spend a code on a request the cap refuses anyway', async () => {
    const { admin, recoveryCodes } = await seedMfaAdmin();
    const now = new Date().toISOString();
    await db('admin_webauthn_credentials').insert(
      Array.from({ length: passkeyService.MAX_PASSKEYS_PER_ADMIN }, (_, i) => ({
        admin_user_id: admin.id, credential_id: `mfa-cap-${admin.id}-${i}`, public_key: 'AQ', counter: 0, name: `k${i}`, created_at: now,
      }))
    );
    const before = await recoveryCodesLeft(admin);
    const res = await registerOptions(admin, { currentPassword: PASSWORD, code: recoveryCodes[0] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PASSKEY_LIMIT');
    expect(await recoveryCodesLeft(admin)).toBe(before);
  });

  it('a challenge issued before two-factor authentication was switched on cannot finish after it', async () => {
    const admin = await seedAdmin();
    const options = await registerOptions(admin);
    expect(options.status).toBe(200);
    await db('admin_users').where({ id: admin.id }).update({
      two_factor_enabled: true,
      two_factor_secret: mfaService.encryptSecret(mfaService.generateSecret()),
    });

    mockVerifyRegistration.mockResolvedValueOnce({
      verified: true,
      registrationInfo: {
        aaguid: '00000000-0000-0000-0000-000000000000',
        credential: { id: 'cred-before-mfa', publicKey: new Uint8Array([1, 2, 3, 4]), counter: 0, transports: ['internal'] },
      },
    });
    const res = await registerVerify(admin, cookieOf(options));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PASSKEY_CHALLENGE_INVALID');
    expect(await passkeyService.countForAdmin(admin.id)).toBe(0);
    mockVerifyRegistration.mockReset();
  });
});

describe('list, rename, delete', () => {
  it('lists only the caller\'s passkeys and renames only its own', async () => {
    const admin = await seedAdmin();
    const other = await seedAdmin();
    const mine = await addPasskey(admin, 'cred-mine');
    const theirs = await addPasskey(other, 'cred-theirs');

    const list = await asAdmin(request(adminApp).get('/api/admin/auth/passkeys'), admin);
    expect(list.body.passkeys.map((p) => p.id)).toEqual([mine.id]);
    expect(Object.keys(list.body.passkeys[0]).sort()).toEqual(['createdAt', 'id', 'lastUsedAt', 'name']);

    const rename = await asAdmin(request(adminApp).patch(`/api/admin/auth/passkeys/${mine.id}`), admin).send({ name: 'Phone' });
    expect(rename.status).toBe(200);
    expect((await db('admin_webauthn_credentials').where({ id: mine.id }).first()).name).toBe('Phone');

    const foreign = await asAdmin(request(adminApp).patch(`/api/admin/auth/passkeys/${theirs.id}`), admin).send({ name: 'x' });
    expect(foreign.status).toBe(404);
  });

  it('deleting asks for the current password and never reaches another account', async () => {
    const admin = await seedAdmin();
    const other = await seedAdmin();
    const mine = await addPasskey(admin, 'cred-del');
    const theirs = await addPasskey(other, 'cred-del-other');
    const del = (id, body) => asAdmin(request(adminApp).post(`/api/admin/auth/passkeys/${id}/delete`), admin).send(body);

    expect((await del(mine.id, {})).status).toBe(400);
    expect((await del(mine.id, { currentPassword: 'nope' })).status).toBe(400);
    expect((await del(theirs.id, { currentPassword: PASSWORD })).status).toBe(404);
    expect(await passkeyService.countForAdmin(admin.id)).toBe(1);

    expect((await del(mine.id, { currentPassword: PASSWORD })).status).toBe(200);
    expect(await passkeyService.countForAdmin(admin.id)).toBe(0);
    expect(await passkeyService.countForAdmin(other.id)).toBe(1);
  });

  it('an account without a password cannot delete its last passkey', async () => {
    const admin = await seedAdmin();
    const first = await addPasskey(admin, 'cred-last-1');
    const second = await addPasskey(admin, 'cred-last-2');
    await db('admin_users').where({ id: admin.id }).update({ password_hash: '' });
    const del = (id) => asAdmin(request(adminApp).post(`/api/admin/auth/passkeys/${id}/delete`), admin).send({});

    expect((await del(first.id)).status).toBe(200);
    const last = await del(second.id);
    expect(last.status).toBe(409);
    expect(await passkeyService.countForAdmin(admin.id)).toBe(1);
  });

  it('a hard delete of the account removes its passkeys (SQLite has no cascade)', async () => {
    const role = await db('roles').where({ name: 'super_admin' }).first();
    const actor = await seedAdmin({ role_id: role.id });
    const target = await seedAdmin();
    await addPasskey(target, 'cred-hard-delete');
    await require('../../src/services/userManagementService').deleteAdminUser(target.id, actor.id);
    expect(await db('admin_webauthn_credentials').where({ admin_user_id: target.id })).toHaveLength(0);
  });
});

describe('password change', () => {
  // Only a reset by somebody else removes passkeys (adminPasswordReset.js);
  // an admin changing their own password is signed in and keeps them.
  it('keeps the passkeys when an admin changes their own password', async () => {
    const admin = await seedAdmin();
    const passkey = await addPasskey(admin, 'cred-own-change');

    const res = await asAdmin(request(adminApp).post('/api/admin/auth/change-password'), admin)
      .send({ currentPassword: PASSWORD, newPassword: 'Brand-New-Passphrase-2026!' });
    expect(res.status).toBe(200);

    const row = await db('admin_users').where({ id: admin.id }).first();
    await expect(bcrypt.compare(PASSWORD, row.password_hash)).resolves.toBe(false);
    const rows = await db('admin_webauthn_credentials').where({ admin_user_id: admin.id });
    expect(rows.map((r) => r.id)).toEqual([passkey.id]);
  });
});

describe('passwordless login', () => {
  it('options name no account and do not change with what the caller sends', async () => {
    const a = await loginOptions();
    const b = await loginOptions({ username: 'admin', email: 'someone@example.com' });
    for (const res of [a, b]) {
      expect(res.status).toBe(200);
      expect(res.body.options.rpId).toBe('photos.example.com');
      expect(res.body.options.userVerification).toBe('required');
      expect(res.body.options.allowCredentials).toBeUndefined();
      expect(jwt.decode(cookieOf(res).split('=')[1])).toMatchObject({ purpose: 'login', uid: null });
    }
    expect(Object.keys(a.body.options).sort()).toEqual(Object.keys(b.body.options).sort());
  });

  it('establishes the same admin session as a password login', async () => {
    const admin = await seedAdmin();
    const passkey = await addPasskey(admin, 'cred-login', { counter: 3 });
    const options = await loginOptions({ remember_me: true });
    accept(4);
    const res = await loginVerify(cookieOf(options), { response: { id: 'cred-login' } })
      .set('X-Forwarded-For', '203.0.113.7');

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: admin.id, username: admin.username, mustChangePassword: false });

    expect(mockVerifyAuthentication).toHaveBeenCalledWith(expect.objectContaining({
      expectedChallenge: options.body.options.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: 'photos.example.com',
      requireUserVerification: true,
      credential: expect.objectContaining({ id: 'cred-login', counter: 3 }),
    }));

    // establishAdminSession: the admin cookie with the remembered lifetime,
    // last_login, the success row in login_attempts.
    const adminCookie = (res.headers['set-cookie'] || []).find((c) => c.startsWith('admin_token='));
    expect(adminCookie).toMatch(/HttpOnly/i);
    expect(adminCookie).toMatch(/Max-Age=2592000/);
    const session = jwt.verify(adminCookie.split(';')[0].split('=')[1], process.env.JWT_SECRET, { issuer: 'picpeak-auth' });
    expect(session).toMatchObject({ id: admin.id, type: 'admin', rememberMe: true, ip: '203.0.113.7' });
    // The spent challenge cookie is cleared.
    expect((res.headers['set-cookie'] || []).some((c) => /^passkey_challenge=;/.test(c))).toBe(true);

    const row = await db('admin_users').where({ id: admin.id }).first();
    expect(row.last_login).toBeTruthy();
    expect(row.last_login_ip).toBe('203.0.113.7');
    const attempts = await db('login_attempts').where({ identifier: admin.username });
    expect(attempts).toHaveLength(1);
    expect(Number(attempts[0].success)).toBe(1);

    const stored = await db('admin_webauthn_credentials').where({ id: passkey.id }).first();
    expect(Number(stored.counter)).toBe(4);
    expect(stored.last_used_at).toBeTruthy();
    const activity = await db('activity_logs').where({ activity_type: 'admin_passkey_login' }).orderBy('id', 'desc').first();
    expect(activity).toBeTruthy();
  });

  it('spends the challenge: the same cookie cannot complete a second login', async () => {
    const admin = await seedAdmin();
    await addPasskey(admin, 'cred-once');
    const cookie = cookieOf(await loginOptions());
    accept();
    expect((await loginVerify(cookie, { response: { id: 'cred-once' } })).status).toBe(200);

    accept();
    const replay = await loginVerify(cookie, { response: { id: 'cred-once' } });
    expect(replay.status).toBe(400);
    expect(replay.body.code).toBe('PASSKEY_CHALLENGE_INVALID');
    expect(replay.headers['set-cookie'].some((c) => c.startsWith('admin_token='))).toBe(false);
    mockVerifyAuthentication.mockReset();
  });

  // A restore replaces revoked_tokens, so a challenge spent before it is no
  // longer on record; the cutoff the restore publishes is what still refuses it.
  it('refuses a challenge issued before a restore, even when its use is no longer on record', async () => {
    const sessionCutoff = require('../../src/utils/sessionCutoff');
    const admin = await seedAdmin();
    await addPasskey(admin, 'cred-restore');
    const cookie = cookieOf(await loginOptions());
    accept();
    expect((await loginVerify(cookie, { response: { id: 'cred-restore' } })).status).toBe(200);

    const { jti } = jwt.decode(cookie.split('=')[1]);
    expect(await db('revoked_tokens').where({ token_id: jti }).del()).toBe(1);
    // Published by another replica: this process still has the old cutoff in
    // its short-lived cache, which the challenge check must not rely on.
    expect(await sessionCutoff.getSessionsValidAfter()).toBe(0);
    await sessionCutoff.setSessionsValidAfter(sessionCutoff.nextSessionCutoff(), { refreshCache: false });
    try {
      accept();
      const replay = await loginVerify(cookie, { response: { id: 'cred-restore' } });
      expect(replay.status).toBe(400);
      expect(replay.body.code).toBe('PASSKEY_CHALLENGE_INVALID');
      expect(replay.headers['set-cookie'].some((c) => c.startsWith('admin_token='))).toBe(false);
      expect(await db('revoked_tokens').where({ token_id: jti }).first()).toBeUndefined();
    } finally {
      await db('app_settings').where({ setting_key: sessionCutoff.CUTOFF_KEY }).del();
      sessionCutoff._resetCache();
      mockVerifyAuthentication.mockReset();
    }
  });

  it('rejects a missing challenge and a registration challenge', async () => {
    const admin = await seedAdmin();
    await addPasskey(admin, 'cred-purpose');
    expect((await loginVerify(null, { response: { id: 'cred-purpose' } })).body.code).toBe('PASSKEY_CHALLENGE_INVALID');
    const register = cookieOf(await registerOptions(admin));
    expect((await loginVerify(register, { response: { id: 'cred-purpose' } })).body.code).toBe('PASSKEY_CHALLENGE_INVALID');
    expect(mockVerifyAuthentication).not.toHaveBeenCalled();
  });

  it('answers every rejected login the same way', async () => {
    const admin = await seedAdmin();
    await addPasskey(admin, 'cred-ok');
    const inactive = await seedAdmin();
    await addPasskey(inactive, 'cred-inactive');
    await db('admin_users').where({ id: inactive.id }).update({ is_active: false });
    const sso = await seedAdmin();
    await addPasskey(sso, 'cred-sso');
    await db('admin_users').where({ id: sso.id }).update({ auth_provider: 'oidc' });

    const attempt = async (credentialId, prepare) => {
      const cookie = cookieOf(await loginOptions());
      if (prepare) prepare();
      return loginVerify(cookie, { response: { id: credentialId } });
    };

    const results = [
      await attempt('no-such-credential'),
      await attempt('cred-inactive'),
      await attempt('cred-sso'),
      // What the library does with a wrong origin, RP ID or signature.
      await attempt('cred-ok', () => mockVerifyAuthentication.mockRejectedValueOnce(
        new Error('Unexpected authentication response origin "https://evil.example"'))),
      await attempt('cred-ok', () => mockVerifyAuthentication.mockResolvedValueOnce({ verified: false, authenticationInfo: {} })),
    ];
    for (const res of results) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual(FAILED);
      expect((res.headers['set-cookie'] || []).some((c) => c.startsWith('admin_token='))).toBe(false);
    }
    // Failures are counted against the account's bucket, like a wrong password.
    const failures = await db('login_attempts').where({ identifier: admin.username });
    expect(failures).toHaveLength(2);
    expect(failures.every((row) => Number(row.success) === 0)).toBe(true);
  });

  it('rejects and records a signature counter that does not advance', async () => {
    const admin = await seedAdmin();
    const passkey = await addPasskey(admin, 'cred-counter', { counter: 10 });

    // The library accepts, but the counter it reports is not ahead.
    accept(10);
    const equal = await loginVerify(cookieOf(await loginOptions()), { response: { id: 'cred-counter' } });
    expect(equal.status).toBe(401);
    expect(equal.body).toEqual(FAILED);

    // The library's own check throws for the same condition.
    mockVerifyAuthentication.mockRejectedValueOnce(new Error('Response counter value 4 was lower than expected 10'));
    const lower = await loginVerify(cookieOf(await loginOptions()), { response: { id: 'cred-counter' } });
    expect(lower.status).toBe(401);

    const stored = await db('admin_webauthn_credentials').where({ id: passkey.id }).first();
    expect(Number(stored.counter)).toBe(10);
    expect(stored.last_used_at).toBeFalsy();
    const logged = await db('activity_logs').where({ activity_type: 'admin_passkey_counter_regression' });
    expect(logged.length).toBeGreaterThanOrEqual(2);
  });

  it('honours the lockout of the account from that address', async () => {
    const admin = await seedAdmin();
    await addPasskey(admin, 'cred-locked');
    const now = new Date().toISOString();
    await db('login_attempts').insert(Array.from({ length: 5 }, () => ({
      identifier: admin.username, ip_address: '198.51.100.9', user_agent: '', attempt_time: now, success: false,
    })));
    const res = await loginVerify(cookieOf(await loginOptions()), { response: { id: 'cred-locked' } })
      .set('X-Forwarded-For', '198.51.100.9');
    expect(res.status).toBe(423);
    expect(mockVerifyAuthentication).not.toHaveBeenCalled();
  });
});

describe('SSO-only mode', () => {
  it('disables passkey login and registration with the password login', async () => {
    const admin = await seedAdmin();
    await addPasskey(admin, 'cred-sso-only');
    const cookie = cookieOf(await loginOptions());
    jest.spyOn(oidcService, 'isLocalLoginDisabled').mockResolvedValue(true);

    const options = await loginOptions();
    expect(options.status).toBe(403);
    expect(options.body.code).toBe('LOCAL_LOGIN_DISABLED');
    expect(cookieOf(options)).toBeNull();

    const verify = await loginVerify(cookie, { response: { id: 'cred-sso-only' } });
    expect(verify.status).toBe(403);
    expect(mockVerifyAuthentication).not.toHaveBeenCalled();

    const status = await asAdmin(request(adminApp).get('/api/admin/auth/passkeys'), admin);
    expect(status.body).toMatchObject({ available: false, reason: 'sso_only' });
    const register = await registerOptions(admin);
    expect(register.status).toBe(400);
    expect(register.body).toMatchObject({ code: 'PASSKEY_UNAVAILABLE', reason: 'sso_only' });
  });

  it('an account owned by the identity provider cannot register one', async () => {
    const admin = await seedAdmin({ auth_provider: 'oidc' });
    const res = await registerOptions(admin);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'PASSKEY_UNAVAILABLE', reason: 'sso_account' });
  });
});

describe('second factor', () => {
  // Registered before two-factor authentication is on: adding a passkey to an
  // account that has it asks for a code, which is covered on its own above.
  async function seedWithPasskey(credentialId) {
    const admin = await seedAdmin();
    await addPasskey(admin, credentialId);
    await db('admin_users').where({ id: admin.id }).update({ two_factor_enabled: true });
    return admin;
  }

  async function passwordStep(admin) {
    const res = await request(authApp).post('/api/auth/admin/login').set('Origin', ORIGIN)
      .send({ username: admin.username, password: PASSWORD });
    expect(res.status).toBe(200);
    return res.body;
  }

  it('the password step says whether a passkey can stand in for the code', async () => {
    const withKey = await seedWithPasskey('cred-2fa-flag');
    const without = await seedAdmin({ two_factor_enabled: true });
    expect(await passwordStep(withKey)).toMatchObject({ mfaRequired: true, passkeyAvailable: true });
    expect(await passwordStep(without)).toMatchObject({ mfaRequired: true, passkeyAvailable: false });
  });

  it('completes the login with one of the account\'s own passkeys', async () => {
    const admin = await seedWithPasskey('cred-2fa');
    const { mfaToken } = await passwordStep(admin);

    const options = await loginOptions({ mfaToken });
    expect(options.status).toBe(200);
    expect(options.body.options.allowCredentials.map((c) => c.id)).toEqual(['cred-2fa']);
    expect(jwt.decode(cookieOf(options).split('=')[1])).toMatchObject({ purpose: 'mfa', uid: admin.id });

    accept();
    const res = await loginVerify(cookieOf(options), { mfaToken, response: { id: 'cred-2fa' } });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(admin.id);
    expect(res.headers['set-cookie'].some((c) => c.startsWith('admin_token='))).toBe(true);
    const activity = await db('activity_logs').where({ activity_type: 'admin_mfa_login' }).orderBy('id', 'desc').first();
    expect(JSON.parse(activity.metadata)).toMatchObject({ method: 'passkey' });
  });

  it('does not accept another account\'s passkey, nor a challenge of the other kind', async () => {
    const admin = await seedWithPasskey('cred-2fa-own');
    const other = await seedAdmin();
    await addPasskey(other, 'cred-2fa-foreign');
    const { mfaToken } = await passwordStep(admin);

    const foreign = await loginVerify(cookieOf(await loginOptions({ mfaToken })), { mfaToken, response: { id: 'cred-2fa-foreign' } });
    expect(foreign.status).toBe(401);
    expect(foreign.body).toEqual(FAILED);

    // A passwordless challenge cannot finish the second-factor step...
    const primary = await loginVerify(cookieOf(await loginOptions()), { mfaToken, response: { id: 'cred-2fa-own' } });
    expect(primary.body.code).toBe('PASSKEY_CHALLENGE_INVALID');
    // ...and a second-factor challenge cannot finish a passwordless login.
    const second = await loginVerify(cookieOf(await loginOptions({ mfaToken })), { response: { id: 'cred-2fa-own' } });
    expect(second.body.code).toBe('PASSKEY_CHALLENGE_INVALID');
    expect(mockVerifyAuthentication).not.toHaveBeenCalled();

    // Failures land in the second factor's account-wide bucket.
    expect(await db('login_attempts').where({ identifier: `mfa:${admin.id}` })).toHaveLength(1);
  });

  it('needs a live mfa_pending token', async () => {
    const res = await loginOptions({ mfaToken: 'not-a-token' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('MFA_SESSION_EXPIRED');
  });
});

describe('public settings', () => {
  it('names the passkey origin only while a passkey login can work', async () => {
    const app = buildRouteApp('/api/public/settings', require('../../src/routes/publicSettings'));
    const read = async () => (await request(app).get('/api/public/settings')).body.passkey_origin;

    const admin = await seedAdmin();
    await addPasskey(admin, 'cred-public');
    expect(await read()).toBe(ORIGIN);

    process.env.FRONTEND_URL = 'http://10.0.0.5';
    expect(await read()).toBeNull();
  });
});
