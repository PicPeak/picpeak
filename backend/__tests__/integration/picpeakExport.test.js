'use strict';

// Validates the engine-neutral .picpeak export: it must produce a real zip with
// a manifest + per-table NDJSON, exclude knex bookkeeping, and honour the photo
// toggle. Uses the shared CRM DB harness (temp SQLite) — no docker needed.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

const fs = require('fs');
const path = require('path');
const StreamZip = require('node-stream-zip');
const { bootCrmDb } = require('./helpers/crmDb');

let db;
let cleanup;
let tmpDir;
let createPicpeak;

// bootCrmDb MUST run before requiring the service (which transitively requires
// db.js) so the export reads this test's DB, not the default path.
beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.env.STORAGE_PATH = tmpDir; // isolate file collection to the temp dir
  ({ createPicpeak } = require('../../src/services/picpeakExportService'));
}, 60000);

afterAll(async () => {
  await cleanup();
});

async function readZip(filePath) {
  const zip = new StreamZip.async({ file: filePath });
  const entries = Object.keys(await zip.entries());
  const manifest = JSON.parse((await zip.entryData('manifest.json')).toString('utf8'));
  await zip.close();
  return { entries, manifest };
}

describe('picpeak export (.picpeak logical export)', () => {
  it('produces a .picpeak with a manifest and per-table NDJSON', async () => {
    const { filePath, manifest } = await createPicpeak({ includePhotos: false });
    try {
      expect(filePath.endsWith('.picpeak')).toBe(true);
      expect(fs.existsSync(filePath)).toBe(true);

      expect(manifest.format).toBe(1);
      expect(manifest.kind).toBe('picpeak-backup');
      expect(manifest.database.engine).toBe('sqlite');
      expect(manifest.options.includePhotos).toBe(false);
      expect(manifest.contains_secrets).toBe(true);
      // Migrations seed real tables (e.g. app_settings) — expect several.
      expect(Object.keys(manifest.tables).length).toBeGreaterThan(0);
      expect(Object.keys(manifest.tables)).toContain('app_settings');

      const { entries, manifest: zipped } = await readZip(filePath);
      expect(entries).toContain('manifest.json');
      expect(entries.some((n) => n.startsWith('data/') && n.endsWith('.ndjson'))).toBe(true);
      expect(entries).toContain('data/app_settings.ndjson');
      // Manifest inside the zip matches the returned one.
      expect(zipped.tables).toEqual(manifest.tables);
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  it('never exports knex bookkeeping tables', async () => {
    const { filePath, manifest } = await createPicpeak({ includePhotos: false });
    try {
      const names = Object.keys(manifest.tables);
      expect(names).not.toContain('knex_migrations');
      expect(names).not.toContain('knex_migrations_lock');
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  it('row counts in the manifest match the NDJSON line counts', async () => {
    // Insert a couple of settings so at least one table is non-empty.
    await db('app_settings')
      .insert({ setting_key: 'picpeak_export_test_a', setting_value: JSON.stringify('1'), setting_type: 'string' })
      .onConflict('setting_key').merge();

    const { filePath, manifest } = await createPicpeak({ includePhotos: false });
    try {
      const zip = new StreamZip.async({ file: filePath });
      const buf = await zip.entryData('data/app_settings.ndjson');
      await zip.close();
      const lines = buf.toString('utf8').split('\n').filter((l) => l.trim().length > 0);
      expect(lines.length).toBe(manifest.tables.app_settings.rowCount);
      expect(manifest.tables.app_settings.rowCount).toBeGreaterThan(0);
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });
});
