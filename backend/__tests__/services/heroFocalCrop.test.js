/**
 * The hero crop follows the event's focal point (issue 1737).
 *
 * The hero tier is a 1920x1080 cover crop and it was always cut at the
 * centre. events.hero_image_anchor only reached the gallery as CSS
 * object-position, which moves the view within that centre crop but can
 * never reach the top or bottom of a portrait source — so "Top", "Bottom"
 * and every custom point looked exactly like "Center".
 *
 * generateHeroImage now cuts at the anchor, and ensureHeroImage treats a
 * readable rendition cut at another anchor as stale.
 */
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const sharp = require('sharp');

const EXTERNAL_ROOT = path.join(os.tmpdir(), `picpeak-hero-focal-${process.pid}`);
process.env.EXTERNAL_MEDIA_ROOT = EXTERNAL_ROOT;

jest.mock('../../src/database/db', () => {
  // `sharedHeroPaths`: hero keys some OTHER photo row still points at.
  const state = { event: null, updates: [], sharedHeroPaths: [] };
  const api = (table) => {
    if (table === 'events') return { where: () => ({ first: async () => state.event }) };
    if (table === 'photos') {
      return {
        where: (criteria) => ({
          update: async (values) => { state.updates.push({ criteria, values }); return 1; },
          whereNot: () => ({ first: async () => (state.sharedHeroPaths.includes(criteria.hero_path) ? { id: -1 } : undefined) }),
        }),
      };
    }
    throw new Error(`unexpected table in test: ${table}`);
  };
  api.__state = state;
  return { db: api };
});

const LocalFsStorage = require('../../src/services/storage/LocalFsStorage');
const storageModule = require('../../src/services/storage');
const { db } = require('../../src/database/db');
const { heroAnchorPoint, normalizeHeroAnchor, heroAnchorQuery, heroQueryRedirect, heroRenditionName } = require('../../src/utils/heroAnchor');

const EVENT = { id: 9, slug: 'tall-hero', source_mode: 'reference', external_path: 'weddings/2026-09', hero_image_anchor: 'center' };

// A portrait source in three horizontal bands: red on top, green in the
// middle, blue at the bottom. A 16:9 frame covers well under a third of it,
// so which band the output shows says where the crop was cut.
const RED = [220, 30, 30]; const GREEN = [30, 200, 60]; const BLUE = [30, 60, 220];
async function writeBandedJpeg(absPath, { width = 600, height = 1800 } = {}) {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  const buf = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    const band = y < height / 3 ? RED : y < (2 * height) / 3 ? GREEN : BLUE;
    for (let x = 0; x < width; x++) buf.set(band, (y * width + x) * 3);
  }
  await sharp(buf, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toFile(absPath);
}

async function centrePixel(storage, key) {
  const { data, info } = await sharp(storage.resolveLocalPath(key)).raw().toBuffer({ resolveWithObject: true });
  const at = ((Math.floor(info.height / 2) * info.width) + Math.floor(info.width / 2)) * info.channels;
  return [data[at], data[at + 1], data[at + 2]];
}
const closeTo = (pixel, band) => pixel.every((v, i) => Math.abs(v - band[i]) < 40);

