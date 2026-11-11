'use strict';

// The schema level comes from the runner's ledger, `migrations.filename`
// (issue 2458). It used to be read from knex_migrations, which the runner
// never writes, so the export manifest carried null, the forward-only guard
// never fired and the backup services reported 'unknown'.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

const fs = require('fs');
const path = require('path');
const { bootCrmDb } = require('./helpers/crmDb');
const { migrationOrder, latestMigration } = require('../../src/utils/schemaLevel');

let db;
let cleanup;
let tmpDir;
let newest;

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.env.STORAGE_PATH = tmpDir;
  const core = fs.readdirSync(path.resolve(__dirname, '..', '..', 'migrations', 'core'))
    .filter((f) => /^\d{3}_.*\.js$/.test(f));
  newest = core.reduce((a, b) => (migrationOrder(b) > migrationOrder(a) || (migrationOrder(b) === migrationOrder(a) && b > a) ? b : a));
}, 120000);

afterAll(async () => {
  await cleanup();
});

const manifest = (latest) => ({
  kind: 'picpeak-backup', format: 1, database: { engine: 'sqlite', latest_migration: latest }, tables: {},
});

test('a migrated instance reports its newest migration file', async () => {
  expect(await latestMigration(db)).toBe(newest);
});

test('the export manifest carries the newest migration file', async () => {
  const { createPicpeak } = require('../../src/services/picpeakExportService');
  const { filePath, manifest: written } = await createPicpeak({ includePhotos: false });
  try {
    expect(written.database.latest_migration).toBe(newest);
  } finally {
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  }
});

test('the import guard refuses a newer archive and accepts an older, equal or unknown one', async () => {
  const { validateManifest } = require('../../src/services/picpeakImportService');
  const newer = `${migrationOrder(newest) + 1}_from_the_future.js`;
  expect((await validateManifest(manifest(newer))).some((b) => /newer database schema/.test(b))).toBe(true);
  expect(await validateManifest(manifest(newest))).toEqual([]);
  expect(await validateManifest(manifest('100_older.js'))).toEqual([]);
  // An archive made before this fix carries null: still restorable.
  expect(await validateManifest(manifest(null))).toEqual([]);
});

test('the backup services report the schema level', async () => {
  const backupService = require('../../src/services/backupService');
  const { databaseBackupService } = require('../../src/services/databaseBackup');
  const backupManifest = require('../../src/services/backupManifest');
  expect(await backupService.getCurrentSchemaVersion()).toBe(newest);
  expect(await databaseBackupService.getCurrentSchemaVersion()).toBe(newest);
  expect(await backupManifest.getSchemaVersion()).toBe(newest);
});

test('an install with only knex_migrations falls back to it', async () => {
  // Last: empties this suite's own copy of the ledger.
  await db('migrations').del();
  await db.schema.createTable('knex_migrations', (t) => { t.increments('id'); t.string('name'); });
  await db('knex_migrations').insert([{ name: '120_b.js' }, { name: '099_a.js' }]);
  expect(await latestMigration(db)).toBe('120_b.js');
  await db('knex_migrations').del();
  expect(await latestMigration(db)).toBeNull();
});
