/**
 * Pins the Stage-B refactor that lifted the file-backup walker's
 * subdirectory list out of hard-coded JS into the `backup_paths`
 * table seeded by migration 109.
 *
 * Scenarios:
 *   1. Walker reads canonical seed → all 7 default subdirs walked
 *   2. include_in_default=false on one row → that subdir is skipped
 *   3. New row inserted at runtime → walker picks it up without restart
 *   4. feature_flag gating → row only walked when the named app_settings
 *      boolean is truthy (mirrors historical `includeArchived` behavior)
 *   5. Empty table → walker falls back to LEGACY_BACKUP_PATHS (defense
 *      in depth — never silently scans nothing)
 *
 * Why not stub `db('backup_paths')`: the whole point of Stage B is
 * that the walker is now data-driven, so the test has to actually
 * mutate the table and observe the walker's output change. Stubs
 * would re-introduce the hard-coding the refactor is meant to remove.
 */

const fs = require('fs');
const path = require('path');

const { bootCrmDb } = require('./helpers/crmDb');

jest.setTimeout(120000);

describe('backupService — configurable walker (backup_paths)', () => {
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

  function seedFile(relPath, content = 'dummy bytes') {
    const abs = path.join(storagePath, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  beforeEach(async () => {
    // Restore canonical seed before every test. Tests mutate this table
    // freely; the next test starts from a known state.
    await db('backup_paths').del();
    const {
      DEFAULT_PATHS,
    } = require('../../migrations/core/109_add_backup_paths');
    await db('backup_paths').insert(DEFAULT_PATHS.map((row) => ({
      ...row,
      created_at: new Date(),
      updated_at: new Date(),
    })));
  });

  it('migration 109 seeds the canonical 7 paths', async () => {
    const rows = await db('backup_paths').orderBy('display_order', 'asc').select();
    expect(rows.map((r) => r.path)).toEqual([
      'events/active',
      'events/archived',
      'thumbnails',
      'previews',
      'heroes',
      'uploads',
      'business-docs',
    ]);
    // Only events/archived is gated by a feature flag.
    expect(rows.filter((r) => r.feature_flag).map((r) => r.path)).toEqual([
      'events/archived',
    ]);
  });

  it('walks every default subdir when files are present', async () => {
    seedFile('events/active/E1/a.jpg');
    seedFile('thumbnails/E1/a.jpg');
    seedFile('previews/E1/a.jpg');
    seedFile('heroes/E1/hero.jpg');
    seedFile('uploads/intake/x.bin');
    seedFile('business-docs/quote/2026/Q-001.pdf');
    // events/archived is gated — left out of this test; covered below.

    const files = await backupService.getFilesToBackup({ backup_include_archived: true });
    const rels = files.map((f) => f.relativePath);

    expect(rels).toEqual(expect.arrayContaining([
      'events/active/E1/a.jpg',
      'thumbnails/E1/a.jpg',
      'previews/E1/a.jpg',
      'heroes/E1/hero.jpg',
      'uploads/intake/x.bin',
      'business-docs/quote/2026/Q-001.pdf',
    ]));
  });

  it('skips a path when include_in_default is toggled off', async () => {
    seedFile('thumbnails/E1/thumb.jpg');
    seedFile('events/active/E1/photo.jpg');

    await db('backup_paths').where('path', 'thumbnails').update({
      include_in_default: false,
    });

    const files = await backupService.getFilesToBackup({ backup_include_archived: true });
    const rels = files.map((f) => f.relativePath);

    expect(rels).toContain('events/active/E1/photo.jpg');
    expect(rels).not.toContain('thumbnails/E1/thumb.jpg');
  });

  it('picks up a new path inserted at runtime — no restart needed', async () => {
    // Simulates a future feature shipping its own subdirectory and
    // self-healing a `backup_paths` row at boot.
    await db('backup_paths').insert({
      path: 'plugin-store',
      include_in_default: true,
      feature_flag: null,
      display_order: 200,
      description: 'Hypothetical future feature payload',
      created_at: new Date(),
      updated_at: new Date(),
    });
    seedFile('plugin-store/cache/payload.bin');

    const files = await backupService.getFilesToBackup({ backup_include_archived: true });
    const rels = files.map((f) => f.relativePath);

    expect(rels).toContain('plugin-store/cache/payload.bin');
  });

  it('respects feature_flag gating (events/archived ⇄ backup_include_archived)', async () => {
    seedFile('events/active/E1/active.jpg');
    seedFile('events/archived/E2/archived.jpg');

    // backup_include_archived=false → archived/ is skipped.
    const filesOff = await backupService.getFilesToBackup({ backup_include_archived: false });
    const relsOff = filesOff.map((f) => f.relativePath);
    expect(relsOff).toContain('events/active/E1/active.jpg');
    expect(relsOff).not.toContain('events/archived/E2/archived.jpg');

    // backup_include_archived=true → archived/ is included.
    const filesOn = await backupService.getFilesToBackup({ backup_include_archived: true });
    const relsOn = filesOn.map((f) => f.relativePath);
    expect(relsOn).toContain('events/archived/E2/archived.jpg');
  });

  it('falls back to LEGACY_BACKUP_PATHS when the table is empty', async () => {
    // Defense in depth: even if seed-and-self-heal both failed, the
    // walker must still cover the historical set so "Run Backup Now"
    // cannot silently degrade to no-op.
    await db('backup_paths').del();
    seedFile('events/active/E1/photo.jpg');
    seedFile('business-docs/quote/2026/Q-002.pdf');

    const files = await backupService.getFilesToBackup({ backup_include_archived: true });
    const rels = files.map((f) => f.relativePath);

    expect(rels).toContain('events/active/E1/photo.jpg');
    expect(rels).toContain('business-docs/quote/2026/Q-002.pdf');
  });

  it('legacy boolean call signature still works (backward compat)', async () => {
    // Existing call sites (and the businessDocs regression test) pass
    // a boolean for `includeArchived`. Refactor must not break them.
    seedFile('events/archived/E3/legacy.jpg');

    const filesOff = await backupService.getFilesToBackup(false);
    expect(filesOff.map((f) => f.relativePath)).not.toContain('events/archived/E3/legacy.jpg');

    const filesOn = await backupService.getFilesToBackup(true);
    expect(filesOn.map((f) => f.relativePath)).toContain('events/archived/E3/legacy.jpg');
  });

  // Issue #871 — the "What to Backup" checkboxes were stored but never read.
  describe('UI opt-out toggles (issue #871)', () => {
    it('unchecking Thumbnails excludes thumbnails/', async () => {
      seedFile('thumbnails/E1/thumb.jpg');
      seedFile('events/active/E1/photo.jpg');

      const files = await backupService.getFilesToBackup({
        backup_include_thumbnails: false,
      });
      const rels = files.map((f) => f.relativePath);

      expect(rels).toContain('events/active/E1/photo.jpg');
      expect(rels).not.toContain('thumbnails/E1/thumb.jpg');
    });

    it('unchecking Photos excludes events/active', async () => {
      seedFile('thumbnails/E1/thumb.jpg');
      seedFile('events/active/E1/photo.jpg');

      const files = await backupService.getFilesToBackup({
        backup_include_photos: false,
      });
      const rels = files.map((f) => f.relativePath);

      expect(rels).toContain('thumbnails/E1/thumb.jpg');
      expect(rels).not.toContain('events/active/E1/photo.jpg');
    });

    it('defaults to including everything when the keys were never saved', async () => {
      seedFile('thumbnails/E1/thumb.jpg');
      seedFile('events/active/E1/photo.jpg');

      const files = await backupService.getFilesToBackup({});
      const rels = files.map((f) => f.relativePath);

      expect(rels).toContain('thumbnails/E1/thumb.jpg');
      expect(rels).toContain('events/active/E1/photo.jpg');
    });

    it("accepts the UI's plural backup_include_archives for the archived gate", async () => {
      seedFile('events/archived/E4/archived.jpg');

      const files = await backupService.getFilesToBackup({
        backup_include_archives: true,
      });
      expect(files.map((f) => f.relativePath)).toContain('events/archived/E4/archived.jpg');
    });

    it('the UI plural key beats the migration-seeded singular key', async () => {
      // Migration seeds backup_include_archived=true on every install; the
      // form only ever writes the plural key, so unchecking Archives must
      // win over the stale seeded value.
      seedFile('events/archived/E5/archived.jpg');

      const files = await backupService.getFilesToBackup({
        backup_include_archived: true,   // seeded default
        backup_include_archives: false,  // what the admin actually chose
      });
      expect(files.map((f) => f.relativePath)).not.toContain('events/archived/E5/archived.jpg');
    });

    it('rsync gets the de-selected paths and noise filters as --exclude args', async () => {
      const excluded = await backupService.resolveExcludedBackupPaths({
        backup_include_thumbnails: false,
        backup_include_archives: false,
      });
      expect(excluded.map((r) => r.path)).toEqual(
        expect.arrayContaining(['thumbnails', 'events/archived'])
      );

      const args = backupService.buildRsyncArgs(
        { backup_rsync_host: 'backup.example.com', backup_rsync_path: '/srv/backups' },
        excluded.map((r) => `/${r.path}/`)
      );
      const excludes = args
        .map((a, i) => (a === '--exclude' ? args[i + 1] : null))
        .filter(Boolean);
      expect(excludes).toEqual(expect.arrayContaining([
        '.nfs*',
        '/thumbnails/',
        '/events/archived/',
      ]));
    });

    it('rows toggled off via include_in_default also become rsync excludes', async () => {
      // The enabled-only loader hides these rows from the walker, but rsync
      // syncs the whole storage root, so they must still appear as excludes.
      await db('backup_paths').where('path', 'previews').update({
        include_in_default: false,
      });

      const excluded = await backupService.resolveExcludedBackupPaths({});
      expect(excluded.map((r) => r.path)).toContain('previews');
    });
  });

  // Issue #871 — .nfs* silly-rename artifacts were uploaded to S3.
  it('never backs up filesystem noise (.nfs*, .DS_Store)', async () => {
    seedFile('thumbnails/E1/.nfs000000000000006600000008');
    seedFile('events/active/E1/.DS_Store');
    seedFile('events/active/E1/photo.jpg');

    const files = await backupService.getFilesToBackup({});
    const rels = files.map((f) => f.relativePath);

    expect(rels).toContain('events/active/E1/photo.jpg');
    expect(rels.some((r) => r.includes('.nfs'))).toBe(false);
    expect(rels.some((r) => r.includes('.DS_Store'))).toBe(false);
  });

  it('the walker honors backup_exclude_patterns (previously rsync-only)', async () => {
    seedFile('events/active/E1/photo.jpg');
    seedFile('events/active/E1/scratch.tmp');

    const files = await backupService.getFilesToBackup({
      backup_exclude_patterns: ['*.tmp'],
    });
    const rels = files.map((f) => f.relativePath);

    expect(rels).toContain('events/active/E1/photo.jpg');
    expect(rels).not.toContain('events/active/E1/scratch.tmp');
  });

  it('glob patterns are literal outside the star (.nfs* must not eat anfs-…)', async () => {
    seedFile('events/active/E1/anfs-photo.jpg');
    seedFile('events/active/E1/notes-tmp');

    const files = await backupService.getFilesToBackup({
      backup_exclude_patterns: ['*.tmp'],
    });
    const rels = files.map((f) => f.relativePath);

    // '.nfs*' used to compile to /^.nfs.*$/ whose dot matched any char;
    // '*.tmp' used to compile to /^.*.tmp$/ which also matched 'notes-tmp'.
    expect(rels).toContain('events/active/E1/anfs-photo.jpg');
    expect(rels).toContain('events/active/E1/notes-tmp');
  });

  // Issue #871 — weekly schedules silently ran daily, and the dashboard's
  // "next backup" was a hardcoded "tomorrow 02:00".
  describe('schedule resolution + next run (issue #871)', () => {
    it('a named label beats the stray default cron the UI used to send', () => {
      expect(backupService.resolveScheduleCron({
        backup_schedule: 'weekly',
        backup_schedule_cron: '0 3 * * *', // old UI default, sent unconditionally
      })).toBe('0 3 * * 0');
    });

    it('custom schedules use the cron field', () => {
      expect(backupService.resolveScheduleCron({
        backup_schedule: 'custom',
        backup_schedule_cron: '15 5 * * 2',
      })).toBe('15 5 * * 2');
    });

    it('falls back to the default daily cron', () => {
      expect(backupService.resolveScheduleCron({})).toBe('0 2 * * *');
    });

    it('getNextScheduledRun is null when backups are disabled', () => {
      expect(backupService.getNextScheduledRun(null)).toBeNull();
      expect(backupService.getNextScheduledRun({ backup_enabled: false })).toBeNull();
    });

    it('getNextScheduledRun returns the real next weekly fire time', () => {
      const iso = backupService.getNextScheduledRun({
        backup_enabled: true,
        backup_schedule: 'weekly',
        backup_schedule_cron: '0 3 * * *',
      });
      const next = new Date(iso);
      expect(Number.isNaN(next.getTime())).toBe(false);
      expect(next.getTime()).toBeGreaterThan(Date.now());
      expect(next.getDay()).toBe(0);   // Sunday
      expect(next.getHours()).toBe(3); // 03:00
    });
  });

  // Issue #871 — "Backup Size: 167.6 TB": file_size_bytes is a bigInteger
  // column, node-postgres returns int8 as a string, and the S3 path did
  // `backedUpSize += size` — string concatenation.
  it('getDatabaseBackupInfo coerces file_size_bytes to a number', async () => {
    await db('database_backup_runs').del();
    await db('database_backup_runs').insert({
      backup_type: 'full',
      status: 'completed',
      file_path: '/backups/db/dump.sql.gz',
      // Simulate the PG int8-as-string driver behaviour (sqlite stores
      // whatever it is handed, so the string round-trips).
      file_size_bytes: '421988',
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });

    const info = await backupService.getDatabaseBackupInfo();
    expect(typeof info.size).toBe('number');
    expect(info.size).toBe(421988);
  });
});
