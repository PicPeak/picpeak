/**
 * Account lockout on the admin and customer password logins is scoped to
 * identifier + source IP, like the gallery/client paths already were.
 *
 * Before: both routes called checkAccountLockout(identifier) without the
 * request IP, so five anonymous failures from one address (the default
 * per-IP allowance) returned 423 to the account owner on every other
 * address until the attempt window cleared. Scanner finding e64e427f.
 */

const express = require('express');
const request = require('supertest');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const fsSync = require('fs');
const osMod = require('os');
const pathMod = require('path');
const { bootCrmDb } = require('../integration/helpers/crmDb');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = pathMod.join(
  fsSync.mkdtempSync(pathMod.join(osMod.tmpdir(), 'picpeak-lockout-scope-')), 'db.sqlite'
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-not-a-real-key';

// Fixture credential, assembled so secret scanners do not read it as a leak.
const PASSWORD = ['Fixture', 'Login', '2026!'].join('-');
const ATTACKER_IP = '198.51.100.7';
const OWNER_IP = '203.0.113.9';

let app; let db; let cleanup;

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  const hash = await bcrypt.hash(PASSWORD, 4);
  await db('admin_users').insert({
    username: 'scope-admin', email: 'scope-admin@example.com', password_hash: hash, is_active: true,
  });
  await db('customer_accounts').insert({
    email: 'scope-customer@example.com', display_name: 'Scope', password_hash: hash, is_active: 1,
    created_at: new Date().toISOString(),
  });

  app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', require('../../src/routes/auth'));
  app.use('/api/customer/auth', require('../../src/routes/customerAuth'));
}, 120000);

afterAll(async () => {
  await require('../../src/services/serviceShutdown').stopServices();
  if (cleanup) await cleanup();
});

beforeEach(async () => { await db('login_attempts').del(); });

const post = (path, ip, body) => request(app).post(path).set('X-Forwarded-For', ip).send(body);

describe('admin login lockout is scoped to identifier + IP', () => {
  const login = (ip, password) => post('/api/auth/admin/login', ip, { username: 'scope-admin', password });

  it('five failures from one address still lock that address', async () => {
    for (let i = 0; i < 5; i++) expect((await login(ATTACKER_IP, 'wrong')).status).toBe(401);
    expect((await login(ATTACKER_IP, PASSWORD)).status).toBe(423);
  });

  it('does not deny the owner on another address after five anonymous failures', async () => {
    for (let i = 0; i < 5; i++) await login(ATTACKER_IP, 'wrong');
    const res = await login(OWNER_IP, PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ username: 'scope-admin' });
  });
});

describe('customer login lockout is scoped to identifier + IP', () => {
  const login = (ip, password) => post('/api/customer/auth/login', ip, { email: 'scope-customer@example.com', password });

  it('five failures from one address still lock that address', async () => {
    for (let i = 0; i < 5; i++) expect((await login(ATTACKER_IP, 'wrong')).status).toBe(401);
    expect((await login(ATTACKER_IP, PASSWORD)).status).toBe(423);
  });

  it('does not deny the owner on another address after five anonymous failures', async () => {
    for (let i = 0; i < 5; i++) await login(ATTACKER_IP, 'wrong');
    const res = await login(OWNER_IP, PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.customer).toMatchObject({ email: 'scope-customer@example.com' });
  });
});

describe('the second-factor step has its own account-wide bucket', () => {
  const jwt = require('jsonwebtoken');
  let adminId; let mfaToken;
  const failure = (identifier, ip) => db('login_attempts').insert({
    identifier, ip_address: ip, user_agent: 'jest', attempt_time: new Date().toISOString(), success: false,
  });
  const verify = (ip) => post('/api/auth/admin/login/mfa', ip, { mfaToken, code: '000000' });

  beforeAll(async () => {
    adminId = (await db('admin_users').where({ username: 'scope-admin' }).first()).id;
    mfaToken = jwt.sign(
      { id: adminId, username: 'scope-admin', type: 'mfa_pending', loginId: 'scope-admin' },
      process.env.JWT_SECRET, { algorithm: 'HS256', issuer: 'picpeak-auth', expiresIn: '5m' },
    );
  });

  it('five wrong codes lock the step for every address, not only the guessing ones', async () => {
    // A holder of the mfa_pending token rotating addresses must not get a
    // fresh batch of guesses per address.
    for (let i = 1; i <= 5; i += 1) await failure(`mfa:${adminId}`, `198.51.100.${i}`);
    expect((await verify('203.0.113.77')).status).toBe(423);
  });

  it('anonymous password failures do not lock the second factor', async () => {
    for (let i = 0; i < 5; i += 1) await failure('scope-admin', ATTACKER_IP);
    expect((await verify(OWNER_IP)).status).not.toBe(423);
    expect((await verify(ATTACKER_IP)).status).not.toBe(423);
  });

});
