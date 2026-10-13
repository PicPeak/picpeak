/**
 * The passkey cap under concurrent registrations (issue 1733).
 *
 * finishRegistration counts the account's passkeys and then inserts. On
 * PostgreSQL (READ COMMITTED, one connection per request) two requests that
 * finish together both count nine and both insert, leaving eleven; the
 * account row is locked first so the second count sees the first insert.
 *
 * The race needs PostgreSQL: with PICPEAK_PG_TEST_URL this suite runs there,
 * in a schema of its own. Without it the suite runs on SQLite, whose single
 * connection serializes the requests anyway, and only pins the outcome.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { randomUUID } = require('crypto');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-passkey-race-test-'));
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'db.sqlite');
process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
fs.mkdirSync(process.env.STORAGE_PATH, { recursive: true });
process.env.JWT_SECRET = process.env.JWT_SECRET || 'passkey-race-test-secret';

const ORIGIN = 'https://photos.example.com';
process.env.FRONTEND_URL = ORIGIN;

const mockVerifyRegistration = jest.fn();
jest.mock('@simplewebauthn/server', () => ({
  ...jest.requireActual('@simplewebauthn/server'),
  verifyRegistrationResponse: (...args) => mockVerifyRegistration(...args),
}));

const request = require('supertest');
const bcrypt = require('bcrypt');
const knex = require('knex');

const { bootCrmDb, mintAdminToken, buildRouteApp } = require('./helpers/crmDb');

jest.setTimeout(120000);

const pgUrl = process.env.PICPEAK_PG_TEST_URL;
const PASSWORD = 'correct-horse';
const CONTENDERS = 6;

let db; let cleanup; let owner; let schema; let app; let passkeyService;

beforeAll(async () => {
  if (pgUrl) {
    schema = `passkey_race_${randomUUID().replace(/-/g, '')}`;
    owner = knex({ client: 'pg', connection: pgUrl });
    await owner.schema.createSchema(schema);
    process.env.DATABASE_CLIENT = 'pg';
    jest.doMock('../../knexfile', () => ({ client: 'pg', connection: pgUrl, searchPath: [schema] }));
  }
  ({ db, cleanup } = await bootCrmDb());
  passkeyService = require('../../src/services/passkeyService');
  app = buildRouteApp('/api/admin/auth', require('../../src/routes/adminAuth'));
}, 120000);

afterAll(async () => {
  if (cleanup) await cleanup();
  if (owner) { await owner.schema.dropSchema(schema, true); await owner.destroy(); }
});

it('lets exactly one of several concurrent registrations take the last free slot', async () => {
  const inserted = await db('admin_users').insert({
    username: 'race', email: 'race@example.com', password_hash: await bcrypt.hash(PASSWORD, 4),
    must_change_password: false, is_active: true, created_at: new Date().toISOString(),
  }).returning('id');
  const adminId = inserted[0]?.id ?? inserted[0];
  const token = mintAdminToken(adminId);
  const now = new Date().toISOString();
  await db('admin_webauthn_credentials').insert(
    Array.from({ length: passkeyService.MAX_PASSKEYS_PER_ADMIN - 1 }, (_, i) => ({
      admin_user_id: adminId, credential_id: `race-seed-${i}`, public_key: 'AQ', counter: 0, name: `k${i}`, created_at: now,
    }))
  );

  const cookies = [];
  for (let i = 0; i < CONTENDERS; i += 1) {
    const options = await request(app).post('/api/admin/auth/passkeys/register/options')
      .set('Authorization', `Bearer ${token}`).set('Origin', ORIGIN).send({ currentPassword: PASSWORD });
    expect(options.status).toBe(200);
    cookies.push(options.headers['set-cookie'].find((c) => c.startsWith('passkey_challenge=')).split(';')[0]);
  }

  let n = 0;
  mockVerifyRegistration.mockImplementation(async () => ({
    verified: true,
    registrationInfo: {
      aaguid: '00000000-0000-0000-0000-000000000000',
      credential: { id: `race-new-${n += 1}`, publicKey: new Uint8Array([1, 2, 3, 4]), counter: 0, transports: ['internal'] },
    },
  }));

  const results = await Promise.all(cookies.map((cookie) => request(app)
    .post('/api/admin/auth/passkeys/register/verify')
    .set('Authorization', `Bearer ${token}`).set('Origin', ORIGIN).set('Cookie', cookie)
    .send({ response: { id: 'ignored' }, name: 'Racer' })));

  expect(results.map((res) => res.status).sort()).toEqual([200, ...Array(CONTENDERS - 1).fill(409)]);
  expect(results.filter((res) => res.status === 409).map((res) => res.body.code))
    .toEqual(Array(CONTENDERS - 1).fill('PASSKEY_LIMIT'));
  expect(await passkeyService.countForAdmin(adminId)).toBe(passkeyService.MAX_PASSKEYS_PER_ADMIN);
});
