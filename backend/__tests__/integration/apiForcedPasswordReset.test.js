const request = require('supertest');
const knex = require('knex');
const { randomUUID } = require('crypto');
const { bootCrmDb, seedMinimal, assignAdminRole, buildRouteApp } = require('./helpers/crmDb');
const pgUrl = process.env.PICPEAK_PG_TEST_URL;
let db; let cleanup; let app; let adminId; let otherId; let owner; let schema; let token;
beforeAll(async () => {
  if (pgUrl) {
    schema = `api_reset_${randomUUID().replace(/-/g, '')}`;
    owner = knex({ client: 'pg', connection: pgUrl });
    await owner.schema.createSchema(schema);
    process.env.DATABASE_CLIENT = 'pg';
    jest.doMock('../../knexfile', () => ({ client: 'pg', connection: pgUrl, searchPath: [schema] }));
  }
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId } = await seedMinimal(db));
  await assignAdminRole(db, adminId);
  const [other] = await db('admin_users').insert({ username: 'other', email: 'other@example.test', password_hash: 'unused',
    is_active: true, must_change_password: false }).returning('id');
  otherId = other.id ?? other;
  await assignAdminRole(db, otherId);
  const { generateApiToken } = require('../../src/middleware/apiTokenAuth');
  token = generateApiToken();
  await db('api_tokens').insert({ name: 'owner-key', hashed_token: token.hashed, preview: token.preview, scopes: 'read', created_by: adminId });
  const otherToken = generateApiToken();
  await db('api_tokens').insert({ name: 'other-key', hashed_token: otherToken.hashed, preview: otherToken.preview, scopes: 'read', created_by: otherId });
  app = buildRouteApp('/v1', require('../../src/routes/v1/events'));
});
afterAll(async () => {
  if (cleanup) await cleanup();
  if (owner) { await owner.schema.dropSchema(schema, true); await owner.destroy(); }
});
const callApi = () => request(app).get('/v1/events').set('Authorization', `Bearer ${token.plaintext}`);

test('existing keys respect a forced-change flag before any protected API handler runs', async () => {
  await callApi().expect(200);
  await db('admin_users').where({ id: adminId }).update({ must_change_password: true });
  const denied = await callApi().expect(403);
  expect(denied.body.code).toBe('MUST_CHANGE_PASSWORD');
  await db('admin_users').where({ id: adminId }).update({ must_change_password: false });
});
test('forced reset revokes only the target account keys permanently', async () => {
  await require('../../src/services/userManagementService').resetAdminPassword(adminId, otherId);
  expect((await db('api_tokens').where({ created_by: adminId }).first()).revoked_at).toBeTruthy();
  expect((await db('api_tokens').where({ created_by: otherId }).first()).revoked_at).toBeFalsy();
  await db('admin_users').where({ id: adminId }).update({ must_change_password: false });
  const denied = await callApi().expect(401);
  expect(denied.body.code).toBe('TOKEN_REVOKED');
});

test('upgrade revokes already-pending reset keys and is idempotent', async () => {
  await db('admin_users').where({ id: otherId }).update({ must_change_password: true });
  const migration = require('../../migrations/core/230_revoke_forced_reset_api_tokens');
  await migration.up(db);
  const row = await db('api_tokens').where({ created_by: otherId }).first();
  expect(row.revoked_at).toBeTruthy();
  await migration.up(db);
  await migration.down(db);
  expect((await db('api_tokens').where({ id: row.id }).first()).revoked_at).toEqual(row.revoked_at);
});

test('failed revocation rolls back the password reset', async () => {
  const before = await db('admin_users').where({ id: adminId }).first();
  const prototype = Object.getPrototypeOf(db.client);
  const original = prototype._query;
  const query = jest.spyOn(prototype, '_query').mockImplementation(function(connection, queryObject) {
    if (/^update ["`]api_tokens["`]/i.test(queryObject.sql)) return Promise.reject(new Error('injected revocation failure'));
    return original.call(this, connection, queryObject);
  });
  try {
    await expect(require('../../src/services/adminPasswordReset').setAdminPasswordForReset(adminId, 'changed-hash'))
      .rejects.toThrow('injected revocation failure');
  } finally { query.mockRestore(); }
  const after = await db('admin_users').where({ id: adminId }).first();
  expect(after.password_hash).toBe(before.password_hash);
  expect(after.must_change_password).toBe(before.must_change_password);
});
