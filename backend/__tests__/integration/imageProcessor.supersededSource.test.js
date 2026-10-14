/**
 * Issue 1974: an ordinary image regenerates with no derivative scope, and
 * its write used to match the row by id alone. A file replaced while the
 * rendition was being built then ended up with a thumbnail of the old one.
 */
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

describe('lazy renditions of an ordinary image whose source changes meanwhile', () => {
  let db, cleanup, storage, imageProcessor, eventId;
  const resultId = rows => rows[0]?.id ?? rows[0];

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    eventId = resultId(await db('events').insert({ slug: 'superseded-source', event_type: 'wedding', event_name: 'Superseded source',
      event_date: '2026-10-14', host_email: 'host@fixture.invalid', admin_email: 'admin@fixture.invalid',
      password_hash: 'x', share_link: '/gallery/superseded-source/share', expires_at: new Date(Date.now() + 3600000).toISOString(),
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
  afterEach(() => jest.restoreAllMocks());

  async function photo(name) {
    const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: 'red' } }).jpeg().toBuffer();
    await storage.put(`events/active/superseded-source/individual/${name}`, jpeg, { contentType: 'image/jpeg' });
    const id = resultId(await db('photos').insert({ event_id: eventId, filename: name, original_filename: name,
      path: `superseded-source/individual/${name}`, type: 'individual', mime_type: 'image/jpeg', media_type: 'image',
      size_bytes: jpeg.length, processing_status: 'complete', source_origin: 'managed' }).returning('id'));
    return db('photos').where({ id }).first();
  }

  // Runs `change` against the row the moment the rendition lands in storage.
  function onRenditionWrite(prefix, change) {
    const put = storage.put.bind(storage);
    return jest.spyOn(storage, 'put').mockImplementation(async (key, ...args) => {
      const value = await put(key, ...args);
      if (key.startsWith(prefix)) await change(key);
      return value;
    });
  }

  test('a replaced source keeps its own thumbnail and the stale rendition is dropped', async () => {
    const row = await photo('replaced.jpg');
    const spy = onRenditionWrite('thumbnails/', () => db('photos').where({ id: row.id })
      .update({ filename: 'replacement.jpg', path: 'superseded-source/individual/replacement.jpg', thumbnail_path: 'thumbnails/thumb_replacement.jpg' }));

    await expect(imageProcessor.ensureThumbnail(row, { force: true })).resolves.toBeNull();

    expect((await db('photos').where({ id: row.id }).first()).thumbnail_path).toBe('thumbnails/thumb_replacement.jpg');
    const written = spy.mock.calls.find(([key]) => key.startsWith('thumbnails/'))[0];
    expect(await storage.stat(written)).toBeFalsy();
  });

  test('a replaced source keeps its own preview', async () => {
    const row = await photo('preview-replaced.jpg');
    const spy = onRenditionWrite('previews/', () => db('photos').where({ id: row.id })
      .update({ filename: 'preview-replacement.jpg', path: 'superseded-source/individual/preview-replacement.jpg', preview_path: null }));

    await expect(imageProcessor.ensurePreviewImage(row, { force: true })).resolves.toBeNull();
    expect((await db('photos').where({ id: row.id }).first()).preview_path).toBeNull();
    const written = spy.mock.calls.find(([key]) => key.startsWith('previews/'))[0];
    expect(await storage.stat(written)).toBeFalsy();
  });

  test('a rendition the row still points at is kept, as after an event rename', async () => {
    const row = await photo('renamed.jpg');
    const spy = onRenditionWrite('thumbnails/', key => db('photos').where({ id: row.id })
      .update({ filename: 'renamed-new.jpg', path: 'superseded-source-new/individual/renamed.jpg', thumbnail_path: key }));

    await expect(imageProcessor.ensureThumbnail(row, { force: true })).resolves.toBeNull();

    const written = spy.mock.calls.find(([key]) => key.startsWith('thumbnails/'))[0];
    expect((await db('photos').where({ id: row.id }).first()).thumbnail_path).toBe(written);
    expect((await storage.stat(written)).size).toBeGreaterThan(0);
  });

  // A video renders inside a derivative scope. Its refusal used to throw
  // before anything deleted the poster frame it had just published.
  test('a scoped rendition of a replaced source does not stay behind', async () => {
    const row = await photo('replaced.mp4');
    await db('photos').where({ id: row.id }).update({ mime_type: 'video/mp4', media_type: 'video' });
    const video = await db('photos').where({ id: row.id }).first();
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'blue' } }).jpeg().toBuffer();
    jest.spyOn(require('../../src/services/videoProcessor'), 'processUploadedVideo')
      .mockImplementation(async (_source, thumbnailKey) => {
        await storage.put(thumbnailKey, jpeg, { contentType: 'image/jpeg' });
        return { thumbnailKey };
      });
    const spy = onRenditionWrite('thumbnails/', () => db('photos').where({ id: row.id })
      .update({ filename: 'replacement.mp4', path: 'superseded-source/individual/replacement.mp4' }));

    await expect(imageProcessor.ensureThumbnail(video, { force: true })).rejects.toMatchObject({ code: 'MEDIA_SUPERSEDED' });

    const written = spy.mock.calls.find(([key]) => key.startsWith('thumbnails/'))[0];
    expect(await storage.stat(written)).toBeFalsy();
    expect((await db('photos').where({ id: row.id }).first()).thumbnail_path).toBeNull();
  });

  // A tier is named after the source, not the scope, so another worker may
  // have written the same key and be serving it: the refusal leaves it alone.
  test('a source-named tier is not deleted by a refusal', async () => {
    const row = await photo('tier.dng');
    const jpeg = await sharp({ create: { width: 640, height: 480, channels: 3, background: 'green' } }).jpeg().toBuffer();
    jest.spyOn(require('../../src/services/mediaProcessService'), 'withSnapshot').mockImplementation(async () => {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'picpeak-raw-test-'));
      const file = path.join(dir, 'preview.jpg');
      await fsp.writeFile(file, jpeg);
      return { path: file, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
    });
    const spy = onRenditionWrite('thumbnails/thumb_w', () => db('photos').where({ id: row.id })
      .update({ filename: 'tier-renamed.dng', path: 'superseded-source-new/individual/tier.dng' }));

    await imageProcessor.ensureThumbnailAtWidth(row, 150).catch(() => {});

    const written = spy.mock.calls.find(([key]) => key.startsWith('thumbnails/thumb_w'))[0];
    expect((await storage.stat(written)).size).toBeGreaterThan(0);
  });

  test('an unchanged source still gets its thumbnail', async () => {
    const row = await photo('unchanged.jpg');
    const key = await imageProcessor.ensureThumbnail(row, { force: true });
    expect(key).toMatch(/^thumbnails\//);
    expect((await db('photos').where({ id: row.id }).first()).thumbnail_path).toBe(key);
  });
});
