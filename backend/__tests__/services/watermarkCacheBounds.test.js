/**
 * The watermark result cache stays bounded.
 *
 * On object storage every render goes through withLocalCopy, which copies the
 * source to a fresh random temp path and removes it afterwards. Keyed on that
 * path, each render left an entry nothing could ever hit again, held until
 * the one-hour sweep. Such copies are no longer cached, and the cache keeps at
 * most cacheMaxEntries results and cacheMaxBytes bytes, least recently used
 * first out.
 */
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const sharp = require('sharp');

jest.mock('../../src/database/db', () => {
  const api = (table) => {
    if (table === 'app_settings') {
      return { where: () => ({ whereIn: () => [], first: async () => null }), whereIn: () => ({ select: async () => [] }) };
    }
    return { where: () => ({ first: async () => null }) };
  };
  return { db: api };
});

const mockSource = { file: null };
jest.mock('../../src/services/storage', () => {
  const storage = {
    kind: () => 's3',
    getToFile: async (_key, dest) => {
      // eslint-disable-next-line global-require
      await require('fs').promises.copyFile(mockSource.file, dest);
    },
  };
  return { getStorage: () => storage, initStorage: async () => storage };
});

const watermarkService = require('../../src/services/watermarkService');
const { withLocalCopy, isLocalCopyPath } = require('../../src/services/imageProcessor');

const settings = {
  enabled: true, logoPath: null, position: 'bottom-right', opacity: 50, size: 15, companyName: 'Studio',
};

describe('watermark cache bounds', () => {
  let tmpDir;
  const photos = [];

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-wmcache-'));
    for (let i = 0; i < 5; i += 1) {
      const file = path.join(tmpDir, `photo-${i}.jpg`);
      await sharp({ create: { width: 200, height: 120, channels: 3, background: { r: 40 * i, g: 90, b: 60 } } })
        .jpeg().toFile(file);
      photos.push(file);
    }
    [mockSource.file] = photos;
  });
  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    watermarkService.clearCache();
    watermarkService.cacheMaxEntries = 256;
    watermarkService.cacheMaxBytes = 256 * 1024 * 1024;
  });

  it('recognises withLocalCopy paths and nothing else', async () => {
    let copyPath = null;
    await withLocalCopy('events/active/x/photo.jpg', async (p) => { copyPath = p; });
    expect(isLocalCopyPath(copyPath)).toBe(true);
    expect(isLocalCopyPath(photos[0])).toBe(false);
    expect(isLocalCopyPath(path.join(os.tmpdir(), '..', 'picpeak-src-x', 'a.jpg'))).toBe(false);
    expect(isLocalCopyPath(null)).toBe(false);
  });

  it('does not cache renders of object-storage copies', async () => {
    for (let i = 0; i < 4; i += 1) {
      const out = await withLocalCopy('events/active/x/photo.jpg',
        (p) => watermarkService.applyWatermark(p, settings, { failClosed: true }));
      expect(Buffer.isBuffer(out)).toBe(true);
    }
    expect(watermarkService.cache.size).toBe(0);
    expect(watermarkService.cacheBytes).toBe(0);
  });

  it('still reuses the result for a stable path', async () => {
    const first = await watermarkService.applyWatermark(photos[0], settings, { failClosed: true });
    const second = await watermarkService.applyWatermark(photos[0], settings, { failClosed: true });
    expect(second).toBe(first);
    expect(watermarkService.cache.size).toBe(1);
  });

  it('evicts the least recently used entry past the entry ceiling', async () => {
    watermarkService.cacheMaxEntries = 3;
    for (const photo of photos.slice(0, 3)) await watermarkService.applyWatermark(photo, settings);
    // Touch the oldest, so the second is now least recently used.
    await watermarkService.applyWatermark(photos[0], settings);
    await watermarkService.applyWatermark(photos[3], settings);
    expect(watermarkService.cache.size).toBe(3);
    const keys = [...watermarkService.cache.keys()];
    expect(keys.some((k) => k.startsWith(`${photos[0]}_`))).toBe(true);
    expect(keys.some((k) => k.startsWith(`${photos[1]}_`))).toBe(false);
  });

  it('keeps the cached bytes within the byte ceiling', async () => {
    const one = await watermarkService.applyWatermark(photos[0], settings);
    watermarkService.clearCache();
    watermarkService.cacheMaxBytes = one.length * 2 + 1;
    for (const photo of photos) {
      await watermarkService.applyWatermark(photo, settings);
      expect(watermarkService.cacheBytes).toBeLessThanOrEqual(watermarkService.cacheMaxBytes);
      const total = [...watermarkService.cache.values()].reduce((n, e) => n + e.buffer.length, 0);
      expect(total).toBe(watermarkService.cacheBytes);
    }
    expect(watermarkService.cache.size).toBeGreaterThan(0);
    expect(watermarkService.cache.size).toBeLessThan(photos.length);
  });
});
