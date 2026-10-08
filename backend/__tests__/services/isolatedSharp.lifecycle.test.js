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
  let sharp, children, spawn;
  beforeEach(() => {
    jest.resetModules(); children = [];
    spawn = jest.fn(() => {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
      child.kill = jest.fn(); children.push(child); return child;
    });
    jest.doMock('child_process', () => ({ ...jest.requireActual('child_process'), spawn }));
    jest.doMock('../../src/services/imageResourcePolicy', () => {
      const actual = jest.requireActual('../../src/services/imageResourcePolicy');
      return { ...actual, configuration: () => ({ ...actual.configuration(), workers: 1, queueLength: 1, inputBytes: 1024 * 1024 }) };
    });
    sharp = require('../../src/services/isolatedSharp');
  });
  afterEach(() => { jest.dontMock('child_process'); jest.dontMock('../../src/services/imageResourcePolicy'); });
  const finish = child => { child.stdout.write(JSON.stringify({ value: { width: 16, height: 16 } })); child.emit('close', 0, null); };

  test('cancel returns promptly but cannot release the native lease before close', async () => {
    const controller = new AbortController();
    const first = sharp('/fixture/first.jpg', { signal: controller.signal }).metadata();
    await waitFor(() => children.length === 1);
    controller.abort();
    await expect(first).rejects.toMatchObject({ code: 'IMAGE_CANCELLED' });
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
    const second = sharp('/fixture/second.jpg').metadata();
    await expect(sharp('/fixture/third.jpg').metadata()).rejects.toMatchObject({ code: 'IMAGE_QUEUE_FULL' });
    expect(spawn).toHaveBeenCalledTimes(1);
    children[0].emit('close', null, 'SIGKILL');
    await waitFor(() => children.length === 2);
    finish(children[1]);
    await expect(second).resolves.toMatchObject({ width: 16 });
    const args = spawn.mock.calls[0][1];
    expect(args.join(' ')).toContain('ulimit -v');
    expect(args.join(' ')).toContain('--jitless');
  });

  test('crash is isolated and has no implicit retry', async () => {
    const first = sharp('/fixture/first.jpg').metadata();
    await waitFor(() => children.length === 1);
    children[0].emit('close', null, 'SIGABRT');
    await expect(first).rejects.toMatchObject({ code: 'IMAGE_WORKER_FAILED' });
    expect(spawn).toHaveBeenCalledTimes(1);
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
    await expect(first).rejects.toMatchObject({ code: 'IMAGE_CANCELLED' });
    await expect(sharp(input).metadata()).rejects.toMatchObject({ code: 'IMAGE_QUEUE_FULL' });
    children[0].emit('close', null, 'SIGKILL');
    await new Promise(resolve => setTimeout(resolve, 20));
    const second = sharp(input).metadata();
    await waitFor(() => children.length === 2);
    finish(children[1]); await second;
  });
});
