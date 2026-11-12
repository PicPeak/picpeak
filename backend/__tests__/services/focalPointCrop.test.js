/**
 * Content-aware cropping (issue 2377): the focal point sharp's attention
 * strategy finds, and the cover crop that follows it.
 *
 * Synthetic photos: a flat grey field with one saturated red subject off
 * centre. Pins:
 *  - detection puts the point on the subject's side, in oriented coordinates,
 *    square sources included; a field with nothing in it has no point
 *  - a cover thumbnail keeps the subject when cut around the point, and loses
 *    it at the centre; no point keeps today's centre crop byte for byte
 *  - `meta` without `focal` detects and hands the point back; a given point
 *    (manual or stored) is used as is and nothing is detected
 *  - the crop window keeps the point inside at the same fraction (the reason
 *    one object-position fits every rendition), and never enlarges
 */

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const sharp = require('sharp');

jest.mock('../../src/database/db', () => {
  const api = (table) => {
    if (table === 'app_settings') {
      return { where: () => ({ whereIn: () => [], first: async () => null }), whereIn: async () => [] };
    }
    return { where: () => ({ first: async () => null, update: async () => 1 }) };
  };
  return { db: api };
});

const LocalFsStorage = require('../../src/services/storage/LocalFsStorage');
const storageModule = require('../../src/services/storage');
const { focalCoverWindow, focalQuery, focalPointOf, normalizeFocalPoint } = require('../../src/utils/focalPoint');

const COVER = { width: 300, height: 300, fit: 'cover', quality: 85, format: 'jpeg' };
const INSIDE = { ...COVER, fit: 'inside' };

let tmpDir;
let storageRoot;
let imageProcessor;

// Mean red-minus-green of an image: high where the red subject is.
async function redness(buffer) {
  const { channels } = await sharp(buffer).stats();
  return channels[0].mean - channels[1].mean;
}

async function photo(name, { width, height, left, top, size = 120, orientation }) {
  const subject = await sharp({ create: { width: size, height: size, channels: 3, background: { r: 230, g: 20, b: 20 } } }).png().toBuffer();
  let image = sharp({ create: { width, height, channels: 3, background: { r: 128, g: 128, b: 128 } } })
    .composite([{ input: subject, left, top }]);
  if (orientation) image = sharp(await image.jpeg().toBuffer()).withMetadata({ orientation });
  const file = path.join(tmpDir, name);
  await image.jpeg({ quality: 95 }).toFile(file);
  return file;
}

const thumbnailBytes = async (key) => fs.readFile(path.join(storageRoot, key));

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-focal-'));
  storageRoot = path.join(tmpDir, 'storage');
  await fs.mkdir(storageRoot, { recursive: true });
  process.env.STORAGE_PATH = storageRoot;
  const storage = new LocalFsStorage({ root: storageRoot });
  await storage.init();
  storageModule.setStorageForTesting(storage);
  delete require.cache[require.resolve('../../src/services/imageProcessor')];
  imageProcessor = require('../../src/services/imageProcessor');
}, 60000);

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe('detectFocalPoint', () => {
  test('finds a subject near the right edge of a landscape photo', async () => {
    // Subject centred at (840, 300) of 1200x600: x 0.7, y 0.5.
    const file = await photo('right.jpg', { width: 1200, height: 600, left: 780, top: 240 });
    const point = await imageProcessor.detectFocalPoint(file);
    expect(point.x).toBeGreaterThan(0.6);
    expect(point.x).toBeLessThan(0.8);
    expect(Math.abs(point.y - 0.5)).toBeLessThan(0.15);
  });

  test('finds a subject near the top of a portrait photo', async () => {
    const file = await photo('top.jpg', { width: 600, height: 1200, left: 240, top: 120 });
    const point = await imageProcessor.detectFocalPoint(file);
    expect(point.y).toBeLessThan(0.3);
    expect(Math.abs(point.x - 0.5)).toBeLessThan(0.15);
  });

  test('a square source still gets a point', async () => {
    const file = await photo('square.jpg', { width: 800, height: 800, left: 600, top: 340 });
    const point = await imageProcessor.detectFocalPoint(file);
    expect(point.x).toBeGreaterThan(0.6);
  });

  test('reads the photo as displayed: EXIF orientation applies first', async () => {
    // Stored 1200x600 with the subject on the right; Orientation 6 turns it
    // 90° clockwise, so it displays 600x1200 with the subject at the bottom.
    const file = await photo('turned.jpg', { width: 1200, height: 600, left: 960, top: 240, orientation: 6 });
    const point = await imageProcessor.detectFocalPoint(file);
    expect(point.y).toBeGreaterThan(0.7);
    expect(Math.abs(point.x - 0.5)).toBeLessThan(0.15);
  });

  test('a field with nothing in it has no point, and an unreadable file does not throw', async () => {
    const flat = path.join(tmpDir, 'flat.jpg');
    await sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 128, g: 128, b: 128 } } }).jpeg().toFile(flat);
    expect(await imageProcessor.detectFocalPoint(flat)).toBeNull();
    const broken = path.join(tmpDir, 'broken.jpg');
    await fs.writeFile(broken, 'not an image');
    await expect(imageProcessor.detectFocalPoint(broken)).resolves.toBeNull();
  });
});

