/**
 * A reference-gallery file can be rewritten in place: same path, other bytes.
 * Nothing the derivative guard compared (path, filename, external_relpath …)
 * changes then, so a rendition started from the old bytes published over the
 * refreshed row, and a tier of the old bytes was found again under the same
 * key. The recorded size is the external source's version: it is part of the
 * guard and of every external rendition key.
 */
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const mediaRoot = require('fs').mkdtempSync(path.join(os.tmpdir(), 'picpeak-srcversion-media-'));
process.env.EXTERNAL_MEDIA_ROOT = mediaRoot;

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

describe('renditions of an external file rewritten in place', () => {
  let db, cleanup, storage, imageProcessor, eventId;
  const resultId = rows => rows[0]?.id ?? rows[0];

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    eventId = resultId(await db('events').insert({ slug: 'source-version', event_type: 'wedding', event_name: 'Source version',
      event_date: '2026-10-14', host_email: 'host@fixture.invalid', admin_email: 'admin@fixture.invalid',
      password_hash: 'x', share_link: '/gallery/source-version/share', expires_at: new Date(Date.now() + 3600000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_by: adminId, source_mode: 'reference', external_path: 'shoot' }).returning('id'));
    const LocalFs = require('../../src/services/storage/LocalFsStorage');
    storage = new LocalFs({ root: process.env.STORAGE_PATH }); await storage.init();
    require('../../src/services/storage').setStorageForTesting(storage);
    imageProcessor = require('../../src/services/imageProcessor');
  }, 60000);
  afterAll(async () => {
    await require('../../src/services/isolatedSharp').shutdown();
    require('../../src/services/storage').resetStorage();
    if (cleanup) await cleanup();
    await fsp.rm(mediaRoot, { recursive: true, force: true });
  });
  afterEach(() => jest.restoreAllMocks());

  // Distinct dimensions per version, so a rendition can be traced to its bytes.
  async function writeSource(name, width, height) {
    const full = path.join(mediaRoot, 'shoot', name);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await sharp({ create: { width, height, channels: 3, background: { r: width % 255, g: 40, b: height % 255 } } })
      .jpeg().toFile(full);
    return (await fsp.stat(full)).size;
  }

  async function externalPhoto(name) {
    const size = await writeSource(name, 400, 300);
    const id = resultId(await db('photos').insert({ event_id: eventId, filename: name, original_filename: name,
      path: `shoot/${name}`, external_relpath: `shoot/${name}`, type: 'individual', mime_type: 'image/jpeg', media_type: 'image',
      size_bytes: size, processing_status: 'complete', source_origin: 'reference' }).returning('id'));
    return db('photos').where({ id }).first();
  }

  // What the import pass does on an edited file: new bytes on the share, the
  // new size recorded, the renditions dropped.
  async function editInPlace(row, width, height) {
    const size = await writeSource(path.basename(row.external_relpath), width, height);
    await db('photos').where({ id: row.id }).update({ size_bytes: size, preview_path: null, hero_path: null });
    return db('photos').where({ id: row.id }).first();
  }

  // Runs `change` the moment a rendition under `prefix` lands in storage.
  function onRenditionWrite(prefix, change) {
    const put = storage.put.bind(storage);
    return jest.spyOn(storage, 'put').mockImplementation(async (key, ...args) => {
      const value = await put(key, ...args);
      if (key.startsWith(prefix)) await change(key);
      return value;
    });
  }

  const widthOf = async key => (await sharp(path.join(storage.root, key)).metadata()).width;

  test('a preview built from the old bytes is not recorded after an in-place edit', async () => {
    const row = await externalPhoto('edited-preview.jpg');
    let edited;
    const spy = onRenditionWrite('previews/', async () => { if (!edited) edited = await editInPlace(row, 260, 200); });

    await expect(imageProcessor.ensurePreviewImage(row, { force: true })).resolves.toBeNull();

    const stale = spy.mock.calls.find(([key]) => key.startsWith('previews/'))[0];
    expect((await db('photos').where({ id: row.id }).first()).preview_path).toBeNull();
    expect(await storage.stat(stale)).toBeFalsy();
    jest.restoreAllMocks();

    const fresh = await imageProcessor.ensurePreviewImage(edited, { force: true });
    expect(fresh).not.toBe(stale);
    expect(fresh).toContain(`_v${edited.size_bytes}_`);
    expect(await widthOf(fresh)).toBe(260);
  });

  test('a hero built from the old bytes is not recorded after an in-place edit', async () => {
    const row = await externalPhoto('edited-hero.jpg');
    const spy = onRenditionWrite('heroes/', async () => { await editInPlace(row, 260, 200); });

    await expect(imageProcessor.ensureHeroImage(row)).resolves.toBeNull();

    const stale = spy.mock.calls.find(([key]) => key.startsWith('heroes/'))[0];
    expect((await db('photos').where({ id: row.id }).first()).hero_path).toBeNull();
    expect(await storage.stat(stale)).toBeFalsy();
  });

  test('a preview tier of the old bytes is not served for the new ones', async () => {
    const row = await externalPhoto('edited-tier.jpg');
    const stale = await imageProcessor.ensurePreviewImageAtWidth(row, 640);
    expect(await widthOf(stale)).toBe(400);

    const edited = await editInPlace(row, 260, 200);
    const fresh = await imageProcessor.ensurePreviewImageAtWidth(edited, 640);
    expect(fresh).not.toBe(stale);
    expect(await widthOf(fresh)).toBe(260);
  });

  test('a thumbnail tier of the old bytes is not served for the new ones', async () => {
    const row = await externalPhoto('edited-thumb-tier.jpg');
    const stale = await imageProcessor.ensureThumbnailAtWidth(row, 150);
    const edited = await editInPlace(row, 260, 200);
    const fresh = await imageProcessor.ensureThumbnailAtWidth(edited, 150);
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(stale);
  });

  test('an unchanged source keeps its preview and its tiers are served from the cache', async () => {
    const row = await externalPhoto('unchanged.jpg');
    const key = await imageProcessor.ensurePreviewImage(row, { force: true });
    expect((await db('photos').where({ id: row.id }).first()).preview_path).toBe(key);

    const tier = await imageProcessor.ensurePreviewImageAtWidth(row, 640);
    const put = jest.spyOn(storage, 'put');
    await expect(imageProcessor.ensurePreviewImageAtWidth(row, 640)).resolves.toBe(tier);
    expect(put).not.toHaveBeenCalled();
  });

  test('a row selected without its size derives the same tier key', async () => {
    const row = await externalPhoto('partial-select.jpg');
    const tier = await imageProcessor.ensurePreviewImageAtWidth(row, 640);
    const partial = await db('photos').where({ id: row.id })
      .first('id', 'event_id', 'path', 'filename', 'external_relpath', 'source_origin', 'media_type', 'mime_type');
    expect(partial.size_bytes).toBeUndefined();
    const put = jest.spyOn(storage, 'put');
    await expect(imageProcessor.ensurePreviewImageAtWidth(partial, 640)).resolves.toBe(tier);
    expect(put).not.toHaveBeenCalled();
  });

  test('a RAW tier written before the version was part of its cache id is cleaned up', async () => {
    const row = await externalPhoto('legacy-raw.jpg');
    await db('photos').where({ id: row.id }).update({ filename: 'legacy-raw.dng', external_relpath: 'shoot/legacy-raw.dng' });
    const raw = await db('photos').where({ id: row.id }).first();
    // The cache id as it was: the source fields without the size.
    const fields = ['event_id', 'path', 'filename', 'external_relpath', 'source_origin', 'processing_attempt_id'];
    const oldId = require('crypto').createHash('sha256')
      .update(JSON.stringify(fields.map(field => raw[field] ?? null))).digest('hex').slice(0, 24);
    const { outputName } = require('../../src/services/mediaAttemptService');
    const scoped = outputName(`p${raw.id}_legacy-raw.dng`, { id: oldId });
    const legacyKeys = [
      `previews/preview_w640_${scoped.replace(/\.[^.]+$/, '')}.jpg`,
      `thumbnails/thumb_w600_${scoped}`,
    ];
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).jpeg().toBuffer();
    for (const key of legacyKeys) await storage.put(key, jpeg, { contentType: 'image/jpeg' });

    await imageProcessor.deletePreviewTiers(raw);
    await imageProcessor.deleteThumbnailTiers(raw);
    for (const key of legacyKeys) expect(await storage.stat(key)).toBeFalsy();
  });

  test('a tier written before the version was part of the name is still served and cleaned up', async () => {
    const row = await externalPhoto('legacy-tier.jpg');
    const legacyKey = `previews/preview_w640_p${row.id}_legacy-tier.jpg`;
    const jpeg = await sharp({ create: { width: 400, height: 300, channels: 3, background: 'red' } }).jpeg().toBuffer();
    await storage.put(legacyKey, jpeg, { contentType: 'image/jpeg' });

    await expect(imageProcessor.ensurePreviewImageAtWidth(row, 640)).resolves.toBe(legacyKey);
    await imageProcessor.deletePreviewTiers(row);
    expect(await storage.stat(legacyKey)).toBeFalsy();
  });
});
