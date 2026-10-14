/**
 * A reference-gallery file edited in place (same path, new bytes) must not
 * keep the old picture.
 *
 * The re-scan found the row by external_relpath and skipped it, so the row
 * kept the old dimensions and capture date, and every derivative (thumbnail,
 * preview, hero, watermark) kept rendering the bytes the file had at import.
 *
 * Driven through the real route against real files.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const request = require('supertest');
const sharp = require('sharp');

describe('external re-scan of a file changed in place', () => {
  let tmpDir; let db; let app; let mediaRoot; let storageRoot; let generateThumbnail;

  const writeJpeg = async (rel, { width, height, exifDate, color }) => {
    const full = path.join(mediaRoot, rel);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    let img = sharp({ create: { width, height, channels: 3, background: color } });
    if (exifDate) img = img.withExif({ IFD2: { DateTimeOriginal: exifDate } });
    await img.jpeg().toFile(full);
    return full;
  };

  const writeStored = async (key) => {
    const full = path.join(storageRoot, key);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, 'old rendition');
    return full;
  };
  const exists = (key) => fs.existsSync(path.join(storageRoot, key));

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-extchanged-'));
    mediaRoot = path.join(tmpDir, 'media');
    storageRoot = path.join(tmpDir, 'storage');
    await fs.promises.mkdir(mediaRoot, { recursive: true });

    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'data', 'db.sqlite');
    await fs.promises.mkdir(path.dirname(process.env.TEST_DATABASE_PATH), { recursive: true });
    process.env.STORAGE_PATH = storageRoot;
    process.env.EXTERNAL_MEDIA_ROOT = mediaRoot;
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'extchanged-secret';

    jest.resetModules();
    jest.doMock('../../src/middleware/auth', () => ({
      adminAuth: (req, _res, next) => { req.admin = { id: 1, username: 'tester', roleName: 'admin' }; next(); },
    }));
    jest.doMock('../../src/middleware/permissions', () => ({
      ...jest.requireActual('../../src/middleware/permissions'),
      requirePermission: () => (_req, _res, next) => next(),
    }));
    jest.doMock('../../src/middleware/ownership', () => ({
      ...jest.requireActual('../../src/middleware/ownership'),
      requireEventOwnership: (_req, _res, next) => next(),
    }));
    jest.doMock('../../src/services/imageProcessor', () => {
      const actual = jest.requireActual('../../src/services/imageProcessor');
      return {
        ...actual,
        generateThumbnail: jest.fn(async (_src, { outputBasename }) => `thumbnails/thumb_${outputBasename}`),
        ensureThumbnail: jest.fn(),
      };
    });
    jest.doMock('../../src/utils/logger', () => ({
      debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    }));

    ({ db } = await require('./helpers/crmDb').bootCrmDb());
    await require('./helpers/externalMediaFixture').seedExternalAdminFixture(db);
    // bootCrmDb points STORAGE_PATH at its own directory.
    storageRoot = process.env.STORAGE_PATH;
    ({ generateThumbnail } = require('../../src/services/imageProcessor'));

    app = express();
    app.use(express.json());
    app.use('/api/admin/external-media', require('../../src/routes/adminExternalMedia'));
  }, 180000);

  afterAll(async () => {
    if (db) await db.destroy?.();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  async function seedEvent() {
    await db('photos').del();
    await db('events').del();
    await fs.promises.rm(mediaRoot, { recursive: true, force: true });
    await fs.promises.mkdir(mediaRoot, { recursive: true });
    const [e] = await db('events').insert({
      slug: `extchanged-${Math.random().toString(36).slice(2, 8)}`,
      event_type: 'wedding', event_name: 'extchanged', event_date: '2026-01-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `extchanged-${Math.random()}`, expires_at: new Date().toISOString(),
      source_mode: 'reference',
    }).returning('id');
    return typeof e === 'object' ? e.id : e;
  }

  const runImport = (eventId, external_path) => request(app)
    .post(`/api/admin/external-media/events/${eventId}/import-external`)
    .send({ external_path, recursive: true });

  // Import, then give the row a preview, hero and watermark, as viewing would.
  async function importWithRenditions(eventId) {
    await writeJpeg('shoot/a.jpg', { width: 60, height: 40, exifDate: '2026:06:01 10:00:00', color: { r: 10, g: 20, b: 30 } });
    const first = await runImport(eventId, 'shoot');
    expect(first.body.imported).toBe(1);
    const photo = await db('photos').where({ event_id: eventId }).first();
    const keys = {
      thumbnail_path: photo.thumbnail_path,
      preview_path: `previews/preview_ext${photo.id}_a.jpg`,
      hero_path: `heroes/hero_ext${photo.id}_a.jpg`,
      watermark_path: `watermarked/wm_${photo.id}.jpg`,
    };
    for (const key of Object.values(keys)) await writeStored(key);
    await db('photos').where({ id: photo.id }).update({ ...keys, thumb_hash: 'old-hash' });
    return { photo: await db('photos').where({ id: photo.id }).first(), keys };
  }

  it('refreshes the row and drops every derivative when the file changed', async () => {
    const eventId = await seedEvent();
    const { photo, keys } = await importWithRenditions(eventId);
    generateThumbnail.mockClear();

    // The edit on the share: other pixels, other size, other date.
    await writeJpeg('shoot/a.jpg', { width: 300, height: 500, exifDate: '2026:07:15 12:00:00', color: { r: 240, g: 200, b: 10 } });
    const newSize = (await fs.promises.stat(path.join(mediaRoot, 'shoot/a.jpg'))).size;
    expect(newSize).not.toBe(Number(photo.size_bytes));

    const zips = jest.spyOn(require('../../src/services/downloadZipService'), 'invalidate');
    const res = await runImport(eventId, 'shoot');
    expect(res.body.imported).toBe(0);
    expect(res.body.refreshed).toBe(1);
    // The prebuilt Download All zip still held the old picture.
    expect(zips).toHaveBeenCalledWith(eventId);
    zips.mockRestore();

    const after = await db('photos').where({ id: photo.id }).first();
    expect(Number(after.size_bytes)).toBe(newSize);
    expect([after.width, after.height]).toEqual([300, 500]);
    expect(new Date(after.captured_at).getUTCMonth()).toBe(6); // July
    expect(after.preview_path).toBeNull();
    expect(after.hero_path).toBeNull();
    expect(after.watermark_path).toBeNull();
    // Made again at once, from the new file.
    expect(generateThumbnail).toHaveBeenCalledTimes(1);
    expect(generateThumbnail.mock.calls[0][0]).toBe(path.join(mediaRoot, 'shoot/a.jpg'));
    expect(after.thumbnail_path).toBe(keys.thumbnail_path);
    expect(after.thumb_hash).toBeNull();

    expect(exists(keys.preview_path)).toBe(false);
    expect(exists(keys.hero_path)).toBe(false);
    expect(exists(keys.watermark_path)).toBe(false);
  });

  it('leaves an unchanged file and its derivatives alone', async () => {
    const eventId = await seedEvent();
    const { photo, keys } = await importWithRenditions(eventId);
    generateThumbnail.mockClear();

    const zips = jest.spyOn(require('../../src/services/downloadZipService'), 'invalidate');
    const res = await runImport(eventId, 'shoot');
    expect(res.body.refreshed).toBe(0);
    expect(res.body.skipped).toBe(1);
    expect(zips).not.toHaveBeenCalled();
    zips.mockRestore();

    const after = await db('photos').where({ id: photo.id }).first();
    expect(after.preview_path).toBe(keys.preview_path);
    expect(after.thumb_hash).toBe('old-hash');
    expect(generateThumbnail).not.toHaveBeenCalled();
    for (const key of Object.values(keys)) expect(exists(key)).toBe(true);
  });

  it('makes another row pointing at its files let go of them', async () => {
    // Keys are named after this photo, so a rebuild writes the edited
    // picture under them: a row sharing one would show it.
    const eventId = await seedEvent();
    const { photo, keys } = await importWithRenditions(eventId);
    const [twin] = await db('photos').insert({
      event_id: eventId, filename: 'twin.jpg', path: 'x/twin.jpg', type: 'individual',
      source_origin: 'managed', thumbnail_path: keys.thumbnail_path, thumb_hash: 'twin-hash',
      hero_path: keys.hero_path, preview_path: 'previews/twin-own.jpg',
    }).returning('id');
    const twinId = typeof twin === 'object' ? twin.id : twin;

    await writeJpeg('shoot/a.jpg', { width: 300, height: 500, color: { r: 240, g: 200, b: 10 } });
    expect((await runImport(eventId, 'shoot')).body.refreshed).toBe(1);

    const after = await db('photos').where({ id: twinId }).first();
    expect(after.thumbnail_path).toBeNull();
    expect(after.thumb_hash).toBeNull();
    expect(after.hero_path).toBeNull();
    // Its own rendition is not touched.
    expect(after.preview_path).toBe('previews/twin-own.jpg');
    expect(exists(keys.hero_path)).toBe(false);
    expect((await db('photos').where({ id: photo.id }).first()).hero_path).toBeNull();
  });

  it('forgets in-memory watermarks made from the old bytes', async () => {
    const eventId = await seedEvent();
    await importWithRenditions(eventId);
    const watermarkService = require('../../src/services/watermarkService');
    const source = path.join(mediaRoot, 'shoot/a.jpg');
    watermarkService.cache.set(`${source}_{"enabled":true}_stripped`, { buffer: Buffer.from('old'), timestamp: Date.now() });
    watermarkService.cache.set(`${source}-other_{"enabled":true}_stripped`, { buffer: Buffer.from('x'), timestamp: Date.now() });

    await writeJpeg('shoot/a.jpg', { width: 300, height: 500, color: { r: 240, g: 200, b: 10 } });
    expect((await runImport(eventId, 'shoot')).body.refreshed).toBe(1);
    expect(watermarkService.cache.has(`${source}_{"enabled":true}_stripped`)).toBe(false);
    expect(watermarkService.cache.has(`${source}-other_{"enabled":true}_stripped`)).toBe(true);
  });

  it('forgets in-memory watermarks of its thumbnail, preview and hero too', async () => {
    // The gallery watermarks those from the derivative's local file, under
    // a path that does not change with a rebuild.
    const eventId = await seedEvent();
    const { photo, keys } = await importWithRenditions(eventId);
    const watermarkService = require('../../src/services/watermarkService');
    const tier = require('../../src/services/imageProcessor').previewTierKeys(photo)[0];
    const cached = [keys.thumbnail_path, keys.preview_path, keys.hero_path, tier]
      .map((key) => `${path.join(storageRoot, key)}_{"enabled":true}_stripped`);
    for (const key of cached) watermarkService.cache.set(key, { buffer: Buffer.from('old'), timestamp: Date.now() });

    await writeJpeg('shoot/a.jpg', { width: 300, height: 500, color: { r: 240, g: 200, b: 10 } });
    expect((await runImport(eventId, 'shoot')).body.refreshed).toBe(1);
    for (const key of cached) expect(watermarkService.cache.has(key)).toBe(false);
  });

  it('still refreshes an edited file behind a new one in a gallery at its photo cap', async () => {
    const eventId = await seedEvent();
    const { photo } = await importWithRenditions(eventId);
    await db('events').where({ id: eventId }).update({ photo_cap: 1 });
    // Named to come before a.jpg, so the walk (directory order, not sorted;
    // name order on APFS and most ext4 directories this small) meets the new
    // file first. With the fix the order does not matter.
    await writeJpeg('shoot/0-new.jpg', { width: 50, height: 50, color: { r: 1, g: 2, b: 3 } });
    await writeJpeg('shoot/a.jpg', { width: 300, height: 500, color: { r: 240, g: 200, b: 10 } });

    const res = await runImport(eventId, 'shoot');
    expect(res.body).toMatchObject({ imported: 0, refreshed: 1, capReached: true });
    expect((await db('photos').where({ id: photo.id }).first()).width).toBe(300);
    expect(await db('photos').where({ event_id: eventId }).count({ n: '*' }).first()).toMatchObject({ n: 1 });
  });

  it('keeps the row eligible when a cached rendition cannot be removed', async () => {
    const eventId = await seedEvent();
    const { photo, keys } = await importWithRenditions(eventId);
    const imageProcessor = require('../../src/services/imageProcessor');
    const storage = require('../../src/services/storage').getStorage();
    const tierKey = imageProcessor.previewTierKeys(photo)[0];
    await writeStored(tierKey);
    const realDelete = storage.delete.bind(storage);
    const spy = jest.spyOn(storage, 'delete').mockImplementation(async (key) => {
      if (key === tierKey) throw new Error('storage unavailable');
      return realDelete(key);
    });
    try {
      await writeJpeg('shoot/a.jpg', { width: 300, height: 500, color: { r: 240, g: 200, b: 10 } });
      expect((await runImport(eventId, 'shoot')).body.refreshed).toBe(0);
      const kept = await db('photos').where({ id: photo.id }).first();
      expect(Number(kept.size_bytes)).toBe(Number(photo.size_bytes));
    } finally {
      spy.mockRestore();
    }
    // Storage back: the next pass completes it.
    expect((await runImport(eventId, 'shoot')).body.refreshed).toBe(1);
    expect(exists(tierKey)).toBe(false);
    expect((await db('photos').where({ id: photo.id }).first()).preview_path).toBeNull();
    expect(keys.preview_path).toBeTruthy();
  });

  it('purges faces and scene tags with the new metadata', async () => {
    const eventId = await seedEvent();
    const { photo } = await importWithRenditions(eventId);
    await db('photos').where({ id: photo.id }).update({ face_status: 'done', face_count: 2, tag_status: 'done' });

    await writeJpeg('shoot/a.jpg', { width: 300, height: 500, color: { r: 240, g: 200, b: 10 } });
    expect((await runImport(eventId, 'shoot')).body.refreshed).toBe(1);
    const after = await db('photos').where({ id: photo.id }).first();
    // Neither feature is on for this gallery: cleared, not queued.
    expect(after.face_status).toBeNull();
    expect(after.face_count).toBeNull();
    expect(after.tag_status).toBeNull();
  });

  it('takes the credit of the new file, and keeps a manual one', async () => {
    const eventId = await seedEvent();
    const { photo } = await importWithRenditions(eventId);
    await db('photos').where({ id: photo.id }).update({ credit_name: 'Old Artist', credit_source: 'exif' });
    const writeCredited = (artist) => sharp({ create: { width: 300, height: 500, channels: 3, background: { r: 9, g: 9, b: 9 } } })
      .withExif({ IFD0: { Artist: artist } }).jpeg().toFile(path.join(mediaRoot, 'shoot/a.jpg'));

    await writeCredited('New Artist');
    expect((await runImport(eventId, 'shoot')).body.refreshed).toBe(1);
    expect((await db('photos').where({ id: photo.id }).first()).credit_name).toBe('New Artist');

    await db('photos').where({ id: photo.id }).update({ credit_name: 'Set By Admin', credit_source: 'manual' });
    await writeJpeg('shoot/a.jpg', { width: 320, height: 520, color: { r: 5, g: 200, b: 90 } });
    expect((await runImport(eventId, 'shoot')).body.refreshed).toBe(1);
    expect((await db('photos').where({ id: photo.id }).first())).toMatchObject({ credit_name: 'Set By Admin', credit_source: 'manual' });
  });

  it('drops a category the face scan chose, keeps one an admin chose', async () => {
    const eventId = await seedEvent();
    const { photo } = await importWithRenditions(eventId);
    const [cat] = await db('photo_categories').insert({ name: 'Portraits', slug: `portraits-${eventId}`, event_id: eventId }).returning('id');
    const categoryId = typeof cat === 'object' ? cat.id : cat;
    await db('photos').where({ id: photo.id }).update({ category_id: categoryId, auto_categorized: true });

    await writeJpeg('shoot/a.jpg', { width: 300, height: 500, color: { r: 240, g: 200, b: 10 } });
    expect((await runImport(eventId, 'shoot')).body.refreshed).toBe(1);
    expect((await db('photos').where({ id: photo.id }).first()).category_id).toBeNull();

    await db('photos').where({ id: photo.id }).update({ category_id: categoryId, auto_categorized: false });
    await writeJpeg('shoot/a.jpg', { width: 320, height: 520, color: { r: 5, g: 200, b: 90 } });
    expect((await runImport(eventId, 'shoot')).body.refreshed).toBe(1);
    expect((await db('photos').where({ id: photo.id }).first()).category_id).toBe(categoryId);
  });

  it('leaves a changed file that is still being written for the next automatic pass', async () => {
    const eventId = await seedEvent();
    await db('events').where({ id: eventId }).update({
      created_by: 1, external_path: 'shoot', external_watch: 1, is_active: 1, is_archived: 0,
    });
    const { photo, keys } = await importWithRenditions(eventId);
    const { importExternalFolder } = require('../../src/services/externalImportService');

    // Just written: mtime is now, inside the settle window.
    await writeJpeg('shoot/a.jpg', { width: 300, height: 500, color: { r: 240, g: 200, b: 10 } });
    const pass = { eventId, externalPath: 'shoot', actor: { type: 'system' }, automatic: true, settleMs: 5000 };
    expect(await importExternalFolder(pass)).toMatchObject({ refreshed: 0, deferred: 1 });
    expect((await db('photos').where({ id: photo.id }).first()).preview_path).toBe(keys.preview_path);

    // Quiet for longer than the window: refreshed.
    const old = new Date(Date.now() - 60000);
    await fs.promises.utimes(path.join(mediaRoot, 'shoot/a.jpg'), old, old);
    expect(await importExternalFolder(pass)).toMatchObject({ refreshed: 1, deferred: 0 });
    expect((await db('photos').where({ id: photo.id }).first()).preview_path).toBeNull();
  });

  it('does not touch a photo an upload replaced, which no longer reads the share', async () => {
    const eventId = await seedEvent();
    const { photo, keys } = await importWithRenditions(eventId);
    await db('photos').where({ id: photo.id }).update({ source_origin: 'managed' });

    await writeJpeg('shoot/a.jpg', { width: 300, height: 500, color: { r: 240, g: 200, b: 10 } });
    const res = await runImport(eventId, 'shoot');
    expect(res.body.refreshed).toBe(0);

    const after = await db('photos').where({ id: photo.id }).first();
    expect(Number(after.size_bytes)).toBe(Number(photo.size_bytes));
    expect(after.preview_path).toBe(keys.preview_path);
    expect(exists(keys.preview_path)).toBe(true);
  });
});
