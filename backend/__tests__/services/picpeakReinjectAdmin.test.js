/**
 * Regression tests for reinjectCurrentAdmin — the operator-preservation step of
 * the .picpeak restore (GHSA-qxfx-4493-4v8f follow-up). Runs against a real
 * in-memory SQLite DB so the UNIQUE(email)/UNIQUE(username) constraints behave
 * as in production. Reconciliation is non-destructive (update-in-place / rename,
 * never delete) so restored rows referenced by FKs keep their ids.
 */
const knex = require('knex');

let db;
let reinjectCurrentAdmin;

beforeAll(() => {
  jest.doMock('../../knexfile', () => ({ client: 'sqlite3' }), { virtual: false });
  reinjectCurrentAdmin = require('../../src/services/picpeakImportService').reinjectCurrentAdmin;
});

beforeEach(async () => {
  db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await db.schema.createTable('admin_users', (t) => {
    t.increments('id');
    t.string('username').notNullable().unique();
    t.string('email').notNullable().unique();
    t.string('password_hash');
    t.boolean('is_active').defaultTo(true);
    t.boolean('must_change_password').defaultTo(false);
    t.integer('role_id');
    t.integer('created_by');
    t.boolean('two_factor_enabled').defaultTo(false);
    t.string('two_factor_secret');
    t.text('two_factor_recovery_codes');
  });
});

afterEach(async () => { await db.destroy(); });

const operator = {
  id: 1, username: 'admin', email: 'op@example.com',
  password_hash: 'OP_HASH', is_active: 1, must_change_password: 0, role_id: 1, created_by: 99,
  two_factor_enabled: 1, two_factor_secret: 'OP_SECRET', two_factor_recovery_codes: '["a","b"]',
};

test('restores login + MFA in place, keeping the row id and its FK columns (FK-safe)', async () => {
  await db('admin_users').insert({
    id: 7, username: 'someoneelse', email: 'OP@example.com',
    password_hash: 'ATTACKER', is_active: 1, must_change_password: 0, role_id: 4, created_by: 5,
    two_factor_enabled: 0, two_factor_secret: 'ATTACKER_SECRET', two_factor_recovery_codes: null,
  });
  await db.transaction((trx) => reinjectCurrentAdmin(trx, operator));

  const rows = await db('admin_users');
  expect(rows).toHaveLength(1);
  const row = rows[0];
  expect(row.id).toBe(7);                            // id preserved → FK refs hold
  expect(row.username).toBe('admin');
  expect(row.password_hash).toBe('OP_HASH');
  expect(Boolean(row.two_factor_enabled)).toBe(true);
  expect(row.two_factor_secret).toBe('OP_SECRET');   // attacker MFA secret gone
  expect(row.two_factor_recovery_codes).toBe('["a","b"]');
  // Relationship/audit FKs are NOT forced from the operator snapshot (avoids
  // dangling role_id/created_by on a cross-instance restore) — the restored
  // row keeps its own already-valid values.
  expect(row.role_id).toBe(4);
  expect(row.created_by).toBe(5);
});

test('renames (not deletes) a different row holding the operator username', async () => {
  await db('admin_users').insert({
    id: 3, username: 'admin', email: 'other@instance.test',
    password_hash: 'OTHER', is_active: 1, role_id: 4,
  });
  await expect(db.transaction((trx) => reinjectCurrentAdmin(trx, operator))).resolves.not.toThrow();

  const rows = await db('admin_users').orderBy('id');
  expect(rows).toHaveLength(2);                       // the other admin survives (FK-safe)
  const other = rows.find((r) => r.id === 3);
  expect(other.username).toBe('admin__restored_3');  // renamed, id kept
  expect(other.email).toBe('other@instance.test');
  const op = rows.find((r) => r.username === 'admin');
  expect(op.password_hash).toBe('OP_HASH');
});

test('reconciles email and username colliding with DIFFERENT rows without deleting either', async () => {
  await db('admin_users').insert([
    { id: 4, username: 'someoneelse', email: 'op@example.com', password_hash: 'A', role_id: 4 },
    { id: 5, username: 'admin', email: 'other@instance.test', password_hash: 'B', role_id: 4 },
  ]);
  await expect(db.transaction((trx) => reinjectCurrentAdmin(trx, operator))).resolves.not.toThrow();

  const rows = await db('admin_users').orderBy('id');
  expect(rows).toHaveLength(2);                       // both rows survive
  const opRow = rows.find((r) => r.id === 4);         // email match updated in place
  expect(opRow.username).toBe('admin');
  expect(opRow.password_hash).toBe('OP_HASH');
  const renamed = rows.find((r) => r.id === 5);       // username holder renamed, not deleted
  expect(renamed.username).toBe('admin__restored_5');
});

test('inserts the operator with a non-colliding id when neither key exists in the backup', async () => {
  await db('admin_users').insert({
    id: 9, username: 'backupadmin', email: 'backup@instance.test', password_hash: 'B', role_id: 1,
  });
  await db.transaction((trx) => reinjectCurrentAdmin(trx, operator));

  const rows = await db('admin_users').orderBy('id');
  expect(rows).toHaveLength(2);                       // backup admin untouched
  const opRow = rows.find((r) => r.username === 'admin');
  expect(opRow.password_hash).toBe('OP_HASH');
  expect(opRow.id).toBe(10);                          // max(9)+1, no collision
  expect(opRow.created_by).toBeNull();                // self-ref FK nulled so the insert can't dangle
});
