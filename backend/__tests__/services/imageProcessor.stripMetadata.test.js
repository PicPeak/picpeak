/**
 * Derived images must not carry the original's EXIF, GPS, XMP or IPTC.
 *
 * The generators used to call `.withMetadata(false)`, which in sharp 0.35
 * KEEPS the metadata. sharp's default output is already stripped, so the
 * calls were removed. Originals stay untouched on purpose (a download of the
 * original keeps its EXIF).
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

describe('derived images carry no EXIF or GPS', () => {
  let tmpDir;
  let storageRoot;
  let imageProcessor;
  let src;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-strip-'));
    storageRoot = path.join(tmpDir, 'storage');
    await fs.mkdir(storageRoot, { recursive: true });
    process.env.STORAGE_PATH = storageRoot;
    const storage = new LocalFsStorage({ root: storageRoot });
    await storage.init();
    storageModule.setStorageForTesting(storage);

    src = path.join(tmpDir, 'tagged.jpg');
    await sharp({ create: { width: 400, height: 200, channels: 3, background: { r: 120, g: 80, b: 40 } } })
      .withExif({
        IFD0: { Make: 'SecretCam', Copyright: 'Jane Doe' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '52/1 30/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '13/1 24/1 0/1' },
      })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toFile(src);

    delete require.cache[require.resolve('../../src/services/imageProcessor')];
    imageProcessor = require('../../src/services/imageProcessor');
  }, 60000);

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  const expectStripped = async (rel, { portrait = true } = {}) => {
    expect(rel).toBeTruthy();
    const out = await sharp(path.join(storageRoot, rel)).metadata();
    expect(out.exif).toBeUndefined();
    expect(out.xmp).toBeUndefined();
    expect(out.iptc).toBeUndefined();
    // Pixels were rotated before the tag went away. The hero is a fixed
    // landscape frame, so only the others can show it.
    if (portrait) expect(out.height).toBeGreaterThan(out.width);
  };

  test('the fixture carries GPS, Make and Copyright', async () => {
    const m = await sharp(src).metadata();
    expect(m.exif).toBeDefined();
    const raw = m.exif.toString('latin1');
    expect(raw).toContain('SecretCam');
    expect(raw).toContain('Jane Doe');
    expect(m.orientation).toBe(6);
  });

  test('thumbnail', async () => {
    await expectStripped(await imageProcessor.generateThumbnail(src, { outputBasename: 't.jpg', regenerate: true }));
  });

  test('preview', async () => {
    await expectStripped(await imageProcessor.generatePreviewImage(src, { outputBasename: 'p.jpg' }));
  });

  test('hero', async () => {
    await expectStripped(await imageProcessor.generateHeroImage(src, { outputBasename: 'h.jpg', regenerate: true }), { portrait: false });
  });
});
