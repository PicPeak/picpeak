/**
 * EXIF orientation in the gallery-facing generators (#1185).
 *
 * sharp decodes the pixels as stored, not as displayed. A photo whose
 * Orientation tag is not 1 — routine for portrait shots on bodies that tag
 * rather than rotate the sensor data — therefore resizes from the raw frame
 * and comes out sideways. The generators then call `.withMetadata(false)`,
 * which strips the tag from the output, so the browser has no hint left to
 * correct it either: nothing downstream can recover it.
 *
 * The download path (`resizeToBox`) always got this right. These three did
 * not, which is why the same photo looked correct on download and rotated in
 * the gallery.
 *
 * Every assertion here fails on the unfixed generators.
 */

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const sharp = require('sharp');

// imageProcessor reads its thumbnail settings from app_settings, so without a
// db the require() alone hangs the run. Same shape the other generator tests
// use (ensureHeroImage.external.test.js).
jest.mock('../../src/database/db', () => {
  const api = (table) => {
    if (table === 'app_settings') {
      return { where: () => ({ whereIn: () => [], first: async () => null }), whereIn: async () => [] };
    }
    if (table === 'events') return { where: () => ({ first: async () => null }) };
    if (table === 'photos') return { where: () => ({ update: async () => 1, first: async () => null }) };
    return { where: () => ({ first: async () => null }) };
  };
  return { db: api };
});

const LocalFsStorage = require('../../src/services/storage/LocalFsStorage');
const storageModule = require('../../src/services/storage');

describe('EXIF orientation in thumbnails, heroes and previews (#1185)', () => {
  let tmpDir;
  let imageProcessor;
  let landscapeTaggedPortrait;

  // 400x200 as stored, Orientation 6 (90° CW) — so it DISPLAYS as 200x400.
  // This is exactly the shape the reporter's Sony bodies produce: the sensor
  // data is landscape and the tag carries the rotation.
  const W = 400;
  const H = 200;

  let storageRoot;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-orient-'));
    storageRoot = path.join(tmpDir, 'storage');
    await fs.mkdir(storageRoot, { recursive: true });
    process.env.STORAGE_PATH = storageRoot;

    const storage = new LocalFsStorage({ root: storageRoot });
    await storage.init();
    storageModule.setStorageForTesting(storage);

    landscapeTaggedPortrait = path.join(tmpDir, 'portrait-tagged.jpg');
    await sharp({
      create: { width: W, height: H, channels: 3, background: { r: 120, g: 80, b: 40 } },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toFile(landscapeTaggedPortrait);

    delete require.cache[require.resolve('../../src/services/imageProcessor')];
    imageProcessor = require('../../src/services/imageProcessor');
  }, 60000);

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test('the fixture really is stored landscape with a rotation tag', async () => {
    const m = await sharp(landscapeTaggedPortrait).metadata();
    expect(m.width).toBe(W);
    expect(m.height).toBe(H);
    expect(m.orientation).toBe(6);
  });

  test('orientedDimensions reports what a viewer sees, not what is stored', async () => {
    const m = await sharp(landscapeTaggedPortrait).metadata();
    // Swapped: this is what the grid needs to size a tile, and what the
    // database should hold.
    expect(imageProcessor.orientedDimensions(m)).toEqual({ width: H, height: W });
  });

  test('orientedDimensions leaves an untagged image alone', async () => {
    const plain = path.join(tmpDir, 'plain.jpg');
    await sharp({ create: { width: W, height: H, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .jpeg().toFile(plain);
    const m = await sharp(plain).metadata();
    expect(imageProcessor.orientedDimensions(m)).toEqual({ width: W, height: H });
  });

  test('orientedDimensions survives metadata it cannot use', () => {
    expect(imageProcessor.orientedDimensions(null)).toEqual({ width: null, height: null });
    expect(imageProcessor.orientedDimensions({})).toEqual({ width: null, height: null });
  });

  test('the thumbnail comes out portrait, not sideways', async () => {
    const rel = await imageProcessor.generateThumbnail(landscapeTaggedPortrait, {
      outputBasename: 'orient-thumb.jpg',
      regenerate: true,
    });
    expect(rel).toBeTruthy();

    const out = await sharp(path.join(storageRoot, rel)).metadata();
    // Unfixed, this came back wider than tall — the raw frame, resized.
    expect(out.height).toBeGreaterThan(out.width);
  });

  test('the preview tier comes out portrait too', async () => {
    const rel = await imageProcessor.generatePreviewImage(landscapeTaggedPortrait, {
      outputBasename: 'orient-preview.jpg',
    });
    expect(rel).toBeTruthy();

    const out = await sharp(path.join(storageRoot, rel)).metadata();
    expect(out.height).toBeGreaterThan(out.width);
  });

  test('the watermarked rendition is oriented too', async () => {
    // gallery.js serves photos.watermark_path ahead of the original when
    // branding watermarking is on, so this is the rendition a guest actually
    // sees — and it went through its own sharp pipeline that nobody had
    // rotated.
    const watermarkService = require('../../src/services/watermarkService');
    const buf = await watermarkService.applyWatermark(landscapeTaggedPortrait, {
      enabled: true, position: 'bottom-right', opacity: 50, size: 15,
      // companyName, not text — the SVG branch reads this one, and without it
      // the service falls through without compositing anything.
      companyName: 'PicPeak',
    });
    expect(Buffer.isBuffer(buf)).toBe(true);

    const out = await sharp(buf).metadata();
    // 400x200 stored, tagged 6 — so the watermarked output must be portrait.
    expect(out.height).toBeGreaterThan(out.width);
  });

  test('the orientation tag is gone from the output, so nothing double-rotates', async () => {
    // The pixels are corrected now, so a surviving tag would make a viewer
    // rotate an already-rotated image. withMetadata(false) strips it; this
    // pins that the two changes agree.
    const rel = await imageProcessor.generateThumbnail(landscapeTaggedPortrait, {
      outputBasename: 'orient-thumb-tag.jpg',
      regenerate: true,
    });
    const out = await sharp(path.join(storageRoot, rel)).metadata();
    expect(out.orientation === undefined || out.orientation === 1).toBe(true);
  });
});
