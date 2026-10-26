jest.mock('../../utils/logger');
jest.mock('fluent-ffmpeg');
// The compatibility fixtures remain independent from real native validation;
// stand in at the new mandatory supervisor boundary, not child_process.
jest.mock('../mediaProcessService', () => ({
  probeVideo: path => new Promise((resolve, reject) => require('fluent-ffmpeg').ffprobe(path, (error, value) => error ? reject(error) : resolve(value))),
  probeSnapshot: jest.fn(async () => ({})),
  inputOptions: () => [],
  withSnapshot: (path, _kind, callback) => callback(path, { format: 'mov,mp4', policy: { nativeBytes: 768 * 1024 * 1024, thumbnailMs: 60000 } }),
  run: (_command, args) => new Promise((resolve, reject) => {
    const command = require('fluent-ffmpeg')(args[args.indexOf('-i') + 1]);
    const output = args[args.length - 1];
    command.on('end', () => resolve({ stdout: Buffer.alloc(0) })).on('error', reject)
      .screenshots({ filename: require('path').basename(output), folder: require('path').dirname(output) });
  }),
}));
jest.mock('../storage', () => ({
  getStorage: jest.fn()
}));
jest.mock('../imageProcessor', () => ({
  generateVideoPlaceholder: jest.fn(),
  DEFAULT_THUMBNAIL_WIDTH: 300,
  DEFAULT_THUMBNAIL_HEIGHT: 300
}));

const ffmpeg = require('fluent-ffmpeg');
const { getStorage } = require('../storage');
const { generateVideoPlaceholder } = require('../imageProcessor');
const {
  extractVideoMetadata,
  processUploadedVideo
} = require('../videoProcessor');

describe('extractVideoMetadata (#1370)', () => {
  afterEach(() => jest.clearAllMocks());

  it('returns null duration rather than 0 when ffprobe has none, so "unknown" and "a real 0s clip" stay distinguishable', async () => {
    ffmpeg.ffprobe = jest.fn((videoPath, cb) => {
      cb(null, {
        streams: [{ codec_type: 'video', width: 1920, height: 1080, codec_name: 'hevc' }],
        format: {} // no duration field at all
      });
    });

    const metadata = await extractVideoMetadata('/tmp/video.mp4');

    expect(metadata.duration).toBeNull();
    expect(metadata.width).toBe(1920);
    expect(metadata.videoCodec).toBe('hevc');
  });

  it('floors a real duration', async () => {
    ffmpeg.ffprobe = jest.fn((videoPath, cb) => {
      cb(null, { streams: [], format: { duration: 12.9 } });
    });

    const metadata = await extractVideoMetadata('/tmp/video.mp4');

    expect(metadata.duration).toBe(12);
  });
});

