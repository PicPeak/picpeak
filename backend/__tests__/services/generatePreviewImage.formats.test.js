/**
 * The preview tier must not destroy what it is previewing.
 *
 * generatePreviewImage encoded JPEG unconditionally. JPEG has no alpha channel
 * and no second frame, so a transparent PNG came back flattened onto a solid
 * background and an animated GIF came back as its first frame — for every
 * consumer of this tier, not just the lightbox: the slideshow (#1015), admin
 * previews, and the face avatars that read it as a whole-frame rendition.
 *
 * Driven against real Sharp output, because the whole question is what is in
 * the encoded bytes.
 */

const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const sharp = require('sharp');

const LocalFsStorage = require('../../src/services/storage/LocalFsStorage');
const storageModule = require('../../src/services/storage');

/** A 2x2 GIF89a with two frames and a NETSCAPE loop block. */
const ANIMATED_GIF = Buffer.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
  0x02, 0x00, 0x02, 0x00,
  0xF0, 0x00, 0x00,
  0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF,
  0x21, 0xFF, 0x0B, 0x4E, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45,
  0x32, 0x2E, 0x30, 0x03, 0x01, 0x00, 0x00, 0x00,
  0x21, 0xF9, 0x04, 0x00, 0x0A, 0x00, 0x00, 0x00,
  0x2C, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x02, 0x00, 0x00,
  0x02, 0x02, 0x44, 0x01, 0x00,
  0x21, 0xF9, 0x04, 0x00, 0x0A, 0x00, 0x00, 0x00,
  0x2C, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x02, 0x00, 0x00,
  0x02, 0x02, 0x4C, 0x01, 0x00,
  0x3B,
]);

// No width-tier case here: the responsive `?w=` renditions (#1095) are
// main-only, so this branch has a single canonical preview per photo.
describe('generatePreviewImage encodes for the source (#1166 follow-up)', () => {
  let storage; let storageRoot; let srcDir; let imageProcessor;

  beforeAll(async () => {
    storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-prevfmt-store-'));
    srcDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-prevfmt-src-'));
    storage = new LocalFsStorage({ root: storageRoot });
    await storage.init();
    storageModule.setStorageForTesting(storage);

    delete require.cache[require.resolve('../../src/services/imageProcessor')];
    imageProcessor = require('../../src/services/imageProcessor');
  }, 30000);

  afterAll(async () => {
    storageModule.resetStorage();
    await fs.rm(storageRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(srcDir, { recursive: true, force: true }).catch(() => {});
  });

  const outMeta = async (key) => sharp(storage.resolveLocalPath(key)).metadata();

  it('keeps transparency, as WebP, for a PNG with alpha', async () => {
    const src = path.join(srcDir, 'logo.png');
    await sharp({
      create: { width: 800, height: 600, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).png().toFile(src);

    const key = await imageProcessor.generatePreviewImage(src, { regenerate: true });

    expect(key).toBe('previews/preview_logo.webp');
    const meta = await outMeta(key);
    expect(meta.format).toBe('webp');
    // The regression, stated directly: JPEG would have flattened this.
    expect(meta.hasAlpha).toBe(true);
  });

  it('keeps every frame, as WebP, for an animated GIF', async () => {
    const src = path.join(srcDir, 'wave.gif');
    // Hand-assembled rather than produced by Sharp: writing a multi-page image
    // needs pageHeight threaded through the pipeline, and a fixture that
    // silently comes out single-page would make this test pass for the wrong
    // reason. 2x2, two frames, black then white.
    await fs.writeFile(src, ANIMATED_GIF);
    // Precondition: the fixture really is animated.
    expect((await sharp(src, { animated: true }).metadata()).pages).toBe(2);

    const key = await imageProcessor.generatePreviewImage(src, { regenerate: true });

    expect(key).toBe('previews/preview_wave.webp');
    const meta = await sharp(storage.resolveLocalPath(key), { animated: true }).metadata();
    expect(meta.format).toBe('webp');
    // The regression, stated directly: JPEG kept only the first frame.
    expect(meta.pages).toBe(2);
  });

  it('still writes plain JPEG for an ordinary photo', async () => {
    // The common path must not pay for the two cases above: JPEG is smaller
    // than WebP at the quality this tier uses, and every existing preview is
    // one.
    const src = path.join(srcDir, 'shot.jpg');
    await sharp({ create: { width: 2400, height: 1600, channels: 3, background: { r: 90, g: 90, b: 90 } } })
      .jpeg().toFile(src);

    const key = await imageProcessor.generatePreviewImage(src, { regenerate: true });

    expect(key).toBe('previews/preview_shot.jpg');
    const meta = await outMeta(key);
    expect(meta.format).toBe('jpeg');
    // 2400x1600 capped at the 1920 long edge, aspect preserved — unchanged.
    expect([meta.width, meta.height]).toEqual([1920, 1280]);
  });

  it('names the output for what it wrote, not for the source', async () => {
    // A PNG source used to produce `preview_x.png` holding JPEG bytes. Harmless
    // while the route hard-coded image/jpeg; wrong once the encoding varies,
    // and the route now reads the extension.
    const src = path.join(srcDir, 'opaque.png');
    await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .png().toFile(src);

    const key = await imageProcessor.generatePreviewImage(src, { regenerate: true });

    expect(key).toBe('previews/preview_opaque.jpg');
    expect((await outMeta(key)).format).toBe('jpeg');
  });

  it('returns null on an unreadable source instead of throwing', async () => {
    const src = path.join(srcDir, 'not-an-image.jpg');
    await fs.writeFile(src, 'plain text');

    await expect(imageProcessor.generatePreviewImage(src, { regenerate: true })).resolves.toBeNull();
  });
});
