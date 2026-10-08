'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const mockAttemptDirectory = jest.fn();
const mockSyncDirectory = jest.fn();
const mockAcquireLease = jest.fn();
const mockProbeLease = jest.fn();
const mockRunnerStart = jest.fn();
const mockRunnerRun = jest.fn();
const mockDb = jest.fn();
let mockDbLoads = 0;

jest.mock('../../src/services/portableRestorePaths', () => ({
  attemptDirectory: (...args) => mockAttemptDirectory(...args),
  syncDirectory: (...args) => mockSyncDirectory(...args),
}));
// These are explicit component-contract mocks, not native lease/guardian proof.
jest.mock('../../src/services/linuxKernelLease', () => ({
  acquire: (...args) => mockAcquireLease(...args), probe: (...args) => mockProbeLease(...args),
}), { virtual: true });
jest.mock('../../src/services/nativeProcessRunner', () => ({
  start: (...args) => mockRunnerStart(...args), run: (...args) => mockRunnerRun(...args),
}), { virtual: true });
jest.mock('../../src/database/db', () => {
  mockDbLoads += 1;
  return { db: (...args) => mockDb(...args) };
});

const worker = require('../../src/services/portableRestoreWorker');
const applicationWork = require('../../src/services/activeApplicationWork');
const ATTEMPT = '21bc9cd0-864e-4c80-a0c3-5c1b70afed12';
const EPOCH = '085f59f1-de77-4b57-a604-061dc82413b7';
const OTHER_EPOCH = '5d552aab-92aa-4448-8a65-cc8752d82df1';
const ENV = ['PICPEAK_IMPORT_WORKER_MEMORY_MIB', 'PICPEAK_IMPORT_WORKER_TIMEOUT_MS', 'PICPEAK_IMPORT_WORKER_CPU_SECONDS', 'NODE_ENV'];
const MAX_REQUEST = 32768;
const HARD_METADATA = 32 * 1024 * 1024;
let fixture;
let directory;
let descriptor;
let row;
let originals;
let where;
let first;
let originalPlatform;

const unsafe = { code: 'RESTORE_WORKER_UNSAFE', statusCode: 503 };
const asLinux = () => Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
const args = () => ({ attemptId: ATTEMPT, epoch: EPOCH, workerLeaseDescriptor: descriptor, onStart: jest.fn(async () => {}) });
const request = (changes = {}) => ({ version: 1, attemptId: ATTEMPT, epoch: EPOCH,
  archivePath: path.join(directory, 'request.picpeak'), operatorId: 1, optionsJson: '{}', optionsDigest: worker.digest('{}'),
  workerLeaseDescriptor: descriptor, ...changes });

async function privateFile(name, value, mode = 0o600) {
  const file = path.join(directory, name);
  await fsp.writeFile(file, value, { mode });
  return file;
}

beforeEach(async () => {
  originals = Object.fromEntries(ENV.map(name => [name, process.env[name]]));
  originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  for (const name of ENV) delete process.env[name];
  process.env.NODE_ENV = 'production';
  jest.clearAllMocks();
  fixture = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'picpeak-owned-worker-contract-')));
  directory = path.join(fixture, ATTEMPT);
  await fsp.mkdir(directory, { mode: 0o700 });
  descriptor = { path: path.join(directory, 'worker.lease'), device: '1', inode: '2', filesystem: '61267' };
  row = { id: 1, attempt_id: ATTEMPT, epoch: EPOCH, state: 'restoring', operator_id: 1,
    options_json: '{}', worker_lease_json: JSON.stringify(descriptor) };
  mockAttemptDirectory.mockImplementation(async id => {
    if (id !== ATTEMPT) throw new Error('unknown attempt');
    return directory;
  });
  mockSyncDirectory.mockResolvedValue(undefined);
  mockAcquireLease.mockResolvedValue({ ...descriptor, release: jest.fn(async () => {}) });
  mockProbeLease.mockResolvedValue('free');
  first = jest.fn(async () => row);
  where = jest.fn(() => ({ first }));
  mockDb.mockImplementation(() => ({ where }));
  mockRunnerRun.mockImplementation(async (_executable, _argv, policy) => {
    await policy.onStart({ ...descriptor });
    return { stdout: Buffer.from(`PICPEAK_RESTORE_RESULT=${JSON.stringify({ version: 1, attemptId: ATTEMPT, outcome: 'committed' })}\n`) };
  });
});

