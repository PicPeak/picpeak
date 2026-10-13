/**
 * Admin passkeys against the REAL @simplewebauthn/server (issue 1733).
 *
 * adminPasskeys.test.js mocks the library's verify calls to drive the route
 * logic. This suite mocks nothing: a software authenticator (a P-256 key that
 * builds the attestation and assertion bytes a browser would send) goes
 * through the same routes, so what is pinned here is the contract between
 * this repo and the library: the options it is given, the stored public key
 * it gets back, and that a wrong origin, a wrong RP ID, a missing user
 * verification, a foreign key or a stale counter are refused by it.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-passkeys-real-test-'));
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'db.sqlite');
process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
fs.mkdirSync(process.env.STORAGE_PATH, { recursive: true });
process.env.JWT_SECRET = process.env.JWT_SECRET || 'passkey-real-test-secret';
delete process.env.RECAPTCHA_SECRET_KEY;
delete process.env.OIDC_BREAK_GLASS;

const ORIGIN = 'https://photos.example.com';
const RP_ID = 'photos.example.com';
process.env.FRONTEND_URL = ORIGIN;

const request = require('supertest');
const bcrypt = require('bcrypt');

const { bootCrmDb, mintAdminToken, buildRouteApp } = require('../integration/helpers/crmDb');

jest.setTimeout(120000);

// ── a software authenticator ───────────────────────────────────────────────

const b64u = (buffer) => Buffer.from(buffer).toString('base64url');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest();

// Just enough CBOR for an attestation object and a COSE key.
function cborHead(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
}
function cbor(value) {
  if (typeof value === 'number') return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  if (typeof value === 'string') return Buffer.concat([cborHead(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (Buffer.isBuffer(value)) return Buffer.concat([cborHead(2, value.length), value]);
  const entries = [...value.entries()];
  return Buffer.concat([cborHead(5, entries.length), ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)])]);
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

function createAuthenticator() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credentialId = crypto.randomBytes(32);
  const coseKey = cbor(new Map([
    [1, 2], [3, -7], [-1, 1],
    [-2, Buffer.from(jwk.x, 'base64url')],
    [-3, Buffer.from(jwk.y, 'base64url')],
  ]));
  const counterBytes = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const clientData = (type, challenge, origin) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));

  return {
    id: b64u(credentialId),
    attest(options, { origin = ORIGIN, rpId = RP_ID, flags = FLAG_UP | FLAG_UV | FLAG_AT, counter = 0 } = {}) {
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([
        sha256(rpId), Buffer.from([flags]), counterBytes(counter),
        Buffer.alloc(16), idLength, credentialId, coseKey,
      ]);
      return {
        id: b64u(credentialId),
        rawId: b64u(credentialId),
        type: 'public-key',
        response: {
          clientDataJSON: b64u(clientData('webauthn.create', options.challenge, origin)),
          attestationObject: b64u(cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))),
          transports: ['internal'],
        },
        clientExtensionResults: {},
      };
    },
    assert(options, { origin = ORIGIN, rpId = RP_ID, flags = FLAG_UP | FLAG_UV, counter = 0, key = privateKey } = {}) {
      const authData = Buffer.concat([sha256(rpId), Buffer.from([flags]), counterBytes(counter)]);
      const clientDataJSON = clientData('webauthn.get', options.challenge, origin);
      const signature = crypto.sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), key);
      return {
        id: b64u(credentialId),
        rawId: b64u(credentialId),
        type: 'public-key',
        response: {
          clientDataJSON: b64u(clientDataJSON),
          authenticatorData: b64u(authData),
          signature: b64u(signature),
        },
        clientExtensionResults: {},
      };
    },
  };
}

// ── harness ────────────────────────────────────────────────────────────────

const PASSWORD = 'correct-horse';
let db;
let cleanup;
let adminApp;
let authApp;
let passwordHash;

async function seedAdmin() {
  const uname = `real-${Math.random().toString(36).slice(2, 10)}`;
  const inserted = await db('admin_users').insert({
    username: uname, email: `${uname}@example.com`, password_hash: passwordHash,
    must_change_password: false, is_active: true, created_at: new Date().toISOString(),
  }).returning('id');
  const id = inserted[0]?.id ?? inserted[0];
  return { id, username: uname, token: mintAdminToken(id) };
}

const cookieOf = (res) => {
  const line = (res.headers['set-cookie'] || []).find((c) => c.startsWith('passkey_challenge='));
  return line ? line.split(';')[0] : null;
};

const post = (app, url, { admin, cookie, body }) => {
  const req = request(app).post(url).set('Origin', ORIGIN);
  if (admin) req.set('Authorization', `Bearer ${admin.token}`);
  if (cookie) req.set('Cookie', cookie);
  return req.send(body);
};

async function register(admin, authenticator, attestOptions) {
  const options = await post(adminApp, '/api/admin/auth/passkeys/register/options', { admin, body: { currentPassword: PASSWORD } });
  expect(options.status).toBe(200);
  return post(adminApp, '/api/admin/auth/passkeys/register/verify', {
    admin,
    cookie: cookieOf(options),
    body: { name: 'Software key', response: authenticator.attest(options.body.options, attestOptions) },
  });
}

async function signIn(authenticator, assertOptions) {
  const options = await post(authApp, '/api/auth/admin/passkey/options', { body: {} });
  expect(options.status).toBe(200);
  return post(authApp, '/api/auth/admin/passkey/verify', {
    cookie: cookieOf(options),
    body: { response: authenticator.assert(options.body.options, assertOptions) },
  });
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  passwordHash = await bcrypt.hash(PASSWORD, 4);
  adminApp = buildRouteApp('/api/admin/auth', require('../../src/routes/adminAuth'));
  authApp = buildRouteApp('/api/auth', require('../../src/routes/auth'));
}, 120000);

afterAll(async () => {
  if (cleanup) await cleanup();
});

describe('registration, verified by the library', () => {
  it('accepts a user-verified credential for this origin and RP ID', async () => {
    const admin = await seedAdmin();
    const authenticator = createAuthenticator();
    const res = await register(admin, authenticator);
    expect(res.status).toBe(200);
    const row = await db('admin_webauthn_credentials').where({ credential_id: authenticator.id }).first();
    expect(row).toMatchObject({ admin_user_id: admin.id, name: 'Software key' });
    expect(JSON.parse(row.transports)).toEqual(['internal']);
  });

  it.each([
    ['another origin', { origin: 'https://photos.example.com.evil.test' }],
    ['another RP ID', { rpId: 'evil.test' }],
    ['no user verification', { flags: FLAG_UP | FLAG_AT }],
  ])('refuses %s', async (_label, attestOptions) => {
    const admin = await seedAdmin();
    const authenticator = createAuthenticator();
    const res = await register(admin, authenticator, attestOptions);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PASSKEY_VERIFICATION_FAILED');
    expect(await db('admin_webauthn_credentials').where({ credential_id: authenticator.id }).first()).toBeUndefined();
  });

  it('refuses a response signed over a challenge the server did not issue', async () => {
    const admin = await seedAdmin();
    const authenticator = createAuthenticator();
    const options = await post(adminApp, '/api/admin/auth/passkeys/register/options', { admin, body: { currentPassword: PASSWORD } });
    const res = await post(adminApp, '/api/admin/auth/passkeys/register/verify', {
      admin,
      cookie: cookieOf(options),
      body: { response: authenticator.attest({ challenge: b64u(crypto.randomBytes(32)) }) },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PASSKEY_VERIFICATION_FAILED');
  });
});

describe('sign-in, verified by the library', () => {
  it('signs in with the stored public key and advances the counter', async () => {
    const admin = await seedAdmin();
    const authenticator = createAuthenticator();
    expect((await register(admin, authenticator)).status).toBe(200);

    const first = await signIn(authenticator, { counter: 1 });
    expect(first.status).toBe(200);
    expect(first.body.user.id).toBe(admin.id);
    expect(first.headers['set-cookie'].some((c) => c.startsWith('admin_token='))).toBe(true);

    // A counter that does not advance is a clone or a replay.
    const stale = await signIn(authenticator, { counter: 1 });
    expect(stale.status).toBe(401);
    expect(await db('activity_logs').where({ activity_type: 'admin_passkey_counter_regression' })).toHaveLength(1);

    expect((await signIn(authenticator, { counter: 2 })).status).toBe(200);
    const row = await db('admin_webauthn_credentials').where({ credential_id: authenticator.id }).first();
    expect(Number(row.counter)).toBe(2);
  });

  it('signs in repeatedly with an authenticator that keeps no counter', async () => {
    const admin = await seedAdmin();
    const authenticator = createAuthenticator();
    expect((await register(admin, authenticator)).status).toBe(200);
    expect((await signIn(authenticator)).status).toBe(200);
    expect((await signIn(authenticator)).status).toBe(200);
  });

  it.each([
    ['another origin', () => ({ origin: 'https://evil.test' })],
    ['another RP ID', () => ({ rpId: 'evil.test' })],
    ['no user verification', () => ({ flags: FLAG_UP })],
    ['a signature from another key', () => ({ key: crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey })],
  ])('refuses %s', async (_label, assertOptions) => {
    const admin = await seedAdmin();
    const authenticator = createAuthenticator();
    expect((await register(admin, authenticator)).status).toBe(200);
    const res = await signIn(authenticator, assertOptions());
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Passkey sign-in failed', code: 'PASSKEY_INVALID' });
    expect((res.headers['set-cookie'] || []).some((c) => c.startsWith('admin_token='))).toBe(false);
  });

  it('refuses an assertion made for an earlier challenge', async () => {
    const admin = await seedAdmin();
    const authenticator = createAuthenticator();
    expect((await register(admin, authenticator)).status).toBe(200);

    const earlier = await post(authApp, '/api/auth/admin/passkey/options', { body: {} });
    const captured = authenticator.assert(earlier.body.options);
    const later = await post(authApp, '/api/auth/admin/passkey/options', { body: {} });
    const res = await post(authApp, '/api/auth/admin/passkey/verify', { cookie: cookieOf(later), body: { response: captured } });
    expect(res.status).toBe(401);
  });
});
