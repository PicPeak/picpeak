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
let captureOperatorPasskeys;
let preserveOperatorPasskeys;

beforeAll(() => {
  jest.doMock('../../knexfile', () => ({ client: 'sqlite3' }), { virtual: false });
  ({ reinjectCurrentAdmin, captureOperatorPasskeys, preserveOperatorPasskeys } =
    require('../../src/services/picpeakImportService'));
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

// Passkeys (issue 1733) are the operator's credentials as much as the password
// and the TOTP secret are: the archive must neither remove them nor attach
// keys of its own to the operator's account, which would sign in as them.
describe('operator passkeys', () => {
  const now = '2026-10-01T00:00:00.000Z';
  const key = (id, adminId, credentialId, extra = {}) => ({
    id, admin_user_id: adminId, credential_id: credentialId, public_key: `PUB_${credentialId}`,
    counter: 0, name: credentialId, created_at: now, ...extra,
  });

  beforeEach(async () => {
    await db.schema.createTable('admin_webauthn_credentials', (t) => {
      t.increments('id');
      t.integer('admin_user_id').notNullable();
      t.string('credential_id').notNullable().unique();
      t.text('public_key').notNullable();
      t.bigInteger('counter').notNullable().defaultTo(0);
      t.text('transports');
      t.string('aaguid');
      t.string('name').notNullable();
      t.datetime('created_at').notNullable();
      t.datetime('last_used_at');
    });
  });

  // What the restore does around the wipe: snapshot, replace the rows with
  // the archive's, re-insert the operator, then restore their passkeys.
  async function restore({ before, archivedAdmins, archivedKeys }) {
    await db('admin_users').insert({ ...operator });
    if (before.length) await db('admin_webauthn_credentials').insert(before);
    return db.transaction(async (trx) => {
      const snapshot = await captureOperatorPasskeys(trx, operator.id);
      await trx('admin_webauthn_credentials').del();
      await trx('admin_users').del();
      if (archivedAdmins.length) await trx('admin_users').insert(archivedAdmins);
      if (archivedKeys.length) await trx('admin_webauthn_credentials').insert(archivedKeys);
      const operatorId = await reinjectCurrentAdmin(trx, operator);
      await preserveOperatorPasskeys(trx, operatorId, snapshot);
      return operatorId;
    });
  }

  const keysOf = (adminId) => db('admin_webauthn_credentials').where({ admin_user_id: adminId }).orderBy('id');

  test('replaces archived keys on the matching account with the operator\'s own', async () => {
    const operatorId = await restore({
      before: [key(1, operator.id, 'op-key', { counter: 41, transports: '["internal"]', last_used_at: now })],
      archivedAdmins: [
        { id: 7, username: 'someoneelse', email: 'OP@example.com', password_hash: 'ATTACKER' },
        { id: 8, username: 'colleague', email: 'colleague@example.com', password_hash: 'C' },
      ],
      archivedKeys: [key(1, 7, 'archived-key'), key(2, 8, 'colleague-key')],
    });

    expect(operatorId).toBe(7);
    const own = await keysOf(7);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({
      credential_id: 'op-key', public_key: 'PUB_op-key', counter: 41,
      transports: '["internal"]', name: 'op-key', last_used_at: now,
    });
    expect(await db('admin_webauthn_credentials').where({ credential_id: 'archived-key' }).first()).toBeUndefined();
    // Nobody else's keys are touched, and the re-inserted row took a free id.
    expect((await keysOf(8)).map((row) => row.credential_id)).toEqual(['colleague-key']);
    expect(own[0].id).toBe(3);
  });

  test('removes archived keys from the operator\'s account when the operator has none', async () => {
    await restore({
      before: [],
      archivedAdmins: [{ id: 7, username: 'someoneelse', email: 'op@example.com', password_hash: 'ATTACKER' }],
      archivedKeys: [key(1, 7, 'archived-key')],
    });
    expect(await db('admin_webauthn_credentials')).toHaveLength(0);
  });

  test('the operator\'s key wins over an archived row that claims its credential id for another account', async () => {
    const operatorId = await restore({
      before: [key(1, operator.id, 'op-key')],
      archivedAdmins: [{ id: 8, username: 'colleague', email: 'colleague@example.com', password_hash: 'C' }],
      archivedKeys: [key(5, 8, 'op-key', { public_key: 'ATTACKER_PUB' })],
    });
    const rows = await db('admin_webauthn_credentials');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ admin_user_id: operatorId, credential_id: 'op-key', public_key: 'PUB_op-key' });
  });

  test('a fresh operator row does not inherit archived keys that point at its new id', async () => {
    // FK checks are suspended during the load, so an archive can carry keys
    // for an account id it does not contain: the one the operator will get.
    const operatorId = await restore({
      before: [key(1, operator.id, 'op-key')],
      archivedAdmins: [{ id: 9, username: 'backupadmin', email: 'backup@instance.test', password_hash: 'B' }],
      archivedKeys: [key(1, 10, 'planted-key')],
    });
    expect(operatorId).toBe(10);
    expect((await keysOf(10)).map((row) => row.credential_id)).toEqual(['op-key']);
  });

  test('does nothing on a schema without the table', async () => {
    await db.schema.dropTable('admin_webauthn_credentials');
    await db('admin_users').insert({ ...operator });
    await db.transaction(async (trx) => {
      const snapshot = await captureOperatorPasskeys(trx, operator.id);
      expect(snapshot).toEqual([]);
      await expect(preserveOperatorPasskeys(trx, operator.id, snapshot)).resolves.toBeUndefined();
    });
  });
});