describe('generateThumbnail with a focal point', () => {
  let source;
  beforeAll(async () => {
    // Subject at the far right of a 2:1 photo: a centred square misses it.
    source = await photo('edge.jpg', { width: 1200, height: 600, left: 940, top: 180, size: 240 });
  });

  test('a cover crop around the point keeps the subject the centre crop cuts off', async () => {
    const centred = await imageProcessor.generateThumbnail(source, { outputBasename: 'centre.jpg', settings: COVER, focal: null });
    const focused = await imageProcessor.generateThumbnail(source, { outputBasename: 'focus.jpg', settings: COVER, focal: { x: 0.9, y: 0.5 } });
    expect(await redness(await thumbnailBytes(centred))).toBeLessThan(5);
    expect(await redness(await thumbnailBytes(focused))).toBeGreaterThan(20);
    const { width, height } = await sharp(await thumbnailBytes(focused)).metadata();
    expect([width, height]).toEqual([300, 300]);
  });

  test('responsive tiers are cut around the same point', async () => {
    const tier = await imageProcessor.generateThumbnail(source, {
      outputBasename: 'tier.jpg', settings: COVER, width: 600, height: 600, focal: { x: 0.9, y: 0.5 },
    });
    expect(path.basename(tier)).toBe('thumb_w600_tier.jpg');
    // withoutEnlargement: 600 fits the 600px-high source exactly.
    expect(await redness(await thumbnailBytes(tier))).toBeGreaterThan(20);
  });

  test('no point is the centre crop, byte for byte', async () => {
    const before = await imageProcessor.generateThumbnail(source, { outputBasename: 'a.jpg', settings: COVER, focal: null });
    const bytes = await thumbnailBytes(before);
    const expected = await sharp(source, { failOn: 'none' }).rotate()
      .resize(300, 300, { withoutEnlargement: true, fit: 'cover', position: 'center' })
      .jpeg({ quality: 85, progressive: true, mozjpeg: true }).toBuffer();
    expect(bytes.equals(expected)).toBe(true);
  });

  test('`meta` without a point detects one, uses it, and hands it back', async () => {
    const meta = {};
    const key = await imageProcessor.generateThumbnail(source, { outputBasename: 'detect.jpg', settings: COVER, meta });
    expect(meta.focal.x).toBeGreaterThan(0.75);
    expect(await redness(await thumbnailBytes(key))).toBeGreaterThan(20);
  });

  test('a given point wins over detection: nothing is detected', async () => {
    const meta = {};
    const key = await imageProcessor.generateThumbnail(source, { outputBasename: 'manual.jpg', settings: COVER, meta, focal: { x: 0, y: 0.5 } });
    expect(meta).not.toHaveProperty('focal');
    // Cut at the left edge, as the admin asked, though the subject is right.
    expect(await redness(await thumbnailBytes(key))).toBeLessThan(5);
  });

  test('fit inside keeps the whole frame, point or not', async () => {
    const key = await imageProcessor.generateThumbnail(source, { outputBasename: 'inside.jpg', settings: INSIDE, focal: { x: 0.9, y: 0.5 } });
    const { width, height } = await sharp(await thumbnailBytes(key)).metadata();
    expect([width, height]).toEqual([300, 150]);
  });
});

describe('focalCoverWindow', () => {
  test('keeps the point inside, at the same fraction of the window', () => {
    for (const x of [0, 0.1, 0.5, 0.83, 1]) {
      const w = focalCoverWindow(1200, 600, 300, 300, { x, y: 0.5 });
      expect(w).toMatchObject({ top: 0, width: 600, height: 600 });
      expect(x * 1200).toBeGreaterThanOrEqual(w.left);
      expect(x * 1200).toBeLessThanOrEqual(w.left + w.width);
      expect((x * 1200 - w.left) / w.width).toBeCloseTo(x, 2);
    }
  });

  test('portrait sources slide vertically, other box shapes keep their ratio', () => {
    expect(focalCoverWindow(600, 1200, 300, 300, { x: 0.5, y: 0.25 })).toEqual({ left: 0, top: 150, width: 600, height: 600 });
    expect(focalCoverWindow(1200, 600, 400, 300, { x: 1, y: 0 })).toEqual({ left: 400, top: 0, width: 800, height: 600 });
  });

  test('nothing to place without a point', () => {
    expect(focalCoverWindow(1200, 600, 300, 300, null)).toBeNull();
  });

  test('a box larger than the source: the piece sharp keeps, placed at the point', () => {
    // sharp never enlarges here: 1200x600 into 900x900 keeps a 900x600 piece.
    expect(focalCoverWindow(1200, 600, 900, 900, { x: 0.9, y: 0.5 })).toEqual({ left: 270, top: 0, width: 900, height: 600 });
    expect(focalCoverWindow(600, 1200, 900, 900, { x: 0.5, y: 1 })).toEqual({ left: 0, top: 300, width: 600, height: 900 });
    expect(focalCoverWindow(200, 100, 300, 300, { x: 1, y: 1 })).toEqual({ left: 0, top: 0, width: 200, height: 100 });
  });
});

describe('focal point values', () => {
  test('rows: both columns or none, fractions only', () => {
    expect(focalPointOf({ focal_x: 0.25, focal_y: 0.75 })).toEqual({ x: 0.25, y: 0.75 });
    expect(focalPointOf({ focal_x: 0.25, focal_y: null })).toBeNull();
    expect(focalPointOf({ focal_x: 1.5, focal_y: 0.5 })).toBeNull();
    expect(normalizeFocalPoint({ x: 0.12345, y: 1 })).toEqual({ x: 0.123, y: 1 });
    expect(normalizeFocalPoint({ x: '0.5', y: 0.5 })).toBeNull();
  });

  test('the URL names the point, and nothing without one', () => {
    expect(focalQuery({ focal_x: 0.9, focal_y: 0.5 })).toBe('fp=900-500');
    expect(focalQuery({ focal_x: null, focal_y: null })).toBe('');
  });
});
