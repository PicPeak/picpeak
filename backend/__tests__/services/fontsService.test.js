const fs = require('fs');
const fsPromises = fs.promises;
const os = require('os');
const path = require('path');

// Silence the logger so test output stays clean. Capture calls so the
// "warning logged" assertions can still verify behaviour.
jest.mock('../../src/utils/logger', () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

const logger = require('../../src/utils/logger');
// Required ONCE at module top so the jest.mock factory above applies to
// the logger reference that fontsService captures. A previous version
// re-required it inside beforeEach() with jest.resetModules() — that
// silently bypassed the mock (logger calls went to the real logger),
// so the "warning logged" assertions would resolve as 0 calls and
// silently pass-as-noop. Module-level state in fontsService is just
// the cache, which clearFontsCache() resets between tests.
const fontsService = require('../../src/services/fontsService');

// Probe at load time: is the host filesystem case-sensitive?
// macOS APFS and Windows NTFS treat "Inter" and "INTER" as the same
// directory entry, which means the "two folders, same lowercase key"
// dedup test below can't be set up via real folders on those platforms —
// the second mkdir is a no-op. Skip that one test conditionally.
const FS_IS_CASE_SENSITIVE = (() => {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-fs-probe-'));
  fs.writeFileSync(path.join(probeDir, 'casetest'), '');
  let sensitive = true;
  try {
    fs.accessSync(path.join(probeDir, 'CASETEST'));
    sensitive = false;
  } catch { /* file not found → case-sensitive FS */ }
  fs.rmSync(probeDir, { recursive: true, force: true });
  return sensitive;
})();
const testCaseSensitiveFS = FS_IS_CASE_SENSITIVE ? test : test.skip;

let bundledRoot;
let userRoot;

/**
 * Create a font family folder with the given weights (and optional meta.json).
 * @param {string} root absolute path to the bundled or user root
 * @param {string} folderName e.g. "Inter" or "Playfair-Display"
 * @param {Array<number>|Array<string>} weights numeric weights (creates `<w>.woff2`)
 *                                              or filenames to create directly
 * @param {Object|null} meta optional meta.json contents (object) or null
 */
async function makeFamily(root, folderName, weights, meta = null) {
  const dir = path.join(root, folderName);
  await fsPromises.mkdir(dir, { recursive: true });
  for (const w of weights) {
    const fname = typeof w === 'number' ? `${w}.woff2` : w;
    await fsPromises.writeFile(path.join(dir, fname), Buffer.from([]));
  }
  if (meta !== null) {
    await fsPromises.writeFile(
      path.join(dir, 'meta.json'),
      typeof meta === 'string' ? meta : JSON.stringify(meta)
    );
  }
  return dir;
}

beforeEach(async () => {
  jest.clearAllMocks();

  bundledRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'picpeak-fonts-bundled-'));
  userRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'picpeak-fonts-user-'));

  process.env.PICPEAK_BUNDLED_FONTS_ROOT = bundledRoot;
  // The user root resolves under STORAGE_PATH/fonts, so STORAGE_PATH must
  // point at the parent of userRoot — we name the leaf "fonts" ourselves.
  const storageParent = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'picpeak-fonts-storage-'));
  await fsPromises.rename(userRoot, path.join(storageParent, 'fonts'));
  userRoot = path.join(storageParent, 'fonts');
  process.env.STORAGE_PATH = storageParent;

  // Uploads go through the storage adapter, rooted at STORAGE_PATH.
  require('../../src/services/storage').resetStorage();
  // Reset the module-level cache so each test sees a fresh scan.
  // (Both getBundledFontsRoot and getUserFontsRoot read process.env at
  // call-time, so the env vars set above are picked up without needing
  // to re-require the module — see fontsService.js getBundledFontsRoot /
  // getUserFontsRoot.)
  fontsService.clearFontsCache();
});

