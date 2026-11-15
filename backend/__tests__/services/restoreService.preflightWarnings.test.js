/**
 * Restore pre-flight: which version differences warn, and what a restore
 * stopped before it changed anything records.
 *
 * A beta install restoring a full backup from an older beta was blocked with
 * "Version mismatch" (the normal upgrade case: the post-restore migrations
 * bring the data up), and the failed run then claimed the destination "may be
 * partial" although the block happened before anything was touched.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-restore-preflight-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'restore-preflight-test-secret';

jest.mock('../../src/utils/safeExec', () => ({
  spawnAsync: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  spawnToFile: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  spawnFromFile: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}));
jest.mock('../../src/services/emailProcessor', () => ({ queueEmail: jest.fn() }));
jest.mock('../../src/services/portableRestoreIngress', () => ({ withIngress: run => run() }), { virtual: true });
jest.mock('../../src/services/portableRestoreCoordinator', () => ({
  admitUpload: async () => {}, isRegistered: () => false, pendingCoreMigrations: async () => [],
}));

const { bootCrmDb } = require('../integration/helpers/crmDb');

describe('assessBackupVersion', () => {
  const { _internal: { assessBackupVersion } } = require('../../src/services/restoreService');
  const code = (backup, current) => assessBackupVersion(backup, current)?.code ?? null;
  const severity = (backup, current) => assessBackupVersion(backup, current)?.severity ?? null;

  it('says nothing for the same version', () => {
    expect(assessBackupVersion('3.204.0-beta.0', '3.204.0-beta.0')).toBeNull();
  });

  it('an older backup on the same line is an info line, not a warning', () => {
    expect(assessBackupVersion('3.202.2-beta.0', '3.204.0-beta.0')).toMatchObject({
      severity: 'info', code: 'version_older',
      params: { backupVersion: '3.202.2-beta.0', currentVersion: '3.204.0-beta.0' },
    });
    expect(severity('3.135.2', '3.135.14')).toBe('info');
    // Numeric, not lexical: 3.99 is older than 3.100.
    expect(code('3.99.0-beta.0', '3.100.0-beta.0')).toBe('version_older');
  });

  it('a backup from a newer version warns', () => {
    expect(assessBackupVersion('3.204.1-beta.0', '3.204.0-beta.0')).toMatchObject({
      severity: 'warning', code: 'version_newer',
    });
    expect(code('3.136.0', '3.135.14')).toBe('version_newer');
  });

  it('orders prerelease numbers numerically', () => {
    expect(code('3.204.0-beta.2', '3.204.0-beta.10')).toBe('version_older');
    expect(code('3.204.0-beta.10', '3.204.0-beta.2')).toBe('version_newer');
    expect(code('v3.204.0-beta.1', '3.204.0-beta.0')).toBe('version_newer');
  });

  it('a backup from the other release line warns in either direction', () => {
    expect(assessBackupVersion('3.135.14', '3.204.0-beta.0')).toMatchObject({
      severity: 'warning', code: 'version_other_line',
    });
    // Stable's side: the running app is 3.135.x, a newer-looking beta backup still warns.
    expect(code('3.204.0-beta.0', '3.135.14')).toBe('version_other_line');
    expect(code('3.135.0-beta.0', '3.135.14')).toBe('version_other_line');
  });

  it('an unparsable version keeps the mismatch warning', () => {
    for (const [backup, current] of [[undefined, '3.204.0-beta.0'], ['dev', '3.204.0-beta.0'], ['3.204.0-beta.0', 'x']]) {
      const notice = assessBackupVersion(backup, current);
      expect(notice).toMatchObject({ severity: 'warning', code: 'version_unknown' });
      expect(notice.message).toMatch(/^Version mismatch/);
    }
  });
});

describe('restoreService pre-flight', () => {
  let cleanup; let RestoreService; let db; let backupManifest;
  const currentVersion = require('../../package.json').version;
  // Same release line as the running app, so only the order differs.
  const sameLine = (core) => core + (currentVersion.includes('-') ? '-beta.0' : '');

  const manifestFor = (version) => backupManifest.signManifest({
    manifest: { version: '3.0' }, system: {}, application: { version }, verification: {},
    backup: { id: 'b1', type: 'full', timestamp: new Date().toISOString() },
    files: { count: 0, total_size: 0, manifest: [] },
    database: { type: 'sqlite', checksum: crypto.createHash('sha256').update('stubbed dump').digest('hex') },
    metadata: {},
  });

  const stubbedService = () => {
    const svc = new RestoreService();
    svc.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-restore-preflight-tmp-'));
    svc.loadAndValidateManifest = async () => manifestFor(currentVersion);
    svc.checkDiskSpace = async () => ({ hasEnoughSpace: true });
    svc.performFullRestore = jest.fn(async () => ({ databaseRestored: true, filesRestored: 0, errors: [] }));
    svc.performPostRestoreVerification = async () => ({ isValid: true, errors: [], checksums: {} });
    svc.requeueFaceScans = async () => {};
    svc.attemptRollback = jest.fn(async () => {});
    svc.sendRestoreNotification = jest.fn(async () => {});
    return svc;
  };
  const options = (extra = {}) => ({
    source: '/backups', manifestPath: '/backups/m.json', restoreType: 'full', ...extra,
  });
  const latestRun = () => db('restore_runs').orderBy('id', 'desc').first();

  beforeAll(async () => {
    ({ cleanup } = await bootCrmDb());
    ({ RestoreService } = require('../../src/services/restoreService'));
    ({ db } = require('../../src/database/db'));
    backupManifest = require('../../src/services/backupManifest');
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('validation lists an older backup as info and a newer one as a warning, with codes', async () => {
    const svc = new RestoreService();
    const older = await svc.performPreRestoreValidation(manifestFor(sameLine('0.1.0')), { restoreType: 'files' });
    expect(older.isValid).toBe(true);
    expect(older.warnings.join(' ')).not.toMatch(/version/i);
    expect(older.notices).toContainEqual(expect.objectContaining({ severity: 'info', code: 'version_older' }));

    const newer = await svc.performPreRestoreValidation(manifestFor(sameLine('999.0.0')), { restoreType: 'files' });
    expect(newer.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/newer version/)]));
    expect(newer.notices).toContainEqual(expect.objectContaining({ severity: 'warning', code: 'version_newer' }));
  });

  it('a backup from the other release line warns against the running version', async () => {
    // On stable (no prerelease) a beta backup is the other line; on main the reverse.
    const otherLine = currentVersion.includes('-') ? '3.135.14' : '3.204.0-beta.0';
    const validation = await new RestoreService().performPreRestoreValidation(manifestFor(otherLine), { restoreType: 'files' });
    expect(validation.notices).toContainEqual(expect.objectContaining({
      severity: 'warning', code: 'version_other_line', params: { backupVersion: otherLine, currentVersion },
    }));
    expect(validation.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/another release line/)]));
  });

  it('warnings carry a code and their values next to the plain message', async () => {
    await db('events').insert({
      slug: 'preflight-event', event_type: 'wedding', event_name: 'Preflight', event_date: '2026-01-01',
      share_link: 'preflight-share', password_hash: 'x', expires_at: '2027-01-01T00:00:00.000Z', created_at: new Date().toISOString(),
    });
    try {
      const validation = await new RestoreService().performPreRestoreValidation(manifestFor(currentVersion), { restoreType: 'full' });
      const events = validation.notices.find((n) => n.code === 'existing_events');
      expect(events).toMatchObject({ severity: 'warning', params: { count: 1 } });
      expect(validation.warnings).toContain(events.message);
    } finally {
      await db('events').where({ slug: 'preflight-event' }).del();
    }
  });

  it('a restore blocked by warnings is recorded as blocked, unchanged, and nothing is rolled back', async () => {
    const svc = stubbedService();
    svc.performPreRestoreValidation = async () => ({
      isValid: true, errors: [], warnings: ['Database contains 4 existing events that will be overwritten'], notices: [],
    });
    svc.createPreRestoreBackup = jest.fn(async () => '/tmp/never');

    await expect(svc.restore(options())).rejects.toThrow(/Restore blocked due to warnings/);

    const run = await latestRun();
    expect(run.status).toBe('blocked');
    expect(run.error_message).toContain('this install was not modified');
    expect(run.error_message).not.toMatch(/partial|rolled back/);
    expect(Boolean(run.was_rollback_attempted)).toBe(false);
    expect(svc.createPreRestoreBackup).not.toHaveBeenCalled();
    expect(svc.performFullRestore).not.toHaveBeenCalled();
    expect(svc.attemptRollback).not.toHaveBeenCalled();
  });

  it('a failed safety backup also stops before any change', async () => {
    const svc = stubbedService();
    svc.performPreRestoreValidation = async () => ({ isValid: true, errors: [], warnings: [], notices: [] });
    svc.createPreRestoreBackup = async () => { throw new Error('Failed to create pre-restore backup: disk full'); };

    await expect(svc.restore(options())).rejects.toThrow(/disk full/);

    const run = await latestRun();
    expect(run.status).toBe('blocked');
    expect(run.error_message).toContain('this install was not modified');
    expect(svc.performFullRestore).not.toHaveBeenCalled();
  });

  it('a failure after the restore started writing keeps the failed status and the partial-state text', async () => {
    const svc = stubbedService();
    svc.performPreRestoreValidation = async () => ({ isValid: true, errors: [], warnings: [], notices: [] });
    svc.performFullRestore = jest.fn(async () => { throw new Error('pg_restore exploded'); });

    await expect(svc.restore(options({ skipPreBackup: true }))).rejects.toThrow(/pg_restore exploded/);

    const run = await latestRun();
    expect(run.status).toBe('failed');
    expect(run.error_message).toBe('pg_restore exploded (no pre-restore backup available — destination may be partial)');
  });

  it('a failure after the restore started writing still rolls back from the safety backup', async () => {
    const svc = stubbedService();
    svc.performPreRestoreValidation = async () => ({ isValid: true, errors: [], warnings: [], notices: [] });
    svc.createPreRestoreBackup = jest.fn(async () => '/tmp/pre-restore-safety');
    svc.performFullRestore = jest.fn(async () => { throw new Error('tar failed'); });

    await expect(svc.restore(options())).rejects.toThrow(/tar failed/);

    expect(svc.attemptRollback).toHaveBeenCalledWith('/tmp/pre-restore-safety');
    const run = await latestRun();
    expect(run.status).toBe('failed');
    expect(run.error_message).toBe('tar failed (rolled back successfully to pre-restore state)');
    expect(Boolean(run.was_rollback_attempted)).toBe(true);
  });
});
