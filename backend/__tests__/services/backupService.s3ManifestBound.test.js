/**
 * The latest S3 manifest is downloaded into a fresh temp dir on every backup
 * status request. There was no size bound, and the temp dir was removed only
 * after a successful parse, so an oversized or malformed object stayed on
 * disk after every failed validation. Scanner finding 19f1f5df.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { Readable } = require('stream');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-s3manifest-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 's3manifest-test-secret';

jest.mock('node-cron', () => ({ schedule: jest.fn(() => ({ stop: jest.fn() })) }));

const backupService = require('../../src/services/backupService');
const backupManifest = require('../../src/services/backupManifest');

const LIMIT = backupService.MAX_S3_MANIFEST_BYTES;

describe('backupService — bounded S3 manifest download', () => {
  let scratchTmp; let originalTmpdir;

  beforeEach(() => {
    // os.tmpdir() reads TMPDIR per call, so every mkdtemp in the service
    // lands here and leftovers are easy to spot.
    originalTmpdir = process.env.TMPDIR;
    scratchTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-s3manifest-tmp-'));
    process.env.TMPDIR = scratchTmp;
  });

  afterEach(() => {
    if (originalTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmpdir;
    fs.rmSync(scratchTmp, { recursive: true, force: true });
  });

  const leftovers = () => fs.readdirSync(scratchTmp).filter((n) => n.startsWith('backup-manifest-'));

  it('rejects an oversized ContentLength before fetching the body', async () => {
    const client = {
      getMetadata: jest.fn().mockResolvedValue({ ContentLength: LIMIT + 1 }),
      downloadStream: jest.fn(),
    };
    await expect(backupService.loadManifestFromS3Bounded(client, 'manifests/m.json', 'run-1'))
      .rejects.toThrow(/above the .* limit/);
    expect(client.downloadStream).not.toHaveBeenCalled();
    expect(leftovers()).toEqual([]);
  });

  it('aborts a body longer than declared and leaves no temp dir', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 0x7b); // 1 MiB of '{'
    const chunks = Array.from({ length: 17 }, () => chunk); // 17 MiB > 16 MiB
    const client = {
      getMetadata: jest.fn().mockResolvedValue({ ContentLength: 100 }),
      downloadStream: jest.fn().mockResolvedValue(Readable.from(chunks)),
    };
    await expect(backupService.loadManifestFromS3Bounded(client, 'manifests/m.json', 'run-2'))
      .rejects.toThrow(/exceeds the .* limit/);
    expect(leftovers()).toEqual([]);
  });

  it('cleans up after a malformed manifest', async () => {
    const client = {
      getMetadata: jest.fn().mockResolvedValue({ ContentLength: 12 }),
      downloadStream: jest.fn().mockResolvedValue(Readable.from([Buffer.from('{ not json :')])),
    };
    await expect(backupService.loadManifestFromS3Bounded(client, 'manifests/m.json', 'run-3'))
      .rejects.toThrow();
    expect(leftovers()).toEqual([]);
  });

  it('loads a well-formed manifest and cleans up', async () => {
    const manifest = {
      manifest: { version: '2.0' }, backup: { id: 'b1', type: 'full' }, system: {}, application: {},
      files: { count: 0, manifest: [] }, database: {},
      verification: { total_checksum: null, checksum_algorithm: 'sha256' },
    };
    manifest.verification.total_checksum = backupManifest.calculateManifestChecksum(manifest, { keyed: false });
    const client = {
      getMetadata: jest.fn().mockResolvedValue({ ContentLength: 10 }),
      downloadStream: jest.fn().mockResolvedValue(Readable.from([Buffer.from(JSON.stringify(manifest))])),
    };
    const loaded = await backupService.loadManifestFromS3Bounded(client, 'manifests/m.json', 'run-4');
    expect(loaded.backup.id).toBe('b1');
    expect(leftovers()).toEqual([]);
  });
});
