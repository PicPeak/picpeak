const { estimate, configuration, renditionBudget, isTransient, isInterruption, refusal } = require('../../src/services/mediaProcessPolicy');
const { videoSignature, rawSignature } = require('../../src/services/mediaProcessService');
const ordinary = () => ({ format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '10' },
  streams: [{ codec_type: 'video', width: 3840, height: 2160, avg_frame_rate: '30/1', pix_fmt: 'yuv420p' }] });
test('ordinary 4K and HDR have finite, frame-aware deployment admission', () => {
  expect(estimate(ordinary())).toEqual({ decodedBytes: 3840 * 2160 * 8, work: 3840 * 2160 * 300, duration: 10 });
  const hdr = ordinary(); hdr.streams[0].pix_fmt = 'yuv420p10le';
  expect(estimate(hdr).decodedBytes).toBe(3840 * 2160 * 16);
});
test('dimensions, streams, rate and equivalent numeric encodings cannot bypass policy', () => {
  for (const alter of [
    item => { item.streams[0].width = 50000; }, item => { item.streams[0].width = 'Infinity'; },
    item => { item.streams[0].width = -1; }, item => { item.streams[0].width = 1.5; },
    item => { item.streams[0].avg_frame_rate = '1000/1'; }, item => { item.streams[0].avg_frame_rate = '1/0'; },
    item => { item.streams = Array(17).fill(item.streams[0]); }, item => { item.format.format_name = 'hls'; },
  ]) { const item = ordinary(); alter(item); expect(() => estimate(item)).toThrow(); }
  const numeric = ordinary(); numeric.streams[0].width = '3.84e3';
  expect(estimate(numeric)).toEqual(estimate(ordinary()));
});
describe('limits an operator has to ask for', () => {
  const names = ['MEDIA_MAX_VIDEO_DURATION_SECONDS', 'MEDIA_MAX_VIDEO_PIXEL_FRAMES', 'MEDIA_MAX_INPUT_MIB', 'MEDIA_MAX_VIDEO_OUTPUT_MIB',
    'MEDIA_FFMPEG_MEMORY_MIB', 'MEDIA_FFMPEG_THREADS', 'VIDEO_RENDITION_TIMEOUT_MS', 'VIDEO_RENDITION_MAX_TIMEOUT_MS'];
  afterEach(() => { for (const name of names) delete process.env[name]; });
  test('by default no video is refused for its length, its size or the work it takes', () => {
    const policy = configuration();
    expect(policy).toMatchObject({ inputBytes: null, outputBytes: null, maxDuration: null, maxWork: null });
    const long = ordinary(); long.format.duration = '36000';
    expect(estimate(long).duration).toBe(36000);
    const unknown = ordinary(); delete unknown.format.duration; delete unknown.streams[0].avg_frame_rate;
    expect(() => estimate(unknown)).not.toThrow();
  });
  test('a configured duration or work limit refuses, and unknown length counts as the whole budget', () => {
    process.env.MEDIA_MAX_VIDEO_DURATION_SECONDS = '7200'; process.env.MEDIA_MAX_VIDEO_PIXEL_FRAMES = '2000000000000';
    const long = ordinary(); long.format.duration = '36000';
    expect(() => estimate(long)).toThrow(/duration/);
    const frames = ordinary(); frames.streams[0].nb_frames = '1e15';
    expect(() => estimate(frames)).toThrow(/work/);
    const unknown = ordinary(); delete unknown.format.duration; delete unknown.streams[0].avg_frame_rate;
    expect(estimate(unknown).work).toBe(2000000000000);
  });
  test('ffmpeg threads follow the CPU count up to four and a transcode has no address-space cap unless one is set', () => {
    const policy = configuration();
    expect(policy.threads).toBe(Math.min(4, require('os').availableParallelism()));
    expect(policy.transcodeBytes).toBe(0);
    expect(policy.nativeBytes).toBeGreaterThanOrEqual(2048 * 1024 * 1024);
    process.env.MEDIA_FFMPEG_THREADS = '2'; process.env.MEDIA_FFMPEG_MEMORY_MIB = '4096';
    expect(configuration()).toMatchObject({ threads: 2, transcodeBytes: 4096 * 1024 * 1024 });
  });
  test('the transcode budget grows with the video and the thread count; the configured timeout is only its floor', () => {
    process.env.MEDIA_FFMPEG_THREADS = '4';
    expect(renditionBudget(60)).toEqual({ wallMs: 3600000, cpuSeconds: 3600 * 4 });
    expect(renditionBudget(1800)).toEqual({ wallMs: 36000000, cpuSeconds: 36000 * 4 });
    expect(renditionBudget(86400).wallMs).toBe(86400000);
    expect(renditionBudget(NaN).wallMs).toBe(3600000);
    process.env.MEDIA_FFMPEG_THREADS = '1';
    expect(renditionBudget(1800).cpuSeconds).toBe(36000);
    // A value above the old two-hour ceiling is honoured, not a boot failure.
    process.env.VIDEO_RENDITION_TIMEOUT_MS = '14400000';
    expect(renditionBudget(60).wallMs).toBe(14400000);
  });
});
test('"not now" codes are transient with status 503; a verdict on the media is not', () => {
  for (const code of ['MEDIA_CANCELLED', 'MEDIA_QUEUE_FULL', 'MEDIA_WORKER_UNAVAILABLE', 'MEDIA_LEASE_UNAVAILABLE', 'MEDIA_LEASE_BUSY']) {
    const error = refusal('later', code);
    expect(isTransient(error)).toBe(true); expect(error.status).toBe(503); expect(isInterruption(error)).toBe(true);
  }
  for (const code of ['MEDIA_RESOURCE_LIMIT', 'MEDIA_INVALID_SIGNATURE', 'MEDIA_TIMEOUT', 'MEDIA_OUTPUT_LIMIT']) {
    const error = refusal('no', code);
    expect(isTransient(error)).toBe(false); expect(error.status).toBe(422);
  }
  expect(isInterruption(refusal('gone', 'MEDIA_SUPERSEDED'))).toBe(true);
});
test('extensions do not substitute for video and RAW container signatures', () => {
  expect(() => videoSignature(Buffer.from('#EXTM3U\n'))).toThrow();
  expect(() => rawSignature(Buffer.from([255, 216, 255, 224]), 'spoof.DNG')).toThrow();
  for (const name of ['dng', 'cr2', 'nef', 'arw', 'pef', '3fr', 'dcr', 'kdc']) expect(() => rawSignature(Buffer.from('II*\0'), `normal.${name}`)).not.toThrow();
  expect(() => rawSignature(Buffer.from('FUJIFILMCCD-RAW '), 'normal.RAF')).not.toThrow();
  expect(() => rawSignature(Buffer.from('IIU\0'), 'normal.RW2')).not.toThrow();
  expect(() => rawSignature(Buffer.from('IIRO'), 'normal.ORF')).not.toThrow();
});
