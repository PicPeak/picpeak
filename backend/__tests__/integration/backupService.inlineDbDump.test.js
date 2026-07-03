/**
 * Pins the inline-DB-dump + fail-loud guard added to `runBackupInternal`.
 *
 * The previous behaviour was: file-backup looked up an existing dump via
 * `getDatabaseBackupInfo()` and silently shipped a files-only manifest
 * when none was found. Admins clicking "Run Backup Now" got an apparent
 * success that omitted every customer / quote / invoice / contract row —
 * the data-loss footgun that this commit closes.
 *
 * Five scenarios under test:
 *   1. Default (inline dump enabled), dump succeeds → backup proceeds
 *   2. Default, dump throws → run aborts, backup_runs row marked failed
 *   3. Opt-out + recent DB dump available → backup proceeds
 *   4. Opt-out + no DB dump available → fail loud
 *   5. Opt-out + DB dump file is 0 bytes on disk → fail loud
 *
 * Mocking strategy: the underlying `databaseBackupService.backup()` and
 * the local-destination writer are stubbed so the test exercises just
 * the new guard logic without depending on `pg_dump` / `sqlite3` CLI
 * binaries being available in the test environment.
 */

const fs = require('fs');
const path = require('path');

const { bootCrmDb } = require('./helpers/crmDb');

// Set up mocks BEFORE bootCrmDb so backupService picks them up at require time.
const mockBackupFn = jest.fn();
jest.mock('../../src/services/databaseBackup', () => ({
  databaseBackupService: { backup: mockBackupFn },
  startScheduledBackups: jest.fn(),
  stopScheduledBackups: jest.fn(),
  DatabaseBackupService: class {},
}));

jest.setTimeout(30000);

describe('backupService — inline DB dump + fail-loud guard', () => {
  let db;
  let cleanup;
  let storagePath;
  let backupService;
  let dumpFileAbs;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    storagePath = process.env.STORAGE_PATH;
    backupService = require('../../src/services/backupService');

    // Seed backup destination settings so the run can proceed past the
    // "destination not configured" guard.
    const dest = path.join(storagePath, 'backups');
    fs.mkdirSync(dest, { recursive: true });
    // getBackupConfigInternal filters by setting_type='backup', so the
    // tests have to seed with that type or the resolver returns
    // `{ ... }` with the keys missing — runBackup then sees
    // `backup_destination_type === undefined` and bails before our
    // new guard runs.
    await db('app_settings').insert([
      { setting_key: 'backup_destination_type',    setting_value: JSON.stringify('local'), setting_type: 'backup' },
      { setting_key: 'backup_destination_path',    setting_value: JSON.stringify(dest),    setting_type: 'backup' },
      { setting_key: 'backup_enabled',             setting_value: JSON.stringify(true),    setting_type: 'backup' },
      { setting_key: 'backup_email_on_failure',    setting_value: JSON.stringify(false),   setting_type: 'backup' },
    ]).onConflict('setting_key').merge();

    // Pre-create a dump file that getDatabaseBackupInfo can resolve to.
    // Reused/mutated per-test via the database_backup_runs seed below.
    dumpFileAbs = path.join(storagePath, 'backups', 'fake-dump.sql.gz');
    fs.writeFileSync(dumpFileAbs, 'pretend this is a pg_dump'.repeat(100));

    // Neutralise the file-scan step: we don't care which files would
    // be backed up, just whether the run reaches that stage at all.
    backupService.getFilesToBackup = jest.fn(async () => []);
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  beforeEach(async () => {
    mockBackupFn.mockReset();
    // Default to "dump produced this file with this size" — the per-test
    // setup overrides as needed.
    mockBackupFn.mockResolvedValue({
      success: true,
      path: dumpFileAbs,
      size: fs.statSync(dumpFileAbs).size,
      duration: 1,
      checksum: 'abc',
    });

    // Re-seed the database_backup_runs row that getDatabaseBackupInfo
    // resolves against (its query is `status='completed'` + most recent).
    await db('database_backup_runs').del();
    await db('database_backup_runs').insert({
      started_at: new Date(),
      completed_at: new Date(),
      status: 'completed',
      backup_type: 'pg',
      file_path: dumpFileAbs,
      file_size_bytes: fs.statSync(dumpFileAbs).size,
      destination_path: dumpFileAbs,
    });
  });

  it('default behaviour: inline dump runs, then file backup proceeds', async () => {
    // Inline-dump setting is unset (undefined) — default is ON.
    await db('app_settings').where('setting_key', 'backup_database_inline_dump').del();

    await backupService.runBackup(true);

    expect(mockBackupFn).toHaveBeenCalledTimes(1);

    const run = await db('backup_runs').orderBy('id', 'desc').first();
    expect(run.status).toBe('completed');
    expect(run.error_message).toBeNull();
  });

  it('aborts the run when the inline dump throws', async () => {
    await db('app_settings').where('setting_key', 'backup_database_inline_dump').del();
    mockBackupFn.mockRejectedValueOnce(new Error('pg_dump segfaulted'));

    await backupService.runBackup(true);

    const run = await db('backup_runs').orderBy('id', 'desc').first();
    expect(run.status).toBe('failed');
    expect(run.error_message).toMatch(/pg_dump segfaulted/);
  });

  it('opt-out: skips inline dump but proceeds when a recent dump exists', async () => {
    await db('app_settings').insert({
      setting_key: 'backup_database_inline_dump',
      setting_value: JSON.stringify(false),
      setting_type: 'backup',
    }).onConflict('setting_key').merge();

    await backupService.runBackup(true);

    expect(mockBackupFn).not.toHaveBeenCalled();

    const run = await db('backup_runs').orderBy('id', 'desc').first();
    expect(run.status).toBe('completed');
  });

  it('opt-out + no recent dump: fails loud with a clear error', async () => {
    await db('app_settings').insert({
      setting_key: 'backup_database_inline_dump',
      setting_value: JSON.stringify(false),
      setting_type: 'backup',
    }).onConflict('setting_key').merge();
    // Wipe the dump row so getDatabaseBackupInfo returns backupFile=null.
    await db('database_backup_runs').del();

    await backupService.runBackup(true);

    const run = await db('backup_runs').orderBy('id', 'desc').first();
    expect(run.status).toBe('failed');
    expect(run.error_message).toMatch(/No database backup available/);
  });

  it('opt-out + 0-byte dump file: fails loud', async () => {
    await db('app_settings').insert({
      setting_key: 'backup_database_inline_dump',
      setting_value: JSON.stringify(false),
      setting_type: 'backup',
    }).onConflict('setting_key').merge();

    const emptyDump = path.join(storagePath, 'backups', 'empty-dump.sql.gz');
    fs.writeFileSync(emptyDump, '');
    await db('database_backup_runs').del();
    await db('database_backup_runs').insert({
      started_at: new Date(),
      completed_at: new Date(),
      status: 'completed',
      backup_type: 'pg',
      file_path: emptyDump,
      file_size_bytes: 0,
      destination_path: emptyDump,
    });

    await backupService.runBackup(true);

    const run = await db('backup_runs').orderBy('id', 'desc').first();
    expect(run.status).toBe('failed');
    expect(run.error_message).toMatch(/is empty/);
  });
});