afterEach(async () => {
  fontsService.clearFontsCache();
  await fsPromises.rm(bundledRoot, { recursive: true, force: true }).catch(() => {});
  // userRoot's parent is the actual mkdtemp; remove it.
  await fsPromises.rm(path.dirname(userRoot), { recursive: true, force: true }).catch(() => {});
  delete process.env.PICPEAK_BUNDLED_FONTS_ROOT;
  delete process.env.STORAGE_PATH;
});

describe('fontsService.listFonts', () => {
  describe('roots', () => {
    test('empty bundled root + missing user root → []', async () => {
      // delete user root so it triggers ENOENT
      await fsPromises.rm(path.dirname(userRoot), { recursive: true, force: true });
      const fonts = await fontsService.listFonts();
      expect(fonts).toEqual([]);
    });

    test('missing bundled root (ENOENT) → [], does not throw', async () => {
      await fsPromises.rm(bundledRoot, { recursive: true, force: true });
      const fonts = await fontsService.listFonts();
      expect(fonts).toEqual([]);
    });

    test('non-directory entries at the root are skipped', async () => {
      await fsPromises.writeFile(path.join(bundledRoot, 'README.md'), 'hi');
      await makeFamily(bundledRoot, 'Inter', [400, 700]);
      const fonts = await fontsService.listFonts();
      expect(fonts.map((f) => f.family)).toEqual(['Inter']);
    });

    test('hidden folders are skipped', async () => {
      await makeFamily(bundledRoot, '.git', [400]);
      await makeFamily(bundledRoot, '.DS_Store', [400]);
      await makeFamily(bundledRoot, 'Inter', [400]);
      const fonts = await fontsService.listFonts();
      expect(fonts.map((f) => f.family)).toEqual(['Inter']);
    });
  });

  describe('weight parsing', () => {
    test('three weight files → sorted ascending', async () => {
      await makeFamily(bundledRoot, 'Inter', [700, 400, 600]);
      const [inter] = await fontsService.listFonts();
      expect(inter.weights).toEqual([400, 600, 700]);
    });

    test('non-numeric filenames are ignored', async () => {
      await makeFamily(bundledRoot, 'Inter', ['bold.woff2', 'regular.woff2', '400.woff2', '700.woff2']);
      const [inter] = await fontsService.listFonts();
      expect(inter.weights).toEqual([400, 700]);
    });

    test('non-.woff2 files are ignored', async () => {
      await makeFamily(bundledRoot, 'Inter', ['400.ttf', '400.woff', '400.woff2', '700.otf']);
      const [inter] = await fontsService.listFonts();
      expect(inter.weights).toEqual([400]);
    });

    test('weight values out of range (sub-1 / over-1000) are ignored', async () => {
      await makeFamily(bundledRoot, 'Inter', [0, 400, 1001, 700]);
      const [inter] = await fontsService.listFonts();
      expect(inter.weights).toEqual([400, 700]);
    });

    test('family folder with no usable .woff2 files is silently skipped', async () => {
      await makeFamily(bundledRoot, 'NoWeights', ['readme.txt', 'bold.ttf']);
      await makeFamily(bundledRoot, 'Inter', [400]);
      const fonts = await fontsService.listFonts();
      expect(fonts.map((f) => f.family)).toEqual(['Inter']);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Skipping NoWeights')
      );
    });
  });

  describe('folder name → display family', () => {
    test('hyphens become spaces', async () => {
      await makeFamily(bundledRoot, 'Playfair-Display', [400]);
      const [pd] = await fontsService.listFonts();
      expect(pd.family).toBe('Playfair Display');
    });

    test('case is preserved', async () => {
      await makeFamily(bundledRoot, 'IBM-Plex-Sans', [400]);
      const [ibm] = await fontsService.listFonts();
      expect(ibm.family).toBe('IBM Plex Sans');
    });
  });

  describe('user-overrides-bundled', () => {
    test('user folder of the same family wins; weights come from user', async () => {
      await makeFamily(bundledRoot, 'Inter', [400, 600, 700]);
      await makeFamily(userRoot, 'Inter', [400, 900]); // different weights
      const [inter] = await fontsService.listFonts();
      expect(inter.weights).toEqual([400, 900]);
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('overrides bundled default')
      );
    });

    test('user-only family is included', async () => {
      await makeFamily(userRoot, 'Lobster', [400]);
      const fonts = await fontsService.listFonts();
      expect(fonts.map((f) => f.family)).toEqual(['Lobster']);
    });

    testCaseSensitiveFS('case-insensitive duplicate within the same root → second skipped, warning', async () => {
      // Two folder names whose lowercase keys collide. On a case-sensitive
      // FS (Linux ext4) we can create both `Inter/` and `INTER/`; on a
      // case-insensitive FS (macOS APFS, Windows NTFS) the second mkdir
      // resolves to the same directory as the first and the dedup branch
      // is unreachable from this test setup — see testCaseSensitiveFS above.
      await makeFamily(bundledRoot, 'Inter', [400]);
      await makeFamily(bundledRoot, 'INTER', [700]);
      const fonts = await fontsService.listFonts();
      expect(fonts).toHaveLength(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Duplicate family')
      );
    });
  });

  describe('meta.json — generic fallback', () => {
    test('valid generic="serif"', async () => {
      await makeFamily(bundledRoot, 'Playfair-Display', [400], { generic: 'serif' });
      const [pd] = await fontsService.listFonts();
      expect(pd.generic).toBe('serif');
    });

    test('valid generic="cursive"', async () => {
      await makeFamily(bundledRoot, 'Comic-Neue', [400], { generic: 'cursive' });
      const [cn] = await fontsService.listFonts();
      expect(cn.generic).toBe('cursive');
    });

    test('valid generic="monospace"', async () => {
      await makeFamily(bundledRoot, 'Fira-Mono', [400], { generic: 'monospace' });
      const [fm] = await fontsService.listFonts();
      expect(fm.generic).toBe('monospace');
    });

    test('missing meta.json → defaults to sans-serif (no warning)', async () => {
      await makeFamily(bundledRoot, 'Inter', [400]);
      const [inter] = await fontsService.listFonts();
      expect(inter.generic).toBe('sans-serif');
      // No warning for the missing-file case (it's the normal path).
      const noisy = (logger.warn.mock.calls || []).filter((c) =>
        String(c[0]).includes('meta.json')
      );
      expect(noisy).toEqual([]);
    });

    test('invalid generic value → defaults to sans-serif, warning logged', async () => {
      await makeFamily(bundledRoot, 'Inter', [400], { generic: 'bogus' });
      const [inter] = await fontsService.listFonts();
      expect(inter.generic).toBe('sans-serif');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('invalid generic "bogus"')
      );
    });

    test('malformed JSON → defaults to sans-serif, warning logged', async () => {
      await makeFamily(bundledRoot, 'Inter', [400], '{ this is not json');
      const [inter] = await fontsService.listFonts();
      expect(inter.generic).toBe('sans-serif');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('not valid JSON')
      );
    });
  });

  describe('result shape', () => {
    test('every family is { family, weights, generic, formats, versions, source }', async () => {
      await makeFamily(bundledRoot, 'Inter', [400, 700]);
      await makeFamily(bundledRoot, 'Playfair-Display', [400], { generic: 'serif' });
      const fonts = await fontsService.listFonts();
      for (const f of fonts) {
        expect(f).toEqual({
          family: expect.any(String),
          weights: expect.any(Array),
          generic: expect.stringMatching(/^(sans-serif|serif|cursive|monospace)$/),
          formats: expect.any(Object),
          versions: expect.any(Object),
          source: 'bundled',
        });
        expect(f.weights.length).toBeGreaterThan(0);
      }
    });

    test('output sorted alphabetically by family', async () => {
      await makeFamily(bundledRoot, 'Zilla-Slab', [400]);
      await makeFamily(bundledRoot, 'Alpha-Sans', [400]);
      await makeFamily(bundledRoot, 'Mid-Pack', [400]);
      const fonts = await fontsService.listFonts();
      expect(fonts.map((f) => f.family)).toEqual([
        'Alpha Sans',
        'Mid Pack',
        'Zilla Slab'
      ]);
    });
  });

  describe('cache', () => {
    test('cache hit: second call within TTL does not re-readdir', async () => {
      await makeFamily(bundledRoot, 'Inter', [400]);
      const spy = jest.spyOn(fsPromises, 'readdir');
      await fontsService.listFonts();
      const callsAfterFirst = spy.mock.calls.length;
      await fontsService.listFonts();
      expect(spy.mock.calls.length).toBe(callsAfterFirst);
      spy.mockRestore();
    });

    test('clearFontsCache forces a fresh scan on the next call', async () => {
      await makeFamily(bundledRoot, 'Inter', [400]);
      await fontsService.listFonts();

      // Add a new family AFTER the cache was populated.
      await makeFamily(bundledRoot, 'Roboto', [400]);

      // Without clearing, listFonts returns the stale cache.
      const stale = await fontsService.listFonts();
      expect(stale.map((f) => f.family)).toEqual(['Inter']);

      // After clear, the new family appears.
      fontsService.clearFontsCache();
      const fresh = await fontsService.listFonts();
      expect(fresh.map((f) => f.family)).toEqual(['Inter', 'Roboto']);
    });
  });
});

