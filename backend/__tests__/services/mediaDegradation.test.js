/**
 * The native media protections are optional: every case here is a host that
 * lacks one of them, and media work has to carry on regardless. Runs on any
 * platform; the Linux-only branches are driven through the capability record
 * and a stand-in for the guard binary that speaks its protocol.
 */
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const logger = require('../../src/utils/logger');
const capabilities = require('../../src/services/mediaCapabilities');
const runner = require('../../src/services/nativeProcessRunner');
const kernelLease = require('../../src/services/linuxKernelLease');
const processLease = require('../../src/services/linuxProcessLease');
const imagePolicy = require('../../src/services/imageResourcePolicy');

const FAKE_GUARD = path.join(__dirname, '../fixtures/fakeMediaGuard.js');
const REAL_GUARD = capabilities.GUARD;
const platform = process.platform;
const setPlatform = value => Object.defineProperty(process, 'platform', { value, configurable: true });
const alive = pid => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
const settle = async (predicate, label) => {
  for (let index = 0; index < 400; index++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(`Timed out waiting for ${label}`);
};
let dir;
beforeAll(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'media-degradation-')); });
afterAll(async () => { await fsp.rm(dir, { recursive: true, force: true }); });
beforeEach(() => { jest.clearAllMocks(); runner.start(); });
afterEach(async () => {
  await runner.stop();
  setPlatform(platform); capabilities.GUARD = REAL_GUARD; capabilities.set(null); processLease.reset();
  jest.restoreAllMocks();
  for (const name of ['MEDIA_PROCESS_LEASE_PATH', 'MEDIA_PROCESS_HOST_ID', 'MEDIA_PROCESS_CONCURRENCY', 'VIDEO_RENDITION_CONCURRENCY', 'MEDIA_PROCESS_QUEUE_LENGTH', 'FAKE_GUARD_MODE']) delete process.env[name];
});