afterEach(async () => {
  jest.restoreAllMocks();
  Object.defineProperty(process, 'platform', originalPlatform);
  for (const name of ENV) {
    if (originals[name] === undefined) delete process.env[name];
    else process.env[name] = originals[name];
  }
  await fsp.rm(fixture, { recursive: true, force: true });
});

describe('production portable worker resource configuration', () => {
  it('uses finite default native memory, JavaScript heap, wall and CPU limits', () => {
    expect(worker.workerConfiguration()).toEqual({ memoryBytes: 768 * 1024 * 1024, heap: 384, wallMs: 1800000, cpuSeconds: 600 });
  });

  it('accepts only documented boundary configurations and caps heap below native memory', () => {
    process.env.PICPEAK_IMPORT_WORKER_MEMORY_MIB = '256';
    process.env.PICPEAK_IMPORT_WORKER_TIMEOUT_MS = '1';
    process.env.PICPEAK_IMPORT_WORKER_CPU_SECONDS = '1';
    expect(worker.workerConfiguration()).toEqual({ memoryBytes: 256 * 1024 * 1024, heap: 128, wallMs: 1, cpuSeconds: 1 });
    process.env.PICPEAK_IMPORT_WORKER_MEMORY_MIB = '4096';
    process.env.PICPEAK_IMPORT_WORKER_TIMEOUT_MS = '7200000';
    process.env.PICPEAK_IMPORT_WORKER_CPU_SECONDS = '7200';
    expect(worker.workerConfiguration()).toEqual({ memoryBytes: 4096 * 1024 * 1024, heap: 1024, wallMs: 7200000, cpuSeconds: 7200 });
  });

  it.each([
    ['PICPEAK_IMPORT_WORKER_MEMORY_MIB', '255'], ['PICPEAK_IMPORT_WORKER_MEMORY_MIB', '4097'],
    ['PICPEAK_IMPORT_WORKER_TIMEOUT_MS', '7200001'], ['PICPEAK_IMPORT_WORKER_CPU_SECONDS', '7201'],
    ...['PICPEAK_IMPORT_WORKER_MEMORY_MIB', 'PICPEAK_IMPORT_WORKER_TIMEOUT_MS', 'PICPEAK_IMPORT_WORKER_CPU_SECONDS']
      .flatMap(name => ['', '0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992'].map(value => [name, value])),
  ])('refuses invalid %s=%s instead of falling back to unlimited work', (name, value) => {
    process.env[name] = value;
    expect(() => worker.workerConfiguration()).toThrow(expect.objectContaining(unsafe));
  });
});