describe('heroAnchor helpers', () => {
  it('reads keywords, "X% Y%" and garbage', () => {
    expect(heroAnchorPoint('top')).toEqual([50, 0]);
    expect(heroAnchorPoint('bottom')).toEqual([50, 100]);
    expect(heroAnchorPoint('12% 88%')).toEqual([12, 88]);
    expect(heroAnchorPoint('constructor')).toEqual([50, 50]);
    expect(heroAnchorPoint(null)).toEqual([50, 50]);
    expect(normalizeHeroAnchor('top')).toBe('50% 0%');
    expect(normalizeHeroAnchor(undefined)).toBe('50% 50%');
  });

  it('adds a URL fragment only away from the centre, so existing hero URLs stay as they are', () => {
    expect(heroAnchorQuery('center')).toBe('');
    expect(heroAnchorQuery('50% 50%')).toBe('');
    expect(heroAnchorQuery(null)).toBe('');
    expect(heroAnchorQuery('0% 0%')).toBe('fp=0-0');
    expect(heroAnchorQuery('bottom')).toBe('fp=50-100');
  });

  it('redirects a hero URL whose fp is not the current anchor, keeping the other parameters', () => {
    // Matching URLs are served.
    expect(heroQueryRedirect({}, 'center')).toBeNull();
    expect(heroQueryRedirect({ fp: '50-0' }, 'top')).toBeNull();
    expect(heroQueryRedirect({ fp: '0-0', wm: '3' }, '0% 0%')).toBeNull();
    // A stale centre URL while the event is off-centre: the cache must not
    // learn the off-centre crop under it.
    expect(heroQueryRedirect({}, 'top')).toBe('?fp=50-0');
    expect(heroQueryRedirect({ wm: '3', admin_preview: '1' }, 'bottom')).toBe('?wm=3&admin_preview=1&fp=50-100');
    // A stale off-centre URL after the event went back to centre.
    expect(heroQueryRedirect({ fp: '50-0' }, 'center')).toBe('');
    expect(heroQueryRedirect({ fp: '50-0', wm: '3' }, null)).toBe('?wm=3');
    // Only a string fp counts; an array is not the current anchor either.
    expect(heroQueryRedirect({ fp: ['50-0', '50-0'] }, 'top')).toBe('?fp=50-0');
  });

  it('keeps the pre-258 file name at the centre and one file per anchor elsewhere', () => {
    expect(heroRenditionName('a.jpg', undefined)).toBe('hero_a.jpg');
    expect(heroRenditionName('a.jpg', 'center')).toBe('hero_a.jpg');
    expect(heroRenditionName('a.jpg', '50% 50%')).toBe('hero_a.jpg');
    expect(heroRenditionName('a.jpg', 'top')).toBe('hero_fp50-0_a.jpg');
    expect(heroRenditionName('ext12_a.jpg', '12% 88%')).toBe('hero_fp12-88_ext12_a.jpg');
  });
});

