/**
 * restoreService — every required file counts.
 *
 * Per-file failures were tolerated as long as one other file copied, and the
 * post-restore verification only looked at the first 100 manifest entries, so
 * a run with missing or corrupt required files was recorded (and announced)
 * as a successful restore. Scanner finding 6b5d467d.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-restore-required-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'restore-required-test-secret';

const { bootCrmDb } = require('../integration/helpers/crmDb');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

describe('restoreService — required files are fatal', () => {
  let cleanup; let restoreService;
  let backupRoot; let storageRoot;

  const writeFixture = (rel, content) => {
    const abs = path.join(backupRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return { path: rel, size: content.length, checksum: sha256(content) };
  };

  beforeAll(async () => {
    ({ cleanup } = await bootCrmDb());
    ({ restoreService } = require('../../src/services/restoreService'));
    storageRoot = process.env.STORAGE_PATH;
    backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-restore-required-backup-'));
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    fs.rmSync(backupRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(storageRoot, { recursive: true, force: true });
    fs.mkdirSync(storageRoot, { recursive: true });
  });

  it('fails the run when one of 101 required entries is missing instead of returning success', async () => {
    const entries = [];
    for (let i = 0; i < 100; i += 1) {
      entries.push(writeFixture(`many/uploads/p${i}.jpg`, Buffer.from(`photo-${i}`)));
    }
    entries.push({ path: 'many/uploads/p100.jpg', size: 9, checksum: sha256(Buffer.from('photo-100')) });

    await expect(restoreService.performFilesRestore(backupRoot, { files: { manifest: entries } }, { restoreType: 'files' }))
      .rejects.toThrow(/1 of 101 file restorations failed.*Source file not found: many\/uploads\/p100\.jpg/);
  });

  it('post-restore verification checks the whole manifest, not the first 100 entries', async () => {
    const entries = [];
    for (let i = 0; i < 100; i += 1) {
      const content = Buffer.from(`verify-${i}`);
      const rel = `verify/uploads/p${i}.jpg`;
      fs.mkdirSync(path.join(storageRoot, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(storageRoot, rel), content);
      entries.push({ path: rel, size: content.length, checksum: sha256(content) });
    }
    entries.push({ path: 'verify/uploads/p100.jpg', size: 10, checksum: sha256(Buffer.from('verify-100')) });

    const verification = await restoreService.performPostRestoreVerification(
      { files: { manifest: entries }, database: {} }, { restoreType: 'files' },
    );
    expect(verification.isValid).toBe(false);
    expect(verification.errors).toEqual(['File not found after restore: verify/uploads/p100.jpg']);
  });

  it('post-restore verification covers the selected files of a selective restore', async () => {
    const verification = await restoreService.performPostRestoreVerification(
      { files: { manifest: [] }, database: {} },
      { restoreType: 'selective', selectedItems: [{ type: 'file', path: 'nope/missing.jpg' }] },
    );
    expect(verification.isValid).toBe(false);
    expect(verification.errors).toEqual(['File not found after restore: nope/missing.jpg']);
  });
});