describe('processUploadedVideo degrades gracefully instead of rejecting the whole video (#1370)', () => {
  let storage;

  beforeEach(() => {
    storage = { putFromFile: jest.fn().mockResolvedValue(undefined), exists: jest.fn().mockResolvedValue(true) };
    getStorage.mockReturnValue(storage);
    generateVideoPlaceholder.mockResolvedValue('thumbnails/thumb_placeholder.jpg');
  });

  afterEach(() => jest.clearAllMocks());

  it('keeps the thumbnail when only metadata extraction fails', async () => {
    ffmpeg.ffprobe = jest.fn((videoPath, cb) => cb(new Error('moov atom not found')));
    ffmpeg.mockImplementation(() => ({
      screenshots: jest.fn(function screenshots({ filename, folder }) {
        require('fs').writeFileSync(require('path').join(folder, filename), 'jpeg-bytes');
        return this;
      }),
      on(event, handler) {
        if (event === 'end') setImmediate(handler);
        return this;
      }
    }));

    const result = await processUploadedVideo('/tmp/video.mp4', 'thumbnails/thumb_video.jpg');

    expect(result.success).toBe(true);
    expect(result.metadata).toBeNull();
    expect(result.thumbnailKey).toBe('thumbnails/thumb_video.jpg');
    expect(result.placeholder).toBe(false);
    expect(result.thumbnailError).toBeNull();
    // A real thumbnail already succeeded — never touch the placeholder path.
    expect(generateVideoPlaceholder).not.toHaveBeenCalled();
  });

  it('falls back to the SVG placeholder when thumbnail generation fails, so the gallery never falls back to rendering the raw video as an <img> (codex review)', async () => {
    ffmpeg.ffprobe = jest.fn((videoPath, cb) => {
      cb(null, {
        streams: [{ codec_type: 'video', width: 1080, height: 1920, codec_name: 'h264' }],
        format: { duration: 5.4 }
      });
    });
    ffmpeg.mockImplementation(() => ({
      screenshots() { return this; },
      on(event, handler) {
        if (event === 'error') setImmediate(() => handler(new Error('ffmpeg seek failed')));
        return this;
      }
    }));

    // The placeholder lands under the SAME key a real frame would have — the
    // filename derivation below exists for that — so "is this the
    // placeholder" cannot be read off the key. Pinned here because the first
    // cut of the flag compared keys and never fired on a real install.
    generateVideoPlaceholder.mockResolvedValue('thumbnails/thumb_wedding_001.jpg');

    const result = await processUploadedVideo('/tmp/video.mp4', 'thumbnails/thumb_wedding_001.jpg');

    expect(result.success).toBe(true);
    expect(result.metadata).toEqual(expect.objectContaining({ duration: 5, videoCodec: 'h264' }));
    // thumbnailKey is always thumbnails/thumb_<name>.jpg — strip the prefix
    // back to a filename so generateVideoPlaceholder recomputes the same key.
    // Explicit width/height so generateVideoPlaceholder skips its DB-backed
    // settings lookup — this can run inside an open per-file SQLite
    // transaction (chunked video upload), where that lookup deadlocks.
    expect(generateVideoPlaceholder).toHaveBeenCalledWith('wedding_001.jpg', { width: 300, height: 300 });
    expect(result.thumbnailKey).toBe('thumbnails/thumb_wedding_001.jpg');
    expect(storage.putFromFile).not.toHaveBeenCalled();
    // Says so, with the reason, so the caller can note it on the row
    // (issue 1430, item 6).
    expect(result.placeholder).toBe(true);
    expect(result.thumbnailError).toBe('ffmpeg seek failed');
  });

  it('in strict mode throws instead of writing the placeholder when no frame is taken', async () => {
    ffmpeg.ffprobe = jest.fn((videoPath, cb) => {
      cb(null, { streams: [{ codec_type: 'video', width: 1080, height: 1920, codec_name: 'h264' }], format: { duration: 5.4 } });
    });
    ffmpeg.mockImplementation(() => ({
      screenshots() { return this; },
      on(event, handler) {
        if (event === 'error') setImmediate(() => handler(new Error('ffmpeg seek failed')));
        return this;
      }
    }));

    await expect(processUploadedVideo('/tmp/video.mp4', 'thumbnails/thumb_wedding_001.jpg', { strict: true }))
      .rejects.toThrow('ffmpeg seek failed');
    expect(generateVideoPlaceholder).not.toHaveBeenCalled();
    expect(storage.putFromFile).not.toHaveBeenCalled();
  });

  it('throws when metadata, thumbnail generation, AND the placeholder all fail, so the caller surfaces a retryable failure instead of completing with nothing to show (codex review)', async () => {
    ffmpeg.ffprobe = jest.fn((videoPath, cb) => cb(new Error('Invalid data found when processing input')));
    ffmpeg.mockImplementation(() => ({
      screenshots() { return this; },
      on(event, handler) {
        if (event === 'error') setImmediate(() => handler(new Error('ffmpeg seek failed')));
        return this;
      }
    }));
    generateVideoPlaceholder.mockRejectedValue(new Error('sharp render failed'));

    await expect(processUploadedVideo('/tmp/corrupt.mp4', 'thumbnails/thumb_corrupt.jpg'))
      .rejects.toThrow('Unable to generate any thumbnail');
  });
});

describe('portrait phone clips (issue 2263)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('stores the displayed size and the capture date as an ISO string', async () => {
    ffmpeg.ffprobe = jest.fn((videoPath, cb) => cb(null, {
      streams: [{ codec_type: 'video', width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] }],
      format: { duration: 3, tags: { creation_time: '2025-06-15T12:30:00.000000Z' } }
    }));

    const metadata = await extractVideoMetadata('/tmp/portrait.mov');

    expect(metadata).toEqual(expect.objectContaining({ width: 1080, height: 1920, capturedAt: '2025-06-15T12:30:00.000Z' }));
  });

  it('has no capture date when the container carries none', async () => {
    ffmpeg.ffprobe = jest.fn((videoPath, cb) => cb(null, {
      streams: [{ codec_type: 'video', width: 1920, height: 1080 }], format: { duration: 3 }
    }));

    expect((await extractVideoMetadata('/tmp/landscape.mp4')).capturedAt).toBeNull();
  });

  it('fits the poster frame inside the box instead of squashing it into a square', async () => {
    const mediaProcesses = require('../mediaProcessService');
    const run = jest.spyOn(mediaProcesses, 'run').mockImplementation(async (_command, args) => {
      require('fs').writeFileSync(args[args.length - 1], 'jpeg-bytes');
      return { stdout: Buffer.alloc(0) };
    });
    getStorage.mockReturnValue({ putFromFile: jest.fn().mockResolvedValue(undefined) });
    const { generateVideoThumbnail } = require('../videoProcessor');

    await generateVideoThumbnail('/tmp/portrait.mov', 'thumbnails/thumb_portrait.jpg');
    await generateVideoThumbnail('/tmp/portrait.mov', 'thumbnails/thumb_portrait.jpg', { size: '640x480' });

    const filters = run.mock.calls.map(([, args]) => args[args.indexOf('-vf') + 1]);
    expect(filters).toEqual([
      'scale=w=300:h=300:force_original_aspect_ratio=decrease',
      'scale=w=640:h=480:force_original_aspect_ratio=decrease',
    ]);
    // The size check still stands in front of the filter string.
    await expect(generateVideoThumbnail('/tmp/portrait.mov', 'thumbnails/thumb_portrait.jpg', { size: '300:300,crop' }))
      .rejects.toThrow('Invalid video thumbnail size');
  });
});

