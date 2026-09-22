const knex = require('knex');
const { randomUUID } = require('crypto');
const migration = require('../../migrations/core/229_login_attempts');
const legacyMigration = require('../../migrations/legacy/015_add_login_attempts_table');

const pgUrl = process.env.PICPEAK_PG_TEST_URL;
let db; let owner; let schema; let cleanup; let security;
beforeAll(async () => {
  if (pgUrl) {
    schema = `login_attempts_${randomUUID().replace(/-/g, '')}`;
    owner = knex({ client: 'pg', connection: pgUrl });
    await owner.schema.createSchema(schema);
    process.env.DATABASE_CLIENT = 'pg';
    jest.doMock('../../knexfile', () => ({ client: 'pg', connection: pgUrl, searchPath: [schema] }));
  }
  ({ db, cleanup } = await require('../integration/helpers/crmDb').bootCrmDb());
  security = require('../../src/utils/authSecurity');
});
afterAll(async () => {
  if (cleanup) await cleanup();
  if (owner) { await owner.schema.dropSchema(schema, true); await owner.destroy(); }
});

test('fresh core migrations create working account lockout across source IPs', async () => {
  await expect(security.assertAuthSecuritySchema()).resolves.toBeUndefined();
  const { maxAttempts } = await security.getSecurityConfig();
  for (let i = 0; i < maxAttempts; i++) {
    await security.trackFailedAttempt('account', `192.0.2.${i + 1}`, 'test');
  }
  expect(await security.checkAccountLockout('account')).toMatchObject({ isLocked: true });
  expect(await security.checkAccountLockout('unrelated')).toEqual({ isLocked: false });
});

test('repeated core/legacy migrations and rollback retain attempts', async () => {
  const before = await db('login_attempts').count('* as count').first();
  await migration.up(db);
  await legacyMigration.up(db);
  await migration.down(db);
  expect(await db('login_attempts').count('* as count').first()).toEqual(before);
});

test('missing schema fails the startup check and never disables account lockout', async () => {
  await db.schema.dropTable('login_attempts');
  await expect(security.assertAuthSecuritySchema()).rejects.toThrow(/migrations/);
  expect(await security.checkAccountLockout('account')).toMatchObject({ isLocked: true });
  await migration.up(db);
  await expect(security.assertAuthSecuritySchema()).resolves.toBeUndefined();
});
