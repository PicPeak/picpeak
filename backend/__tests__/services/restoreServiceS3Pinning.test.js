/**
 * DNS-rebinding follow-up to the blind-SSRF fix in restoreServiceS3Ssrf.test.js
 * (GHSA-vm2x-c628-3cx5).
 *
 * isHostAllowed()/validateExternalUrlAsync() are check-then-connect on their
 * own: they resolve the S3 endpoint hostname once to vet it, then hand a
 * bare hostname to the AWS SDK, which resolves it AGAIN when it actually
 * connects. An attacker who controls DNS for the endpoint hostname (or an
 * infra DNS-rebinding condition) can answer the first lookup with a public
 * IP and the second with a private/metadata one.
 *
 * downloadFileFromS3() now builds pinned http/https agents (pinnedRequest.js
 * — the same primitive webhookDeliveryWorker.js and emailWebhookTransport.js
 * use for outbound HTTP) from the validated address and passes them into
 * S3StorageAdapter, which threads them into the S3Client's NodeHttpHandler
 * requestHandler. This asserts that wiring: the agents S3StorageAdapter
 * receives resolve the endpoint hostname to ONLY the address vetted during
 * validation, and never fall through to a second, real DNS lookup that a
 * rebinding attacker could answer differently.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-restores3pin-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'restores3pin-test-secret';

jest.mock('dns', () => {
  const actual = jest.requireActual('dns');
  return { ...actual, promises: { ...actual.promises, lookup: jest.fn() }, lookup: jest.fn() };
});

let capturedConfig;
jest.mock('../../src/services/storage/s3Storage', () =>
  jest.fn().mockImplementation((config) => {
    capturedConfig = config;
    return { download: jest.fn().mockResolvedValue(undefined), testConnection: jest.fn().mockResolvedValue(true) };
  })
);

const dns = require('dns');
const promiseLookup = dns.promises.lookup;
const S3StorageAdapter = require('../../src/services/storage/s3Storage');
const { RestoreService } = require('../../src/services/restoreService');

describe('downloadFileFromS3 DNS-rebinding pinning', () => {
  let restoreService;
  let originalNodeEnv;

  beforeEach(() => {
    restoreService = new RestoreService();
    capturedConfig = undefined;
    promiseLookup.mockReset();
    dns.lookup.mockReset();
    S3StorageAdapter.mockClear();
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    capturedConfig?.httpAgent?.destroy();
    capturedConfig?.httpsAgent?.destroy();
  });

  it('passes pinned http/https agents into S3StorageAdapter built from the validated address', async () => {
    promiseLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

    await restoreService.downloadFileFromS3(
      's3://backups/manifest.json',
      '/tmp/whatever/manifest.json',
      { endpoint: 'rebind.example.com', accessKeyId: 'k', secretAccessKey: 's' }
    );

    expect(S3StorageAdapter).toHaveBeenCalledTimes(1);
    expect(capturedConfig.httpAgent).toBeInstanceOf(require('http').Agent);
    expect(capturedConfig.httpsAgent).toBeInstanceOf(require('https').Agent);
  });

  it('the pinned agent never performs a second DNS lookup — rebinding to a private IP on the real resolver is ignored', async () => {
    // First (validation) lookup: public IP, passes the preflight.
    promiseLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    // If the pinned agent ever fell through to a real lookup, this would
    // hand back a private/metadata address — simulating the rebind.
    dns.lookup.mockImplementation((_hostname, options, callback) => {
      if (typeof options === 'function') { callback = options; options = {}; }
      callback(null, ...(options?.all ? [[{ address: '169.254.169.254', family: 4 }]] : ['169.254.169.254', 4]));
    });

    await restoreService.downloadFileFromS3(
      's3://backups/manifest.json',
      '/tmp/whatever/manifest.json',
      { endpoint: 'rebind.example.com', accessKeyId: 'k', secretAccessKey: 's' }
    );

    const pinnedLookup = capturedConfig.httpAgent.options.lookup;
    expect(typeof pinnedLookup).toBe('function');

    const result = await new Promise((resolve, reject) => {
      pinnedLookup('rebind.example.com', {}, (err, address, family) => {
        if (err) return reject(err);
        resolve({ address, family });
      });
    });

    // Only the address vetted during validation is ever handed back —
    // never the private address the real resolver would now answer with.
    expect(result).toEqual({ address: '93.184.216.34', family: 4 });
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it('rejects a lookup for any hostname other than the one that was validated', async () => {
    promiseLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

    await restoreService.downloadFileFromS3(
      's3://backups/manifest.json',
      '/tmp/whatever/manifest.json',
      { endpoint: 'rebind.example.com', accessKeyId: 'k', secretAccessKey: 's' }
    );

    const pinnedLookup = capturedConfig.httpAgent.options.lookup;

    await expect(new Promise((resolve, reject) => {
      pinnedLookup('attacker-controlled.example', {}, (err, address) => {
        if (err) return reject(err);
        resolve(address);
      });
    })).rejects.toThrow(/hostname changed/i);
  });

  it('does not pin agents when no custom endpoint is configured (default AWS, no rebinding surface)', async () => {
    await restoreService.downloadFileFromS3(
      's3://backups/manifest.json',
      '/tmp/whatever/manifest.json',
      { accessKeyId: 'k', secretAccessKey: 's' }
    );

    expect(promiseLookup).not.toHaveBeenCalled();
    expect(capturedConfig.httpAgent).toBeUndefined();
    expect(capturedConfig.httpsAgent).toBeUndefined();
  });
});

describe('downloadFromS3 pins the client used for the restore downloads', () => {
  let restoreService;
  let originalNodeEnv;
  const manifest = { database: { backup_file: 'picpeak.sqlite.gz' }, files: { manifest: [] } };
  const options = (endpoint) => ({
    restoreType: 'database',
    s3Config: { endpoint, accessKeyId: 'k', secretAccessKey: 's' },
  });

  beforeEach(() => {
    restoreService = new RestoreService();
    restoreService.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-restores3pin-dl-'));
    capturedConfig = undefined;
    promiseLookup.mockReset();
    dns.lookup.mockReset();
    S3StorageAdapter.mockClear();
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    capturedConfig?.httpAgent?.destroy();
    capturedConfig?.httpsAgent?.destroy();
  });

  it('builds the client, whose connection check and downloads share it, with agents pinned to the validated address', async () => {
    promiseLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    // A second, real lookup would now answer with the metadata address.
    dns.lookup.mockImplementation((_hostname, opts, callback) => {
      if (typeof opts === 'function') { callback = opts; opts = {}; }
      callback(null, ...(opts?.all ? [[{ address: '169.254.169.254', family: 4 }]] : ['169.254.169.254', 4]));
    });

    await restoreService.downloadFromS3('s3://backups/2026-09-15', manifest, options('rebind.example.com'));

    expect(S3StorageAdapter).toHaveBeenCalledTimes(1);
    expect(capturedConfig.httpsAgent).toBeInstanceOf(require('https').Agent);
    const pinnedLookup = capturedConfig.httpsAgent.options.lookup;
    const result = await new Promise((resolve, reject) => {
      pinnedLookup('rebind.example.com', {}, (err, address, family) => (err ? reject(err) : resolve({ address, family })));
    });
    expect(result).toEqual({ address: '93.184.216.34', family: 4 });
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it('refuses an endpoint that resolves to a private address before building any client', async () => {
    promiseLookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);

    await expect(restoreService.downloadFromS3('s3://backups/2026-09-15', manifest, options('internal.example.com')))
      .rejects.toThrow(/private or internal network address/i);
    expect(S3StorageAdapter).not.toHaveBeenCalled();
  });
});