describe('the preview image an admin picks (issue 2263, item 4)', () => {
  const { posterCandidateOffsets, posterSeekSeconds, generateVideoThumbnail, generatePosterCandidates } = require('../videoProcessor');
  const mediaProcesses = require('../mediaProcessService');
  const seeks = run => run.mock.calls.map(([, args]) => args[args.indexOf('-ss') + 1]);
  // ffmpeg as it behaves: a seek at or past the end writes no file.
  const ffmpegFor = length => jest.spyOn(mediaProcesses, 'run').mockImplementation(async (_command, args) => {
    if (Number(args[args.indexOf('-ss') + 1]) < length) require('fs').writeFileSync(args[args.length - 1], 'jpeg-bytes');
    return { stdout: Buffer.alloc(0) };
  });

  afterEach(() => jest.restoreAllMocks());

  it('offers frames at 10%, 50% and 90% of the clip', () => {
    expect(posterCandidateOffsets(10)).toEqual([1, 5, 9]);
    expect(posterCandidateOffsets(0.5)).toEqual([0.05, 0.25, 0.45]);
    expect(posterCandidateOffsets(12.345)).toEqual([1.235, 6.173, 11.111]);
  });

  it('falls back to the first frame, the default one and 3 s in without a duration', () => {
    expect(posterCandidateOffsets(null)).toEqual([0, 1, 3]);
    expect(posterCandidateOffsets(0)).toEqual([0, 1, 3]);
    expect(posterCandidateOffsets('n/a')).toEqual([0, 1, 3]);
  });

  it('seeks to the picked frame, the default 1 s without one, and stays inside a short clip', () => {
    expect(posterSeekSeconds(4.5, 10)).toBe(4.5);
    expect(posterSeekSeconds(null, 10)).toBe(1);
    expect(posterSeekSeconds(undefined, undefined)).toBe(1);
    expect(posterSeekSeconds(null, 0.5)).toBe(0.25);
    expect(posterSeekSeconds(12, 10)).toBe(5);
    expect(posterSeekSeconds(0, 10)).toBe(0);
  });

  it('gives a clip shorter than a second a real poster frame instead of none', async () => {
    const run = ffmpegFor(0.5);
    mediaProcesses.probeSnapshot.mockResolvedValueOnce({ format: { duration: '0.5' } });
    getStorage.mockReturnValue({ putFromFile: jest.fn().mockResolvedValue(undefined) });

    await expect(generateVideoThumbnail('/tmp/short.mp4', 'thumbnails/thumb_short.jpg')).resolves.toBe('thumbnails/thumb_short.jpg');
    expect(seeks(run)).toEqual(['0.25']);
  });

  it('takes the poster at the stored offset', async () => {
    const run = ffmpegFor(10);
    mediaProcesses.probeSnapshot.mockResolvedValueOnce({ format: { duration: '10' } });
    getStorage.mockReturnValue({ putFromFile: jest.fn().mockResolvedValue(undefined) });

    await generateVideoThumbnail('/tmp/clip.mp4', 'thumbnails/thumb_clip.jpg', { offsetSeconds: 7.25 });
    expect(seeks(run)).toEqual(['7.25']);
  });

  it('renders the three candidates from one snapshot as small JPEGs, and leaves out a frame past the end', async () => {
    const snapshot = jest.spyOn(mediaProcesses, 'withSnapshot');
    let run = ffmpegFor(10);
    mediaProcesses.probeSnapshot.mockResolvedValueOnce({ format: { duration: '10' } });

    const result = await generatePosterCandidates('/tmp/clip.mp4', { duration: 10 });
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(result.duration).toBe(10);
    expect(result.candidates.map(c => c.offsetSeconds)).toEqual([1, 5, 9]);
    expect(result.candidates[0].jpeg.toString()).toBe('jpeg-bytes');
    expect(run.mock.calls[0][1]).toContain('scale=w=320:h=320:force_original_aspect_ratio=decrease');

    // No duration from ffprobe or the row: 3 s in lies past a 2 s clip.
    jest.restoreAllMocks();
    run = ffmpegFor(2);
    mediaProcesses.probeSnapshot.mockRejectedValueOnce(new Error('moov atom not found'));
    const unknown = await generatePosterCandidates('/tmp/clip.mp4', { duration: null });
    expect(seeks(run)).toEqual(['0', '1', '3']);
    expect(unknown.candidates.map(c => c.offsetSeconds)).toEqual([0, 1]);
  });
});