describe('hero focal crop (issue 1737)', () => {
  let storage; let storageRoot; let imageProcessor; let source;

  beforeAll(async () => {
    storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-hero-focal-store-'));
    storage = new LocalFsStorage({ root: storageRoot });
    await storage.init();
    storageModule.setStorageForTesting(storage);
    delete require.cache[require.resolve('../../src/services/imageProcessor')];
    imageProcessor = require('../../src/services/imageProcessor');
    source = path.join(EXTERNAL_ROOT, EVENT.external_path, 'banded.jpg');
    await writeBandedJpeg(source);
  }, 30000);

  afterAll(async () => {
    storageModule.resetStorage();
    await fs.rm(storageRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(EXTERNAL_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(() => { db.__state.event = { ...EVENT }; db.__state.updates = []; db.__state.sharedHeroPaths = []; });

  it.each([
    ['50% 0%', RED, 'red'],
    ['top', RED, 'red'],
    [undefined, GREEN, 'green'],
    ['center', GREEN, 'green'],
    ['50% 100%', BLUE, 'blue'],
  ])('generateHeroImage cuts the frame at anchor %s (%s band)', async (anchor, band) => {
    const key = await imageProcessor.generateHeroImage(source, {
      width: 160, height: 90, anchor, outputBasename: `anchor-${String(anchor).replace(/\W/g, '')}.jpg`,
    });
    expect(key).toBeTruthy();
    const meta = await sharp(storage.resolveLocalPath(key)).metadata();
    expect([meta.width, meta.height]).toEqual([160, 90]);
    expect(closeTo(await centrePixel(storage, key), band)).toBe(true);
  });

  it('ensureHeroImage regenerates a readable hero that was cut at another anchor, and records the new one', async () => {
    const photo = {
      id: 401, event_id: EVENT.id, source_origin: 'external',
      external_relpath: path.join(EVENT.external_path, 'banded.jpg'), filename: 'banded.jpg',
      hero_path: null, hero_anchor: null,
    };
    // First request: the event says top.
    const key = await imageProcessor.ensureHeroImage(photo, { anchor: 'top' });
    expect(key).toBeTruthy();
    expect(db.__state.updates).toEqual([{ criteria: { id: 401 }, values: { hero_path: key, hero_anchor: '50% 0%' } }]);
    expect(closeTo(await centrePixel(storage, key), RED)).toBe(true);

    // Same anchor again: the stored file is reused, nothing is written.
    db.__state.updates = [];
    const stored = { ...photo, hero_path: key, hero_anchor: '50% 0%' };
    await expect(imageProcessor.ensureHeroImage(stored, { anchor: '50% 0%' })).resolves.toBe(key);
    expect(db.__state.updates).toEqual([]);

    // A caller without the anchor keeps whatever is stored.
    await expect(imageProcessor.ensureHeroImage(stored)).resolves.toBe(key);
    expect(db.__state.updates).toEqual([]);

    // The admin moves the focal point to the bottom: a new file, and the
    // previous anchor's file goes — the watermark cache keys on the path and
    // a concurrent flight for the old anchor must never be handed this one.
    const again = await imageProcessor.ensureHeroImage(stored, { anchor: 'bottom' });
    expect(again).not.toBe(key);
    expect(again).toContain('hero_fp50-100_');
    expect(db.__state.updates).toEqual([{ criteria: { id: 401 }, values: { hero_path: again, hero_anchor: '50% 100%' } }]);
    expect(closeTo(await centrePixel(storage, again), BLUE)).toBe(true);
    expect(await storage.exists(key)).toBe(false);
  });

  it('keeps the previous file when another photo row still points at it', async () => {
    // Managed hero names derive from the source basename, so two photos can
    // share a key; the superseded file must survive for the other row.
    const photo = {
      id: 404, event_id: EVENT.id, source_origin: 'external',
      external_relpath: path.join(EVENT.external_path, 'banded.jpg'), filename: 'banded.jpg',
      hero_path: null, hero_anchor: null,
    };
    const key = await imageProcessor.ensureHeroImage(photo, { anchor: 'top' });
    db.__state.sharedHeroPaths = [key];
    const next = await imageProcessor.ensureHeroImage({ ...photo, hero_path: key, hero_anchor: '50% 0%' }, { anchor: 'bottom' });
    expect(next).not.toBe(key);
    expect(await storage.exists(key)).toBe(true);
    expect(await storage.exists(next)).toBe(true);
  });

  it('two requests for different anchors do not share a flight', async () => {
    const photo = {
      id: 403, event_id: EVENT.id, source_origin: 'external',
      external_relpath: path.join(EVENT.external_path, 'banded.jpg'), filename: 'banded.jpg',
      hero_path: null, hero_anchor: null,
    };
    const [top, bottom] = await Promise.all([
      imageProcessor.ensureHeroImage(photo, { anchor: 'top' }),
      imageProcessor.ensureHeroImage(photo, { anchor: 'bottom' }),
    ]);
    expect(top).not.toBe(bottom);
    expect(closeTo(await centrePixel(storage, top), RED)).toBe(true);
    expect(closeTo(await centrePixel(storage, bottom), BLUE)).toBe(true);
  });

  it('treats a pre-258 hero (NULL hero_anchor) as the centre crop', async () => {
    const photo = {
      id: 402, event_id: EVENT.id, source_origin: 'external',
      external_relpath: path.join(EVENT.external_path, 'banded.jpg'), filename: 'banded.jpg',
      hero_path: null, hero_anchor: null,
    };
    const key = await imageProcessor.ensureHeroImage(photo, { anchor: 'center' });
    db.__state.updates = [];
    // The row an upgraded install has: file present, anchor column NULL.
    await expect(imageProcessor.ensureHeroImage({ ...photo, hero_path: key, hero_anchor: null }, { anchor: 'center' })).resolves.toBe(key);
    expect(db.__state.updates).toEqual([]);
  });
});
