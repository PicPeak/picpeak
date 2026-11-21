/**
 * Every database dump holds its own backup run as 'running': the
 * backup_runs row and the dump's database_backup_runs row are made final
 * only after the dump. A restore of that dump brought the rows back and
 * nothing ever ended them, so the dashboard showed a backup running forever
 * that the admin UI would not delete. A process that died mid-run left the
 * same row. interruptedRuns.js marks them failed.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-interrupted-runs-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'interrupted-runs-test-secret';

jest.mock('../../src/utils/safeExec', () => ({
  spawnAsync: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  spawnToFile: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  spawnFromFile: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}));
jest.mock('../../src/services/emailProcessor', () => ({ queueEmail: jest.fn() }));
jest.mock('../../src/services/portableRestoreIngress', () => ({ withIngress: run => run() }), { virtual: true });
jest.mock('../../src/services/portableRestoreCoordinator', () => {
  const actual = jest.requireActual('../../src/services/portableRestoreCoordinator');
  return { admitUpload: async () => {}, isRegistered: () => false, pendingCoreMigrations: actual.pendingCoreMigrations };
});

const { bootCrmDb } = require('../integration/helpers/crmDb');

const HOUR = 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

describe('interrupted backup and restore runs', () => {
  let cleanup; let db; let RestoreService; let interruptedRuns; let backupService; let databaseBackupService;

  beforeAll(async () => {
    ({ cleanup } = await bootCrmDb());
    ({ db } = require('../../src/database/db'));
    ({ RestoreService } = require('../../src/services/restoreService'));
    interruptedRuns = require('../../src/services/interruptedRuns');
    backupService = require('../../src/services/backupService');
    ({ databaseBackupService } = require('../../src/services/databaseBackup'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(async () => {
    jest.restoreAllMocks();
    databaseBackupService.currentRunId = null;
    for (const table of ['backup_runs', 'database_backup_runs', 'restore_runs']) await db(table).del();
  });

  const insertId = (result) => (Array.isArray(result) ? (result[0]?.id ?? result[0]) : result);
  const addBackupRun = async (startedAt, status = 'running') => insertId(await db('backup_runs')
    .insert({ started_at: iso(startedAt), status, backup_type: 'manual' }).returning('id'));
  const addDumpRun = async (startedAt, status = 'running') => insertId(await db('database_backup_runs')
    .insert({ started_at: iso(startedAt), status, backup_type: 'sqlite' }).returning('id'));
  const addRestoreRun = async (startedAt, status = 'running') => insertId(await db('restore_runs')
    .insert({ started_at: iso(startedAt), status, restore_type: 'full', source: 'local' }).returning('id'));
  const row = (table, id) => db(table).where({ id }).first();

  // A restore whose database step "replaces" the database with the rows a
  // dump taken mid-backup holds.
  const restoreWith = (restoreType, restoredRows) => {
    const svc = new RestoreService();
    svc.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-interrupted-runs-tmp-'));
    svc.loadAndValidateManifest = async () => require('../../src/services/backupManifest').signManifest({
      manifest: { version: '3.0' }, system: {}, application: {}, verification: {},
      backup: { id: 'b1', type: 'full', timestamp: new Date().toISOString() },
      files: { count: 0, total_size: 0, manifest: [] },
      database: { type: 'sqlite', checksum: require('crypto').createHash('sha256').update('dump').digest('hex') },
      metadata: {},
    });
    svc.performPreRestoreValidation = async () => ({ isValid: true, errors: [], warnings: [] });
    svc.checkDiskSpace = async () => ({ hasEnoughSpace: true });
    svc.performDatabaseRestore = async () => { await restoredRows(); return { success: true }; };
    svc.performFullRestore = async () => { await restoredRows(); return { databaseRestored: true, filesRestored: 0, errors: [] }; };
    svc.performFilesRestore = async () => { await restoredRows(); return { filesRestored: 0, errors: [] }; };
    svc.performPostRestoreVerification = async () => ({ isValid: true, errors: [], checksums: {} });
    svc.requeueFaceScans = async () => {};
    svc.sendRestoreNotification = jest.fn(async () => {});
    return svc.restore({ source: '/backups', manifestPath: '/backups/m.json', restoreType, skipPreBackup: true });
  };

  it.each(['database', 'full'])('a %s restore ends the running rows the dump brought back', async (restoreType) => {
    const dumpedAt = Date.now() - 2 * HOUR;
    const ids = {};
    const result = await restoreWith(restoreType, async () => {
      ids.backup = await addBackupRun(dumpedAt);
      ids.dump = await addDumpRun(dumpedAt + 1000);
      ids.restore = await addRestoreRun(dumpedAt - HOUR);
      ids.done = await addBackupRun(dumpedAt - 24 * HOUR, 'completed');
    });

    expect(result.success).toBe(true);
    for (const [table, id] of [['backup_runs', ids.backup], ['database_backup_runs', ids.dump], ['restore_runs', ids.restore]]) {
      const restored = await row(table, id);
      expect(restored.status).toBe('failed');
      expect(restored.error_message).toMatch(/^Interrupted: .*restored backup/);
      expect(restored.completed_at).toBeTruthy();
    }
    expect((await row('backup_runs', ids.done)).status).toBe('completed');
    // The restore's own row is not one of them.
    const own = await db('restore_runs').whereNot({ id: ids.restore }).orderBy('id', 'desc').first();
    expect(own.status).toBe('completed');
  });

  it('a files restore leaves the run rows alone', async () => {
    const id = await addBackupRun(Date.now() - 2 * HOUR);
    const result = await restoreWith('files', async () => {});
    expect(result.success).toBe(true);
    expect((await row('backup_runs', id)).status).toBe('running');
  });

  it('the backup this process is running is untouched by a restore and by the sweep', async () => {
    const old = Date.now() - 13 * HOUR;
    const live = await addBackupRun(old);
    const liveDump = await addDumpRun(old);
    const dead = await addBackupRun(old);
    jest.spyOn(backupService, 'currentRunId').mockReturnValue(live);
    databaseBackupService.currentRunId = liveDump;

    expect(await interruptedRuns.markRestoredRuns(Date.now())).toBe(1);
    expect((await row('backup_runs', live)).status).toBe('running');
    expect((await row('database_backup_runs', liveDump)).status).toBe('running');
    expect((await row('backup_runs', dead)).status).toBe('failed');

    expect(await interruptedRuns.sweepStaleRuns()).toBe(0);
    expect((await row('backup_runs', live)).status).toBe('running');
  });

  it('the sweep marks only rows older than the window that predate this process', async () => {
    const now = Date.now();
    const stale = await addBackupRun(now - 13 * HOUR);
    const staleDump = await addDumpRun(now - 13 * HOUR);
    const staleRestore = await addRestoreRun(now - 13 * HOUR);
    // Could still be another replica's backup.
    const recent = await addBackupRun(now - HOUR);
    const sinceBoot = await addBackupRun(now);

    expect(await interruptedRuns.sweepStaleRuns(now)).toBe(3);
    for (const [table, id] of [['backup_runs', stale], ['database_backup_runs', staleDump], ['restore_runs', staleRestore]]) {
      const swept = await row(table, id);
      expect(swept.status).toBe('failed');
      expect(swept.error_message).toMatch(/^Interrupted: the run did not finish/);
    }
    expect((await row('backup_runs', recent)).status).toBe('running');
    expect((await row('backup_runs', sinceBoot)).status).toBe('running');

    // Started after this process booted: another replica's, even when old.
    await db('backup_runs').del();
    const later = interruptedRuns.BOOTED_AT + 1000;
    const afterBoot = await addBackupRun(later);
    expect(await interruptedRuns.sweepStaleRuns(later + 13 * HOUR)).toBe(0);
    expect((await row('backup_runs', afterBoot)).status).toBe('running');
  });

  it('the sweep waits while a restore runs in this process', async () => {
    const stale = await addBackupRun(Date.now() - 13 * HOUR);
    const { restoreService } = require('../../src/services/restoreService');
    restoreService.isRunning = true;
    try {
      expect(await interruptedRuns.sweepStaleRuns()).toBe(0);
    } finally {
      restoreService.isRunning = false;
    }
    expect((await row('backup_runs', stale)).status).toBe('running');
  });
});
