/**
 * deleteThumbnailTiers / deletePreviewTiers (issue 2113).
 *
 * A RAW photo's cached sizes are named through its processing attempt
 * (derivativeCacheId), so a row handed in without processing_attempt_id
 * derives other keys and the old tiers stay. And the deletes used to swallow
 * every storage error, so a failed delete looked like a clean one. Now a
 * missing object is still fine, anything else is reported: logged by
 * default, thrown with `strict`.
 */
const path = require('path');
const fs = require('fs').promises;
const os = require('os');

// Managed rows only: withSourceVersion reads the database for external rows
// alone, so nothing here may reach it.
jest.mock('../../src/database/db', () => ({
  db: () => { throw new Error('unexpected database access in test'); },
}));

const LocalFsStorage = require('../../src/services/storage/LocalFsStorage');
const storageModule = require('../../src/services/storage');
const logger = require('../../src/utils/logger');

const RAW_ROW = {
  id: 7101, event_id: 31, source_origin: 'managed',
  path: 'raw-ev/IMG_0001.NEF', filename: 'IMG_0001.NEF', processing_attempt_id: 'attempt-a1',
};

describe('tier deletes (issue 2113)', () => {
  let storage; let storageRoot; let imageProcessor; let warn;

  beforeAll(async () => {
    storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-tierdel-'));
    storage = new LocalFsStorage({ root: storageRoot });
    await storage.init();
    storageModule.setStorageForTesting(storage);
    delete require.cache[require.resolve('../../src/services/imageProcessor')];
    imageProcessor = require('../../src/services/imageProcessor');
  });

  beforeEach(() => { warn = jest.spyOn(logger, 'warn').mockImplementation(() => {}); });
  afterEach(() => { jest.restoreAllMocks(); });

  afterAll(async () => {
    storageModule.resetStorage();
    await fs.rm(storageRoot, { recursive: true, force: true }).catch(() => {});
  });

  const exists = (key) => storage.stat(key).then(Boolean);

  it('derives a RAW row\'s tier keys from its processing attempt', () => {
    const partial = { ...RAW_ROW };
    delete partial.processing_attempt_id;
    const full = [...imageProcessor.thumbnailTierKeys(RAW_ROW), ...imageProcessor.previewTierKeys(RAW_ROW)];
    const withoutAttempt = new Set([...imageProcessor.thumbnailTierKeys(partial), ...imageProcessor.previewTierKeys(partial)]);
    // The attempt-scoped keys (where the cached sizes are written) are not
    // among what a row without the attempt derives.
    expect(full.filter((k) => !withoutAttempt.has(k)).length).toBeGreaterThan(0);
  });

  it('deletes the cached sizes written under the attempt-scoped keys', async () => {
    const scoped = [imageProcessor.thumbnailTierKeys(RAW_ROW)[0], imageProcessor.previewTierKeys(RAW_ROW)[0]];
    for (const key of scoped) await storage.put(key, Buffer.from('old tier'));
    const partial = { ...RAW_ROW };
    delete partial.processing_attempt_id;

    // What the regenerate action did before: the row lacked the attempt id.
    await imageProcessor.deleteThumbnailTiers(partial, { strict: true });
    await imageProcessor.deletePreviewTiers(partial, { strict: true });
    expect(await Promise.all(scoped.map(exists))).toEqual([true, true]);

    await imageProcessor.deleteThumbnailTiers(RAW_ROW, { strict: true });
    await imageProcessor.deletePreviewTiers(RAW_ROW, { strict: true });
    expect(await Promise.all(scoped.map(exists))).toEqual([false, false]);
  });

  it('treats a missing tier as deleted', async () => {
    await expect(imageProcessor.deleteThumbnailTiers({ ...RAW_ROW, id: 7102 }, { strict: true })).resolves.toBeUndefined();
    await expect(imageProcessor.deletePreviewTiers({ ...RAW_ROW, id: 7102 }, { strict: true })).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  // The other sweeps that hand the helpers a partial row. Both run against
  // mocked or joined selects elsewhere, so the column list is pinned here.
  it.each([
    ['event delete cascade', '../../src/routes/adminEvents/helpers.js', /const tieredPhotos = await db\('photos'\)([\s\S]*?)'hls_status'\);/, ['event_id', 'processing_attempt_id']],
    ['orientation repair', '../../src/routes/adminPhotoDimensions.js', /'photos\.event_id',\s*'photos\.width', 'photos\.height', 'photos\.face_status',([\s\S]*?)'events\.slug'/, ['photos.processing_attempt_id']],
  ])('the %s selects what a RAW row\'s tier keys need', async (_name, file, pattern, columns) => {
    const source = await fs.readFile(path.join(__dirname, file), 'utf8');
    const select = source.match(pattern);
    expect(select).not.toBeNull();
    for (const column of columns) expect(select[1]).toContain(`'${column}'`);
  });

  describe('a storage error', () => {
    const failOn = (keys) => {
      const original = storage.delete.bind(storage);
      const tried = [];
      jest.spyOn(storage, 'delete').mockImplementation(async (key) => {
        tried.push(key);
        if (keys.includes(key)) throw Object.assign(new Error('AccessDenied'), { name: 'AccessDenied' });
        return original(key);
      });
      return tried;
    };

    it('rejects with strict, after trying every key', async () => {
      const keys = imageProcessor.thumbnailTierKeys(RAW_ROW);
      const tried = failOn([keys[0]]);
      const rejection = imageProcessor.deleteThumbnailTiers(RAW_ROW, { strict: true });
      await expect(rejection).rejects.toThrow(/Could not delete 1 thumbnail tier\(s\) of photo 7101: AccessDenied/);
      await expect(rejection).rejects.toMatchObject({ failedKeys: [keys[0]] });
      expect(tried.sort()).toEqual([...keys].sort());
    });

    it('rejects for previews too', async () => {
      const keys = imageProcessor.previewTierKeys(RAW_ROW);
      failOn([keys[1]]);
      await expect(imageProcessor.deletePreviewTiers(RAW_ROW, { strict: true }))
        .rejects.toMatchObject({ failedKeys: [keys[1]] });
    });

    // Photo delete, trash purge, archive, replacement and rename call the
    // helpers without options and carry on after them.
    it('is logged, not thrown, for best-effort callers', async () => {
      failOn([imageProcessor.thumbnailTierKeys(RAW_ROW)[0], imageProcessor.previewTierKeys(RAW_ROW)[0]]);
      await expect(imageProcessor.deleteThumbnailTiers(RAW_ROW)).resolves.toBeUndefined();
      await expect(imageProcessor.deletePreviewTiers(RAW_ROW)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[0][0])).toMatch(/thumbnail tier\(s\) of photo 7101/);
    });
  });
});
