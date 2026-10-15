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
    await require('../../src/services/isolatedSharp').shutdown();
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

  // withMetadata() used to transform to sRGB explicitly. sharp's implicit
  // conversion processes a profiled 16-bit source in P3 and relabels the
  // result as sRGB (red 180 came out as 169); the explicit transform, applied
  // to an UNtagged 16-bit source, assumes P3 and shifts it the other way
  // (180 came out as 192).
  describe.each([
    ['profiled', 'srgb'],
    ['untagged', null],
  ])('a %s 16-bit source keeps its colour', (label, profile) => {
    let src16;
    beforeAll(async () => {
      src16 = path.join(tmpDir, `deep-${label}.png`);
      let img = sharp({ create: { width: 400, height: 200, channels: 3, background: { r: 180, g: 99, b: 59 } } }).toColourspace('rgb16');
      if (profile) img = img.withIccProfile(profile);
      await img.png().toFile(src16);
      const m = await sharp(src16).metadata();
      expect(m.depth).toBe('ushort');
      expect(m.hasProfile).toBe(Boolean(profile));
    });

    const expectColour = async (rel) => {
      const file = path.join(storageRoot, rel);
      const m = await sharp(file).metadata();
      expect(m.icc).toBeUndefined();
      expect(m.exif).toBeUndefined();
      const { data } = await sharp(file).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
      const [r, g, b] = data;
      expect(Math.abs(r - 180)).toBeLessThanOrEqual(3);
      expect(Math.abs(g - 99)).toBeLessThanOrEqual(3);
      expect(Math.abs(b - 59)).toBeLessThanOrEqual(3);
    };

    test('thumbnail', async () => {
      await expectColour(await imageProcessor.generateThumbnail(src16, { outputBasename: `t-${label}.jpg`, regenerate: true }));
    });
    test('preview', async () => {
      await expectColour(await imageProcessor.generatePreviewImage(src16, { outputBasename: `p-${label}.jpg` }));
    });
    test('hero', async () => {
      await expectColour(await imageProcessor.generateHeroImage(src16, { outputBasename: `h-${label}.jpg`, regenerate: true }));
    });
  });

  // An animated preview is not rotated (that would flatten it), so the
  // Orientation tag is the only hint left and must survive on its own.
  test('an animated preview keeps only its Orientation tag', async () => {
    const frame = (background) => sharp({ create: { width: 80, height: 40, channels: 3, background } }).png().toBuffer();
    const anim = path.join(tmpDir, 'anim.webp');
    await sharp([await frame('#f00'), await frame('#00f')], { join: { animated: true } })
      .withExif({ IFD0: { Make: 'SecretCam' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '52/1 30/1 0/1' } })
      .withMetadata({ orientation: 6 })
      .webp()
      .toFile(anim);

    const rel = await imageProcessor.generatePreviewImage(anim, { outputBasename: 'anim.webp' });
    expect(rel).toBeTruthy();
    const out = await sharp(path.join(storageRoot, rel)).metadata();
    expect(out.pages).toBe(2);
    expect(out.orientation).toBe(6);
    const raw = out.exif.toString('latin1');
    expect(raw).not.toContain('SecretCam');
    expect(raw).not.toContain('52/1');
    expect(out.xmp).toBeUndefined();
  });

  test('the image worker refuses a profile path or arbitrary EXIF', async () => {
    const isolated = require('../../src/services/isolatedSharp');
    await expect(isolated(src).withIccProfile(src).jpeg().toBuffer()).rejects.toThrow('Unsupported image operation');
    await expect(isolated(src).withExif({ IFD0: { Make: 'x' } }).jpeg().toBuffer()).rejects.toThrow('Unsupported image operation');
    await expect(isolated(src).withExif({ IFD0: { Orientation: '6' }, IFD3: {} }).jpeg().toBuffer()).rejects.toThrow('Unsupported image operation');
    await expect(isolated(src).withExif({ IFD0: { Orientation: ['6'] } }).jpeg().toBuffer()).rejects.toThrow('Unsupported image operation');
    await expect(isolated(src).withIccProfile('srgb').jpeg().toBuffer()).rejects.toThrow('Unsupported image operation');
    await expect(isolated(src).withIccProfile('srgb', { attach: true }).jpeg().toBuffer()).rejects.toThrow('Unsupported image operation');
    await expect(isolated(src).withExif({ IFD0: { Orientation: '6' } }).withIccProfile('srgb', { attach: false }).jpeg().toBuffer()).resolves.toBeTruthy();
  });
});
