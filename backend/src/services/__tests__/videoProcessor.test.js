jest.mock('../../utils/logger');
jest.mock('fluent-ffmpeg');
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
