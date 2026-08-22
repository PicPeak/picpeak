/**
 * Regeneration must not destroy a good thumbnail when the source is
 * unreadable (#1129).
 *
 * The old code deleted the target BEFORE sharp opened the source, so a NAS
 * mount that blipped mid-run left the previous rendition gone and the database
 * still pointing at it. Across a bulk regenerate that is the whole gallery,
 * and it is precisely the "worse than before you pressed it" outcome #1129 is
 * about.
 */

const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const sharp = require('sharp');

jest.mock('../../src/database/db', () => ({
  db: () => ({ where: () => ({ first: async () => null, update: async () => 1 }) }),
}));

const LocalFsStorage = require('../../src/services/storage/LocalFsStorage');
const storageModule = require('../../src/services/storage');

describe('generateThumbnail — regenerate is non-destructive (#1129)', () => {
  let storage; let root; let imageProcessor; let srcDir;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-regen-store-'));
    srcDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-regen-src-'));
    storage = new LocalFsStorage({ root });
    await storage.init();
    storageModule.setStorageForTesting(storage);

    delete require.cache[require.resolve('../../src/services/imageProcessor')];
    imageProcessor = require('../../src/services/imageProcessor');
  }, 30000);

  afterAll(async () => {
    storageModule.resetStorage();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    await fs.rm(srcDir, { recursive: true, force: true }).catch(() => {});
  });

  async function writeSource(name, size = 400) {
    const p = path.join(srcDir, name);
    await sharp({ create: { width: size, height: size, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .jpeg().toFile(p);
    return p;
  }

  it('keeps the existing thumbnail when the source cannot be read', async () => {
    const src = await writeSource('present.jpg');
    const key = await imageProcessor.generateThumbnail(src, { regenerate: true });
    expect(key).toBeTruthy();
    expect(await storage.exists(key)).toBe(true);
    const before = await storage.get(key).then((s) => new Promise((res) => {
      const c = []; s.on('data', (d) => c.push(d)); s.on('end', () => res(Buffer.concat(c)));
    }));

    // The mount goes away between runs.
    await fs.unlink(src);
    const second = await imageProcessor.generateThumbnail(src, { regenerate: true })
      .catch(() => null);

    expect(second).toBeFalsy();
    // The old rendition is still there and still serves. Previously it had
    // been deleted before sharp ever looked at the source.
    expect(await storage.exists(key)).toBe(true);
    const after = await storage.get(key).then((s) => new Promise((res) => {
      const c = []; s.on('data', (d) => c.push(d)); s.on('end', () => res(Buffer.concat(c)));
    }));
    expect(after.equals(before)).toBe(true);
  });

  it('still replaces the thumbnail when the source IS readable', async () => {
    const src = await writeSource('replaceme.jpg', 400);
    const key = await imageProcessor.generateThumbnail(src, { regenerate: true });
    const firstSize = (await storage.stat(key)).size;

    // Same key, different source content — the atomic rename in put() is what
    // makes the pre-delete unnecessary.
    await fs.rm(src);
    await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 250, g: 40, b: 9 } } })
      .jpeg().toFile(src);
    const again = await imageProcessor.generateThumbnail(src, { regenerate: true });

    expect(again).toBe(key);
    expect((await storage.stat(key)).size).not.toBe(firstSize);
  });
});
