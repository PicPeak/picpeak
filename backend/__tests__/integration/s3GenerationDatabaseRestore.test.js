'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const knex = require('knex');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
// Set the owned DB before any service imports. Never use a default install DB.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-index-db-restore-'));
process.env.TEST_DATABASE_PATH = path.join(root, 'target.sqlite');
process.env.STORAGE_PATH = path.join(root, 'storage');
const { db, reinitPool } = require('../../src/database/db');
const index = require('../../src/services/storage/generationIndex');
const migration = require('../../migrations/core/250_storage_s3_generation_index');
const { DatabaseBackupService } = require('../../src/services/databaseBackup');
const { RestoreService } = require('../../src/services/restoreService');
const native = spawnSync('sqlite3', ['-version']).status === 0;
const nativeTest = native ? it : it.skip;
let snapshot;
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

beforeAll(async () => {
  fs.mkdirSync(path.join(root, 'storage'));
  await db.schema.createTable('app_settings', table => { table.string('setting_key').primary(); table.text('setting_value'); table.string('setting_type'); table.timestamp('updated_at'); });
  await db.schema.createTable('ordinary_rows', table => { table.integer('id').primary(); table.text('value'); });
  await migration.up(db);
  const rows = index.encodeRows('a'.repeat(64), new Map([['events/active/target.jpg', `.picpeak-generations/target-attempt/${crypto.randomUUID()}`]]));
  await db(index.TABLE).insert(rows); snapshot = await index.snapshotDatabaseIndex(db);
});
afterAll(async () => { await db.destroy(); fs.rmSync(root, { recursive: true, force: true }); });

async function capture(name, { old = false, corrupt = false } = {}) {
  const file = path.join(root, name);
  const source = knex({ client: 'sqlite3', connection: { filename: file }, useNullAsDefault: true });
  try {
    await source.schema.createTable('app_settings', table => { table.string('setting_key').primary(); table.text('setting_value'); table.string('setting_type'); table.timestamp('updated_at'); });
    await source.schema.createTable('ordinary_rows', table => { table.integer('id').primary(); table.text('value'); });
    await source('ordinary_rows').insert({ id: 1, value: old ? 'old-format-row' : 'foreign-row' });
    if (!old) { await migration.up(source); await source(index.TABLE).insert(index.encodeRows('b'.repeat(64), new Map())); }
  } finally { await source.destroy(); }
  if (corrupt) fs.writeFileSync(file, 'not a SQLite archive');
  return file;
}
async function restore(file) {
  const service = new RestoreService();
  return service.performDatabaseRestore(root, { database: { backup_file: file, checksum: hash(file) } }, {});
}

nativeTest('native SQLite full dump scrubs only copied index DATA, keeps schema/live map, excludes its checksum table', async () => {
  const file = path.join(root, 'scrubbed.sqlite');
  await new DatabaseBackupService().createSQLiteBackup(file);
  const copy = knex({ client: 'sqlite3', connection: { filename: file }, useNullAsDefault: true });
  try {
    expect(await copy.schema.hasTable(index.TABLE)).toBe(true); expect(await copy(index.TABLE)).toEqual([]);
    expect(await index.snapshotDatabaseIndex(db)).toEqual(snapshot);
    expect(await new DatabaseBackupService().getTables()).not.toContain(index.TABLE);
  } finally { await copy.destroy(); }
});

nativeTest('actual full database replacement ignores foreign map, and pre-index format reconstructs TARGET schema/map', async () => {
  await restore(await capture('foreign.sqlite'));
  expect(await index.snapshotDatabaseIndex(db)).toEqual(snapshot);
  expect((await db('ordinary_rows').first()).value).toBe('foreign-row');
  await restore(await capture('old.sqlite', { old: true }));
  expect(await index.snapshotDatabaseIndex(db)).toEqual(snapshot);
  expect((await db('ordinary_rows').first()).value).toBe('old-format-row');
});

nativeTest('failed native DB replacement and real gzip rollback preserve target index through pool reinitialization', async () => {
  await expect(restore(await capture('invalid.sqlite', { corrupt: true }))).rejects.toThrow();
  expect(await index.snapshotDatabaseIndex(db)).toEqual(snapshot);
  expect((await db('ordinary_rows').first()).value).toBe('old-format-row');
  const old = await capture('rollback-old.sqlite', { old: true });
  const rollback = path.join(root, 'safety'); fs.mkdirSync(rollback);
  fs.writeFileSync(path.join(rollback, 'backup-manifest.json'), '{}');
  fs.writeFileSync(path.join(rollback, 'database.sql.gz'), zlib.gzipSync(fs.readFileSync(old)));
  const service = new RestoreService();
  // Test the direct rollback caller, not merely snapshot/replay helpers.
  service.generationIndexSnapshot = snapshot;
  await service.attemptRollback(rollback);
  expect(await index.snapshotDatabaseIndex(db)).toEqual(snapshot);
  await reinitPool(); expect(await index.snapshotDatabaseIndex(db)).toEqual(snapshot);
});
