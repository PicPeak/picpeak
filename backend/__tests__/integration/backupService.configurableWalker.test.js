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

jest.setTimeout(30000);

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
});