describe('uploaded fonts (issue 2618)', () => {
  const WOFF2 = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(60)]);
  const WOFF = Buffer.concat([Buffer.from('wOFF'), Buffer.alloc(60)]);
  const TTF = Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00]), Buffer.alloc(60)]);

  test('a font file is known by its first bytes, not its name', () => {
    expect(fontsService.fontFormatOf(WOFF2)).toBe('woff2');
    expect(fontsService.fontFormatOf(WOFF)).toBe('woff');
    expect(fontsService.fontFormatOf(TTF)).toBe('ttf');
    expect(fontsService.fontFormatOf(Buffer.from('<svg onload=alert(1)>'))).toBeNull();
    expect(fontsService.fontFormatOf(Buffer.from('OTTO'))).toBeNull();
  });

  test('woff and ttf weights count, woff2 wins a weight, and each family says where it came from', async () => {
    await makeFamily(bundledRoot, 'Inter', [400]);
    await makeFamily(userRoot, 'Studio-Sans', ['400.ttf', '400.woff2', '700.woff']);
    const fonts = await fontsService.listFonts();
    expect(fonts.find((f) => f.family === 'Inter')).toMatchObject({ source: 'bundled', formats: { 400: 'woff2' } });
    expect(fonts.find((f) => f.family === 'Studio Sans')).toMatchObject({ weights: [400, 700], source: 'uploaded', formats: { 400: 'woff2', 700: 'woff' } });
  });

  test('an upload lands in the user fonts folder, replaces the same weight, and can be removed', async () => {
    await fontsService.saveUploadedFont({ family: 'Studio Serif', weight: 400, generic: 'serif', buffer: TTF });
    await fontsService.saveUploadedFont({ family: 'Studio Serif', weight: 400, generic: 'serif', buffer: WOFF2 });
    expect(fs.readdirSync(path.join(userRoot, 'Studio-Serif')).sort()).toEqual(['400.woff2', 'meta.json']);
    expect((await fontsService.listFonts()).find((f) => f.family === 'Studio Serif')).toMatchObject({ generic: 'serif', source: 'uploaded' });
    expect(await fontsService.deleteUploadedFamily('Studio Serif')).toBe(true);
    expect(fs.existsSync(path.join(userRoot, 'Studio-Serif'))).toBe(false);
    // A bundled family is not removable.
    await makeFamily(bundledRoot, 'Inter', [400]);
    expect(await fontsService.deleteUploadedFamily('Inter')).toBe(false);
  });

  test('refuses what is not a font, a name that is not a plain family name, and odd weights', async () => {
    await expect(fontsService.saveUploadedFont({ family: 'Evil', weight: 400, buffer: Buffer.from('<script>') })).rejects.toMatchObject({ code: 'FONT_TYPE' });
    await expect(fontsService.saveUploadedFont({ family: '../etc', weight: 400, buffer: WOFF2 })).rejects.toMatchObject({ code: 'FONT_NAME' });
    await expect(fontsService.saveUploadedFont({ family: 'Ok', weight: 450, buffer: WOFF2 })).rejects.toMatchObject({ code: 'FONT_WEIGHT' });
    expect(fs.readdirSync(userRoot)).toEqual([]);
  });
});

