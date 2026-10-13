/**
 * Passkey writes that have to queue on the account row (issue 1733): the cap
 * under concurrent registrations, the last-way-in check under concurrent
 * removals, and the order the admin hard delete takes its locks in.
 *
 * The cap:
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

const passkeyRow = (adminId, credentialId) => ({
  admin_user_id: adminId, credential_id: credentialId, public_key: 'AQ', counter: 0,
  name: credentialId, created_at: new Date().toISOString(),
});

async function seedAccount(username, overrides = {}) {
  const inserted = await db('admin_users').insert({
    username, email: `${username}@example.com`, password_hash: 'unused',
    must_change_password: false, is_active: true, created_at: new Date().toISOString(), ...overrides,
  }).returning('id');
  return inserted[0]?.id ?? inserted[0];
}

// An account without a password must keep one passkey: it is its only way in.
// The route counts and then deletes; on PostgreSQL two removals would both
// count two unless they queue on the account row.
it('two concurrent removals from an account without a password leave one passkey', async () => {
  const adminId = await seedAccount('last-way-in', { password_hash: '' });
  const token = mintAdminToken(adminId);
  await db('admin_webauthn_credentials').insert([passkeyRow(adminId, 'last-a'), passkeyRow(adminId, 'last-b')]);
  const ids = (await db('admin_webauthn_credentials').where({ admin_user_id: adminId }).select('id')).map((row) => row.id);

  const results = await Promise.all(ids.map((id) => request(app)
    .post(`/api/admin/auth/passkeys/${id}/delete`)
    .set('Authorization', `Bearer ${token}`).set('Origin', ORIGIN).send({})));

  expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
  expect(await passkeyService.countForAdmin(adminId)).toBe(1);
});

// Registration, removal and the password reset lock the account row and then
// touch its passkeys. The hard delete removes the passkeys too; doing that
// before it holds the account row is the reverse order and can deadlock with
// any of them. Observable only with row locks, so PostgreSQL only.
(pgUrl ? it : it.skip)('the hard delete takes the account row before it touches the passkeys', async () => {
  const role = await db('roles').where({ name: 'super_admin' }).first();
  const actorId = await seedAccount('lock-order-actor', { role_id: role.id });
  const targetId = await seedAccount('lock-order-target');
  await db('admin_webauthn_credentials').insert(passkeyRow(targetId, 'lock-order-key'));

  const other = knex({ client: 'pg', connection: pgUrl, searchPath: [schema] });
  const holder = await other.transaction();
  let deletion;
  try {
    const pid = (await holder.raw('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await holder('admin_users').where({ id: targetId }).forUpdate().first();

    deletion = require('../../src/services/userManagementService').deleteAdminUser(targetId, actorId);
    deletion.catch(() => {});
    const deadline = Date.now() + 30000;
    for (;;) {
      const blocked = await other.raw('SELECT pid FROM pg_stat_activity WHERE ? = ANY(pg_blocking_pids(pid))', [pid]);
      if (blocked.rows.length) break;
      if (Date.now() > deadline) throw new Error('the hard delete never waited for the account row');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // Still free: the delete is waiting for the account row and has not
    // locked the passkeys behind it.
    const free = await holder('admin_webauthn_credentials').where({ admin_user_id: targetId }).forUpdate().noWait();
    expect(free).toHaveLength(1);
    await holder.commit();
    await deletion;
    expect(await db('admin_webauthn_credentials').where({ admin_user_id: targetId })).toHaveLength(0);
    expect(await db('admin_users').where({ id: targetId }).first()).toBeUndefined();
  } finally {
    if (!holder.isCompleted()) await holder.rollback();
    await other.destroy();
  }
});
