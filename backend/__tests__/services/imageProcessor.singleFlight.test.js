/**
 * Lazy rendition generation is single-flight per photo and rendition (#1020).
 *
 * ensureThumbnail / ensureHeroImage / ensurePreviewImage and the tier
 * variants are check-then-generate, and the check reads the path off the row
 * the caller already fetched. N concurrent cold requests for one photo all
 * missed and all ran the same Sharp pass; worse, the hero and preview
 * generators deleted the existing object before writing its replacement, so
 * a reader landing between B's delete and B's write was redirected to the
 * full original, and a regeneration whose source could not be read left the
 * old rendition gone with the row still pointing at it.
 *
 * Driven against real Sharp output and the real LocalFsStorage, plus an
 * in-memory backend with the S3 contract (no local paths, download on read),
 * because the single-flight sits around withLocalCopy and the difference
 * between one download and eight is the whole point.
 */
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const sharp = require('sharp');

const EXTERNAL_ROOT = path.join(os.tmpdir(), `picpeak-sf-ext-${process.pid}`);
process.env.EXTERNAL_MEDIA_ROOT = EXTERNAL_ROOT;

jest.mock('../../src/database/db', () => {
  const state = { events: {}, updates: [], photos: {} };
  const api = (table) => {
    if (table === 'events') {
      return { where: (_col, id) => ({ first: async () => state.events[id] || null }) };
    }
    if (table === 'photos') {
      return {
        where: (criteria) => ({
          update: async (values) => { state.updates.push({ criteria, values }); return 1; },
          // By id, the row the test made (keepTierIfCurrent compares a fresh
          // tier with it; ownDerivativeName finds no source_filename on it, as
          // for an uploaded photo); withSourceVersion's size read finds no
          // recorded size.
          first: async (cols) => {
            if (cols === 'size_bytes') return undefined;
            return (criteria && criteria.id != null && state.photos[criteria.id]) || null;
          },
        }),
      };
    }
    if (table === 'app_settings') {
      return { whereIn: () => ({ select: async () => [] }) };
    }
    throw new Error(`unexpected table in test: ${table}`);
  };
  api.__state = state;
  return { db: api };
});

const LocalFsStorage = require('../../src/services/storage/LocalFsStorage');
const storageModule = require('../../src/services/storage');
const { db } = require('../../src/database/db');

const MANAGED_EVENT = { id: 11, slug: 'managed-ev', source_mode: 'managed' };
const EXTERNAL_EVENT = { id: 7, slug: 'nas-ev', source_mode: 'reference', external_path: 'weddings/sf' };

let nextId = 1000;

async function writeJpeg(absPath, { width = 2400, height = 1600 } = {}) {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await sharp({ create: { width, height, channels: 3, background: { r: 30, g: 120, b: 200 } } })
    .jpeg({ quality: 85 }).toFile(absPath);
}

async function jpegBuffer({ width = 2400, height = 1600 } = {}) {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 60, b: 30 } } })
    .jpeg({ quality: 85 }).toBuffer();
}

/**
 * The S3 contract as imageProcessor sees it: kind() !== 'local', so validity
 * is a stat only, and withLocalCopy has to download the source through
 * getToFile before Sharp can open it.
 */
class MemoryObjectStore {
  constructor() { this.objects = new Map(); this.puts = []; this.downloads = []; this.failNextPut = false; }
  kind() { return 's3'; }
  async init() {}
  async put(key, body) {
    if (this.failNextPut) { this.failNextPut = false; throw new Error('simulated upload failure'); }
    this.puts.push(key);
    this.objects.set(key, Buffer.from(body));
  }
  async stat(key) {
    const b = this.objects.get(key);
    return b ? { size: b.length, mtime: new Date() } : null;
  }
  async exists(key) { return this.objects.has(key); }
  async getToFile(key, localPath) {
    this.downloads.push(key);
    const b = this.objects.get(key);
    if (!b) throw new Error(`NoSuchKey: ${key}`);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, b);
  }
  async delete(key) { this.objects.delete(key); }
}