describe('capability probe (item 1, 2)', () => {
  const fakeAddon = accepted => ({
    acquire: jest.fn(file => {
      if (!accepted(file)) throw Object.assign(new Error('refused'), { code: 'MEDIA_LEASE_UNAVAILABLE' });
      return { descriptor: 7, device: '1', inode: '2', filesystem: '3' };
    }),
    release: jest.fn(), probe: jest.fn(() => 'free'),
  });
  const lines = () => [...logger.info.mock.calls, ...logger.warn.mock.calls].map(call => call[0]).filter(line => /^Media process protections:/.test(line));

  test('outside Linux both protections are off, each with its reason, in one startup line', async () => {
    setPlatform('darwin');
    const first = await capabilities.probe();
    expect(first).toMatchObject({ guard: false, leases: false, leaseRoot: null });
    expect(first.reasons.guard).toMatch(/needs Linux/); expect(first.reasons.leases).toMatch(/need Linux/);
    // Asked again (every job asks): same answer, no second line.
    expect(await capabilities.probe()).toBe(first);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatch(/process guard OFF: .*run unguarded.*kernel leases OFF: .*recovered by age.*host identity:/);
    expect(logger.warn).not.toHaveBeenCalled(); // Normal for development, not a warning.
  });

  test('Linux without the compiled binaries: off, and the line says how to build them', async () => {
    setPlatform('linux');
    jest.spyOn(capabilities, 'loadAddon').mockImplementation(() => { throw new Error('Cannot find module'); });
    capabilities.GUARD = path.join(dir, 'no-such-guard');
    const caps = await capabilities.probe();
    expect(caps).toMatchObject({ guard: false, leases: false });
    expect(lines()).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(lines()[0]).toMatch(/npm run build:native/);
  });

  test('the default lease directory is local, not under the storage path', async () => {
    setPlatform('linux');
    const addon = fakeAddon(() => true);
    jest.spyOn(capabilities, 'loadAddon').mockReturnValue(addon);
    capabilities.GUARD = FAKE_GUARD; jest.spyOn(runner, 'probeGuard').mockResolvedValue({ ok: true });
    const caps = await capabilities.probe();
    expect(caps.leases).toBe(true);
    expect(caps.leaseRoot).toBe(await fsp.realpath(path.join(os.tmpdir(), 'picpeak-media-leases')));
    expect(caps.leaseRoot.startsWith(require('../../src/config/storage').getStoragePath())).toBe(false);
  });

  test('a configured lease directory on a refused filesystem (NFS, a Docker Desktop bind mount) falls back to a local one', async () => {
    setPlatform('linux');
    const configured = path.join(dir, 'on-nfs');
    process.env.MEDIA_PROCESS_LEASE_PATH = configured;
    const real = await fsp.realpath(dir);
    const addon = fakeAddon(file => !file.startsWith(path.join(real, 'on-nfs')));
    jest.spyOn(capabilities, 'loadAddon').mockReturnValue(addon);
    capabilities.GUARD = FAKE_GUARD; jest.spyOn(runner, 'probeGuard').mockResolvedValue({ ok: true });
    const caps = await capabilities.probe();
    expect(caps).toMatchObject({ guard: true, leases: true });
    expect(caps.leaseRoot).not.toContain('on-nfs');
    expect(caps.reasons.leaseFallback).toMatch(/on-nfs.*refused; using/);
    expect(addon.release).toHaveBeenCalledWith(7);
  });

  test('no directory the addon accepts: no kernel leases, and the operator is told what to set', async () => {
    setPlatform('linux');
    jest.spyOn(capabilities, 'loadAddon').mockReturnValue(fakeAddon(() => false));
    capabilities.GUARD = FAKE_GUARD; jest.spyOn(runner, 'probeGuard').mockResolvedValue({ ok: true });
    const caps = await capabilities.probe();
    expect(caps).toMatchObject({ guard: true, leases: false, leaseRoot: null });
    expect(caps.reasons.leases).toMatch(/MEDIA_PROCESS_LEASE_PATH/);
  });

  test('a guard that cannot trace (seccomp, ptrace_scope) is reported with what to change', async () => {
    setPlatform('linux');
    jest.spyOn(capabilities, 'loadAddon').mockReturnValue(fakeAddon(() => true));
    capabilities.GUARD = FAKE_GUARD; process.env.FAKE_GUARD_MODE = 'no-ptrace';
    const caps = await capabilities.probe();
    expect(caps.guard).toBe(false);
    expect(caps.reasons.guard).toMatch(/exited with 125.*ptrace/);
  });

  test('the probe runs one trivial guarded command and accepts a guard that works', async () => {
    setPlatform('linux');
    jest.spyOn(capabilities, 'loadAddon').mockImplementation(() => { throw new Error('none'); });
    capabilities.GUARD = FAKE_GUARD; process.env.FAKE_GUARD_MODE = 'run';
    expect((await capabilities.probe()).guard).toBe(true);
  });
});

