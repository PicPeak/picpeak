const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');
const waitFor = async predicate => {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Fixture child did not reach expected state');
};
const linux = process.platform === 'linux' ? describe : describe.skip;
linux('image worker lifecycle accounting', () => {
  let sharp, children, run;
  beforeEach(() => {
    jest.resetModules(); children = [];
    run = jest.fn((_command, _args, options) => new Promise((resolve, reject) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
      const chunks = [];
      child.stdout.on('data', value => chunks.push(value));
      child.kill = jest.fn(); children.push(child);
      options.signal.addEventListener('abort', () => child.kill('SIGTERM'));
      child.on('close', code => options.signal.aborted ? reject(Object.assign(new Error('cancelled'), { code: 'IMAGE_CANCELLED' })) :
        code === 0 ? resolve({ stdout: Buffer.concat(chunks) }) : reject(Object.assign(new Error('crashed'), { code: 'IMAGE_WORKER_FAILED' })));
    }));
    jest.doMock('../../src/services/nativeProcessRunner', () => ({ run }));
    jest.doMock('../../src/services/imageResourcePolicy', () => {
      const actual = jest.requireActual('../../src/services/imageResourcePolicy');
      return { ...actual, configuration: () => ({ ...actual.configuration(), workers: 1, queueLength: 1, inputBytes: 1024 * 1024 }) };
    });
    sharp = require('../../src/services/isolatedSharp');
  });
  afterEach(() => { jest.dontMock('../../src/services/nativeProcessRunner'); jest.dontMock('../../src/services/imageResourcePolicy'); });
  const finish = child => { child.stdout.write(JSON.stringify({ value: { width: 16, height: 16 } })); child.emit('close', 0, null); };

  test('cancel cannot settle or release the native lease before confirmed close', async () => {
    const controller = new AbortController();
    const first = sharp('/fixture/first.jpg', { signal: controller.signal }).metadata();
    await waitFor(() => children.length === 1);
    controller.abort();
    const rejection = expect(first).rejects.toMatchObject({ code: 'IMAGE_CANCELLED' });
    expect(children[0].kill).toHaveBeenCalledWith('SIGTERM');
    const second = sharp('/fixture/second.jpg').metadata();
    await expect(sharp('/fixture/third.jpg').metadata()).rejects.toMatchObject({ code: 'IMAGE_QUEUE_FULL' });
    expect(run).toHaveBeenCalledTimes(1);
    children[0].emit('close', null, 'SIGKILL');
    await rejection;
    await waitFor(() => children.length === 2);
    finish(children[1]);
    await expect(second).resolves.toMatchObject({ width: 16 });
    const args = run.mock.calls[0][1];
    expect(args.join(' ')).toContain('--jitless');
    expect(run.mock.calls[0][2]).toMatchObject({ prefix: 'IMAGE', memoryBytes: 768 * 1024 * 1024 });
  });

  test('crash is isolated and has no implicit retry', async () => {
    const first = sharp('/fixture/first.jpg').metadata();
    await waitFor(() => children.length === 1);
    children[0].emit('close', null, 'SIGABRT');
    await expect(first).rejects.toMatchObject({ code: 'IMAGE_WORKER_FAILED' });
    expect(run).toHaveBeenCalledTimes(1);
    const second = sharp('/fixture/second.jpg').metadata();
    await waitFor(() => children.length === 2);
    finish(children[1]);
    await expect(second).resolves.toMatchObject({ width: 16 });
  });

  test('cancelled live Buffers stay charged until the actual child closes', async () => {
    const controller = new AbortController();
    const input = Buffer.alloc(600 * 1024);
    const first = sharp(input, { signal: controller.signal }).metadata();
    await waitFor(() => children.length === 1);
    controller.abort();
    const rejection = expect(first).rejects.toMatchObject({ code: 'IMAGE_CANCELLED' });
    await expect(sharp(input).metadata()).rejects.toMatchObject({ code: 'IMAGE_QUEUE_FULL' });
    children[0].emit('close', null, 'SIGKILL');
    await rejection;
    await new Promise(resolve => setTimeout(resolve, 20));
    const second = sharp(input).metadata();
    await waitFor(() => children.length === 2);
    finish(children[1]); await second;
  });
});
