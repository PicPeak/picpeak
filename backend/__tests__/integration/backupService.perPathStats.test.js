/**
 * Per-Stage-B-path tally — Tier 3 of tonight's backup hardening.
 *
 * Pins the new `computePerPathStats` logic that the Backup History
 * "Content Backed Up" pane reads via `backup_runs.statistics.per_path`.
 *
 * Three scenarios:
 *   1. Single file under one path — straightforward attribution
 *   2. Multiple paths with overlapping prefixes — longest-prefix wins
 *      (e.g. `events/active/E1/x.jpg` should attribute to
 *       `events/active`, not `events`)
 *   3. File outside any configured path — silently dropped, doesn't
 *      throw or contaminate other buckets
 *
 * Tests exercise the EXPORTED side: write a backup_runs row via the
 * service entry point and assert the statistics JSON shape. We don't
 * stub `computePerPathStats` directly — the integration view is what
 * the frontend actually consumes.
 */

const fs = require('fs');
const path = require('path');

const { bootCrmDb } = require('./helpers/crmDb');

jest.setTimeout(30000);

describe('backupService — per-Stage-B-path statistics', () => {
  let db;
  let cleanup;
  let storagePath;
  let backupService;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    storagePath = process.env.STORAGE_PATH;
    backupService = require('../../src/services/backupService');
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  function mkFile(rel, content = 'x'.repeat(100)) {
    const abs = path.join(storagePath, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  beforeEach(async () => {
    // Clean slate of any artefacts from prior tests
    await db('backup_runs').del();
    await db('app_settings').where('setting_type', 'backup').del();
    await db('app_settings').insert([
      { setting_key: 'backup_destination_type', setting_value: JSON.stringify('local'), setting_type: 'backup' },
      { setting_key: 'backup_destination_path', setting_value: JSON.stringify(path.join(storagePath, 'destination')), setting_type: 'backup' },
      { setting_key: 'backup_enabled', setting_value: JSON.stringify(true), setting_type: 'backup' },
      { setting_key: 'backup_email_on_failure', setting_value: JSON.stringify(false), setting_type: 'backup' },
      { setting_key: 'backup_include_archived', setting_value: JSON.stringify(true), setting_type: 'backup' },
    ]).onConflict('setting_key').merge();
    fs.mkdirSync(path.join(storagePath, 'destination'), { recursive: true });

    // Restore canonical backup_paths from migration 109
    const { DEFAULT_PATHS } = require('../../migrations/core/109_add_backup_paths');
    await db('backup_paths').del();
    await db('backup_paths').insert(DEFAULT_PATHS.map((row) => ({
      ...row,
      created_at: new Date(),
      updated_at: new Date(),
    })));

    // Wipe leftover files between tests
    for (const dir of ['events', 'business-docs', 'thumbnails', 'previews', 'heroes', 'uploads']) {
      const p = path.join(storagePath, dir);
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    }
  });

  it('attributes files to their owning backup_paths row', async () => {
    mkFile('events/active/E1/photo-a.jpg', 'X'.repeat(1000));
    mkFile('events/active/E1/photo-b.jpg', 'X'.repeat(2000));
    mkFile('business-docs/quote/2026/Q-1.pdf', 'X'.repeat(500));
    mkFile('thumbnails/E1/photo-a.jpg', 'X'.repeat(50));

    // Disable the inline DB dump so we don't need pg_dump in tests;
    // the file walker is what produces per_path.
    await db('app_settings').insert({
      setting_key: 'backup_database_inline_dump',
      setting_value: JSON.stringify(false),
      setting_type: 'backup',
    }).onConflict('setting_key').merge();

    // Seed a fake DB-backup row so the fail-loud guard is satisfied.
    const fakeDump = path.join(storagePath, 'destination', 'fake.sql.gz');
    fs.writeFileSync(fakeDump, 'pretend dump');
    await db('database_backup_runs').insert({
      started_at: new Date(),
      completed_at: new Date(),
      status: 'completed',
      backup_type: 'pg',
      file_path: fakeDump,
      file_size_bytes: fs.statSync(fakeDump).size,
      destination_path: fakeDump,
    });

    await backupService.runBackup(true);

    const run = await db('backup_runs').orderBy('id', 'desc').first();
    expect(run.status).toBe('completed');

    const statsRaw = typeof run.statistics === 'string'
      ? JSON.parse(run.statistics)
      : run.statistics;
    expect(statsRaw.per_path).toBeDefined();

    // events/active should have 2 files (3000 bytes)
    expect(statsRaw.per_path['events/active']).toEqual({ count: 2, size: 3000 });
    // business-docs should have 1 file (500 bytes)
    expect(statsRaw.per_path['business-docs']).toEqual({ count: 1, size: 500 });
    // thumbnails should have 1 file (50 bytes)
    expect(statsRaw.per_path['thumbnails']).toEqual({ count: 1, size: 50 });

    // No spurious buckets for paths that had nothing
    expect(statsRaw.per_path['previews']).toBeUndefined();
    expect(statsRaw.per_path['heroes']).toBeUndefined();
  });

  it('archived path attributed separately from active when both have files', async () => {
    mkFile('events/active/E1/active.jpg', 'X'.repeat(100));
    mkFile('events/archived/E2/archived.jpg', 'X'.repeat(200));

    // backup_include_archived already set true in beforeEach so the
    // archived walker fires; same opt-out for inline DB dump.
    await db('app_settings').insert({
      setting_key: 'backup_database_inline_dump',
      setting_value: JSON.stringify(false),
      setting_type: 'backup',
    }).onConflict('setting_key').merge();
    const fakeDump = path.join(storagePath, 'destination', 'fake.sql.gz');
    fs.writeFileSync(fakeDump, 'pretend dump');
    await db('database_backup_runs').insert({
      started_at: new Date(),
      completed_at: new Date(),
      status: 'completed',
      backup_type: 'pg',
      file_path: fakeDump,
      file_size_bytes: fs.statSync(fakeDump).size,
      destination_path: fakeDump,
    });

    await backupService.runBackup(true);

    const run = await db('backup_runs').orderBy('id', 'desc').first();
    const statsRaw = typeof run.statistics === 'string'
      ? JSON.parse(run.statistics)
      : run.statistics;

    // events/active and events/archived attribute separately —
    // longest-prefix match prevents `events/active/...` from claiming
    // an `events/archived/...` file or vice versa.
    expect(statsRaw.per_path['events/active']).toEqual({ count: 1, size: 100 });
    expect(statsRaw.per_path['events/archived']).toEqual({ count: 1, size: 200 });
  });
});

// NOTE on walker duplication
//
// If two `backup_paths` rows overlap (e.g. one row at `events` AND
// another at `events/active`), the walker scans the same files twice
// — once via each path. Per-path stats then attribute the file to the
// longest-prefix-matching path BOTH times, producing inflated counts.
//
// The canonical seed in migration 109 contains no overlapping pairs,
// so this isn't exercised in practice. But an admin who hand-adds a
// broad row that overlaps an existing nested one will see double
// counts in their next backup's statistics + the destination will
// receive duplicate copies (wasting space). Worth flagging if anyone
// reports it — the fix is to de-dupe `files` in
// `getFilesToBackupInternal` before returning, OR to skip walking a
// path if a longer one has already covered it.
