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
const fsp = require('fs').promises;
const os = require('os');
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
  // fetched the source, before its first sharp call. `seen.sourceOpens`
  // counts A's sharp calls on a file (two per thumbnail render).
  function replicaA(whileRendering, seen = {}) {
    const shared = { db: require(DB), storage: require(STORAGE), sharp: require(SHARP) };
    let pending = whileRendering;
    const hooked = new Proxy(shared.sharp, {
      apply(target, self, args) {
        const chain = Reflect.apply(target, self, args);
        if (typeof args[0] === 'string') seen.sourceOpens = (seen.sourceOpens || 0) + 1;
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

  const storages = [['local storage', LocalFs], ['S3-like storage', RemoteLike]];
  const rowKey = async id => (await db('photos').where({ id }).first()).thumbnail_path;

  test.each(storages)('%s: the forced render under the new settings stays, and A answers it', async (_label, Kind) => {
    const storage = await useStorage(Kind);
    const row = await photo(storage, `race-${Kind.name}.jpg`);
    const put = jest.spyOn(storage, 'put');
    let forced;
    const a = replicaA(async () => {
      await setFit('inside');
      forced = await replicaB.ensureThumbnail({ ...row, thumbnail_path: null }, { force: true });
    });

    const key = await a.ensureThumbnail(row);

    expect(forced).toMatch(/^thumbnails\/thumb_/);
    expect(key).toBe(forced);
    expect(thumbnailPuts(put)).toEqual([forced]);
    expect(await rowKey(row.id)).toBe(forced);
    expect(await heightOf(forced)).toBe(225);
  });

  // The settings change and B's forced render land after A's write, before A
  // records it: on S3 A's key is its own, on local storage it is B's too.
  test.each(storages)('%s: a change landing between the write and the row update is caught too', async (_label, Kind) => {
    const storage = await useStorage(Kind);
    const row = await photo(storage, `late-${Kind.name}.jpg`);
    const put = storage.put.bind(storage);
    let written;
    let forced;
    jest.spyOn(storage, 'put').mockImplementation(async (key, ...args) => {
      const value = await put(key, ...args);
      if (!written && key.startsWith('thumbnails/')) {
        written = key;
        await setFit('inside');
        forced = await replicaB.ensureThumbnail({ ...row, thumbnail_path: null }, { force: true });
      }
      return value;
    });
    const a = replicaA(null);

    const key = await a.ensureThumbnail(row);

    expect(key).toBe(forced);
    expect(await rowKey(row.id)).toBe(forced);
    expect(await heightOf(forced)).toBe(225);
    if (Kind === LocalFs) {
      expect(written).toBe(forced);
    } else {
      expect(written).not.toBe(forced);
      expect(await storage.stat(written)).toBeFalsy();
    }
  });

  // Local storage: B has written the shared key but not recorded it yet when
  // A finds its own write stale. Deleting "a key no row records" would take
  // B's file with it.
  test('local storage: a forced render written but not yet recorded is not deleted', async () => {
    const storage = await useStorage(LocalFs);
    const row = await photo(storage, 'unrecorded.jpg');
    const put = storage.put.bind(storage);
    const del = jest.spyOn(storage, 'delete');
    let releaseB;
    const holdB = new Promise(resolve => { releaseB = resolve; });
    let bWrote;
    let forcedRun;
    let puts = 0;
    jest.spyOn(storage, 'put').mockImplementation(async (key, ...args) => {
      const value = await put(key, ...args);
      if (!key.startsWith('thumbnails/')) return value;
      puts += 1;
      if (puts === 1) { // A's write, under the old settings
        await setFit('inside');
        const written = new Promise(resolve => { bWrote = resolve; });
        forcedRun = replicaB.ensureThumbnail({ ...row, thumbnail_path: null }, { force: true });
        await written;
      } else if (puts === 2) { // B's write: hold B before its row update
        bWrote();
        await holdB;
      }
      return value;
    });
    const a = replicaA(null);

    const key = await a.ensureThumbnail(row);
    releaseB();
    const forced = await forcedRun;

    expect(key).toBe(forced);
    expect(del).not.toHaveBeenCalledWith(forced);
    expect(await rowKey(row.id)).toBe(forced);
    expect(await heightOf(forced)).toBe(225);
  });

  // Inside a processing attempt a RAW gets no lazy scope, and its key is
  // named after the RAW, not after the random download: shared on S3 too.
  test('S3-like storage: an unscoped RAW key is kept and written again, not deleted', async () => {
    const storage = await useStorage(RemoteLike);
    const row = await photo(storage, 'attempt.dng');
    const preview = await sharp({ create: { width: 640, height: 480, channels: 3, background: 'green' } }).jpeg().toBuffer();
    jest.spyOn(require('../../src/services/mediaProcessService'), 'withSnapshot').mockImplementation(async () => {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'picpeak-raw-test-'));
      const file = path.join(dir, 'preview.jpg');
      await fsp.writeFile(file, preview);
      return { path: file, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
    });
    const put = storage.put.bind(storage);
    const del = jest.spyOn(storage, 'delete');
    const writes = [];
    jest.spyOn(storage, 'put').mockImplementation(async (key, ...args) => {
      const value = await put(key, ...args);
      if (key.startsWith('thumbnails/')) {
        writes.push(key);
        if (writes.length === 1) await setFit('inside');
      }
      return value;
    });

    const key = await require('../../src/services/mediaAttemptContext')
      .run({ assertCurrent: async () => {} }, () => replicaB.ensureThumbnail(row));

    expect(writes).toEqual([key, key]);
    expect(del).not.toHaveBeenCalledWith(key);
    expect(await rowKey(row.id)).toBe(key);
    expect(await heightOf(key)).toBe(225);
  });

  test('a thumbnail recorded since for a replaced source is not taken', async () => {
    const storage = await useStorage(RemoteLike);
    const row = await photo(storage, 'before.jpg');
    const replacement = await sharp({ create: { width: 640, height: 480, channels: 3, background: 'blue' } }).jpeg().toBuffer();
    await storage.put('events/active/main-thumb-race/individual/after.jpg', replacement, { contentType: 'image/jpeg' });
    let forced;
    const a = replicaA(async () => {
      await setFit('inside');
      await db('photos').where({ id: row.id }).update({ filename: 'after.jpg', path: 'main-thumb-race/individual/after.jpg' });
      forced = await replicaB.ensureThumbnail({ ...(await db('photos').where({ id: row.id }).first()), thumbnail_path: null }, { force: true });
    });

    const key = await a.ensureThumbnail(row);

    expect(forced).toMatch(/^thumbnails\/thumb_/);
    expect(key).toBeNull();
    expect(await rowKey(row.id)).toBe(forced);
  });

  test.each(storages)('%s: a change with no forced render yet renders again under the new settings', async (_label, Kind) => {
    const storage = await useStorage(Kind);
    const row = await photo(storage, `again-${Kind.name}.jpg`);
    const put = jest.spyOn(storage, 'put');
    const a = replicaA(() => setFit('inside'));

    const key = await a.ensureThumbnail(row);

    expect(key).toMatch(/^thumbnails\/thumb_/);
    expect(thumbnailPuts(put)).toEqual([key]);
    expect(await rowKey(row.id)).toBe(key);
    expect(await heightOf(key)).toBe(225);
  });

  test.each(storages)('%s: without a settings change the lazy render publishes, as before', async (_label, Kind) => {
    const storage = await useStorage(Kind);
    const row = await photo(storage, `plain-${Kind.name}.jpg`);
    const a = replicaA(null);

    const key = await a.ensureThumbnail(row);

    expect(key).toMatch(/^thumbnails\/thumb_/);
    expect(await rowKey(row.id)).toBe(key);
    expect(await heightOf(key)).toBe(300);
  });

  // Fails the next app_settings read once `arm()` was called.
  function failNextSettingsRead() {
    const realDb = require(DB).db;
    const original = realDb.client.runner;
    const state = { armed: false, failed: false, arm: () => { state.armed = true; } };
    jest.spyOn(realDb.client, 'runner').mockImplementation(function (builder) {
      const runner = original.call(this, builder);
      if (state.armed && builder._single && builder._single.table === 'app_settings') {
        state.armed = false;
        state.failed = true;
        runner.run = () => Promise.reject(new Error('settings unavailable'));
      }
      return runner;
    });
    return state;
  }

  test('a settings read that fails at the check publishes, as before', async () => {
    const storage = await useStorage(LocalFs);
    const row = await photo(storage, 'read-fails.jpg');
    const read = failNextSettingsRead();
    const a = replicaA(async () => read.arm());

    const key = await a.ensureThumbnail(row);

    expect(read.failed).toBe(true);
    expect(key).toMatch(/^thumbnails\/thumb_/);
    expect(await rowKey(row.id)).toBe(key);
  });

  test('a first settings read that fails renders under the stored settings and publishes', async () => {
    // The fit is 'cover' (beforeEach), not the default: comparing against the
    // defaults a failed read answers would drop the render.
    const storage = await useStorage(LocalFs);
    const row = await photo(storage, 'first-read-fails.jpg');
    const read = failNextSettingsRead();
    const seen = {};
    const a = replicaA(null, seen);
    read.arm();

    const key = await a.ensureThumbnail(row);

    expect(read.failed).toBe(true);
    expect(seen.sourceOpens).toBe(2);
    expect(key).toMatch(/^thumbnails\/thumb_/);
    expect(await rowKey(row.id)).toBe(key);
    expect(await heightOf(key)).toBe(300);
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
