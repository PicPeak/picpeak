/**
 * Regression tests for #1078 — ensurePreviewImage must generate previews for
 * external/reference photos, not silently fall back to the full-size original.
 *
 * resolvePhotoStorageKey returns null for external photos by design, and that
 * null used to be handed straight to withLocalCopy, which throws. The lightbox
 * preview route caught the throw and redirected to the original, so a gallery
 * whose photos all live on an external mount paid full size on every open —
 * the exact cost the preview tier (#492) exists to avoid.
 */
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const sharp = require('sharp');

// Must be set before externalMediaService is first required: it caches the
// resolved root on first call, and the dir has to exist to win over the
// container default.
const EXTERNAL_ROOT = path.join(os.tmpdir(), `picpeak-ext-media-${process.pid}`);
process.env.EXTERNAL_MEDIA_ROOT = EXTERNAL_ROOT;

jest.mock('../../src/database/db', () => {
  const state = { event: null, updates: [] };
  const api = (table) => {
    if (table === 'events') {
      return { where: () => ({ first: async () => state.event }) };
    }
    if (table === 'photos') {
      return {
        where: (criteria) => ({
          update: async (values) => {
            state.updates.push({ criteria, values });
            return 1;
          },
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

const EVENT = {
  id: 7,
  slug: 'nas-wedding',
  source_mode: 'reference',
  external_path: 'weddings/2026-08-smith',
};

async function writeSourceJpeg(absPath, { width = 2400, height = 1600 } = {}) {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  const buf = Buffer.alloc(width * height * 3);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 7) % 256;
  await sharp(buf, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 }).toFile(absPath);
}

describe('ensurePreviewImage — external/reference sources (#1078)', () => {
  let storage;
  let storageRoot;
  let imageProcessor;

  beforeAll(async () => {
    storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-preview-store-'));
    storage = new LocalFsStorage({ root: storageRoot });
    await storage.init();
    storageModule.setStorageForTesting(storage);

    // Require AFTER the storage injection so the module sees it.
    delete require.cache[require.resolve('../../src/services/imageProcessor')];
    imageProcessor = require('../../src/services/imageProcessor');

    await fs.mkdir(path.join(EXTERNAL_ROOT, EVENT.external_path), { recursive: true });
  }, 30000);

  afterAll(async () => {
    storageModule.resetStorage();
    await fs.rm(storageRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(EXTERNAL_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(() => {
    db.__state.event = EVENT;
    db.__state.updates = [];
  });

  it.each(['external', 'reference'])(
    'generates a downscaled preview for a %s photo off the media mount',
    async (sourceOrigin) => {
      const relpath = `${sourceOrigin}-shot.jpg`;
      await writeSourceJpeg(path.join(EXTERNAL_ROOT, EVENT.external_path, relpath));

      const photo = {
        id: sourceOrigin === 'external' ? 101 : 102,
        event_id: EVENT.id,
        source_origin: sourceOrigin,
        external_relpath: relpath,
        filename: relpath,
        preview_path: null,
      };

      const key = await imageProcessor.ensurePreviewImage(photo);

      // Per-photo basename so two events referencing the same NAS filename
      // can't clobber each other's preview.
      expect(key).toBe(`previews/preview_ext${photo.id}_${relpath}`);
      expect(await storage.exists(key)).toBe(true);

      const meta = await sharp(storage.resolveLocalPath(key)).metadata();
      expect(meta.format).toBe('jpeg');
      // 2400x1600 capped at the 1920 long edge, aspect preserved.
      expect(meta.width).toBe(1920);
      expect(meta.height).toBe(1280);

      // The generated key is persisted so the next open short-circuits.
      expect(db.__state.updates).toEqual([
        { criteria: { id: photo.id }, values: { preview_path: key } },
      ]);
    }
  );

  it('short-circuits on an existing valid preview instead of regenerating', async () => {
    const relpath = 'already-previewed.jpg';
    await writeSourceJpeg(path.join(EXTERNAL_ROOT, EVENT.external_path, relpath));
    const photo = {
      id: 103,
      event_id: EVENT.id,
      source_origin: 'external',
      external_relpath: relpath,
      filename: relpath,
      preview_path: null,
    };

    const first = await imageProcessor.ensurePreviewImage(photo);
    db.__state.updates = [];

    const second = await imageProcessor.ensurePreviewImage({ ...photo, preview_path: first });
    expect(second).toBe(first);
    expect(db.__state.updates).toEqual([]);
  });

  it('returns null (never throws) when the external source is missing', async () => {
    const photo = {
      id: 104,
      event_id: EVENT.id,
      source_origin: 'external',
      external_relpath: 'not-on-the-mount.jpg',
      filename: 'not-on-the-mount.jpg',
      preview_path: null,
    };

    await expect(imageProcessor.ensurePreviewImage(photo)).resolves.toBeNull();
    expect(db.__state.updates).toEqual([]);
  });

  it('returns null (never throws) for a row with no source_origin in a reference event', async () => {
    // Mode falls back to event.source_mode = 'reference', so
    // resolvePhotoStorageKey yields null. That used to reach withLocalCopy and
    // throw out of ensurePreviewImage instead of honouring null-on-failure.
    const photo = {
      id: 105,
      event_id: EVENT.id,
      source_origin: null,
      external_relpath: null,
      filename: 'orphan.jpg',
      path: 'nas-wedding/individual/orphan.jpg',
      preview_path: null,
    };

    await expect(imageProcessor.ensurePreviewImage(photo)).resolves.toBeNull();
    expect(db.__state.updates).toEqual([]);
  });

  it('branches on source_origin, so a row selected without it looks managed', async () => {
    // Pins why the /regenerate-previews caller must select source_origin:
    // an external row missing that column takes the managed path, where
    // resolvePhotoStorageKey yields null and generation is skipped.
    const relpath = 'column-starved.jpg';
    await writeSourceJpeg(path.join(EXTERNAL_ROOT, EVENT.external_path, relpath));
    const starved = {
      id: 106,
      event_id: EVENT.id,
      external_relpath: relpath,
      preview_path: null,
    };

    await expect(imageProcessor.ensurePreviewImage(starved)).resolves.toBeNull();
    await expect(
      imageProcessor.ensurePreviewImage({ ...starved, source_origin: 'external', filename: relpath })
    ).resolves.toBe(`previews/preview_ext106_${relpath}`);
  });

  it('still routes managed photos through the storage backend', async () => {
    const sourceKey = 'events/active/managed-event/individual/managed.jpg';
    const localSource = path.join(os.tmpdir(), `picpeak-managed-${process.pid}.jpg`);
    await writeSourceJpeg(localSource, { width: 800, height: 600 });
    await storage.put(sourceKey, await fs.readFile(localSource), { contentType: 'image/jpeg' });
    await fs.rm(localSource, { force: true });

    db.__state.event = { id: 8, slug: 'managed-event', source_mode: 'managed' };
    const photo = {
      id: 201,
      event_id: 8,
      source_origin: 'managed',
      path: 'managed-event/individual/managed.jpg',
      filename: 'managed.jpg',
      preview_path: null,
    };

    const key = await imageProcessor.ensurePreviewImage(photo);
    expect(key).toBe('previews/preview_managed.jpg');
    expect(await storage.exists(key)).toBe(true);
  });
});