describe('private bounded metadata helpers', () => {
  it('writes and reads private synced metadata, returning its exact digest', async () => {
    const file = path.join(directory, 'state.json');
    const value = { version: 1, attemptId: ATTEMPT, options: {} };
    expect(await worker.writeOwnedJson(file, value)).toBe(worker.digest(JSON.stringify(value)));
    expect(await worker.readOwnedJson(file)).toEqual(value);
    expect((await fsp.stat(file)).mode & 0o777).toBe(0o600);
    expect(mockSyncDirectory).toHaveBeenCalledWith(directory);
    expect((await fsp.readdir(directory)).filter(name => name.endsWith('.next'))).toEqual([]);
    await worker.writeOwnedJson(file, { version: 2 });
    expect(await worker.readOwnedJson(file)).toEqual({ version: 2 });
  });

  it.each(['oversized', 'empty', 'invalid UTF8', 'invalid JSON', 'public permissions', 'hardlink', 'symlink', 'directory'])('refuses %s private metadata', async kind => {
    const file = path.join(directory, 'unsafe.json');
    if (kind === 'directory') await fsp.mkdir(file, { mode: 0o700 });
    else {
      const data = kind === 'oversized' ? JSON.stringify('x'.repeat(MAX_REQUEST)) : kind === 'empty' ? '' :
        kind === 'invalid UTF8' ? Buffer.from([0xff]) : kind === 'invalid JSON' ? '{' : '{}';
      await fsp.writeFile(file, data, { mode: kind === 'public permissions' ? 0o644 : 0o600 });
      if (kind === 'hardlink') await fsp.link(file, path.join(directory, 'linked.json'));
      if (kind === 'symlink') {
        await fsp.rename(file, path.join(directory, 'original.json'));
        await fsp.symlink(path.join(directory, 'original.json'), file);
      }
    }
    await expect(worker.readOwnedJson(file)).rejects.toBeTruthy();
  });

  it.each([0, -1, 1.5, Infinity, NaN, '32768'])('rejects invalid helper maximum %s before parsing or writing', async maximum => {
    const file = await privateFile('small.json', '0');
    await expect(worker.readOwnedJson(file, maximum)).rejects.toMatchObject(unsafe);
    await expect(worker.writeOwnedJson(path.join(directory, 'out.json'), 0, maximum)).rejects.toMatchObject(unsafe);
    await expect(fsp.stat(path.join(directory, 'out.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cannot enlarge the hard metadata cap through a caller-supplied maximum', async () => {
    const value = { pad: 'x'.repeat(MAX_REQUEST + 1) };
    const file = await privateFile('large.json', JSON.stringify(value));
    await expect(worker.readOwnedJson(file, HARD_METADATA + 1)).rejects.toMatchObject(unsafe);
    await expect(worker.writeOwnedJson(path.join(directory, 'out.json'), value, HARD_METADATA + 1)).rejects.toMatchObject(unsafe);
    await expect(fsp.stat(path.join(directory, 'out.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('supports explicit generation-manifest budgets up to 32 MiB without enlarging the default request budget', async () => {
    const value = { pad: 'x'.repeat(MAX_REQUEST + 1) };
    const file = await privateFile('generation.json', JSON.stringify(value));
    await expect(worker.readOwnedJson(file)).rejects.toMatchObject(unsafe);
    expect(await worker.readOwnedJson(file, MAX_REQUEST * 2)).toEqual(value);
    const small = { version: 1 };
    const output = path.join(directory, 'out.json');
    await worker.writeOwnedJson(output, small, HARD_METADATA);
    expect(await worker.readOwnedJson(output, HARD_METADATA)).toEqual(small);
  });

  it('enforces a legitimate tighter helper cap', async () => {
    const file = await privateFile('small.json', '{}');
    expect(await worker.readOwnedJson(file, 2)).toEqual({});
    await expect(worker.readOwnedJson(file, 1)).rejects.toMatchObject(unsafe);
    await expect(worker.writeOwnedJson(path.join(directory, 'small-out.json'), {}, 1)).rejects.toMatchObject(unsafe);
  });

  it('accepts the exact default metadata limit and refuses the next encoded byte', async () => {
    const file = path.join(directory, 'boundary.json');
    const value = 'x'.repeat(MAX_REQUEST - 2);
    expect(Buffer.byteLength(JSON.stringify(value))).toBe(MAX_REQUEST);
    await worker.writeOwnedJson(file, value);
    expect(await worker.readOwnedJson(file)).toBe(value);
    await expect(worker.writeOwnedJson(file, `${value}x`)).rejects.toMatchObject(unsafe);
    expect(await worker.readOwnedJson(file)).toBe(value);
  });
});

describe('worker admission and immutable request protocol', () => {
  it('rejects mutation outside the supervised context before FD, database or control authority access', async () => {
    const fd = jest.spyOn(fs, 'fstatSync');
    const control = jest.spyOn(applicationWork, 'runControl');
    const loads = mockDbLoads;
    await expect(worker.assertWorkerAuthority()).rejects.toMatchObject(unsafe);
    const supplied = jest.fn();
    await expect(worker.assertWorkerAuthority(supplied)).rejects.toMatchObject(unsafe);
    expect(supplied).not.toHaveBeenCalled();
    expect(fd).not.toHaveBeenCalled();
    expect(mockDb).not.toHaveBeenCalled();
    expect(mockDbLoads).toBe(loads);
    expect(control).not.toHaveBeenCalled();
  });

  it('does not admit a test environment without the supervised worker authority', async () => {
    process.env.NODE_ENV = 'test';
    await expect(worker.assertWorkerAuthority()).rejects.toMatchObject(unsafe);
    expect(mockDb).not.toHaveBeenCalled();
  });

  it('refuses unsupported host platforms and process modes before any privileged access', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    await expect(worker.startWorker(args())).rejects.toMatchObject(unsafe);
    expect(mockAttemptDirectory).not.toHaveBeenCalled();
    expect(mockDb).not.toHaveBeenCalled();
    expect(mockRunnerStart).not.toHaveBeenCalled();
    asLinux();
    const open = jest.spyOn(fsp, 'open');
    await expect(worker.runWorkerProcess('online', '/not-a-request')).rejects.toMatchObject(unsafe);
    expect(open).not.toHaveBeenCalled();
    expect(mockDb).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'busy'])('does not touch database or runner when prior worker proof is %s', async proof => {
    asLinux();
    mockProbeLease.mockResolvedValue(proof);
    await expect(worker.startWorker(args())).rejects.toMatchObject(unsafe);
    expect(mockDb).not.toHaveBeenCalled();
    expect(mockRunnerStart).not.toHaveBeenCalled();
    expect(mockRunnerRun).not.toHaveBeenCalled();
  });

  it('returns unknown on malformed/redirected native lease descriptors without probing another path', async () => {
    expect(await worker.probeWorkerLease(null)).toBe('unknown');
    expect(await worker.probeWorkerLease({ ...descriptor, path: path.join(fixture, 'outside', 'worker.lease') })).toBe('unknown');
    expect(await worker.probeWorkerLease({ ...descriptor, path: path.join(directory, 'not-worker.lease') })).toBe('unknown');
    expect(mockProbeLease).not.toHaveBeenCalled();
  });

  it('passes the complete canonical identity to the native proof and releases newly-created leases', async () => {
    const released = jest.fn(async () => {});
    mockAcquireLease.mockResolvedValue({ ...descriptor, release: released });
    expect(await worker.workerLeaseDescriptor({ attemptId: ATTEMPT })).toEqual(descriptor);
    expect(mockAttemptDirectory).toHaveBeenCalledWith(ATTEMPT, { create: true });
    expect(released).toHaveBeenCalledTimes(1);
    expect(await worker.probeWorkerLease(descriptor)).toBe('free');
    expect(mockProbeLease).toHaveBeenCalledWith(descriptor.path, descriptor);
    mockProbeLease.mockRejectedValue(new Error('unknown identity'));
    expect(await worker.probeWorkerLease(descriptor)).toBe('unknown');
  });

  it('releases a lease when directory durability fails', async () => {
    const released = jest.fn(async () => {});
    mockAcquireLease.mockResolvedValue({ ...descriptor, release: released });
    mockSyncDirectory.mockRejectedValue(new Error('fsync failed'));
    await expect(worker.workerLeaseDescriptor({ attemptId: ATTEMPT })).rejects.toThrow('fsync failed');
    expect(released).toHaveBeenCalledTimes(1);
  });

  it('persists one immutable epoch request and forwards finite limits plus explicit pre-exec admission', async () => {
    asLinux();
    const input = args();
    expect(await worker.startWorker(input)).toMatchObject({ outcome: 'committed', proof: 'kernel_lease_released' });
    const file = path.join(directory, 'request.json');
    const initial = await fsp.readFile(file);
    expect(await worker.readOwnedJson(file)).toEqual(request());
    expect(where).toHaveBeenCalledWith({ id: 1, attempt_id: ATTEMPT, epoch: EPOCH, state: 'restoring' });
    expect(input.onStart).toHaveBeenCalledWith(descriptor);
    expect(mockRunnerRun).toHaveBeenCalledWith(process.execPath,
      ['--jitless', '--max-old-space-size=384', expect.stringMatching(/workers\/portableRestoreWorker\.js$/), 'import', file],
      expect.objectContaining({ memoryBytes: 768 * 1024 * 1024, heap: 384, wallMs: 1800000, cpuSeconds: 600,
        outputBytes: 1024 * 1024, fileBytes: 10 * 1024 * 1024 * 1024, leasePath: descriptor.path,
        env: { NODE_OPTIONS: '', TMPDIR: path.join(directory, 'workspace') }, onStart: expect.any(Function) }));
    await worker.startWorker(args());
    expect(await fsp.readFile(file)).toEqual(initial);
    row.options_json = JSON.stringify({ migrationStorageIndexPath: path.join(directory, 'sidecar.json') });
    await expect(worker.startWorker(args())).rejects.toMatchObject(unsafe);
    expect(await fsp.readFile(file)).toEqual(initial);
    await expect(worker.startWorker({ ...args(), epoch: OTHER_EPOCH })).rejects.toMatchObject(unsafe);
    expect(await fsp.readFile(file)).toEqual(initial);
  });

  it('refuses changed inherited lease identity and missing explicit pre-exec admission', async () => {
    asLinux();
    mockRunnerRun.mockImplementation(async (_executable, _argv, policy) => policy.onStart({ ...descriptor, inode: 'changed' }));
    const input = args();
    await expect(worker.startWorker(input)).rejects.toMatchObject(unsafe);
    expect(input.onStart).not.toHaveBeenCalled();
    mockRunnerRun.mockImplementation(async (_executable, _argv, policy) => policy.onStart(descriptor));
    await expect(worker.startWorker({ ...args(), onStart: undefined })).rejects.toMatchObject(unsafe);
  });

  it('requires terminal native proof and an identity-bound bounded terminal result', async () => {
    asLinux();
    mockProbeLease.mockResolvedValueOnce('free').mockResolvedValueOnce('busy');
    await expect(worker.startWorker(args())).rejects.toMatchObject(unsafe);
    mockProbeLease.mockResolvedValue('free');
    for (const value of [null, { version: 2, attemptId: ATTEMPT, outcome: 'committed' },
      { version: 1, attemptId: OTHER_EPOCH, outcome: 'committed' }, { version: 1, attemptId: ATTEMPT, outcome: 'success' }]) {
      mockRunnerRun.mockResolvedValue({ stdout: Buffer.from(value === null ? '' : `PICPEAK_RESTORE_RESULT=${JSON.stringify(value)}\n`) });
      await expect(worker.startWorker(args())).rejects.toMatchObject(unsafe);
    }
    mockRunnerRun.mockResolvedValue({ stdout: Buffer.from(`PICPEAK_RESTORE_RESULT=${JSON.stringify({ version: 1, attemptId: ATTEMPT, outcome: 'committed', pad: 'x'.repeat(16384) })}\n`) });
    await expect(worker.startWorker(args())).rejects.toMatchObject(unsafe);
  });

  it.each([
    ['version', { version: 2 }], ['attempt', { attemptId: 'bad' }], ['epoch', { epoch: 'bad' }],
    ['digest', { optionsDigest: 'incorrect' }], ['options', { optionsJson: '{"unsafe":true}', optionsDigest: worker.digest('{"unsafe":true}') }],
    ['redirected archive', { archivePath: '/outside/request.picpeak' }],
  ])('rejects %s requests before database authority is loaded', async (_label, changes) => {
    asLinux();
    const file = await privateFile('request.json', JSON.stringify(request(changes)));
    const loads = mockDbLoads;
    await expect(worker.runWorkerProcess('import', file)).rejects.toMatchObject(unsafe);
    expect(mockDb).not.toHaveBeenCalled();
    expect(mockDbLoads).toBe(loads);
  });

  it('refuses a valid request moved away from its canonical epoch path before database access', async () => {
    asLinux();
    const file = await privateFile('redirected.json', JSON.stringify(request()));
    await expect(worker.runWorkerProcess('import', file)).rejects.toMatchObject(unsafe);
    expect(mockDb).not.toHaveBeenCalled();
  });

  const linuxIt = process.platform === 'linux' ? it : it.skip;
  linuxIt('uses real inherited FD9 identity to refuse a forged inode before loading database authority', async () => {
    const leasePath = await privateFile('worker.lease', 'owned kernel lease identity fixture');
    const lease = await fsp.open(leasePath, 'r');
    try {
      const stat = await lease.stat({ bigint: true });
      const forged = { path: leasePath, device: String(stat.dev), inode: String(stat.ino + 1n), filesystem: '61267' };
      const file = await privateFile('request.json', JSON.stringify(request({ workerLeaseDescriptor: forged })));
      const script = `
        const Module = require('module');
        const original = Module._load;
        let databaseLoads = 0;
        Module._load = function(name, parent, main) {
          if (name === './portableRestorePaths' && parent.filename.endsWith('/portableRestoreWorker.js')) {
            return { attemptDirectory: async () => ${JSON.stringify(directory)} };
          }
          if (name === '../database/db' && parent.filename.endsWith('/portableRestoreWorker.js')) {
            databaseLoads += 1;
            throw new Error('Database authority must not be loaded');
          }
          return original.call(this, name, parent, main);
        };
        require(${JSON.stringify(require.resolve('../../src/services/portableRestoreWorker'))}).runWorkerProcess('import', ${JSON.stringify(file)})
          .then(() => { process.stdout.write(JSON.stringify({ unexpected: true, databaseLoads })); process.exitCode = 1; },
            error => process.stdout.write(JSON.stringify({ code: error.code, statusCode: error.statusCode, databaseLoads })));
      `;
      const result = spawnSync(process.execPath, ['-e', script], {
        stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', lease.fd],
        env: { ...process.env, NODE_ENV: 'production', NODE_OPTIONS: '' }, timeout: 10000,
      });
      expect(result.status).toBe(0);
      expect(result.error).toBeUndefined();
      expect(JSON.parse(result.stdout.toString())).toEqual({ ...unsafe, databaseLoads: 0 });
    } finally { await lease.close(); }
  });
});
