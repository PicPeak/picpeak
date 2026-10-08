'use strict';

const knex = require('knex');
const migration = require('../../migrations/core/280_portable_restore_control');
const runtime = require('../../src/services/portableRestoreRuntimeState');

describe('native restore preserves target portable authority', () => {
  let db;
  beforeEach(async () => {
    db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await migration.up(db);
    await db('portable_restore_control').insert({ id: 1, storage_id: 'target-storage', generation: 4, revision: 8 });
    await db('portable_restore_instances').insert({ instance_id: 'target-live-node', generation: 4,
      storage_id: 'target-storage', boot_id: 'target-boot', lease_json: '{"inode":42}' });
    await db('portable_restore_commits').insert({ attempt_id: 'target-commit', local_plan_checksum: 'a'.repeat(64),
      options_digest: 'b'.repeat(64) });
  });
  afterEach(async () => { await db.destroy(); });

  test('recreates an old capture schema and restores the exact target cohort', async () => {
    const state = await runtime.snapshot(db);
    await db.schema.dropTable('portable_restore_commits');
    await db.schema.dropTable('portable_restore_instances');
    await db.schema.dropTable('portable_restore_control');
    await runtime.restore(db, state);
    for (const table of Object.keys(state)) expect(await db(table).select('*')).toEqual(state[table]);
  });

  test('foreign native runtime rows never replace current installation authority', async () => {
    const state = await runtime.snapshot(db);
    await db('portable_restore_control').update({ storage_id: 'foreign-storage', generation: 99 });
    await db('portable_restore_instances').del();
    await db('portable_restore_instances').insert({ instance_id: 'foreign-node', generation: 99,
      storage_id: 'foreign-storage', boot_id: 'foreign-boot', lease_json: '{}' });
    await runtime.restore(db, state);
    expect((await db('portable_restore_control').first()).storage_id).toBe('target-storage');
    expect((await db('portable_restore_instances').first()).instance_id).toBe('target-live-node');
    expect(await db('portable_restore_commits').select('*')).toEqual(state.portable_restore_commits);
  });

  test('rejects an oversized runtime record before native database replacement', async () => {
    await db('portable_restore_control').update({ result_json: 'x'.repeat(65537) });
    await expect(runtime.snapshot(db)).rejects.toThrow('record limit');
    expect((await db('portable_restore_control').first()).storage_id).toBe('target-storage');
  });

  test('rejects foreign table names before deleting any target authority', async () => {
    const state = await runtime.snapshot(db);
    state.foreign_table = [];
    await expect(runtime.restore(db, state)).rejects.toThrow('Invalid target');
    expect((await db('portable_restore_instances').first()).instance_id).toBe('target-live-node');
  });
});
