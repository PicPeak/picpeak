/**
 * Integration test for GET /api/admin/system-health/backup-coverage.
 *
 * Pins the Stage C diagnostic that tells admins what the next
 * "Run Backup Now" will include, skip, or silently miss.
 *
 * Test surface:
 *   1. Empty / fresh install → default seed (7 paths), inline mode,
 *      no DB dump on file yet, no drift
 *   2. Toggle `include_in_default=false` → coverage flips to
 *      'skipped-by-toggle'
 *   3. Feature_flag gating reflects the actual app_settings value
 *      (events/archived ⇄ backup_include_archived)
 *   4. Drift detection: a top-level subdir on disk with no
 *      `backup_paths` row is flagged in `unconfiguredOnDisk`
 *   5. Allow-list: `backups/` and `tmp/` are never flagged as drift
 *   6. Scheduled-only mode + recent dump → `database.ok = true`
 *   7. Scheduled-only mode + stale (>26h) dump → `database.ok = false`
 *      and `lastDumpStale = true`
 *
 * Same auth/permission pass-through strategy as
 * adminBackupIntegrity.test.js — we exercise the route's logic,
 * not the auth middleware.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const { bootCrmDb } = require('./helpers/crmDb');

jest.mock('../../src/middleware/auth', () => ({
  adminAuth: (req, _res, next) => { req.admin = { id: 1 }; next(); },
  customerAuth: (_req, _res, next) => next(),
  galleryAuth: (_req, _res, next) => next(),
}));

jest.mock('../../src/middleware/permissions', () => ({
  requirePermission: () => (_req, _res, next) => next(),
}));

jest.setTimeout(30000);

describe('GET /api/admin/system-health/backup-coverage', () => {
  let db;
  let cleanup;
  let storagePath;
  let app;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    storagePath = process.env.STORAGE_PATH;

    const route = require('../../src/routes/adminSystemHealth');
    app = express();
    app.use(express.json());
    app.use('/api/admin/system-health', route);
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  function mkdir(rel) {
    fs.mkdirSync(path.join(storagePath, rel), { recursive: true });
  }

  function rmdir(rel) {
    fs.rmSync(path.join(storagePath, rel), { recursive: true, force: true });
  }

  async function restoreDefaultPaths() {
    await db('backup_paths').del();
    const { DEFAULT_PATHS } = require('../../migrations/core/109_add_backup_paths');
    await db('backup_paths').insert(DEFAULT_PATHS.map((row) => ({
      ...row,
      created_at: new Date(),
      updated_at: new Date(),
    })));
  }

  beforeEach(async () => {
    await restoreDefaultPaths();
    await db('database_backup_runs').del().catch(() => {});
    await db('app_settings').where('setting_type', 'backup').del().catch(() => {});
  });

  it('returns the canonical 7 paths + database block on a fresh install', async () => {
    const res = await request(app).get('/api/admin/system-health/backup-coverage');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('report');

    const { report } = res.body;
    expect(report.paths.map((p) => p.path)).toEqual([
      'events/active',
      'events/archived',
      'thumbnails',
      'previews',
      'heroes',
      'uploads',
      'business-docs',
    ]);

    // Default mode is inline — no inline_dump setting present means
    // "inline is ON" (matches ensureDatabaseDumpForBackup semantics).
    expect(report.database.mode).toBe('inline');
    expect(report.database.ok).toBe(true);

    expect(report.summary).toMatchObject({
      configuredCount: 7,
      tableMissingFallbackInUse: false,
    });
  });

  it('flips a path to skipped-by-toggle when include_in_default=false', async () => {
    await db('backup_paths').where('path', 'thumbnails').update({
      include_in_default: false,
    });

    const res = await request(app).get('/api/admin/system-health/backup-coverage');
    const thumbnails = res.body.report.paths.find((p) => p.path === 'thumbnails');
    expect(thumbnails.coverage).toBe('skipped-by-toggle');
    expect(thumbnails.includeInDefault).toBe(false);
  });

  it('feature_flag gating reflects app_settings (archived path off vs on)', async () => {
    // backup_include_archived not set → archived skipped via flag
    const off = await request(app).get('/api/admin/system-health/backup-coverage');
    const archivedOff = off.body.report.paths.find((p) => p.path === 'events/archived');
    expect(archivedOff.coverage).toBe('skipped-by-feature-flag');
    expect(archivedOff.featureFlag).toBe('backup_include_archived');
    expect(archivedOff.featureFlagValue).toBe(null); // unset

    // Now set the flag — but path is missing on disk, so coverage
    // resolves to 'missing-on-disk', proving the flag was honoured.
    await db('app_settings').insert({
      setting_key: 'backup_include_archived',
      setting_value: JSON.stringify(true),
      setting_type: 'backup',
    }).onConflict('setting_key').merge();

    const on = await request(app).get('/api/admin/system-health/backup-coverage');
    const archivedOn = on.body.report.paths.find((p) => p.path === 'events/archived');
    expect(archivedOn.featureFlagValue).toBe(true);
    // No on-disk dir → 'missing-on-disk' (not 'skipped-by-feature-flag')
    expect(['missing-on-disk', 'will-scan']).toContain(archivedOn.coverage);
  });

  it('detects unconfigured top-level subdirs as drift', async () => {
    mkdir('events/active');           // configured
    mkdir('plugin-store/cache');      // DRIFT
    mkdir('shiny-new-feature/data');  // DRIFT

    const res = await request(app).get('/api/admin/system-health/backup-coverage');
    expect(res.body.report.drift.unconfiguredOnDisk).toEqual(expect.arrayContaining([
      'plugin-store',
      'shiny-new-feature',
    ]));
    expect(res.body.report.drift.unconfiguredOnDisk).not.toContain('events');

    rmdir('plugin-store');
    rmdir('shiny-new-feature');
  });

  it('never flags backups/ or tmp/ as drift (allow-list)', async () => {
    mkdir('backups');
    mkdir('tmp');

    const res = await request(app).get('/api/admin/system-health/backup-coverage');
    expect(res.body.report.drift.unconfiguredOnDisk).not.toContain('backups');
    expect(res.body.report.drift.unconfiguredOnDisk).not.toContain('tmp');
    expect(res.body.report.drift.expectedNonBackupDirs).toEqual(
      expect.arrayContaining(['backups', 'tmp']),
    );

    rmdir('backups');
    rmdir('tmp');
  });

  it('scheduled-only mode + recent dump → database.ok=true, not stale', async () => {
    await db('app_settings').insert({
      setting_key: 'backup_database_inline_dump',
      setting_value: JSON.stringify(false),
      setting_type: 'backup',
    }).onConflict('setting_key').merge();

    const recentDump = path.join(storagePath, 'backups', 'recent.sql.gz');
    fs.mkdirSync(path.dirname(recentDump), { recursive: true });
    fs.writeFileSync(recentDump, 'pretend dump');
    await db('database_backup_runs').insert({
      started_at: new Date(),
      completed_at: new Date(),  // just now
      status: 'completed',
      backup_type: 'pg',
      file_path: recentDump,
      file_size_bytes: fs.statSync(recentDump).size,
      destination_path: recentDump,
    });

    const res = await request(app).get('/api/admin/system-health/backup-coverage');
    expect(res.body.report.database.mode).toBe('scheduled-only');
    expect(res.body.report.database.inlineDumpExplicitlyDisabled).toBe(true);
    expect(res.body.report.database.lastDumpStale).toBe(false);
    expect(res.body.report.database.ok).toBe(true);
  });

  it('scheduled-only mode + stale dump → database.ok=false, lastDumpStale=true', async () => {
    await db('app_settings').insert({
      setting_key: 'backup_database_inline_dump',
      setting_value: JSON.stringify(false),
      setting_type: 'backup',
    }).onConflict('setting_key').merge();

    const oldDump = path.join(storagePath, 'backups', 'old.sql.gz');
    fs.mkdirSync(path.dirname(oldDump), { recursive: true });
    fs.writeFileSync(oldDump, 'pretend old dump');
    // 48 hours ago — well past the 26h staleness threshold. ISO
    // string instead of a Date object because knex-sqlite's datetime
    // serialisation has a quirk where some Date instances coerce to
    // '[object Object]' on insert (the test 6 "recent dump" case
    // passes only because `new Date()` happens to round-trip safely;
    // arithmetic Dates don't).
    const stale = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    await db('database_backup_runs').insert({
      started_at: stale,
      completed_at: stale,
      status: 'completed',
      backup_type: 'pg',
      file_path: oldDump,
      file_size_bytes: fs.statSync(oldDump).size,
      destination_path: oldDump,
    });

    const res = await request(app).get('/api/admin/system-health/backup-coverage');
    expect(res.body.report.database.lastDumpStale).toBe(true);
    expect(res.body.report.database.ok).toBe(false);
    // Top-level summary reflects the failed DB check.
    expect(res.body.report.summary.databaseOk).toBe(false);
    expect(res.body.report.summary.overallOk).toBe(false);
  });
});
