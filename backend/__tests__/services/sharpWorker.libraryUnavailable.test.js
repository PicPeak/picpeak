// The message sharp 0.35 throws on a CPU below x86-64-v2 (issue 2347), for
// example a Proxmox VM on the kvm64 CPU type.
const UNSUPPORTED_CPU = 'Could not load the "sharp" module using the linuxmusl-x64 runtime\n'
  + 'Unsupported CPU: Prebuilt binaries for Linux x64 require v2 microarchitecture\n'
  + 'WebAssembly.Module(): Wasm SIMD unsupported';

const loadWorkerWith = message => {
  let worker;
  jest.isolateModules(() => {
    jest.doMock('sharp', () => { throw new Error(message); });
    worker = require('../../src/services/sharpWorker');
  });
  return worker;
};
const caught = fn => { try { fn(); } catch (error) { return error; } return null; };

describe('sharp cannot load on this host', () => {
  afterEach(() => jest.dontMock('sharp'));

  test('an unsupported CPU is named as the cause, with where to read on', () => {
    const error = caught(loadWorkerWith(UNSUPPORTED_CPU).loadSharp);
    expect(error.code).toBe('SHARP_UNAVAILABLE');
    expect(error.message).toMatch(/x86-64-v2/);
    expect(error.message).toMatch(/virtual CPU type/);
    expect(error.message).toContain('docs.picpeak.app/deployment/system-requirements#cpu');
    expect(error.detail).toContain('Unsupported CPU');
  });

  test('any other load failure does not guess at the CPU', () => {
    const error = caught(loadWorkerWith('Cannot find module @img/sharp-linux-x64').loadSharp);
    expect(error.code).toBe('SHARP_UNAVAILABLE');
    expect(error.message).not.toMatch(/x86-64-v2/);
  });

  test('the code survives the trip to the parent, sharp\'s own text does not', () => {
    const worker = loadWorkerWith(UNSUPPORTED_CPU);
    const serialized = worker.serializeError(caught(worker.loadSharp));
    expect(serialized.code).toBe('SHARP_UNAVAILABLE');
    expect(serialized).not.toHaveProperty('detail');
  });

  test('a job fails with the same refusal in the in-process fallback', async () => {
    await expect(loadWorkerWith(UNSUPPORTED_CPU).run({ terminal: 'metadataBatch', entries: [], policy: {} }))
      .rejects.toMatchObject({ code: 'SHARP_UNAVAILABLE' });
  });

  test('background work keeps treating it as an ordinary sharp failure', () => {
    const { isResourceError, isTransient, describe: fields } = require('../../src/services/imageResourcePolicy');
    const error = caught(loadWorkerWith(UNSUPPORTED_CPU).loadSharp);
    expect(isResourceError(error)).toBe(false);
    expect(isTransient(error)).toBe(false);
    expect(fields(error)).toEqual({ code: 'SHARP_UNAVAILABLE' });
  });

  test('the startup log says so when no worker starts because of it', async () => {
    jest.resetModules();
    const logger = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };
    jest.doMock('../../src/utils/logger', () => logger);
    jest.doMock('sharp', () => { throw new Error(UNSUPPORTED_CPU); });
    jest.doMock('child_process', () => ({ spawn: () => { throw new Error('spawn EAGAIN'); } }));
    const sharp = require('../../src/services/isolatedSharp');
    await sharp.prepare();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toMatch(/IMAGE PROCESSING IS UNAVAILABLE.*x86-64-v2.*Unsupported CPU/s);
    jest.dontMock('child_process');
    jest.dontMock('../../src/utils/logger');
  });
});
