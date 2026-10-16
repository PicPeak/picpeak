/**
 * Issue 2140: the forced thumbnail renders on the request path (the legacy
 * pointer rebuild of the gallery thumbnail route and of the public OG cover,
 * and the watcher's shared-thumbnail repair) had no settings check. One still
 * running under the old settings while an admin saved new ones and
 * "Regenerate thumbnails" force-rendered the photo on another replica landed
 * after the sweep and kept an old-settings thumbnail.
 *
 * Same two-replica setup as imageProcessor.mainThumbnailSettingsRace: replica
 * A is a second copy of imageProcessor sharing the database, the storage and
 * the sharp pool with replica B, the copy this file requires normally. The
 * code under test (route, OG handler, watcher) is loaded against replica A.
 */
const path = require('path');
const sharp = require('sharp');
const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

const DB = '../../src/database/db';
const STORAGE = '../../src/services/storage';
const SHARP = '../../src/services/isolatedSharp';
const IMAGE_PROCESSOR = '../../src/services/imageProcessor';
const SLUG = 'forced-thumb-race';

describe('a forced request-path thumbnail render across a settings change and a regenerate on another replica', () => {
  let db, cleanup, root, replicaB, eventId, a, forceB;
  // Runs once, after A has fetched the source of a render, before its first
  // sharp call on it.
  let pending = null;
  const resultId = rows => rows[0]?.id ?? rows[0];

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

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    eventId = resultId(await db('events').insert({ slug: SLUG, event_type: 'wedding', event_name: 'Forced thumb race',
      event_date: '2026-10-15', host_email: 'host@fixture.invalid', admin_email: 'admin@fixture.invalid',
      password_hash: 'x', share_link: `/gallery/${SLUG}/share`, share_token: 'forced-thumb-race-share',
      expires_at: new Date(Date.now() + 3600000).toISOString(), require_password: 0, protection_level: 'basic',
      is_active: 1, is_archived: 0, is_draft: 0, created_by: adminId }).returning('id'));
    root = process.env.STORAGE_PATH;
    replicaB = require(IMAGE_PROCESSOR);
    forceB = replicaB.ensureThumbnail;

    const shared = { db: require(DB), storage: require(STORAGE), sharp: require(SHARP) };
    const hooked = new Proxy(shared.sharp, {
      apply(target, self, args) {
        const chain = Reflect.apply(target, self, args);
        // Not on a thumbnail (the validity check of a stored pointer).
        if (pending && typeof args[0] === 'string' && !args[0].includes(`${path.sep}thumbnails${path.sep}`)) {
          const run = pending;
          pending = null;
          const metadata = chain.metadata;
          chain.metadata = async () => { await run(); return metadata(); };
        }
        return chain;
      },
    });
    jest.isolateModules(() => {
      jest.doMock(DB, () => shared.db);
      jest.doMock(STORAGE, () => shared.storage);
      jest.doMock(SHARP, () => hooked);
      a = require(IMAGE_PROCESSOR);
      jest.dontMock(DB);
      jest.dontMock(STORAGE);
      jest.dontMock(SHARP);
    });
    // Everything required from here on (route, OG handler, watcher) runs on
    // replica A.
    jest.doMock(IMAGE_PROCESSOR, () => a);
  }, 60000);
  afterAll(async () => {
    jest.dontMock(IMAGE_PROCESSOR);
    await require(SHARP).shutdown();
    require(STORAGE).resetStorage();
    if (cleanup) await cleanup();
  });
  beforeEach(() => setFit('cover'));
  afterEach(() => { pending = null; jest.restoreAllMocks(); });

  // 640x480: 'cover' renders 300x300, 'inside' 300x225.
  async function photo(storage, name, over = {}) {
    const jpeg = await sharp({ create: { width: 640, height: 480, channels: 3, background: 'red' } }).jpeg().toBuffer();
    await storage.put(`events/active/${SLUG}/individual/${name}`, jpeg, { contentType: 'image/jpeg' });
    const id = resultId(await db('photos').insert({ event_id: eventId, filename: name, original_filename: name,
      path: `${SLUG}/individual/${name}`, type: 'individual', mime_type: 'image/jpeg', media_type: 'image',
      size_bytes: jpeg.length, processing_status: 'complete', source_origin: 'managed', ...over }).returning('id'));
    return db('photos').where({ id }).first();
  }

  // A valid thumbnail under a legacy `./thumbnails/...` pointer: served by
  // nobody, rebuilt by a forced render.
  async function legacyPointer(storage, row) {
    const key = `thumbnails/thumb_legacy-${row.id}.jpg`;
    await storage.put(key, await sharp({ create: { width: 300, height: 300, channels: 3, background: 'gray' } }).jpeg().toBuffer());
    await db('photos').where({ id: row.id }).update({ thumbnail_path: `./${key}` });
    return db('photos').where({ id: row.id }).first();
  }

  // During A's render: new settings saved, and "Regenerate thumbnails" force-
  // renders the photo on replica B.
  function regenerateOnB(row) {
    const state = {};
    pending = async () => {
      await setFit('inside');
      state.forced = await forceB({ ...row, thumbnail_path: null }, { force: true });
    };
    return state;
  }

  const rowKey = async id => (await db('photos').where({ id }).first()).thumbnail_path;
  const heightOf = async key => (await sharp(path.join(root, key)).metadata()).height;
  const binary = (res, cb) => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  };

  describe('gallery thumbnail route, legacy pointer rebuild', () => {
    let app;
    const thumbnail = id => request(app).get(`/api/gallery/${SLUG}/thumbnail/${id}`)
      .set('Authorization', `Bearer ${jwt.sign({ type: 'gallery', eventId, eventSlug: SLUG }, process.env.JWT_SECRET,
        { issuer: 'picpeak-auth', expiresIn: '1h' })}`)
      .buffer().parse(binary);

    beforeAll(() => {
      app = express();
      app.use(express.json());
      app.use(require('cookie-parser')());
      app.use('/api/gallery', require('../../src/routes/gallery'));
    });

    test.each([['local storage', LocalFs], ['S3-like storage', RemoteLike]])(
      '%s: the regenerate under the new settings stays', async (_label, Kind) => {
        const storage = await useStorage(Kind);
        const row = await legacyPointer(storage, await photo(storage, `route-${Kind.name}.jpg`));
        const b = regenerateOnB(row);

        const res = await thumbnail(row.id);

        expect(b.forced).toMatch(/^thumbnails\/thumb_/);
        expect(res.status).toBe(200);
        expect((await sharp(res.body).metadata()).height).toBe(225);
        expect(await rowKey(row.id)).toBe(b.forced);
        expect(await heightOf(b.forced)).toBe(225);
      });

    // No regenerate yet: the row still holds the pointer being replaced,
    // which is not handed back; the photo is rendered again.
    test('a change with no regenerate yet renders again instead of answering the legacy pointer', async () => {
      const storage = await useStorage(LocalFs);
      const row = await legacyPointer(storage, await photo(storage, 'route-again.jpg'));
      pending = () => setFit('inside');

      const res = await thumbnail(row.id);

      expect(res.status).toBe(200);
      expect((await sharp(res.body).metadata()).height).toBe(225);
      const key = await rowKey(row.id);
      expect(key).toMatch(/^thumbnails\/thumb_/);
      expect(await heightOf(key)).toBe(225);
    });
  });

  test('public OG cover, legacy pointer rebuild: the regenerate under the new settings stays', async () => {
    const storage = await useStorage(LocalFs);
    const row = await legacyPointer(storage, await photo(storage, 'og-cover.jpg'));
    await db('photos').where({ id: row.id }).update({ rendition_version: 1 });
    await db('events').where({ id: eventId }).update({ og_image_share_enabled: 1, hero_photo_id: row.id });
    const og = express();
    og.get('/og/:slug', require('../../src/services/galleryOgService').handleGalleryOgCover);
    const b = regenerateOnB(row);

    try {
      const res = await request(og).get(`/og/${SLUG}`).buffer().parse(binary);

      expect(b.forced).toMatch(/^thumbnails\/thumb_/);
      expect(res.status).toBe(200);
      expect((await sharp(res.body).metadata()).height).toBe(225);
      expect(await rowKey(row.id)).toBe(b.forced);
      expect(await heightOf(b.forced)).toBe(225);
    } finally {
      await db('events').where({ id: eventId }).update({ og_image_share_enabled: 0, hero_photo_id: null });
    }
  });

  test('watcher shared-thumbnail repair: the regenerate under the new settings stays', async () => {
    const storage = await useStorage(LocalFs);
    const sharedKey = 'thumbnails/thumb_shared-IMG_0001.jpg';
    await storage.put(sharedKey, await sharp({ create: { width: 300, height: 300, channels: 3, background: 'gray' } }).jpeg().toBuffer());
    const first = await photo(storage, 'repair-1.jpg', { thumbnail_path: sharedKey });
    const second = await photo(storage, 'repair-2.jpg', { thumbnail_path: sharedKey });
    const b = regenerateOnB(first);

    await require('../../src/services/fileWatcher').repairSharedThumbnails();

    expect(b.forced).toMatch(/^thumbnails\/thumb_/);
    expect(await rowKey(first.id)).toBe(b.forced);
    expect(await heightOf(b.forced)).toBe(225);
    const other = await rowKey(second.id);
    expect(other).not.toBe(sharedKey);
    expect(await heightOf(other)).toBe(225);
  });
});
