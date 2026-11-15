/**
 * A native restore runs the core migrations on the restored database in a
 * subprocess. When that subprocess failed, the restore only logged a warning
 * and still reported success, so the instance went on serving a database
 * whose ledger misses migrations the running code depends on. The portable
 * path holds the instance until the ledger is complete (issue 2480); the
 * native path now does the same with maintenance mode.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-restore-migrations-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'restore-migrations-test-secret';

jest.mock('../../src/utils/safeExec', () => ({
  spawnAsync: jest.fn(),
  spawnToFile: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  spawnFromFile: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}));
jest.mock('../../src/services/emailProcessor', () => ({ queueEmail: jest.fn() }));
jest.mock('../../src/services/portableRestoreIngress', () => ({ withIngress: run => run() }), { virtual: true });
// The ledger check under test is the coordinator's own pendingCoreMigrations.
jest.mock('../../src/services/portableRestoreCoordinator', () => {
  const actual = jest.requireActual('../../src/services/portableRestoreCoordinator');
  return { admitUpload: async () => {}, isRegistered: () => false, pendingCoreMigrations: actual.pendingCoreMigrations };
});

const { bootCrmDb } = require('../integration/helpers/crmDb');

describe('restoreService — failed post-restore migrations', () => {
  let cleanup; let RestoreService; let db; let spawnAsync; let clearMaintenanceCache; let maintenanceMiddleware;
  let removed;

  const stubbedService = (restoreType) => {
    const svc = new RestoreService();
    svc.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-restore-migrations-tmp-'));
    svc.loadAndValidateManifest = async () => require('../../src/services/backupManifest').signManifest({
      manifest: { version: '3.0' }, system: {}, application: {}, verification: {},
      backup: { id: 'b1', type: 'full', timestamp: new Date().toISOString() },
      files: { count: 0, total_size: 0, manifest: [] },
      database: { type: 'sqlite', checksum: require('crypto').createHash('sha256').update('stubbed authenticated dump').digest('hex') },
      metadata: {},
    });
    svc.performPreRestoreValidation = async () => ({ isValid: true, errors: [], warnings: [] });
    svc.checkDiskSpace = async () => ({ hasEnoughSpace: true });
    svc.performDatabaseRestore = async () => ({ success: true });
    svc.performFullRestore = async () => ({ databaseRestored: true, filesRestored: 0, errors: [] });
    svc.performPostRestoreVerification = async () => ({ isValid: true, errors: [], checksums: {} });
    svc.requeueFaceScans = async () => {};
    svc.sendRestoreNotification = jest.fn(async () => {});
    return { svc, options: { source: '/backups', manifestPath: '/backups/m.json', restoreType, skipPreBackup: true } };
  };

  const maintenanceOn = async () => {
    const row = await db('app_settings').where({ setting_key: 'general_maintenance_mode' }).first();
    return Boolean(row && (row.setting_value === 'true' || row.setting_value === true));
  };
  // What a visitor's API request gets from the maintenance gate right now.
  const publicStatus = () => new Promise((resolve) => {
    const res = { status: (code) => ({ json: () => resolve(code) }) };
    maintenanceMiddleware({ path: '/api/gallery/some-event', method: 'GET', headers: {} }, res, () => resolve(200));
  });
  const latestRun = () => db('restore_runs').orderBy('id', 'desc').first();

  beforeAll(async () => {
    ({ cleanup } = await bootCrmDb());
    ({ RestoreService } = require('../../src/services/restoreService'));
    ({ db } = require('../../src/database/db'));
    ({ spawnAsync } = require('../../src/utils/safeExec'));
    ({ clearMaintenanceCache, maintenanceMiddleware } = require('../../src/middleware/maintenance'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(async () => {
    spawnAsync.mockReset();
    await db('app_settings').where({ setting_key: 'general_maintenance_mode' }).del();
    clearMaintenanceCache();
  });

  afterEach(async () => {
    if (removed) await db('migrations').insert(removed);
    removed = null;
  });

  // The restored archive predates the newest migration: its ledger lacks it.
  const lagLedger = async () => {
    const row = await db('migrations').orderBy('filename', 'desc').first();
    removed = { ...row };
    await db('migrations').where({ filename: row.filename }).del();
    return row.filename;
  };

  it.each(['database', 'full'])('a %s restore whose migrations fail is held in maintenance, not reported as a success', async (restoreType) => {
    const missing = await lagLedger();
    spawnAsync.mockRejectedValue(new Error('migration 999 exploded'));
    const { svc, options } = stubbedService(restoreType);

    const result = await svc.restore(options);

    expect(spawnAsync).toHaveBeenCalledWith('node', ['migrations/run-migrations-safe.js'], expect.any(Object));
    expect(result.success).toBe(false);
    expect(result.migrationsPending).toEqual([missing]);
    expect(result.error).toContain(missing);
    expect(await maintenanceOn()).toBe(true);
    expect(await publicStatus()).toBe(503);

    const run = await latestRun();
    expect(run.status).toBe('migrations_pending');
    expect(Boolean(run.was_successful)).toBe(false);
    expect(run.error_message).toContain(missing);
    expect(svc.sendRestoreNotification).toHaveBeenCalledWith('failed', expect.objectContaining({ restoreType }));
    expect(svc.isRunning).toBe(false);
  });

  it('a failed migration run that left nothing pending still completes', async () => {
    // The subprocess can fail after its last migration (or with nothing to
    // do); the ledger, not the exit code, decides whether the schema lags.
    spawnAsync.mockRejectedValue(new Error('exit code 1'));
    const { svc, options } = stubbedService('database');

    const result = await svc.restore(options);

    expect(result.success).toBe(true);
    expect(await maintenanceOn()).toBe(false);
    expect(await publicStatus()).toBe(200);
    const run = await latestRun();
    expect(run.status).toBe('completed');
    expect(Boolean(run.was_successful)).toBe(true);
  });

  it('a restore whose migrations ran is unaffected', async () => {
    spawnAsync.mockResolvedValue({ stdout: '', stderr: '' });
    const { svc, options } = stubbedService('database');

    const result = await svc.restore(options);

    expect(result.success).toBe(true);
    expect(await maintenanceOn()).toBe(false);
  });
});
