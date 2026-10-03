/**
 * Built-in full/database restores (and the rollback that replays the
 * pre-restore dump) replace the identity tables but never advanced the global
 * session cutoff, so every admin, customer and gallery JWT minted before the
 * restore kept resolving its numeric id against the restored rows. The
 * portable import did stamp a cutoff, but at "now" in whole seconds while
 * isTokenBeforeCutoff() rejects only `iat < cutoff`, so a token minted
 * earlier in the same second survived. Scanner finding 5f6017d2.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-restore-cutoff-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'restore-cutoff-test-secret';

// The restore shells out (post-restore migrations, sqlite3 .restore on
// rollback); none of that is under test here.
jest.mock('../../src/utils/safeExec', () => ({
  spawnAsync: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  spawnToFile: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  spawnFromFile: jest.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}));
jest.mock('../../src/services/emailProcessor', () => ({ queueEmail: jest.fn() }));

const { bootCrmDb } = require('../integration/helpers/crmDb');

describe('restoreService — pre-restore sessions are invalidated', () => {
  let cleanup; let RestoreService; let _internal; let cutoff;

  const stubbedService = (restoreType) => {
    const svc = new RestoreService();
    svc.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-restore-cutoff-tmp-'));
    svc.loadAndValidateManifest = async () => ({
      backup: { id: 'b1', type: 'full', timestamp: new Date().toISOString() },
      files: { count: 0, total_size: 0, manifest: [] },
      database: { type: 'sqlite' },
      metadata: {},
    });
    svc.performPreRestoreValidation = async () => ({ isValid: true, errors: [], warnings: [] });
    svc.checkDiskSpace = async () => ({ hasEnoughSpace: true });
    svc.performDatabaseRestore = async () => ({ success: true });
    svc.performFilesRestore = async () => ({ filesRestored: 0, totalFiles: 0, errors: [] });
    svc.performFullRestore = async () => ({ databaseRestored: true, filesRestored: 0, errors: [] });
    svc.performPostRestoreVerification = async () => ({ isValid: true, errors: [], checksums: {} });
    svc.requeueFaceScans = async () => {};
    svc.sendRestoreNotification = async () => {};
    return { svc, options: { source: '/backups', manifestPath: '/backups/m.json', restoreType, skipPreBackup: true } };
  };

  beforeAll(async () => {
    ({ cleanup } = await bootCrmDb());
    ({ RestoreService, _internal } = require('../../src/services/restoreService'));
    cutoff = require('../../src/utils/sessionCutoff');
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(async () => {
    await cutoff.setSessionsValidAfter(0);
    cutoff._resetCache();
  });

  it('the cutoff is the next whole second, so a same-second token is out', async () => {
    const minted = Math.floor(Date.now() / 1000); // a JWT iat issued right now
    const next = _internal.nextSessionCutoff();
    expect(next).toBeGreaterThanOrEqual(minted + 1);
    await cutoff.setSessionsValidAfter(next);
    expect(await cutoff.isTokenBeforeCutoff({ iat: minted })).toBe(true);
    expect(await cutoff.isTokenBeforeCutoff({ iat: next })).toBe(false);
  });

  it.each(['database', 'full'])('a %s restore stamps the cutoff', async (restoreType) => {
    const minted = Math.floor(Date.now() / 1000);
    const { svc, options } = stubbedService(restoreType);
    const result = await svc.restore(options);
    expect(result.success).toBe(true);
    expect(await cutoff.getSessionsValidAfter()).toBeGreaterThan(minted);
    expect(await cutoff.isTokenBeforeCutoff({ iat: minted })).toBe(true);
  });

  it('a files-only restore leaves sessions alone', async () => {
    const { svc, options } = stubbedService('files');
    const result = await svc.restore(options);
    expect(result.success).toBe(true);
    expect(await cutoff.getSessionsValidAfter()).toBe(0);
  });

  it('rolling the database back stamps the cutoff again', async () => {
    const minted = Math.floor(Date.now() / 1000);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-restore-cutoff-rb-'));
    fs.writeFileSync(path.join(dir, 'backup-manifest.json'), '{}');
    fs.writeFileSync(path.join(dir, 'database.sql.gz'), zlib.gzipSync(Buffer.from('-- dump')));
    const svc = new RestoreService();
    await svc.attemptRollback(dir);
    expect(await cutoff.getSessionsValidAfter()).toBeGreaterThan(minted);
  });
});