describe('running without the guard (item 3, 4)', () => {
  beforeEach(() => capabilities.set({ guard: false, leases: false }));

  test('the tools run as plain children on any platform', async () => {
    const result = await runner.run('/bin/sh', ['-c', 'cat; echo err >&2'], { input: 'in' });
    expect(result.stdout.toString()).toBe('in'); expect(result.stderr).toBe('err\n');
    const target = path.join(dir, 'stdout-file');
    await runner.run('/bin/sh', ['-c', 'printf to-file'], { stdoutPath: target });
    expect(await fsp.readFile(target, 'utf8')).toBe('to-file');
  });

  test('a timeout ends the whole process group: SIGTERM, then SIGKILL', async () => {
    const pidFile = path.join(dir, 'grandchild.pid');
    // The shell ignores SIGTERM and leaves a grandchild in its group.
    const job = runner.run('/bin/sh', ['-c', `trap '' TERM; sleep 60 & echo $! > ${pidFile}; wait`], { wallMs: 300 });
    await expect(job).rejects.toMatchObject({ code: 'MEDIA_TIMEOUT', status: 422 });
    const grandchild = Number(await fsp.readFile(pidFile, 'utf8'));
    await settle(() => !alive(grandchild), 'the grandchild to be killed');
  }, 20000);

  test('cancellation is transient, a missing tool is ENOENT, a failing tool reports its exit code', async () => {
    const controller = new AbortController();
    const job = runner.run('sleep', ['30'], { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(job).rejects.toMatchObject({ code: 'MEDIA_CANCELLED', status: 503 });
    await expect(runner.run(path.join(dir, 'not-installed'), [])).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(runner.run('/bin/sh', ['-c', 'echo broken >&2; exit 3'])).rejects.toMatchObject({ exitCode: 3, message: expect.stringContaining('broken') });
    await expect(runner.run('/bin/sh', ['-c', 'yes'], { outputBytes: 1024 })).rejects.toMatchObject({ code: 'MEDIA_OUTPUT_LIMIT' });
  });

  test('nothing is ever refused for the platform or for missing supervision', async () => {
    setPlatform('darwin');
    await expect(runner.run('/bin/sh', ['-c', ':'])).resolves.toBeDefined();
    const source = await fsp.readFile(path.join(__dirname, '../../src/services/nativeProcessRunner.js'), 'utf8');
    expect(source).not.toMatch(/requires Linux|thread supervision is unavailable|Deployment memory is too small/);
  });
});

describe('the guard protocol (item 4, 12)', () => {
  beforeEach(() => { capabilities.GUARD = FAKE_GUARD; capabilities.set({ guard: true, leases: false }); });

  test('a command that itself exits 125 is its own failure, not "guard unavailable"', async () => {
    process.env.FAKE_GUARD_MODE = 'run';
    await expect(runner.run('/bin/sh', ['-c', 'exit 125'])).rejects.toMatchObject({ exitCode: 125, message: expect.stringMatching(/^sh failed \(125\)/) });
    // The guard is still trusted, and still used.
    expect(capabilities.current().guard).toBe(true);
    expect((await runner.run('/bin/sh', ['-c', 'echo guarded'])).stdout.toString()).toBe('guarded\n');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test.each(['no-ptrace', 'supervisor-failed', 'no-limits'])('guard failure "%s" switches the guard off and runs the job without it', async mode => {
    process.env.FAKE_GUARD_MODE = mode;
    const target = path.join(dir, `rerun-${mode}`);
    const result = await runner.run('/bin/sh', ['-c', 'printf done'], { stdoutPath: target });
    expect(result.stdout).toBeUndefined();
    expect(await fsp.readFile(target, 'utf8')).toBe('done');
    expect(capabilities.current().guard).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/process guard switched off: .*Media processing continues/);
    // Later jobs go straight to the plain path and say nothing more.
    await runner.run('/bin/sh', ['-c', ':']);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test('a missing guard binary at runtime is a fallback too', async () => {
    capabilities.GUARD = path.join(dir, 'vanished-guard');
    expect((await runner.run('/bin/sh', ['-c', 'echo ok'])).stdout.toString()).toBe('ok\n');
    expect(capabilities.current().guard).toBe(false);
  });
});

describe('budgets and lanes (item 8)', () => {
  beforeEach(() => capabilities.set({ guard: false, leases: false }));

  test('a job\'s time budget starts when it starts, not while it waits behind another', async () => {
    process.env.MEDIA_PROCESS_CONCURRENCY = '1';
    const first = runner.run('sleep', ['0.8'], { wallMs: 5000 });
    // Queued for longer than its whole budget; it still gets all of it.
    const queued = runner.run('/bin/sh', ['-c', 'sleep 0.1; echo ran'], { wallMs: 400 });
    expect((await queued).stdout.toString()).toBe('ran\n');
    await first;
  });

  test('a long transcode does not hold up short jobs, even with one slot per lane', async () => {
    process.env.MEDIA_PROCESS_CONCURRENCY = '1';
    const started = Date.now();
    const transcode = runner.run('sleep', ['1.5'], { lane: 'long', wallMs: 10000 });
    const second = runner.run('sleep', ['1.5'], { lane: 'long', wallMs: 10000 });
    await runner.run('/bin/sh', ['-c', ':'], { wallMs: 1000 });
    expect(Date.now() - started).toBeLessThan(1200);
    await transcode; await second;
    // The long lane ran its two jobs one after the other.
    expect(Date.now() - started).toBeGreaterThanOrEqual(2900);
  }, 20000);

  test('the smallest host still runs one job per lane; memory only limits how many run side by side', async () => {
    jest.spyOn(imagePolicy, 'effectiveMemory').mockReturnValue(256 * 1024 * 1024);
    expect(runner.configuration().bytes).toBe(128 * 1024 * 1024);
    const started = Date.now();
    const big = { memoryBytes: 2048 * 1024 * 1024, wallMs: 5000 };
    const jobs = [runner.run('sleep', ['0.5'], big), runner.run('sleep', ['0.5'], big)];
    await expect(Promise.all(jobs)).resolves.toHaveLength(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
  });

  test('a caller outside the queues is told to come back when the queue is full; nothing queued is dropped', async () => {
    process.env.MEDIA_PROCESS_CONCURRENCY = '1'; process.env.MEDIA_PROCESS_QUEUE_LENGTH = '1';
    const running = runner.run('sleep', ['0.4']);
    const waiting = runner.run('/bin/sh', ['-c', ':']);
    await expect(runner.run('/bin/sh', ['-c', ':'])).rejects.toMatchObject({ code: 'MEDIA_QUEUE_FULL', status: 503, retryAfter: 5 });
    await expect(Promise.all([running, waiting])).resolves.toHaveLength(2);
  });
});

describe('no permanent stalls (item 6)', () => {
  test('a job whose lease file is gone is taken as dead once its process group stays gone', async () => {
    const probe = jest.spyOn(kernelLease, 'probe').mockResolvedValue('unknown');
    const child = spawnSync('/bin/sh', ['-c', 'echo $$']);
    const started = Date.now();
    await expect(runner.waitForNativeDeath({ leasePath: path.join(dir, 'gone.lease'), proofIdentity: { device: '1', inode: '2', filesystem: '3' },
      nativePid: Number(child.stdout.toString()) }, { graceMs: 100, limitMs: 5000 })).resolves.toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(probe).toHaveBeenCalled();
  });

  test('a free lease is proof at once; a lease that never frees is given up on at the limit', async () => {
    jest.spyOn(kernelLease, 'probe').mockResolvedValue('free');
    await expect(runner.waitForNativeDeath({ leasePath: '/x.lease', proofIdentity: {}, nativePid: process.pid })).resolves.toBe(true);
    kernelLease.probe.mockResolvedValue('busy');
    const started = Date.now();
    await expect(runner.waitForNativeDeath({ leasePath: '/x.lease', proofIdentity: {}, nativePid: 0 }, { graceMs: 50, limitMs: 300 })).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('host identity (item 5)', () => {
  test('without MEDIA_PROCESS_HOST_ID or a machine-id, an id is generated once and persisted in the data directory', async () => {
    const data = path.join(dir, 'data');
    const first = await processLease.hostIdentity([data]);
    if (first.source !== 'generated') return; // This host has /etc/machine-id.
    expect(first.host).toMatch(/^[a-f0-9]{64}$/);
    expect(first.detail).toBe(path.join(data, 'media-host-id'));
    expect(await fsp.readFile(path.join(data, 'media-host-id'), 'utf8')).toMatch(/^[a-f0-9]{32}$/);
    // A restart reads the same id back.
    expect((await processLease.hostIdentity([data])).host).toBe(first.host);
    // A read-only data directory falls through to the next place.
    expect((await processLease.hostIdentity([path.join('/dev/null', 'nope'), data])).host).toBe(first.host);
    expect(await processLease.hostIdentity([path.join('/dev/null', 'nope')])).toMatchObject({ host: null, source: 'none', detail: expect.stringMatching(/MEDIA_PROCESS_HOST_ID/) });
  });

  test('a configured id wins; an invalid one is ignored with a note instead of failing the claim', async () => {
    process.env.MEDIA_PROCESS_HOST_ID = 'photo-server-01-main';
    expect(await processLease.hostIdentity([path.join(dir, 'data')])).toMatchObject({ source: 'MEDIA_PROCESS_HOST_ID', host: expect.stringMatching(/^[a-f0-9]{64}$/) });
    process.env.MEDIA_PROCESS_HOST_ID = 'short';
    const ignored = await processLease.hostIdentity([path.join(dir, 'data')]);
    expect(ignored.source).not.toBe('MEDIA_PROCESS_HOST_ID');
    expect(ignored.detail).toMatch(/MEDIA_PROCESS_HOST_ID ignored/);
  });
});

describe('one path for sharp (item 13)', () => {
  test('sharp runs in the warm worker pool only: no guard, no second supervisor, and it stops with its attempt', async () => {
    const source = await fsp.readFile(path.join(__dirname, '../../src/services/isolatedSharp.js'), 'utf8');
    expect(source).not.toMatch(/nativeProcessRunner|mediaProcessService|media-process-guard/);
    // The pool's allow-listed environment and fallback chain are untouched.
    expect(source).toMatch(/ENV_NAMES/); expect(source).toMatch(/'capped'/); expect(source).toMatch(/'inprocess'/);
    const sharp = require('../../src/services/isolatedSharp');
    const controller = new AbortController(); controller.abort();
    await expect(require('../../src/services/mediaAttemptContext').run({ signal: controller.signal },
      () => sharp(Buffer.from('x')).metadata())).rejects.toMatchObject({ code: 'IMAGE_CANCELLED', status: 503 });
  });
});

describe('installing without a compiler (item 3, 14)', () => {
  const root = path.join(__dirname, '../..');
  test('npm install never builds the native pieces; only an explicit build step does', () => {
    const scripts = require('../../package.json').scripts;
    expect(scripts['build:native']).toBe('node scripts/build-native-runner.js');
    for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prestart', 'start']) expect(scripts[hook] || '').not.toMatch(/build:native|build-native/);
    // Fatal in the image builds, tolerated by the native installer.
    for (const file of ['Dockerfile', 'Dockerfile.dev', '../Dockerfile.aio']) expect(fs.readFileSync(path.join(root, file), 'utf8')).toMatch(/&& npm run build:native|^RUN npm run build:native/m);
    const installer = fs.readFileSync(path.join(root, '../scripts/picpeak-setup.sh'), 'utf8');
    expect(installer.match(/npm run build:native"? \|\| log_warn/g)).toHaveLength(2);
    expect(installer).not.toMatch(/npm run build:native"?\n/);
  });

  test('the build script is a no-op outside Linux', () => {
    if (platform === 'linux') return;
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/build-native-runner.js')], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Linux-only; nothing to build/);
  });

  test('every setting of this layer is documented in both env examples and the docs', () => {
    const names = ['MEDIA_PROCESS_HOST_ID', 'MEDIA_PROCESS_LEASE_PATH', 'MEDIA_PROCESS_CONCURRENCY', 'MEDIA_PROCESS_QUEUE_LENGTH',
      'MEDIA_WORKER_MEMORY_MIB', 'MEDIA_FFMPEG_THREADS', 'MEDIA_MAX_INPUT_MIB', 'MEDIA_MAX_SNAPSHOT_MIB',
      'MEDIA_MAX_VIDEO_PIXELS', 'MEDIA_MAX_VIDEO_DIMENSION', 'MEDIA_MAX_VIDEO_STREAMS',
      'MEDIA_MAX_VIDEO_DURATION_SECONDS', 'MEDIA_MAX_VIDEO_FPS', 'MEDIA_MAX_VIDEO_PIXEL_FRAMES', 'MEDIA_PROBE_TIMEOUT_MS',
      'MEDIA_RAW_TIMEOUT_MS', 'MEDIA_THUMBNAIL_TIMEOUT_MS'];
    const web = fs.existsSync(path.join(root, 'src/services/videoRenditionService.js'));
    // The browser-playable copy and its transcode exist on this branch only where that service does.
    if (web) names.push('VIDEO_RENDITION_TIMEOUT_MS', 'VIDEO_RENDITION_MAX_TIMEOUT_MS', 'MEDIA_FFMPEG_MEMORY_MIB', 'MEDIA_MAX_VIDEO_OUTPUT_MIB');
    for (const file of ['../.env.example', '.env.example', '../docs/MEDIA_PROCESSING.md']) {
      const text = fs.readFileSync(path.join(root, file), 'utf8');
      for (const name of names) expect({ file, name, documented: text.includes(name) }).toEqual({ file, name, documented: true });
    }
    const docs = fs.readFileSync(path.join(root, '../docs/MEDIA_PROCESSING.md'), 'utf8');
    for (const heading of ['process guard', 'kernel leases', 'macOS', 'Docker Desktop', 'NFS']) expect(docs).toContain(heading);
    expect(fs.readFileSync(path.join(root, '../CONTRIBUTING.md'), 'utf8')).toMatch(/build:native/);
  });
});
