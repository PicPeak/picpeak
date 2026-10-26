/**
 * A video poster rebuild that failed is not started again by the next tile
 * request (issue 2263): each try is a full source copy plus an ffmpeg run.
 * The queue waits out a cooldown per photo, and a success clears it.
 */

jest.mock('../../src/database/db', () => ({ db: jest.fn(() => { throw new Error('no db in this test'); }) }));
jest.mock('../../src/utils/logger', () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  queueVideoThumbnail, stopVideoThumbnailQueue, startVideoThumbnailQueue, VIDEO_THUMBNAIL_FAILURE_COOLDOWN_MS, VIDEO_THUMBNAIL_TRANSIENT_COOLDOWN_MS, VIDEO_THUMBNAIL_CONCURRENCY,
} = require('../../src/services/imageProcessor');

// defer() runs the build on setImmediate; this lets it and its settle finish.
const flush = () => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

describe('queueVideoThumbnail failure cooldown', () => {
  let clock;
  const now = () => clock;
  let nextId = 1000;

  beforeEach(() => { clock = 1_000_000; });

  it.each([
    ['rejects', () => Promise.reject(new Error('NoSuchKey'))],
    ['resolves without a poster', () => Promise.resolve(null)],
  ])('does not re-queue a rebuild that %s until the cooldown has passed', async (_label, outcome) => {
    const photo = { id: nextId++ };
    const build = jest.fn(outcome);

    expect(queueVideoThumbnail(photo, {}, { build, now })).toBe(true);
    await flush();
    expect(build).toHaveBeenCalledTimes(1);

    clock += VIDEO_THUMBNAIL_FAILURE_COOLDOWN_MS - 1;
    expect(queueVideoThumbnail(photo, {}, { build, now })).toBe(false);
    await flush();
    expect(build).toHaveBeenCalledTimes(1);

    clock += 1;
    expect(queueVideoThumbnail(photo, {}, { build, now })).toBe(true);
    await flush();
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('clears the failure once a rebuild succeeds', async () => {
    const photo = { id: nextId++ };
    const build = jest.fn().mockResolvedValueOnce(null).mockResolvedValue('thumbnails/thumb_clip.jpg');

    queueVideoThumbnail(photo, {}, { build, now });
    await flush();
    clock += VIDEO_THUMBNAIL_FAILURE_COOLDOWN_MS;
    queueVideoThumbnail(photo, {}, { build, now });
    await flush();
    expect(build).toHaveBeenCalledTimes(2);

    // Straight away, no cooldown: the success removed the entry.
    expect(queueVideoThumbnail(photo, {}, { build, now })).toBe(true);
    await flush();
    expect(build).toHaveBeenCalledTimes(3);
  });

  it('runs at most VIDEO_THUMBNAIL_CONCURRENCY builds at once, the rest in turn', async () => {
    const releases = [];
    const build = jest.fn(() => new Promise((resolve) => releases.push(() => resolve('thumbnails/thumb.jpg'))));
    const photos = Array.from({ length: VIDEO_THUMBNAIL_CONCURRENCY + 2 }, () => ({ id: nextId++ }));

    for (const photo of photos) expect(queueVideoThumbnail(photo, {}, { build, now })).toBe(true);
    await flush();
    expect(build).toHaveBeenCalledTimes(VIDEO_THUMBNAIL_CONCURRENCY);

    releases.shift()();
    await flush();
    expect(build).toHaveBeenCalledTimes(VIDEO_THUMBNAIL_CONCURRENCY + 1);

    while (releases.length) {
      releases.shift()();
      await flush();
    }
    expect(build).toHaveBeenCalledTimes(photos.length);
  });

  it('tries again soon after a refusal for capacity, which says nothing about the video', async () => {
    const photo = { id: nextId++ };
    const full = Object.assign(new Error('Media input staging capacity is full'), { code: 'MEDIA_QUEUE_FULL' });
    const build = jest.fn().mockRejectedValueOnce(full).mockResolvedValue('thumbnails/thumb_clip.jpg');

    queueVideoThumbnail(photo, {}, { build, now });
    await flush();
    expect(queueVideoThumbnail(photo, {}, { build, now })).toBe(false);
    clock += VIDEO_THUMBNAIL_TRANSIENT_COOLDOWN_MS;
    expect(queueVideoThumbnail(photo, {}, { build, now })).toBe(true);
    await flush();
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('starts nothing waiting, and queues nothing new, once stopped for shutdown', async () => {
    const releases = [];
    const build = jest.fn(() => new Promise((resolve) => releases.push(() => resolve('thumbnails/thumb.jpg'))));
    const photos = Array.from({ length: VIDEO_THUMBNAIL_CONCURRENCY + 1 }, () => ({ id: nextId++ }));
    for (const photo of photos) queueVideoThumbnail(photo, {}, { build, now });
    await flush();
    expect(build).toHaveBeenCalledTimes(VIDEO_THUMBNAIL_CONCURRENCY);

    stopVideoThumbnailQueue();
    try {
      expect(queueVideoThumbnail({ id: nextId++ }, {}, { build, now })).toBe(false);
      // The running builds finish; the waiting one never starts.
      while (releases.length) { releases.shift()(); await flush(); }
      expect(build).toHaveBeenCalledTimes(VIDEO_THUMBNAIL_CONCURRENCY);
    } finally {
      startVideoThumbnailQueue();
    }
    // Back after a restart, the dropped one can be queued again.
    expect(queueVideoThumbnail(photos[photos.length - 1], {}, { build, now })).toBe(true);
    await flush();
    releases.shift()();
    await flush();
  });

  it('keeps the cooldown per photo', async () => {
    const failing = { id: nextId++ };
    const other = { id: nextId++ };
    const build = jest.fn().mockResolvedValue(null);

    queueVideoThumbnail(failing, {}, { build, now });
    await flush();

    expect(queueVideoThumbnail(other, {}, { build, now })).toBe(true);
    expect(queueVideoThumbnail(failing, {}, { build, now })).toBe(false);
    await flush();
  });
});
