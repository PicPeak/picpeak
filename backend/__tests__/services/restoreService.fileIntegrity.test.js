/**
 * restoreService — file restore integrity.
 *
 *  - A hostile backup tree can place a symlink at a manifest path; the
 *    restore followed it and copied any backend-readable file into managed
 *    storage (scanner finding 1283fcde).
 *  - `restore_max_file_size_mb` was configurable but never enforced; an
 *    oversized replacement object was written in full before its checksum
 *    was compared (scanner finding 4266a14b).
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Readable } = require('stream');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-restore-integrity-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'restore-integrity-test-secret';

const { bootCrmDb } = require('../integration/helpers/crmDb');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

describe('restoreService — file restore integrity', () => {
  let db; let cleanup; let restoreService; let _internal;
  let backupRoot; let storageRoot; let outsideDir;

  const writeFixture = (rel, content) => {
    const abs = path.join(backupRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return { path: rel, size: content.length, checksum: sha256(content) };
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ restoreService, _internal } = require('../../src/services/restoreService'));
    storageRoot = process.env.STORAGE_PATH;
    backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-restore-integrity-backup-'));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-restore-integrity-outside-'));
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'JWT_SECRET=super-secret\n');
    fs.mkdirSync(path.join(outsideDir, 'tree'));
    fs.writeFileSync(path.join(outsideDir, 'tree', 'x.jpg'), 'outside-tree-bytes');
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    fs.rmSync(backupRoot, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    fs.rmSync(storageRoot, { recursive: true, force: true });
    fs.mkdirSync(storageRoot, { recursive: true });
    await db('app_settings').where({ setting_key: 'restore_max_file_size_mb' })
      .update({ setting_value: '5000' });
  });

  describe('symlinks in the backup tree (1283fcde)', () => {
    it('refuses a symlink leaf and a symlinked parent directory, and copies neither', async () => {
      const ok = writeFixture('sym/uploads/ok.jpg', Buffer.from('real-photo-bytes'));
      fs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(backupRoot, 'sym/uploads/leak.png'));
      fs.symlinkSync(path.join(outsideDir, 'tree'), path.join(backupRoot, 'sym/uploads/linked'));

      const manifest = { files: { manifest: [
        ok,
        { path: 'sym/uploads/leak.png', size: 24, checksum: null },
        { path: 'sym/uploads/linked/x.jpg', size: 18, checksum: null },
      ] } };

      await expect(restoreService.performFilesRestore(backupRoot, manifest, { restoreType: 'files' }))
        .rejects.toThrow(/symbolic link.*outside the backup root|outside the backup root.*symbolic link/s);

      expect(fs.existsSync(path.join(storageRoot, 'sym/uploads/leak.png'))).toBe(false);
      expect(fs.existsSync(path.join(storageRoot, 'sym/uploads/linked/x.jpg'))).toBe(false);
      // The genuine entry is still copied; the run fails as a whole.
      expect(fs.readFileSync(path.join(storageRoot, 'sym/uploads/ok.jpg'), 'utf8')).toBe('real-photo-bytes');
    });

    it('openRestoreSource rejects a non-regular file', async () => {
      const dir = path.join(backupRoot, 'nonreg');
      fs.mkdirSync(dir, { recursive: true });
      await expect(_internal.openRestoreSource(fs.realpathSync(backupRoot), 'nonreg', 1024))
        .rejects.toThrow(/not a regular file/);
    });

    it('an ordinary application-generated tree restores', async () => {
      const a = writeFixture('plain/uploads/a.jpg', Buffer.from('aaa'));
      const b = writeFixture('plain/thumbnails/b.jpg', Buffer.from('bbb'));
      const result = await restoreService.performFilesRestore(backupRoot, { files: { manifest: [a, b] } }, { restoreType: 'files' });
      expect(result).toEqual({ filesRestored: 2, totalFiles: 2, errors: [] });
      expect(fs.readFileSync(path.join(storageRoot, 'plain/thumbnails/b.jpg'), 'utf8')).toBe('bbb');
    });
  });

  describe('descriptor ownership', () => {
    it('closes the vetted source handle when the target cannot be prepared', async () => {
      // A regular file where the target directory should be: mkdir throws
      // after openRestoreSource handed the loop an open descriptor.
      const entries = [];
      for (let i = 0; i < 40; i += 1) entries.push(writeFixture(`blocked/sub/f${i}.jpg`, `bytes-${i}`));
      fs.writeFileSync(path.join(storageRoot, 'blocked'), 'not a directory');
      const fdDir = '/dev/fd';
      if (!fs.existsSync(fdDir)) return;
      const openBefore = fs.readdirSync(fdDir).length;

      await expect(restoreService.performFilesRestore(backupRoot, { files: { manifest: entries } }, { restoreType: 'files' }))
        .rejects.toThrow();

      const openAfter = fs.readdirSync(fdDir).length;
      // Descriptor count may wobble by the readdir itself, never by 40 leaked handles.
      expect(openAfter - openBefore).toBeLessThan(5);
    });
  });

  describe('restore_max_file_size_mb is enforced (4266a14b)', () => {
    it('reads the configured limit', async () => {
      await db('app_settings').where({ setting_key: 'restore_max_file_size_mb' }).update({ setting_value: '1' });
      expect(await _internal.getRestoreMaxFileBytes()).toBe(1024 * 1024);
      await db('app_settings').where({ setting_key: 'restore_max_file_size_mb' }).update({ setting_value: 'garbage' });
      expect(await _internal.getRestoreMaxFileBytes()).toBe(5000 * 1024 * 1024);
    });

    it('refuses a local source larger than the limit even when the manifest claims it is small', async () => {
      await db('app_settings').where({ setting_key: 'restore_max_file_size_mb' }).update({ setting_value: '1' });
      const big = writeFixture('big/uploads/big.jpg', Buffer.alloc(1024 * 1024 + 1, 1));
      big.size = 10; // the manifest lies about the stored object
      await expect(restoreService.performFilesRestore(backupRoot, { files: { manifest: [big] } }, { restoreType: 'files' }))
        .rejects.toThrow(/above the restore size limit of 1048576 bytes/);
      expect(fs.existsSync(path.join(storageRoot, 'big/uploads/big.jpg'))).toBe(false);
    });

    it('refuses a manifest entry recorded above the limit before touching the source', async () => {
      await db('app_settings').where({ setting_key: 'restore_max_file_size_mb' }).update({ setting_value: '1' });
      await expect(restoreService.performFilesRestore(backupRoot,
        { files: { manifest: [{ path: 'nowhere/huge.jpg', size: 2 * 1024 * 1024 }] } }, { restoreType: 'files' }))
        .rejects.toThrow(/recorded at 2097152 bytes, above the restore size limit/);
    });

    it('writeBounded aborts a stream that exceeds the limit and removes the partial file', async () => {
      const target = path.join(storageRoot, 'stream-target.bin');
      const source = Readable.from([Buffer.alloc(600, 1), Buffer.alloc(600, 2)]);
      await expect(_internal.writeBounded(source, target, 1000, 'stream-target.bin'))
        .rejects.toThrow(/exceeds the restore size limit of 1000 bytes/);
      expect(fs.existsSync(target)).toBe(false);
    });

    it('downloadS3ObjectBounded rejects an oversized ContentLength before fetching the body', async () => {
      const client = {
        getMetadata: jest.fn().mockResolvedValue({ ContentLength: 5000 }),
        downloadStream: jest.fn(),
      };
      await expect(_internal.downloadS3ObjectBounded(client, 'k', path.join(storageRoot, 'dl.bin'), 1000))
        .rejects.toThrow(/5000 bytes in the backup store, above the restore size limit of 1000 bytes/);
      expect(client.downloadStream).not.toHaveBeenCalled();
    });

    it('downloadS3ObjectBounded aborts a body longer than its declared ContentLength and unlinks it', async () => {
      const target = path.join(storageRoot, 'dl2.bin');
      const client = {
        getMetadata: jest.fn().mockResolvedValue({ ContentLength: 10 }),
        downloadStream: jest.fn().mockResolvedValue(Readable.from([Buffer.alloc(800, 1), Buffer.alloc(800, 2)])),
      };
      await expect(_internal.downloadS3ObjectBounded(client, 'k', target, 1000))
        .rejects.toThrow(/exceeds the restore size limit of 1000 bytes/);
      expect(fs.existsSync(target)).toBe(false);
    });

    it('downloadS3ObjectBounded rejects a manifest size above the limit without a HEAD request', async () => {
      const client = { getMetadata: jest.fn(), downloadStream: jest.fn() };
      await expect(_internal.downloadS3ObjectBounded(client, 'k', path.join(storageRoot, 'dl3.bin'), 1000, { expectedSize: 4000 }))
        .rejects.toThrow(/recorded at 4000 bytes/);
      expect(client.getMetadata).not.toHaveBeenCalled();
    });
  });
});
