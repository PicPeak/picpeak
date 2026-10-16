/**
 * Issue 2122: a lazy thumbnail tier rendered under the old settings and
 * written after "Regenerate thumbnails" had dropped the photo's tiers used to
 * be kept, because its key carries no settings and the source had not
 * changed. The old fit kept being served.
 */
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

describe('a lazy thumbnail tier across a settings change and regenerate', () => {
  let db, cleanup, storage, imageProcessor, eventId;
  const resultId = rows => rows[0]?.id ?? rows[0];

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    eventId = resultId(await db('events').insert({ slug: 'tier-settings', event_type: 'wedding', event_name: 'Tier settings',
      event_date: '2026-10-15', host_email: 'host@fixture.invalid', admin_email: 'admin@fixture.invalid',
      password_hash: 'x', share_link: '/gallery/tier-settings/share', expires_at: new Date(Date.now() + 3600000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_by: adminId }).returning('id'));
    const LocalFs = require('../../src/services/storage/LocalFsStorage');
    storage = new LocalFs({ root: process.env.STORAGE_PATH }); await storage.init();
    require('../../src/services/storage').setStorageForTesting(storage);
    imageProcessor = require('../../src/services/imageProcessor');
  }, 60000);
  afterAll(async () => {
    await require('../../src/services/isolatedSharp').shutdown();
    require('../../src/services/storage').resetStorage();
    if (cleanup) await cleanup();
  });
  beforeEach(() => setFit('cover'));
  afterEach(() => jest.restoreAllMocks());

  async function setFit(fit) {
    const value = JSON.stringify(fit);
    if (!(await db('app_settings').where({ setting_key: 'thumbnail_fit' }).update({ setting_value: value }))) {
      await db('app_settings').insert({ setting_key: 'thumbnail_fit', setting_value: value, setting_type: 'thumbnail' });
    }
  }

  async function photo(name) {
    const jpeg = await sharp({ create: { width: 640, height: 480, channels: 3, background: 'red' } }).jpeg().toBuffer();
    await storage.put(`events/active/tier-settings/individual/${name}`, jpeg, { contentType: 'image/jpeg' });
    const id = resultId(await db('photos').insert({ event_id: eventId, filename: name, original_filename: name,
      path: `tier-settings/individual/${name}`, type: 'individual', mime_type: 'image/jpeg', media_type: 'image',
      size_bytes: jpeg.length, processing_status: 'complete', source_origin: 'managed' }).returning('id'));
    return db('photos').where({ id }).first();
  }

  // A RAW photo renders from its embedded preview; stand one in.
  async function rawPhoto(name) {
    const row = await photo(name);
    const jpeg = await sharp({ create: { width: 640, height: 480, channels: 3, background: 'green' } }).jpeg().toBuffer();
    jest.spyOn(require('../../src/services/mediaProcessService'), 'withSnapshot').mockImplementation(async () => {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'picpeak-raw-test-'));
      const file = path.join(dir, 'preview.jpg');
      await fsp.writeFile(file, jpeg);
      return { path: file, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
    });
    return row;
  }

  // Just before the tier lands in storage, the admin changes the fit and the
  // regenerate sweep drops this photo's tiers (adminThumbnails /regenerate).
  function settingsChangeAndSweepBeforeTierWrite(row) {
    const put = storage.put.bind(storage);
    let fired = false;
    return jest.spyOn(storage, 'put').mockImplementation(async (key, ...args) => {
      if (!fired && key.startsWith('thumbnails/thumb_w')) {
        fired = true;
        await setFit('contain');
        await imageProcessor.deleteThumbnailTiers(row, { strict: true });
      }
      return put(key, ...args);
    });
  }

  const writtenTier = spy => spy.mock.calls.map(([key]) => key).find(key => key.startsWith('thumbnails/thumb_w'));

  test.each([['an ordinary image', 'plain.jpg', photo], ['a RAW photo', 'raw.dng', rawPhoto]])(
    '%s: the old-settings tier is not published, the next render under the new settings is', async (_label, name, make) => {
      const row = await make(name);
      const spy = settingsChangeAndSweepBeforeTierWrite(row);

      await expect(imageProcessor.ensureThumbnailAtWidth(row, 600)).resolves.toBeNull();
      const stale = writtenTier(spy);
      expect(stale).toBeTruthy();
      expect(await storage.stat(stale)).toBeFalsy();

      const key = await imageProcessor.ensureThumbnailAtWidth(row, 600);
      expect(key).toBe(stale);
      expect((await storage.stat(key)).size).toBeGreaterThan(0);
    }
  );

  test('without a settings change the tier is kept, as before', async () => {
    const row = await photo('unchanged.jpg');
    const key = await imageProcessor.ensureThumbnailAtWidth(row, 600);
    expect(key).toMatch(/^thumbnails\/thumb_w600_/);
    expect((await storage.stat(key)).size).toBeGreaterThan(0);
  });

  test('a regenerate sweep without a settings change does not drop a lazy tier', async () => {
    const row = await photo('sweep-only.jpg');
    const put = storage.put.bind(storage);
    jest.spyOn(storage, 'put').mockImplementation(async (key, ...args) => {
      if (key.startsWith('thumbnails/thumb_w')) await imageProcessor.deleteThumbnailTiers(row, { strict: true });
      return put(key, ...args);
    });
    const key = await imageProcessor.ensureThumbnailAtWidth(row, 600);
    expect(key).toMatch(/^thumbnails\/thumb_w600_/);
    expect((await storage.stat(key)).size).toBeGreaterThan(0);
  });

  test('a settings read that fails at the check keeps the tier', async () => {
    // The fit is 'cover' (beforeEach), not the default: answering the
    // defaults instead of failing would drop the tier.
    const row = await photo('read-fails.jpg');
    const put = storage.put.bind(storage);
    let failNext = false;
    let failed = false;
    jest.spyOn(storage, 'put').mockImplementation(async (key, ...args) => {
      const value = await put(key, ...args);
      if (key.startsWith('thumbnails/thumb_w')) failNext = true;
      return value;
    });
    const realDb = require('../../src/database/db').db;
    const original = realDb.client.runner;
    // Fail only the app_settings read issued after the tier write.
    jest.spyOn(realDb.client, 'runner').mockImplementation(function (builder) {
      const runner = original.call(this, builder);
      if (failNext && builder._single && builder._single.table === 'app_settings') {
        failNext = false;
        failed = true;
        runner.run = () => Promise.reject(new Error('settings unavailable'));
      }
      return runner;
    });
    const key = await imageProcessor.ensureThumbnailAtWidth(row, 600);
    expect(failed).toBe(true);
    expect(key).toMatch(/^thumbnails\/thumb_w600_/);
    expect((await storage.stat(key)).size).toBeGreaterThan(0);
  });
});
