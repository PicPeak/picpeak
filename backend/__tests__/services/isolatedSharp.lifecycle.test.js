const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');

const waitFor = async predicate => {
  for (let index = 0; index < 200; index++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Fixture did not reach the expected state');
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// The queue, the worker pool and the fallbacks, driven with fixture children
// that speak the worker's line protocol: one "ready" line, then one JSON
// answer per job line.
describe('image worker queue and pool', () => {
  let sharp, children, spawn, logger, policy, spawnFailure;
  const load = () => {
    jest.resetModules();
    children = [];
    spawnFailure = null;
    spawn = jest.fn((command, args, options) => {
      if (spawnFailure) throw spawnFailure;
      const child = new EventEmitter();
      child.options = options;
      child.jobs = [];
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new Writable({ write(chunk, _encoding, callback) { child.jobs.push(JSON.parse(chunk.toString())); callback(); } });
      child.kill = jest.fn(() => { setImmediate(() => child.emit('close', null, 'SIGKILL')); return true; });
      child.answer = value => child.stdout.write(`${JSON.stringify(value)}\n`);
      children.push(child);
      setImmediate(() => child.answer({ ready: true }));
      return child;
    });
    jest.doMock('child_process', () => ({ ...jest.requireActual('child_process'), spawn }));
    jest.doMock('../../src/utils/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));
    jest.doMock('../../src/services/imageResourcePolicy', () => {
      const actual = jest.requireActual('../../src/services/imageResourcePolicy');
      return { ...actual, configuration: () => ({ ...actual.configuration(), workers: 1, queueLength: 2, timeoutMs: 30000, ...policy }) };
    });
    logger = require('../../src/utils/logger');
    sharp = require('../../src/services/isolatedSharp');
  };
  beforeEach(() => { policy = {}; load(); });
  afterEach(async () => {
    await sharp.shutdown();
    jest.dontMock('child_process'); jest.dontMock('../../src/utils/logger'); jest.dontMock('../../src/services/imageResourcePolicy');
  });
  const metadata = { value: { width: 16, height: 16 } };

  test('the child gets an allow-listed environment without the backend secrets', async () => {
    const before = { JWT_SECRET: process.env.JWT_SECRET, DB_PASSWORD: process.env.DB_PASSWORD, SMTP_PASS: process.env.SMTP_PASS, VIPS_DISC_THRESHOLD: process.env.VIPS_DISC_THRESHOLD };
    Object.assign(process.env, { JWT_SECRET: 'jwt-fixture', DB_PASSWORD: 'db-fixture', SMTP_PASS: 'smtp-fixture', VIPS_DISC_THRESHOLD: '100m' });
    try {
      const job = sharp('/fixture/a.jpg').metadata();
      await waitFor(() => children[0]?.jobs.length === 1);
      children[0].answer(metadata);
      await job;
      const { env } = children[0].options;
      expect(env.JWT_SECRET).toBeUndefined();
      expect(env.DB_PASSWORD).toBeUndefined();
      expect(env.SMTP_PASS).toBeUndefined();
      expect(Object.values(env).join('\n')).not.toMatch(/jwt-fixture|db-fixture|smtp-fixture/);
      expect(env).toMatchObject({ PATH: process.env.PATH, VIPS_CONCURRENCY: '1', VIPS_DISC_THRESHOLD: '100m' });
    } finally {
      for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });

  test('one warm worker serves consecutive jobs, with no shell hop per job', async () => {
    for (let index = 0; index < 5; index++) {
      const job = sharp(`/fixture/${index}.jpg`).metadata();
      await waitFor(() => children[0].jobs.length === index + 1);
      children[0].answer(metadata);
      await expect(job).resolves.toMatchObject({ width: 16 });
    }
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args] = spawn.mock.calls[0];
    if (process.platform === 'linux') {
      expect(command).toBe('/bin/sh');
      expect(args.join(' ')).toContain('ulimit -v');
      expect(args.join(' ')).toContain('exec "$@"');
    } else {
      expect(command).toBe(process.execPath);
    }
    expect(args).toContain('--jitless');
  });

  test('a worker is replaced after a failed job and after a resource limit', async () => {
    const first = sharp('/fixture/a.jpg').metadata();
    await waitFor(() => children[0]?.jobs.length === 1);
    children[0].answer({ error: { message: 'Image has 300 megapixels', code: 'IMAGE_RESOURCE_LIMIT', imageLimit: 'pixels', imageMax: 268.4 } });
    await expect(first).rejects.toMatchObject({ code: 'IMAGE_RESOURCE_LIMIT', status: 422, imageLimit: 'pixels', imageMax: 268.4 });
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
    const second = sharp('/fixture/b.jpg').metadata();
    await waitFor(() => children[1]?.jobs.length === 1);
    children[1].answer(metadata);
    await expect(second).resolves.toMatchObject({ width: 16 });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  test('background jobs wait for a worker however long the queue is; none is refused', async () => {
    const jobs = Array.from({ length: 12 }, (_, index) => sharp(`/fixture/${index}.jpg`).metadata());
    for (let index = 0; index < jobs.length; index++) {
      await waitFor(() => children[0].jobs.length === index + 1);
      children[0].answer(metadata);
    }
    await expect(Promise.all(jobs)).resolves.toHaveLength(12);
  });

  test('an interactive caller is refused with a 503 only once the queue is full', async () => {
    const running = sharp('/fixture/running.jpg').metadata();
    await waitFor(() => children[0]?.jobs.length === 1);
    const waiting = [sharp('/fixture/w1.jpg', { interactive: true }).metadata(), sharp('/fixture/w2.jpg', { interactive: true }).metadata()];
    await expect(sharp('/fixture/refused.jpg', { interactive: true }).metadata())
      .rejects.toMatchObject({ code: 'IMAGE_QUEUE_FULL', status: 503, retryAfter: 5 });
    // The same queue still takes background work.
    const background = sharp('/fixture/background.jpg').metadata();
    for (let index = 0; index < 4; index++) {
      await waitFor(() => children[0].jobs.length === index + 1);
      children[0].answer(metadata);
    }
    await expect(Promise.all([running, ...waiting, background])).resolves.toHaveLength(4);
  });

  test('the deadline starts when a job starts executing, not while it waits', async () => {
    policy = { timeoutMs: 200 };
    const slow = sharp('/fixture/slow.jpg').metadata();
    const queued = sharp('/fixture/queued.jpg').metadata();
    await waitFor(() => children[0]?.jobs.length === 1);
    // The first job overruns its 200 ms; the second has waited all that time.
    await expect(slow).rejects.toMatchObject({ code: 'IMAGE_TIMEOUT', status: 503 });
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
    await waitFor(() => children[1]?.jobs.length === 1);
    children[1].answer(metadata);
    await expect(queued).resolves.toMatchObject({ width: 16 });
  });

  test('cancelling a running job answers at once and keeps its slot until the child is gone', async () => {
    const controller = new AbortController();
    const first = sharp('/fixture/first.jpg', { signal: controller.signal }).metadata();
    await waitFor(() => children[0]?.jobs.length === 1);
    children[0].kill = jest.fn(); // Stays alive until the test says otherwise.
    const second = sharp('/fixture/second.jpg').metadata();
    controller.abort();
    await expect(first).rejects.toMatchObject({ code: 'IMAGE_CANCELLED' });
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
    await pause(20);
    expect(spawn).toHaveBeenCalledTimes(1);
    children[0].emit('close', null, 'SIGKILL');
    await waitFor(() => children[1]?.jobs.length === 1);
    children[1].answer(metadata);
    await expect(second).resolves.toMatchObject({ width: 16 });
  });

  test('a job that runs out of memory in a shared worker runs once more alone with the whole budget', async () => {
    if (process.platform !== 'linux') return; // Only the memory-limited mode has a budget to widen.
    policy = { nativeBytes: 768 * 1024 * 1024, exclusiveBytes: 2048 * 1024 * 1024 };
    const job = sharp('/fixture/large.jpg').toBuffer();
    await waitFor(() => children[0]?.jobs.length === 1);
    children[0].answer({ error: { message: 'vips_tracked: out of memory', code: 'IMAGE_RESOURCE_LIMIT' } });
    await waitFor(() => children[1]?.jobs.length === 1);
    expect(spawn.mock.calls[1][1]).toContain(String(2048 * 1024 * 1024));
    children[1].answer({ error: { message: 'vips_tracked: out of memory', code: 'IMAGE_RESOURCE_LIMIT' } });
    await expect(job).rejects.toMatchObject({ code: 'IMAGE_RESOURCE_LIMIT', imageLimit: 'memory', imageMax: 2048,
      message: expect.stringContaining('IMAGE_WORKER_MEMORY_MIB') });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  test('off Linux the worker is a plain child, announced once', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      load();
      expect(await sharp.prepare()).toBe('child');
      expect(await sharp.prepare()).toBe('child');
      expect(spawn.mock.calls[0][0]).toBe(process.execPath);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0][0]).toMatch(/WITHOUT ITS MEMORY LIMIT.*needs Linux/);
    } finally { Object.defineProperty(process, 'platform', platform); }
  });

  test('where `ulimit -v` is refused the worker falls back to a plain child, announced once', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      load();
      spawn.mockImplementationOnce(() => {
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough();
        child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
        child.kill = jest.fn();
        setImmediate(() => child.emit('close', 125, null));
        return child;
      });
      const job = sharp('/fixture/a.jpg').metadata();
      await waitFor(() => children[0]?.jobs.length === 1);
      children[0].answer(metadata);
      await expect(job).resolves.toMatchObject({ width: 16 });
      expect(spawn.mock.calls[0][0]).toBe('/bin/sh');
      expect(spawn.mock.calls[1][0]).toBe(process.execPath);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0][0]).toMatch(/WITHOUT ITS MEMORY LIMIT.*ulimit -v/);
    } finally { Object.defineProperty(process, 'platform', platform); }
  });

  test('when no child can be started at all, sharp runs in the backend process, announced once', async () => {
    const fs = require('fs').promises;
    const path = require('path');
    const os = require('os');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'isolated-sharp-inprocess-'));
    try {
      const source = path.join(dir, 'source.png');
      await jest.requireActual('sharp')({ create: { width: 40, height: 20, channels: 3, background: 'white' } }).png().toFile(source);
      spawnFailure = Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' });
      expect(await sharp(source).metadata()).toMatchObject({ width: 40, height: 20, format: 'png' });
      const resized = await sharp(source).resize(10).jpeg().toBuffer();
      expect((await jest.requireActual('sharp')(resized).metadata()).width).toBe(10);
      // The pixel limit holds in this mode too.
      policy = { maxPixels: 100 };
      await expect(sharp(source).metadata()).rejects.toMatchObject({ code: 'IMAGE_RESOURCE_LIMIT', imageLimit: 'pixels' });
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0][0]).toMatch(/INSIDE THE BACKEND PROCESS.*EAGAIN/);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});