describe('single-flight rendition generation (#1020)', () => {
  let imageProcessor;

  beforeAll(() => {
    delete require.cache[require.resolve('../../src/services/imageProcessor')];
    imageProcessor = require('../../src/services/imageProcessor');
  });

  beforeEach(() => {
    db.__state.events = { [MANAGED_EVENT.id]: MANAGED_EVENT, [EXTERNAL_EVENT.id]: EXTERNAL_EVENT };
    db.__state.updates = [];
    db.__state.photos = {};
  });

  afterAll(async () => {
    storageModule.resetStorage();
    await fs.rm(EXTERNAL_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  describe('local storage', () => {
    let storage; let storageRoot; let puts;

    beforeAll(async () => {
      storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-sf-store-'));
      storage = new LocalFsStorage({ root: storageRoot });
      await storage.init();
      const origPut = storage.put.bind(storage);
      storage.put = async (key, ...rest) => {
        if (storage.failNextPut) { storage.failNextPut = false; throw new Error('simulated write failure'); }
        if (storage.holdNextPut) { const gate = storage.holdNextPut; storage.holdNextPut = null; await gate; }
        puts.push(key);
        return origPut(key, ...rest);
      };
      storageModule.setStorageForTesting(storage);
    }, 30000);

    beforeEach(() => { puts = []; storage.failNextPut = false; storage.holdNextPut = null; });

    afterAll(async () => {
      await fs.rm(storageRoot, { recursive: true, force: true }).catch(() => {});
    });

    async function managedPhoto() {
      const id = nextId++;
      const name = `managed-${id}.jpg`;
      const rel = `${MANAGED_EVENT.slug}/${name}`;
      await writeJpeg(path.join(storageRoot, 'events/active', rel));
      const row = { id, event_id: MANAGED_EVENT.id, source_origin: 'managed', path: rel, filename: name };
      db.__state.photos[id] = row;
      return row;
    }

    async function externalPhoto({ write = true } = {}) {
      const id = nextId++;
      const name = `external-${id}.jpg`;
      const relpath = path.join(EXTERNAL_EVENT.external_path, name);
      if (write) await writeJpeg(path.join(EXTERNAL_ROOT, relpath));
      const row = { id, event_id: EXTERNAL_EVENT.id, source_origin: 'external', external_relpath: relpath, filename: name };
      db.__state.photos[id] = row;
      return row;
    }

    const putsUnder = (prefix) => puts.filter((k) => k.startsWith(prefix));

    it('ensurePreviewImage: eight concurrent cold requests share one generation', async () => {
      const photo = await managedPhoto();
      const results = await Promise.all(Array.from({ length: 8 }, () => imageProcessor.ensurePreviewImage(photo)));

      expect(results[0]).toMatch(/^previews\/preview_/);
      expect(new Set(results).size).toBe(1);
      expect(putsUnder('previews/')).toHaveLength(1);
      // One flight, one row write — not eight identical updates.
      expect(db.__state.updates).toHaveLength(1);
      expect(await storage.stat(results[0])).toBeTruthy();
    });

    it('ensureHeroImage: eight concurrent cold requests share one generation', async () => {
      const photo = await managedPhoto();
      const results = await Promise.all(Array.from({ length: 8 }, () => imageProcessor.ensureHeroImage(photo)));

      expect(results[0]).toMatch(/^heroes\/hero_/);
      expect(new Set(results).size).toBe(1);
      expect(putsUnder('heroes/')).toHaveLength(1);
      expect(db.__state.updates).toHaveLength(1);
    });

    it('ensureThumbnail: eight concurrent cold requests for an external photo share one generation', async () => {
      const photo = await externalPhoto();
      const results = await Promise.all(Array.from({ length: 8 }, () => imageProcessor.ensureThumbnail(photo)));

      expect(results[0]).toBe(`thumbnails/thumb_ext${photo.id}_${photo.filename}`);
      expect(new Set(results).size).toBe(1);
      expect(putsUnder('thumbnails/')).toHaveLength(1);
      expect(db.__state.updates).toHaveLength(1);
    });

    it('a tier request that resolves to the canonical thumbnail shares the canonical flight', async () => {
      // ensureThumbnailAtWidth hands the canonical width, and every video, to
      // ensureThumbnail. That used to be the one unguarded path a guarded
      // request could fall through into.
      const photo = await managedPhoto();
      const canonical = 300; // DEFAULT_THUMBNAIL_WIDTH; the settings mock returns no override
      const results = await Promise.all([
        imageProcessor.ensureThumbnailAtWidth(photo, canonical),
        imageProcessor.ensureThumbnailAtWidth(photo, canonical),
        imageProcessor.ensureThumbnail(photo),
        imageProcessor.ensureThumbnail(photo),
      ]);

      expect(results[0]).toMatch(/^thumbnails\/thumb_/);
      expect(new Set(results).size).toBe(1);
      expect(putsUnder('thumbnails/')).toHaveLength(1);
    });

    it.each([
      ['ensureThumbnail', 'thumbnail_path', 'thumbnails/'],
      ['ensureHeroImage', 'hero_path', 'heroes/'],
      ['ensurePreviewImage', 'preview_path', 'previews/'],
    ])('%s: a forced rebuild is never satisfied by joining a viewer\'s hot-path check', async (fn, column, prefix) => {
      // adminThumbnails.js forces a rebuild by passing the row with the path
      // nulled. If the validity check ran inside the flight, that call could
      // join a viewer's flight for the same photo — one that was merely
      // stat-ing an already good rendition — and be handed back the very
      // file it was asked to replace, with the endpoint counting a success.
      const photo = await managedPhoto();
      const existing = await imageProcessor[fn](photo);
      expect(existing).toMatch(new RegExp(`^${prefix}`));
      expect(putsUnder(prefix)).toHaveLength(1);

      const [viewer, forced] = await Promise.all([
        imageProcessor[fn]({ ...photo, [column]: existing }),
        imageProcessor[fn]({ ...photo, [column]: null }),
      ]);

      expect(viewer).toBe(existing);
      expect(forced).toBe(existing);
      // The forced call wrote a fresh rendition; the viewer's did not.
      expect(putsUnder(prefix)).toHaveLength(2);
    });

    it.each([
      ['ensureThumbnail', 'thumbnail_path', 'thumbnails/'],
      ['ensurePreviewImage', 'preview_path', 'previews/'],
    ])('%s: a forced rebuild runs after a lazy generation already in flight instead of adopting it', async (fn, column, prefix) => {
      // The lazy flight read the settings when it started; after a settings
      // change it is producing exactly what the admin's regenerate exists to
      // replace. Joining it would count a success and leave the old size
      // cached — the validity check only asks whether the file parses.
      const photo = await managedPhoto();
      let release;
      storage.holdNextPut = new Promise((r) => { release = r; });

      const lazy = imageProcessor[fn](photo);                                   // blocks inside put
      const forced = imageProcessor[fn]({ ...photo, [column]: null }, { force: true });
      const joiner = imageProcessor[fn](photo);                                 // lazy miss after the forced call
      let forcedSettled = false;
      forced.then(() => { forcedSettled = true; });

      await new Promise((r) => setTimeout(r, 60));
      expect(putsUnder(prefix)).toHaveLength(0);
      expect(forcedSettled).toBe(false);

      release();
      const results = await Promise.all([lazy, forced, joiner]);
      expect(results.every((k) => k === results[0])).toBe(true);
      expect(results[0]).toMatch(new RegExp(`^${prefix}`));
      // Lazy wrote once, the forced rebuild wrote once more after it; the
      // later lazy miss joined the forced flight rather than starting a third.
      expect(putsUnder(prefix)).toHaveLength(2);
    });

    it('a replaced photo (same id, new path) does not join a flight still rendering the old source', async () => {
      // replacePhoto keeps the id and changes path/filename. Keyed by id and
      // width alone, a request carrying the replacement row would join the
      // old flight, be handed the old image, and the gallery would cache it.
      const before = await managedPhoto();
      const after = await managedPhoto();
      const replacement = { ...after, id: before.id };
      // The row now holds the replacement.
      db.__state.photos[before.id] = replacement;

      let release;
      storage.holdNextPut = new Promise((r) => { release = r; });
      const stale = imageProcessor.ensureThumbnailAtWidth(before, 600);        // blocks inside put
      const fresh = imageProcessor.ensureThumbnailAtWidth(replacement, 600);
      release();

      const [oldKey, newKey] = await Promise.all([stale, fresh]);
      // Two flights, two renditions; the one cut from the replaced source no
      // longer matches the row, so it is dropped rather than handed out.
      expect(putsUnder('thumbnails/').sort()).toEqual([
        `thumbnails/thumb_w600_p${before.id}_${before.filename}`,
        `thumbnails/thumb_w600_p${before.id}_${after.filename}`,
      ].sort());
      expect(oldKey).toBeNull();
      expect(newKey).toBe(`thumbnails/thumb_w600_p${before.id}_${after.filename}`);

      // Same shape for the canonical preview, which had no guard at all on
      // base and must not gain a cross-source one now.
      storage.holdNextPut = new Promise((r) => { release = r; });
      const staleP = imageProcessor.ensurePreviewImage(before);
      const freshP = imageProcessor.ensurePreviewImage(replacement);
      release();
      const [oldP, newP] = await Promise.all([staleP, freshP]);
      expect(oldP).not.toBe(newP);
      expect(putsUnder('previews/')).toHaveLength(2);
    });

    it('different photos and different widths are separate flights', async () => {
      const a = await managedPhoto();
      const b = await externalPhoto();
      const calls = [
        ...Array.from({ length: 4 }, () => imageProcessor.ensurePreviewImageAtWidth(a, 640)),
        ...Array.from({ length: 4 }, () => imageProcessor.ensurePreviewImageAtWidth(a, 1280)),
        ...Array.from({ length: 4 }, () => imageProcessor.ensurePreviewImageAtWidth(b, 640)),
        ...Array.from({ length: 4 }, () => imageProcessor.ensureThumbnailAtWidth(a, 600)),
        ...Array.from({ length: 4 }, () => imageProcessor.ensureThumbnailAtWidth(b, 600)),
      ];
      const results = await Promise.all(calls);

      expect(results.every(Boolean)).toBe(true);
      expect(new Set(results).size).toBe(5);
      expect(results.slice(0, 4).every((k) => k === results[0])).toBe(true);
      expect(results.slice(4, 8).every((k) => k === results[4])).toBe(true);
      expect(putsUnder('previews/')).toHaveLength(3);
      expect(putsUnder('thumbnails/')).toHaveLength(2);
      // Tiers are pure cache: never written to the row.
      expect(db.__state.updates).toHaveLength(0);
    });

    it('a warm tier is served from storage without a second generation', async () => {
      const photo = await managedPhoto();
      const first = await imageProcessor.ensurePreviewImageAtWidth(photo, 640);
      const again = await Promise.all([
        imageProcessor.ensurePreviewImageAtWidth(photo, 640),
        imageProcessor.ensurePreviewImageAtWidth(photo, 640),
      ]);

      expect(again).toEqual([first, first]);
      expect(putsUnder('previews/')).toHaveLength(1);
    });

    it('a failed flight is cleared so the next request retries instead of adopting the failure', async () => {
      const photo = await externalPhoto({ write: false });

      const cold = await Promise.all(Array.from({ length: 4 }, () => imageProcessor.ensurePreviewImage(photo)));
      expect(cold).toEqual([null, null, null, null]);
      expect(putsUnder('previews/')).toHaveLength(0);

      // The source appears (mount came back, file finished copying).
      await writeJpeg(path.join(EXTERNAL_ROOT, photo.external_relpath));
      const warm = await imageProcessor.ensurePreviewImage(photo);
      expect(warm).toBe(`previews/preview_ext${photo.id}_external-${photo.id}.jpg`);
      expect(putsUnder('previews/')).toHaveLength(1);
    });

    it('a flight that returns null is shared by every waiter and cleared afterwards', async () => {
      const photo = await managedPhoto();
      db.__state.events = {}; // the event lookup inside the flight finds nothing
      const results = await Promise.all(Array.from({ length: 3 }, () => imageProcessor.ensureThumbnail(photo)));
      expect(results).toEqual([null, null, null]);

      db.__state.events = { [MANAGED_EVENT.id]: MANAGED_EVENT };
      const key = await imageProcessor.ensureThumbnail(photo);
      expect(key).toMatch(/^thumbnails\/thumb_/);
      expect(putsUnder('thumbnails/')).toHaveLength(1);
    });

    it('a flight that throws rejects every waiter identically and is cleared afterwards', async () => {
      const photo = await managedPhoto();
      const boom = new Error('db down');
      const realEvents = db.__state.events;
      db.__state.events = new Proxy({}, { get: () => { throw boom; } });

      // ensureThumbnail's event lookup is not wrapped in try/catch, so this
      // propagates — to every caller of the shared flight, not just the first.
      const settled = await Promise.allSettled(Array.from({ length: 3 }, () => imageProcessor.ensureThumbnail(photo)));
      expect(settled.map((s) => s.status)).toEqual(['rejected', 'rejected', 'rejected']);
      expect(settled.every((s) => s.reason === boom)).toBe(true);

      db.__state.events = realEvents;
      const key = await imageProcessor.ensureThumbnail(photo);
      expect(key).toMatch(/^thumbnails\/thumb_/);
    });

    it('the existing hero survives a regeneration whose source cannot be read', async () => {
      // generateHeroImage used to delete the target before Sharp had opened
      // the source, so a corrupt file or a blipped mount stripped the old
      // hero and returned null with the row still pointing at it.
      const src = path.join(storageRoot, 'events/active', MANAGED_EVENT.slug, 'hero-src.jpg');
      await writeJpeg(src);
      const key = await imageProcessor.generateHeroImage(src, { outputBasename: 'survive.jpg' });
      expect(key).toBe('heroes/hero_survive.jpg');
      const before = await storage.stat(key);

      const junk = path.join(storageRoot, 'events/active', MANAGED_EVENT.slug, 'hero-junk.jpg');
      await fs.writeFile(junk, Buffer.from('this is not a jpeg'));
      const result = await imageProcessor.generateHeroImage(junk, { regenerate: true, outputBasename: 'survive.jpg' });

      expect(result).toBeNull();
      const after = await storage.stat(key);
      expect(after).toBeTruthy();
      expect(after.size).toBe(before.size);
      await expect(sharp(storage.resolveLocalPath(key)).metadata()).resolves.toMatchObject({ width: 1920 });
    });

    it('the existing preview survives a regeneration whose write fails', async () => {
      // Probe succeeds, the pipeline runs, the put throws: the catch used to
      // delete the key, which by then only ever held the PREVIOUS good file.
      const src = path.join(storageRoot, 'events/active', MANAGED_EVENT.slug, 'preview-src.jpg');
      await writeJpeg(src);
      const key = await imageProcessor.generatePreviewImage(src, { outputBasename: 'survive.jpg' });
      expect(key).toBe('previews/preview_survive.jpg');
      const before = await storage.stat(key);

      storage.failNextPut = true;
      const result = await imageProcessor.generatePreviewImage(src, { regenerate: true, outputBasename: 'survive.jpg' });

      expect(result).toBeNull();
      const after = await storage.stat(key);
      expect(after).toBeTruthy();
      expect(after.size).toBe(before.size);
    });

    it('the existing hero survives a regeneration whose write fails', async () => {
      const src = path.join(storageRoot, 'events/active', MANAGED_EVENT.slug, 'hero-src2.jpg');
      await writeJpeg(src);
      const key = await imageProcessor.generateHeroImage(src, { outputBasename: 'survive2.jpg' });
      const before = await storage.stat(key);

      storage.failNextPut = true;
      const result = await imageProcessor.generateHeroImage(src, { regenerate: true, outputBasename: 'survive2.jpg' });

      expect(result).toBeNull();
      expect((await storage.stat(key)).size).toBe(before.size);
    });
  });

  describe('S3 contract', () => {
    let store;

    beforeAll(() => {
      store = new MemoryObjectStore();
      storageModule.setStorageForTesting(store);
    });

    beforeEach(() => { store.puts = []; store.downloads = []; store.failNextPut = false; });

    async function managedPhoto() {
      const id = nextId++;
      const name = `s3-${id}.jpg`;
      const rel = `${MANAGED_EVENT.slug}/${name}`;
      store.objects.set(`events/active/${rel}`, await jpegBuffer());
      const row = { id, event_id: MANAGED_EVENT.id, source_origin: 'managed', path: rel, filename: name };
      db.__state.photos[id] = row;
      return row;
    }

    it('ensurePreviewImage: concurrent cold requests download the source once and upload once', async () => {
      const photo = await managedPhoto();
      const results = await Promise.all(Array.from({ length: 6 }, () => imageProcessor.ensurePreviewImage(photo)));

      expect(new Set(results).size).toBe(1);
      expect(results[0]).toMatch(/^previews\/preview_/);
      expect(store.downloads).toEqual([`events/active/${photo.path}`]);
      expect(store.puts).toHaveLength(1);
      expect(await store.stat(results[0])).toBeTruthy();
      expect(db.__state.updates).toHaveLength(1);
    });

    it('ensureHeroImage: concurrent cold requests download the source once and upload once', async () => {
      const photo = await managedPhoto();
      const results = await Promise.all(Array.from({ length: 6 }, () => imageProcessor.ensureHeroImage(photo)));

      expect(new Set(results).size).toBe(1);
      expect(store.downloads).toHaveLength(1);
      expect(store.puts).toHaveLength(1);
    });

    it('ensureThumbnailAtWidth: concurrent cold tier requests download the source once and upload once', async () => {
      const photo = await managedPhoto();
      const results = await Promise.all(Array.from({ length: 6 }, () => imageProcessor.ensureThumbnailAtWidth(photo, 600)));

      expect(new Set(results).size).toBe(1);
      expect(results[0]).toBe(`thumbnails/thumb_w600_p${photo.id}_${photo.filename}`);
      expect(store.downloads).toHaveLength(1);
      expect(store.puts).toEqual([results[0]]);
    });

    it('the existing preview object survives a regeneration whose upload fails', async () => {
      // Fixed outputBasename, as the external and RAW branches pass: the key
      // is the same on both runs, so the pre-fix delete would have hit the
      // good object. (Through withLocalCopy the basename carries a random
      // temp prefix and the two runs never share a key, which is why this
      // drives the generator directly.)
      const srcDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-sf-s3src-'));
      const src = path.join(srcDir, 'src.jpg');
      await writeJpeg(src);
      try {
        const key = await imageProcessor.generatePreviewImage(src, { outputBasename: 's3-survive.jpg' });
        expect(key).toBe('previews/preview_s3-survive.jpg');
        const before = store.objects.get(key);
        expect(before).toBeTruthy();

        store.failNextPut = true;
        const result = await imageProcessor.generatePreviewImage(src, { regenerate: true, outputBasename: 's3-survive.jpg' });

        expect(result).toBeNull();
        expect(store.objects.get(key)).toBe(before);
      } finally {
        await fs.rm(srcDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  });
});
