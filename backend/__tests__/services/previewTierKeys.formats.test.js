/**
 * Preview tier lookup and cleanup must agree with what the generator writes
 * (#1020 follow-up).
 *
 * generatePreviewImage rewrites the extension to match the encoding (`.jpg`,
 * or `.webp` for alpha / multi-frame sources). ensurePreviewImageAtWidth and
 * previewTierKeys kept the SOURCE extension, so for a `.png`, `.JPG`, `.heic`
 * or RAW source the tier was generated on every single request — the stat
 * never matched — and cleanup never found the files, which piled up in
 * storage for the life of the install.
 *
 * Driven against real Sharp output, because the whole question is which
 * extension the encoder actually chose.
 */
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const sharp = require('sharp');

jest.mock('../../src/database/db', () => {
  const state = { event: null };
  const api = (table) => {
    if (table === 'events') return { where: () => ({ first: async () => state.event }) };
    if (table === 'photos') return { where: () => ({ update: async () => 1 }) };
    if (table === 'app_settings') return { whereIn: () => ({ select: async () => [] }) };
    throw new Error(`unexpected table in test: ${table}`);
  };
  api.__state = state;
  return { db: api };
});

const LocalFsStorage = require('../../src/services/storage/LocalFsStorage');
const storageModule = require('../../src/services/storage');
const { db } = require('../../src/database/db');

const EVENT = { id: 21, slug: 'fmt-ev', source_mode: 'managed' };
let nextId = 5000;

describe('preview tier keys follow the encoded extension', () => {
  let storage; let storageRoot; let imageProcessor; let puts;

  beforeAll(async () => {
    storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-tierkeys-'));
    storage = new LocalFsStorage({ root: storageRoot });
    await storage.init();
    const origPut = storage.put.bind(storage);
    storage.put = async (key, ...rest) => { puts.push(key); return origPut(key, ...rest); };
    storageModule.setStorageForTesting(storage);
    delete require.cache[require.resolve('../../src/services/imageProcessor')];
    imageProcessor = require('../../src/services/imageProcessor');
  }, 30000);

  beforeEach(() => { puts = []; db.__state.event = EVENT; });

  afterAll(async () => {
    storageModule.resetStorage();
    await fs.rm(storageRoot, { recursive: true, force: true }).catch(() => {});
  });

  async function photoWith(name, { alpha = false } = {}) {
    const id = nextId++;
    const rel = `${EVENT.slug}/${name}`;
    const abs = path.join(storageRoot, 'events/active', rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const pipeline = sharp({
      create: {
        width: 2000, height: 1400, channels: alpha ? 4 : 3,
        background: alpha ? { r: 10, g: 20, b: 30, alpha: 0.5 } : { r: 10, g: 20, b: 30 },
      },
    });
    if (/\.png$/i.test(name)) await pipeline.png().toFile(abs);
    else if (/\.webp$/i.test(name)) await pipeline.webp().toFile(abs);
    else await pipeline.jpeg().toFile(abs);
    // With its edit columns (issue 2619), none: a row without them is read for them.
    return {
      id, event_id: EVENT.id, source_origin: 'managed', path: rel, filename: name,
      edit_params: null, edit_rev: 0, edit_applied_rev: 0, edit_render_path: null, edit_width: null, edit_height: null,
    };
  }

  it.each([
    ['opaque PNG', 'photo.png', false, '.jpg'],
    ['transparent PNG', 'photo-alpha.png', true, '.webp'],
    ['uppercase JPG', 'IMG_0001.JPG', false, '.jpg'],
    ['jpeg spelled out', 'photo.jpeg', false, '.jpg'],
    ['lowercase jpg', 'photo.jpg', false, '.jpg'],
  ])('%s: the second request is a cache hit, not a second generation', async (_label, name, alpha, ext) => {
    const photo = await photoWith(name, { alpha });

    const first = await imageProcessor.ensurePreviewImageAtWidth(photo, 640);
    expect(first).toBe(`previews/preview_w640_p${photo.id}_${name.replace(/\.[^.]+$/, '')}${ext}`);
    expect(puts).toEqual([first]);

    const second = await imageProcessor.ensurePreviewImageAtWidth(photo, 640);
    expect(second).toBe(first);
    expect(puts).toHaveLength(1);
  });

  it.each([
    ['opaque PNG', 'cleanup.png', false],
    ['transparent PNG', 'cleanup-alpha.png', true],
    ['uppercase JPG', 'CLEANUP.JPG', false],
  ])('%s: previewTierKeys covers the generated key, so deletePreviewTiers removes it', async (_label, name, alpha) => {
    const photo = await photoWith(name, { alpha });
    const k640 = await imageProcessor.ensurePreviewImageAtWidth(photo, 640);
    const k1280 = await imageProcessor.ensurePreviewImageAtWidth(photo, 1280);
    expect(await storage.stat(k640)).toBeTruthy();
    expect(await storage.stat(k1280)).toBeTruthy();

    const keys = imageProcessor.previewTierKeys(photo);
    expect(keys).toEqual(expect.arrayContaining([k640, k1280]));

    await imageProcessor.deletePreviewTiers(photo);
    expect(await storage.stat(k640)).toBeNull();
    expect(await storage.stat(k1280)).toBeNull();
  });

  it('a tier written before the extension rewrite is still found, by lookup and by cleanup', async () => {
    // JPEG bytes under the source's `.png` name — what generatePreviewImage
    // produced before it started rewriting the extension. Served as JPEG by
    // the route (the Content-Type comes from the `.webp` suffix only).
    const photo = await photoWith('legacy.png');
    const legacyKey = `previews/preview_w640_p${photo.id}_legacy.png`;
    await storage.put(legacyKey, await sharp({ create: { width: 640, height: 448, channels: 3, background: '#123' } }).jpeg().toBuffer());
    puts = [];

    expect(await imageProcessor.ensurePreviewImageAtWidth(photo, 640)).toBe(legacyKey);
    expect(puts).toHaveLength(0);

    expect(imageProcessor.previewTierKeys(photo)).toContain(legacyKey);
    await imageProcessor.deletePreviewTiers(photo);
    expect(await storage.stat(legacyKey)).toBeNull();
  });

  it('never lists the canonical 1920 rendition, which preview_path owns', () => {
    const keys = imageProcessor.previewTierKeys({ id: 9, path: 'e/a.png', source_origin: 'managed' });
    expect(keys.some((k) => k.includes('w1920'))).toBe(false);
    expect(keys.every((k) => k.includes('p9_'))).toBe(true);
    // Both encodings plus the legacy source-extension key, per width.
    expect(keys).toEqual([
      'previews/preview_w640_p9_a.jpg', 'previews/preview_w640_p9_a.webp', 'previews/preview_w640_p9_a.png',
      'previews/preview_w1280_p9_a.jpg', 'previews/preview_w1280_p9_a.webp', 'previews/preview_w1280_p9_a.png',
    ]);
  });

  it('does not duplicate the legacy key when the source already is a lowercase .jpg', () => {
    const keys = imageProcessor.previewTierKeys({ id: 9, path: 'e/a.jpg', source_origin: 'managed' });
    expect(keys.filter((k) => k.includes('w640'))).toEqual([
      'previews/preview_w640_p9_a.jpg', 'previews/preview_w640_p9_a.webp',
    ]);
  });
});
