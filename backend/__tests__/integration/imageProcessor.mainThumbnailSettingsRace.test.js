/**
 * Issue 2131: a lazy render of a photo's main thumbnail, still running under
 * the old settings while an admin saved new ones and "Regenerate thumbnails"
 * force-rendered the photo on another replica, landed after the sweep. On
 * local storage both write one key and the old fit overwrote the new file;
 * on S3 the row ended up on the old render.
 *
 * Two replicas: replica A is a second copy of imageProcessor (its own
 * in-flight map, so `force` on B cannot wait for A's flight) sharing the
 * database, the storage and the sharp pool with replica B, the copy this
 * file requires normally.
 */
const path = require('path');
const sharp = require('sharp');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

const DB = '../../src/database/db';
const STORAGE = '../../src/services/storage';
const SHARP = '../../src/services/isolatedSharp';

describe('a lazy main thumbnail across a settings change and a forced regenerate on another replica', () => {
  let db, cleanup, root, replicaB, eventId;
  const resultId = rows => rows[0]?.id ?? rows[0];

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    eventId = resultId(await db('events').insert({ slug: 'main-thumb-race', event_type: 'wedding', event_name: 'Main thumb race',
      event_date: '2026-10-15', host_email: 'host@fixture.invalid', admin_email: 'admin@fixture.invalid',
      password_hash: 'x', share_link: '/gallery/main-thumb-race/share', expires_at: new Date(Date.now() + 3600000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_by: adminId }).returning('id'));
    root = process.env.STORAGE_PATH;
    replicaB = require('../../src/services/imageProcessor');
  }, 60000);
  afterAll(async () => {
    await require(SHARP).shutdown();
    require(STORAGE).resetStorage();
    if (cleanup) await cleanup();
  });
  beforeEach(() => setFit('cover'));
  afterEach(() => jest.restoreAllMocks());

  // An S3-like backend: no local path, so a render downloads the source to a
  // randomly named temp file and its key differs on every run.
  const LocalFs = require('../../src/services/storage/LocalFsStorage');
  class RemoteLike extends LocalFs { kind() { return 's3'; } }

  async function useStorage(Kind) {
    const storage = new Kind({ root });
    await storage.init();
    require(STORAGE).setStorageForTesting(storage);
    return storage;
  }

  async function setFit(fit) {
    const value = JSON.stringify(fit);
    if (!(await db('app_settings').where({ setting_key: 'thumbnail_fit' }).update({ setting_value: value }))) {
      await db('app_settings').insert({ setting_key: 'thumbnail_fit', setting_value: value, setting_type: 'thumbnail' });
    }
  }

  // 640x480: 'cover' renders 300x300, 'inside' 300x225.
  async function photo(storage, name) {
    const jpeg = await sharp({ create: { width: 640, height: 480, channels: 3, background: 'red' } }).jpeg().toBuffer();
    await storage.put(`events/active/main-thumb-race/individual/${name}`, jpeg, { contentType: 'image/jpeg' });
    const id = resultId(await db('photos').insert({ event_id: eventId, filename: name, original_filename: name,
      path: `main-thumb-race/individual/${name}`, type: 'individual', mime_type: 'image/jpeg', media_type: 'image',
      size_bytes: jpeg.length, processing_status: 'complete', source_origin: 'managed' }).returning('id'));
    return db('photos').where({ id }).first();
  }

  // Replica A. `whileRendering` runs once, after A has read its settings and
  // fetched the source, before its first sharp call.
  function replicaA(whileRendering) {
    const shared = { db: require(DB), storage: require(STORAGE), sharp: require(SHARP) };
    let pending = whileRendering;
    const hooked = new Proxy(shared.sharp, {
      apply(target, self, args) {
        const chain = Reflect.apply(target, self, args);
        if (pending) {
          const run = pending;
          pending = null;
          const metadata = chain.metadata;
          chain.metadata = async () => { await run(); return metadata(); };
        }
        return chain;
      },
    });
    let copy;
    jest.isolateModules(() => {
      jest.doMock(DB, () => shared.db);
      jest.doMock(STORAGE, () => shared.storage);
      jest.doMock(SHARP, () => hooked);
      copy = require('../../src/services/imageProcessor');
      jest.dontMock(DB);
      jest.dontMock(STORAGE);
      jest.dontMock(SHARP);
    });
    return copy;
  }

  const thumbnailPuts = spy => spy.mock.calls.map(([key]) => key).filter(key => key.startsWith('thumbnails/'));
  const heightOf = async key => (await sharp(path.join(root, key)).metadata()).height;

  test.each([['local storage', LocalFs], ['S3-like storage', RemoteLike]])(
    '%s: the forced render under the new settings stays', async (_label, Kind) => {
      const storage = await useStorage(Kind);
      const row = await photo(storage, `race-${Kind.name}.jpg`);
      const put = jest.spyOn(storage, 'put');
      let forced;
      const a = replicaA(async () => {
        await setFit('inside');
        forced = await replicaB.ensureThumbnail({ ...row, thumbnail_path: null }, { force: true });
      });

      await expect(a.ensureThumbnail(row)).resolves.toBeNull();

      expect(forced).toMatch(/^thumbnails\/thumb_/);
      expect(thumbnailPuts(put)).toEqual([forced]);
      expect((await db('photos').where({ id: row.id }).first()).thumbnail_path).toBe(forced);
      expect(await heightOf(forced)).toBe(225);
    }
  );

  test.each([['local storage', LocalFs], ['S3-like storage', RemoteLike]])(
    '%s: without a settings change the lazy render publishes, as before', async (_label, Kind) => {
      const storage = await useStorage(Kind);
      const row = await photo(storage, `plain-${Kind.name}.jpg`);
      const a = replicaA(null);

      const key = await a.ensureThumbnail(row);

      expect(key).toMatch(/^thumbnails\/thumb_/);
      expect((await db('photos').where({ id: row.id }).first()).thumbnail_path).toBe(key);
      expect(await heightOf(key)).toBe(300);
    }
  );

  test('a settings read that fails at the check publishes, as before', async () => {
    const storage = await useStorage(LocalFs);
    const row = await photo(storage, 'read-fails.jpg');
    const realDb = require(DB).db;
    const original = realDb.client.runner;
    let failNext = false;
    let failed = false;
    // Fail only the app_settings read issued once the render has started.
    jest.spyOn(realDb.client, 'runner').mockImplementation(function (builder) {
      const runner = original.call(this, builder);
      if (failNext && builder._single && builder._single.table === 'app_settings') {
        failNext = false;
        failed = true;
        runner.run = () => Promise.reject(new Error('settings unavailable'));
      }
      return runner;
    });
    const a = replicaA(async () => { failNext = true; });

    const key = await a.ensureThumbnail(row);

    expect(failed).toBe(true);
    expect(key).toMatch(/^thumbnails\/thumb_/);
    expect((await db('photos').where({ id: row.id }).first()).thumbnail_path).toBe(key);
  });

  test('a forced render does not check the settings', async () => {
    const storage = await useStorage(LocalFs);
    const row = await photo(storage, 'forced.jpg');
    const a = replicaA(() => setFit('inside'));

    const key = await a.ensureThumbnail({ ...row, thumbnail_path: null }, { force: true });

    expect(key).toMatch(/^thumbnails\/thumb_/);
    expect((await db('photos').where({ id: row.id }).first()).thumbnail_path).toBe(key);
  });
});
