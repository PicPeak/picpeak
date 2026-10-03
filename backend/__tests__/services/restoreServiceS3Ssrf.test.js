/**
 * Blind SSRF via the restore S3 download path (GHSA-vm2x-c628-3cx5).
 *
 * downloadFileFromS3() built a bare S3StorageAdapter and called .download()
 * directly, never running the DNS-resolving isHostAllowed() guard that
 * testConnection() applies elsewhere — so an admin with backup.restore could
 * point the request-supplied S3 endpoint at an internal/metadata address for
 * unauthenticated egress via the server. `s3Config` here is fully attacker
 * controlled (POST /api/admin/restore/validate and /restore/start take it
 * straight from the request body — see routes/adminRestore.js), unlike the
 * scheduled-backup S3 endpoint, which is vetted at settings-save time.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-restores3ssrf-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'restores3ssrf-test-secret';

jest.mock('dns', () => {
  const actual = jest.requireActual('dns');
  return { ...actual, promises: { ...actual.promises, lookup: jest.fn() } };
});

// Restore downloads go through getMetadata() (HeadObject size check) and
// downloadStream() (bounded body); download() is no longer called.
jest.mock('../../src/services/storage/s3Storage', () =>
  jest.fn().mockImplementation(() => {
    const { Readable } = require('stream');
    return {
      getMetadata: jest.fn().mockResolvedValue({ ContentLength: 2 }),
      downloadStream: jest.fn().mockImplementation(async () => Readable.from([Buffer.from('{}')])),
    };
  })
);
const manifestScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-restores3ssrf-manifest-'));

const dns = require('dns');
const lookup = dns.promises.lookup;
const S3StorageAdapter = require('../../src/services/storage/s3Storage');
const { RestoreService } = require('../../src/services/restoreService');

describe('downloadFileFromS3 SSRF guard (GHSA-vm2x-c628-3cx5)', () => {
  let restoreService;
  let originalNodeEnv;

  beforeEach(() => {
    restoreService = new RestoreService();
    lookup.mockReset();
    S3StorageAdapter.mockClear();
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('rejects an endpoint hostname that resolves to a private/internal address before any network call', async () => {
    lookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);

    await expect(
      restoreService.downloadFileFromS3(
        's3://backups/manifest.json',
        path.join(manifestScratch, 'manifest.json'),
        { endpoint: 'evil-rebind.example.com', accessKeyId: 'k', secretAccessKey: 's' }
      )
    ).rejects.toThrow(/private or internal network address/i);

    expect(S3StorageAdapter).not.toHaveBeenCalled();
  });

  it('rejects an endpoint hostname that resolves to the cloud metadata address', async () => {
    lookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);

    await expect(
      restoreService.downloadFileFromS3(
        's3://backups/manifest.json',
        path.join(manifestScratch, 'manifest.json'),
        { endpoint: 'metadata-rebind.example.com', accessKeyId: 'k', secretAccessKey: 's' }
      )
    ).rejects.toThrow(/private or internal network address/i);

    expect(S3StorageAdapter).not.toHaveBeenCalled();
  });

  it('allows a legitimate public S3 endpoint through to download()', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

    await restoreService.downloadFileFromS3(
      's3://backups/manifest.json',
      path.join(manifestScratch, 'manifest.json'),
      { endpoint: 's3.example-cdn.com', accessKeyId: 'k', secretAccessKey: 's' }
    );

    expect(S3StorageAdapter).toHaveBeenCalledTimes(1);
  });

  it('does not require the guard outside production (dev MinIO stays usable), but still downloads', async () => {
    process.env.NODE_ENV = 'development';
    lookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]); // would be rejected in prod

    await restoreService.downloadFileFromS3(
      's3://backups/manifest.json',
      path.join(manifestScratch, 'manifest.json'),
      { endpoint: 'localhost:9000', accessKeyId: 'k', secretAccessKey: 's' }
    );

    expect(lookup).not.toHaveBeenCalled();
    expect(S3StorageAdapter).toHaveBeenCalledTimes(1);
  });
});
