/**
 * ensureHeroImage must work for external/reference photos (#1166 follow-up).
 *
 * resolvePhotoStorageKey returns null for external photos by design, and that
 * null used to be handed straight to withLocalCopy, which throws — so the hero
 * route caught it and redirected to the full ORIGINAL. #1078 fixed exactly
 * this shape for ensurePreviewImage and nobody carried it across.
 *
 * It only became visible when the Story hero started asking for hero_url
 * instead of photo.url: on a managed gallery that is a real saving, on a
 * reference-mode gallery it quietly changed nothing.
 */
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const sharp = require('sharp');

const EXTERNAL_ROOT = path.join(os.tmpdir(), `picpeak-hero-ext-${process.pid}`);
process.env.EXTERNAL_MEDIA_ROOT = EXTERNAL_ROOT;

jest.mock('../../src/database/db', () => {
  const state = { event: null, updates: [] };
  const api = (table) => {
    if (table === 'events') return { where: () => ({ first: async () => state.event }) };
    if (table === 'photos') {
      return { where: (criteria) => ({ update: async (values) => { state.updates.push({ criteria, values }); return 1; } }) };
    }
    throw new Error(`unexpected table in test: ${table}`);
  };
  api.__state = state;
  return { db: api };
});

const LocalFsStorage = require('../../src/services/storage/LocalFsStorage');
const storageModule = require('../../src/services/storage');
const { db } = require('../../src/database/db');

const EVENT = { id: 7, slug: 'nas-wedding', source_mode: 'reference', external_path: 'weddings/2026-08' };

async function writeSourceJpeg(absPath, { width = 2400, height = 1600 } = {}) {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  const buf = Buffer.alloc(width * height * 3);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 7) % 256;
  await sharp(buf, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 }).toFile(absPath);
}

describe('ensureHeroImage — external sources', () => {
  let storage; let storageRoot; let imageProcessor;

  beforeAll(async () => {
    storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-hero-store-'));
    storage = new LocalFsStorage({ root: storageRoot });
    await storage.init();
    storageModule.setStorageForTesting(storage);
    delete require.cache[require.resolve('../../src/services/imageProcessor')];
    imageProcessor = require('../../src/services/imageProcessor');
    await fs.mkdir(path.join(EXTERNAL_ROOT, EVENT.external_path), { recursive: true });
  }, 30000);

  afterAll(async () => {
    storageModule.resetStorage();
    await fs.rm(storageRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(EXTERNAL_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(() => { db.__state.event = EVENT; db.__state.updates = []; });

  it.each(['external', 'reference'])('generates a hero for a %s photo off the mount', async (sourceOrigin) => {
    const name = `${sourceOrigin}-hero.jpg`;
    await writeSourceJpeg(path.join(EXTERNAL_ROOT, EVENT.external_path, name));
    const photo = {
      id: sourceOrigin === 'external' ? 301 : 302,
      event_id: EVENT.id,
      source_origin: sourceOrigin,
      // Root-relative, as stored since #1163: external_relpath is resolved
      // from EXTERNAL_MEDIA_ROOT, not from event.external_path. The base-
      // relative form this fixture used to carry stopped resolving the moment
      // that landed, and ensureHeroImage returned null.
      external_relpath: path.join(EVENT.external_path, name),
      filename: name,
      hero_path: null,
    };

    const key = await imageProcessor.ensureHeroImage(photo);

    // The regression: this returned null and the route redirected to the
    // full original.
    expect(key).toBeTruthy();
    expect(await storage.exists(key)).toBe(true);
    // Per-photo basename, so two events sharing a NAS filename cannot clobber
    // each other — same rule as the preview tier.
    expect(key).toContain(`ext${photo.id}_`);
    expect(db.__state.updates).toEqual([{ criteria: { id: photo.id }, values: { hero_path: key } }]);
  });

  it('returns null rather than throwing when the external source is gone', async () => {
    const photo = {
      id: 303, event_id: EVENT.id, source_origin: 'external',
      external_relpath: path.join(EVENT.external_path, 'not-on-the-mount.jpg'), filename: 'not-on-the-mount.jpg', hero_path: null,
    };

    await expect(imageProcessor.ensureHeroImage(photo)).resolves.toBeNull();
    expect(db.__state.updates).toEqual([]);
  });

  it('returns null for a reference-mode row with no source_origin', async () => {
    // Mode falls back to the event's, so resolvePhotoStorageKey yields null.
    // That used to reach withLocalCopy and throw out of the function.
    const photo = {
      id: 304, event_id: EVENT.id, source_origin: null, external_relpath: null,
      filename: 'orphan.jpg', path: 'nas-wedding/individual/orphan.jpg', hero_path: null,
    };

    await expect(imageProcessor.ensureHeroImage(photo)).resolves.toBeNull();
  });
});