// An S3-like store in memory: the adapter interface fontsService uses.
function memoryStore() {
  const objects = new Map();
  const mtimes = new Map();
  let clock = Date.parse('2026-11-28T10:00:00Z');
  const { Readable } = require('stream');
  return {
    objects,
    kind: () => 's3',
    put: async (key, body) => { objects.set(key, Buffer.isBuffer(body) ? body : Buffer.from(String(body))); clock += 1000; mtimes.set(key, new Date(clock)); },
    get: async (key) => { if (!objects.has(key)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return Readable.from([objects.get(key)]); },
    getToFile: async (key, local) => { await fsPromises.mkdir(path.dirname(local), { recursive: true }); await fsPromises.writeFile(local, objects.get(key)); },
    stat: async (key) => (objects.has(key) ? { size: objects.get(key).length, mtime: new Date() } : null),
    exists: async (key) => objects.has(key),
    delete: async (key) => { objects.delete(key); },
    list: async (prefix) => [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, size: objects.get(key).length, mtime: mtimes.get(key) })),
  };
}

describe('uploaded fonts on an object store (S3, several replicas)', () => {
  const WOFF2 = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(60)]);
  const TTF = Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00]), Buffer.alloc(60)]);
  let store;
  beforeEach(() => { store = memoryStore(); require('../../src/services/storage').setStorageForTesting(store); });
  afterEach(() => require('../../src/services/storage').resetStorage());

  test('an upload is stored in the object store, listed from it on any replica, and removed from it', async () => {
    await fontsService.saveUploadedFont({ family: 'Studio Serif', weight: 400, generic: 'serif', buffer: TTF });
    await fontsService.saveUploadedFont({ family: 'Studio Serif', weight: 400, generic: 'serif', buffer: WOFF2 });
    await fontsService.saveUploadedFont({ family: 'Studio Serif', weight: 700, generic: 'serif', buffer: TTF });
    expect([...store.objects.keys()].sort()).toEqual(['fonts/Studio-Serif/400.woff2', 'fonts/Studio-Serif/700.ttf', 'fonts/Studio-Serif/meta.json']);
    // Nothing on this replica's disk.
    expect(fs.readdirSync(userRoot)).toEqual([]);
    fontsService.clearFontsCache();
    expect((await fontsService.listFonts()).find((f) => f.family === 'Studio Serif'))
      .toEqual({ family: 'Studio Serif', weights: [400, 700], generic: 'serif', formats: { 400: 'woff2', 700: 'ttf' }, versions: { 400: expect.any(String), 700: expect.any(String) }, source: 'uploaded' });
    expect(await fontsService.deleteUploadedFamily('Studio Serif')).toBe(true);
    expect(store.objects.size).toBe(0);
    expect(await fontsService.deleteUploadedFamily('Studio Serif')).toBe(false);
  });

  test('the fonts route serves an uploaded file from the object store (read through a local copy)', async () => {
    store.objects.set('fonts/Studio-Serif/400.woff2', WOFF2);
    const express = require('express');
    const request = require('supertest');
    const app = express();
    app.use('/fonts', require('../../src/middleware/fontReadThrough').fontReadThrough());
    const res = await request(app).get('/fonts/Studio-Serif/400.woff2');
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body).equals(WOFF2)).toBe(true);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // Only font files, only from fonts/.
    store.objects.set('fonts/Studio-Serif/evil.html', Buffer.from('<script>'));
    expect((await request(app).get('/fonts/Studio-Serif/evil.html')).status).toBe(404);
    expect((await request(app).get('/fonts/..%2Fsecrets/400.woff2')).status).toBe(404);
    expect((await request(app).get('/fonts/Missing/400.woff2')).status).toBe(404);
  });

  test('fonts placed on this disk before the move to the object store stay listed and served beside the uploaded ones', async () => {
    await makeFamily(userRoot, 'Old-Local', [400]);
    await makeFamily(userRoot, 'Studio-Serif', ['300.woff2']);
    await fontsService.saveUploadedFont({ family: 'Studio Serif', weight: 400, generic: 'serif', buffer: TTF });
    await fontsService.saveUploadedFont({ family: 'Bucket Only', weight: 700, generic: 'serif', buffer: WOFF2 });
    fontsService.clearFontsCache();
    const fonts = await fontsService.listFonts();
    expect(fonts.find((f) => f.family === 'Old Local')).toMatchObject({ weights: [400], source: 'uploaded' });
    expect(fonts.find((f) => f.family === 'Bucket Only')).toMatchObject({ weights: [700], formats: { 700: 'woff2' } });
    // One family on both: its weights from both, the store's file where both have one.
    expect(fonts.find((f) => f.family === 'Studio Serif')).toMatchObject({ weights: [300, 400], formats: { 300: 'woff2', 400: 'ttf' }, generic: 'serif' });
    expect(fonts.filter((f) => f.family === 'Studio Serif')).toHaveLength(1);

    const express = require('express');
    const request = require('supertest');
    const secureStatic = require('../../src/middleware/secureStatic');
    const { fontReadThrough, fontStaticOpts } = require('../../src/middleware/fontReadThrough');
    const app = express();
    app.use('/fonts', fontReadThrough());
    app.use('/fonts', secureStatic(userRoot, fontStaticOpts));
    expect((await request(app).get('/fonts/Old-Local/400.woff2')).status).toBe(200);
    expect((await request(app).get('/fonts/Bucket-Only/700.woff2')).status).toBe(200);
    // A family listed from this disk can be removed like any other.
    expect(await fontsService.deleteUploadedFamily('Old Local')).toBe(true);
    expect(fs.existsSync(path.join(userRoot, 'Old-Local'))).toBe(false);
    expect(await fontsService.deleteUploadedFamily('Studio Serif')).toBe(true);
    expect(fs.existsSync(path.join(userRoot, 'Studio-Serif'))).toBe(false);
    expect([...store.objects.keys()].some((k) => k.startsWith('fonts/Studio-Serif/'))).toBe(false);
  });

  test('a replaced font gets a new address, and the object-store copy is never served stale', async () => {
    const express = require('express');
    const request = require('supertest');
    const { fontReadThrough } = require('../../src/middleware/fontReadThrough');
    const app = express();
    app.use('/fonts', fontReadThrough());
    const versionOf = async () => { fontsService.clearFontsCache(); return (await fontsService.listFonts()).find((f) => f.family === 'Swap Serif').versions[400]; };
    const v1Bytes = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(60, 1)]);
    const v2Bytes = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(60, 2)]);
    await fontsService.saveUploadedFont({ family: 'Swap Serif', weight: 400, generic: 'serif', buffer: v1Bytes });
    const v1 = await versionOf();
    expect(v1).toMatch(/^[a-z0-9]+$/);
    expect(Buffer.from((await request(app).get(`/fonts/Swap-Serif/400.woff2?v=${v1}`)).body).equals(v1Bytes)).toBe(true);
    // Replaced on this replica: a new address, and the old one is not served from the old copy.
    await fontsService.saveUploadedFont({ family: 'Swap Serif', weight: 400, generic: 'serif', buffer: v2Bytes });
    const v2 = await versionOf();
    expect(v2).not.toBe(v1);
    expect(Buffer.from((await request(app).get(`/fonts/Swap-Serif/400.woff2?v=${v1}`)).body).equals(v2Bytes)).toBe(true);
    // Replaced on another replica (straight into the store): the new address fetches it again.
    const v3Bytes = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(60, 3)]);
    await store.put('fonts/Swap-Serif/400.woff2', v3Bytes);
    const v3 = await versionOf();
    expect(v3).not.toBe(v2);
    expect(Buffer.from((await request(app).get(`/fonts/Swap-Serif/400.woff2?v=${v3}`)).body).equals(v3Bytes)).toBe(true);
  });
});
