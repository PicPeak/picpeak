/**
 * What a transcode is given (item 9): threads from the CPU count instead of
 * a pin to one, a time budget that grows with the video, no address-space
 * cap unless the operator sets one, and its own lane.
 */
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/database/db', () => ({ db: jest.fn() }));
jest.mock('../../src/services/mediaAttemptService', () => ({ current: () => null }));
jest.mock('../../src/services/mediaProcessService', () => ({
  run: jest.fn(async () => ({ stdout: Buffer.alloc(0) })),
  probeSnapshot: jest.fn(async () => ({ format: { duration: '600' } })),
  inputOptions: (format, threads = 1) => ['-format_whitelist', format, '-threads', String(threads)],
  withSnapshot: (source, _kind, callback) => callback('/snapshot.mov', { format: 'mov,mp4', policy: require('../../src/services/mediaProcessPolicy').configuration() }),
}));

const processes = require('../../src/services/mediaProcessService');
const service = require('../../src/services/videoRenditionService');
const names = ['MEDIA_FFMPEG_THREADS', 'MEDIA_FFMPEG_MEMORY_MIB', 'VIDEO_RENDITION_TIMEOUT_MS', 'MEDIA_MAX_VIDEO_OUTPUT_MIB'];
const pairs = (args, flag) => args.map((value, index) => value === flag ? args[index + 1] : null).filter(value => value !== null);

describe('videoRenditionService.transcode', () => {
  beforeEach(() => { jest.clearAllMocks(); for (const name of names) delete process.env[name]; });
  afterAll(() => { for (const name of names) delete process.env[name]; });

  test('ffmpeg is not pinned to one thread: decode, encode and filters use the policy\'s thread count', async () => {
    process.env.MEDIA_FFMPEG_THREADS = '3';
    await service.transcode('/in.mov', '/out.mp4', { duration: 600 });
    const [command, args, options] = processes.run.mock.calls[0];
    expect(command).toBe('ffmpeg');
    expect(pairs(args, '-threads')).toEqual(['3', '3']);
    expect(pairs(args, '-filter_threads')).toEqual(['3']);
    expect(args).not.toContain('-filter_complex_threads');
    expect(args[args.length - 1]).toBe('/out.mp4');
    expect(options.lane).toBe('long');
  });

  test('the default thread count is the CPU count, at most four', async () => {
    await service.transcode('/in.mov', '/out.mp4', { duration: 600 });
    const expected = String(Math.min(4, require('os').availableParallelism()));
    expect(pairs(processes.run.mock.calls[0][1], '-threads')).toEqual([expected, expected]);
  });

  test('the time and CPU budget scale with the duration and the threads instead of a flat hour', async () => {
    process.env.MEDIA_FFMPEG_THREADS = '4';
    await service.transcode('/in.mov', '/out.mp4', { duration: 60 });
    expect(processes.run.mock.calls[0][2]).toMatchObject({ wallMs: 3600000, cpuSeconds: 14400 });
    await service.transcode('/in.mov', '/out.mp4', { duration: 5400 }); // 90 minutes
    expect(processes.run.mock.calls[1][2]).toMatchObject({ wallMs: 86400000, cpuSeconds: 345600 });
    await service.transcode('/in.mov', '/out.mp4', { duration: 1800 });
    expect(processes.run.mock.calls[2][2]).toMatchObject({ wallMs: 36000000, cpuSeconds: 144000 });
    // Without a duration from the caller, the snapshot's own probe supplies it (600 s).
    await service.transcode('/in.mov', '/out.mp4');
    expect(processes.run.mock.calls[3][2]).toMatchObject({ wallMs: 12000000 });
  });

  test('a transcode has no address-space cap by default, and the configured one when set', async () => {
    await service.transcode('/in.mov', '/out.mp4', { duration: 60 });
    expect(processes.run.mock.calls[0][2].memoryBytes).toBe(0);
    process.env.MEDIA_FFMPEG_MEMORY_MIB = '4096';
    await service.transcode('/in.mov', '/out.mp4', { duration: 60 });
    expect(processes.run.mock.calls[1][2].memoryBytes).toBe(4096 * 1024 * 1024);
  });
});
