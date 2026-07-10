/**
 * Unit tests for photoProcessor.processPhoto — the worker-mode entry
 * point that runs after a row has been claimed by the background
 * processor. Mocks every external dependency and validates the
 * happy-path DB updates and side-effect ordering.
 *
 * jest.mock factories are evaluated before any local variables exist,
 * so collaborators are kept inside the mock factories themselves and
 * the test reaches into them via require() once they're set up.
 */

const path = require('path');

jest.mock('../../src/database/db', () => {
  const recorded = { whereCalls: [], updateCalls: [] };
  let pendingWhere = null;
  const photosState = { row: null };
  const eventsState = { row: null };

  function makePhotoQuery() {
    return {
      where(args) {
        pendingWhere = args;
        recorded.whereCalls.push(args);
        return this;
      },
      async first() {
        return photosState.row;
      },
      async update(data) {
        recorded.updateCalls.push({ where: pendingWhere, data });
        return 1;
      },
    };
  }

  function makeEventsQuery() {
    return {
      where() {
        return this;
      },
      async first() {
        return eventsState.row;
      },
    };
  }

  function dbFn(table) {
    if (table === 'photos') return makePhotoQuery();
    if (table === 'events') return makeEventsQuery();
    throw new Error(`Unexpected table: ${table}`);
  }
  dbFn.client = { config: { client: 'pg' } };

  return {
    db: dbFn,
    __setPhoto: (row) => { photosState.row = row; },
    __setEvent: (row) => { eventsState.row = row; },
    __reset: () => {
      recorded.whereCalls = [];
      recorded.updateCalls = [];
      photosState.row = null;
      eventsState.row = null;
    },
    __recorded: () => recorded,
  };
});

jest.mock('../../src/services/imageProcessor', () => {
  const mockGenerateThumbnail = jest.fn();
  const mockExtractCaptureDate = jest.fn();
  return {
    generateThumbnail: mockGenerateThumbnail,
    extractCaptureDate: mockExtractCaptureDate,
    withLocalCopy: jest.fn(async (key, fn) =>
      fn(`/tmp/local-copy-${require('path').basename(key)}`)
    ),
  };
});

jest.mock('../../src/services/videoProcessor', () => ({
  processUploadedVideo: jest.fn(),
  isVideoMimeType: (mime) => typeof mime === 'string' && mime.startsWith('video/'),
}));

jest.mock('../../src/services/storage', () => ({ getStorage: jest.fn() }));

jest.mock('../../src/services/photoResolver', () => ({
  resolvePhotoStorageKey: jest.fn(
    (event, photo) => `events/active/${event.slug}/${photo.filename}`
  ),
}));

jest.mock('../../src/utils/filenameSanitizer', () => ({
  generatePhotoFilename: jest.fn(() => 'whatever.jpg'),
}));

jest.mock('../../src/services/watermarkGeneratorService', () => ({
  generateForPhoto: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/services/webhookService', () => ({
  fire: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../src/utils/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

// Stub sharp so we don't actually read any image off disk.
jest.mock('sharp', () => {
  const mock = jest.fn(() => ({
    metadata: jest.fn(async () => ({ width: 1920, height: 1080 })),
  }));
  return mock;
});

const dbModule = require('../../src/database/db');
const imageProcessor = require('../../src/services/imageProcessor');
const videoProcessor = require('../../src/services/videoProcessor');
const watermarkService = require('../../src/services/watermarkGeneratorService');
const webhookService = require('../../src/services/webhookService');

beforeEach(() => {
  dbModule.__reset();
  jest.clearAllMocks();
});

describe('photoProcessor.processPhoto', () => {
  it('marks an image complete with thumbnail and dimensions', async () => {
    dbModule.__setPhoto({
      id: 101,
      event_id: 5,
      filename: 'wedding-001.jpg',
      original_filename: 'IMG_0001.jpg',
      mime_type: 'image/jpeg',
      media_type: 'image',
      size_bytes: 12345,
      captured_at: null,
      processing_status: 'processing',
    });
    dbModule.__setEvent({ id: 5, slug: 'wedding', event_name: 'Wedding' });

    imageProcessor.extractCaptureDate.mockResolvedValueOnce('2026-04-25T12:00:00Z');
    imageProcessor.generateThumbnail.mockResolvedValueOnce('thumbnails/thumb_wedding-001.jpg');

    const { processPhoto } = require('../../src/services/photoProcessor');
    await processPhoto(101);

    const finalUpdate = dbModule.__recorded().updateCalls.pop();
    expect(finalUpdate.data.processing_status).toBe('complete');
    expect(finalUpdate.data.processing_error).toBeNull();
    expect(finalUpdate.data.thumbnail_path).toBe('thumbnails/thumb_wedding-001.jpg');
    expect(finalUpdate.data.width).toBe(1920);
    expect(finalUpdate.data.height).toBe(1080);
    expect(finalUpdate.data.captured_at).toBe('2026-04-25T12:00:00Z');

    expect(watermarkService.generateForPhoto).toHaveBeenCalledWith(101);
    expect(webhookService.fire).toHaveBeenCalledWith(
      'photo.uploaded',
      expect.objectContaining({
        event: expect.objectContaining({ slug: 'wedding' }),
        photo: expect.objectContaining({ id: 101, filename: 'wedding-001.jpg' }),
      })
    );
  });

  it('handles videos with ffmpeg metadata path', async () => {
    dbModule.__setPhoto({
      id: 202,
      event_id: 9,
      filename: 'wedding-video-001.mp4',
      original_filename: 'movie.mp4',
      mime_type: 'video/mp4',
      media_type: 'video',
      size_bytes: 99999,
      captured_at: null,
    });
    dbModule.__setEvent({ id: 9, slug: 'wedding', event_name: 'Wedding' });

    videoProcessor.processUploadedVideo.mockResolvedValueOnce({
      thumbnailKey: 'thumbnails/thumb_wedding-video-001.jpg',
      metadata: {
        duration: 12.5,
        videoCodec: 'h264',
        audioCodec: 'aac',
        width: 1280,
        height: 720,
      },
    });

    const { processPhoto } = require('../../src/services/photoProcessor');
    await processPhoto(202);

    const finalUpdate = dbModule.__recorded().updateCalls.pop();
    expect(finalUpdate.data.processing_status).toBe('complete');
    expect(finalUpdate.data.duration).toBe(12.5);
    expect(finalUpdate.data.video_codec).toBe('h264');
    expect(finalUpdate.data.thumbnail_path).toBe('thumbnails/thumb_wedding-video-001.jpg');

    // Watermark queue is image-only.
    expect(watermarkService.generateForPhoto).not.toHaveBeenCalled();
  });

  it('throws when the photo row no longer exists', async () => {
    dbModule.__setPhoto(null);
    dbModule.__setEvent({ id: 1 });
    const { processPhoto } = require('../../src/services/photoProcessor');
    await expect(processPhoto(999)).rejects.toThrow(/Photo 999 not found/);
  });
});

void path; // referenced indirectly via mocks
