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
    const stale = await imageProcessor.ensureThumbnailAtWidth(row, 600);
    const edited = await editInPlace(row, 260, 200);
    const fresh = await imageProcessor.ensureThumbnailAtWidth(edited, 600);
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

  test('an external RAW row without a recorded size keeps the cache id it had', async () => {
    const row = await externalPhoto('no-size.jpg');
    await db('photos').where({ id: row.id })
      .update({ filename: 'no-size.dng', external_relpath: 'shoot/no-size.dng', size_bytes: null });
    const raw = await db('photos').where({ id: row.id }).first();
    const fields = ['event_id', 'path', 'filename', 'external_relpath', 'source_origin', 'processing_attempt_id'];
    const oldId = require('crypto').createHash('sha256')
      .update(JSON.stringify(fields.map(field => raw[field] ?? null))).digest('hex').slice(0, 24);
    const scoped = require('../../src/services/mediaAttemptService').outputName(`p${raw.id}_no-size.dng`, { id: oldId });
    expect(imageProcessor.thumbnailTierKeys(raw)).toContain(`thumbnails/thumb_w600_${scoped}`);
  });

  test('deleting the gallery sweeps the versioned tiers of its external photos', async () => {
    const adminId = (await db('admin_users').first('id')).id;
    const otherId = resultId(await db('events').insert({ slug: 'source-version-delete', event_type: 'wedding', event_name: 'Delete me',
      event_date: '2026-10-14', host_email: 'host@fixture.invalid', admin_email: 'admin@fixture.invalid',
      password_hash: 'x', share_link: '/gallery/source-version-delete/share', expires_at: new Date(Date.now() + 3600000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_by: adminId, source_mode: 'reference', external_path: 'shoot' }).returning('id'));
    const row = await externalPhoto('cascade.jpg');
    await db('photos').where({ id: row.id }).update({ event_id: otherId });
    const moved = await db('photos').where({ id: row.id }).first();
    const tiers = [
      await imageProcessor.ensurePreviewImageAtWidth(moved, 640),
      await imageProcessor.ensureThumbnailAtWidth(moved, 600),
    ];
    for (const key of tiers) expect(key).toContain(`_v${moved.size_bytes}_`);

    await require('../../src/routes/adminEvents/helpers').deleteEventCascade(otherId, { id: adminId });
    for (const key of tiers) expect(await storage.stat(key)).toBeFalsy();
  });

  // Issue 2059: the mtime is part of the version, so an edit that keeps the
  // byte count is told apart as well.
  async function externalPhotoWithMtime(name) {
    const row = await externalPhoto(name);
    const { mtimeMs } = await fsp.stat(path.join(mediaRoot, row.external_relpath));
    await db('photos').where({ id: row.id }).update({ source_mtime_ms: Math.floor(mtimeMs) });
    return db('photos').where({ id: row.id }).first();
  }
  // The import pass on an edit that kept the byte count: only the mtime moves.
  async function editKeepingSize(row, width, height) {
    await writeSource(path.basename(row.external_relpath), width, height);
    await db('photos').where({ id: row.id })
      .update({ source_mtime_ms: Number(row.source_mtime_ms) + 1000, preview_path: null, hero_path: null });
    return db('photos').where({ id: row.id }).first();
  }

  test('tier keys carry the mtime next to the size', async () => {
    const row = await externalPhotoWithMtime('mtime-key.jpg');
    const tier = await imageProcessor.ensurePreviewImageAtWidth(row, 640);
    expect(tier).toContain(`_v${row.size_bytes}m${row.source_mtime_ms}_`);
  });

  test('a preview tier of the old bytes is not served after an edit that kept the byte count', async () => {
    const row = await externalPhotoWithMtime('same-size-tier.jpg');
    const stale = await imageProcessor.ensurePreviewImageAtWidth(row, 640);
    expect(await widthOf(stale)).toBe(400);

    const edited = await editKeepingSize(row, 260, 200);
    expect(Number(edited.size_bytes)).toBe(Number(row.size_bytes));
    const fresh = await imageProcessor.ensurePreviewImageAtWidth(edited, 640);
    expect(fresh).not.toBe(stale);
    expect(await widthOf(fresh)).toBe(260);
  });

  test('a preview built from the old bytes is not recorded after an edit that kept the byte count', async () => {
    const row = await externalPhotoWithMtime('same-size-preview.jpg');
    const spy = onRenditionWrite('previews/', async () => { await editKeepingSize(row, 260, 200); });

    await expect(imageProcessor.ensurePreviewImage(row, { force: true })).resolves.toBeNull();

    const stale = spy.mock.calls.find(([key]) => key.startsWith('previews/'))[0];
    expect((await db('photos').where({ id: row.id }).first()).preview_path).toBeNull();
    expect(await storage.stat(stale)).toBeFalsy();
  });

  test('a row selected without its mtime derives the same tier key', async () => {
    const row = await externalPhotoWithMtime('partial-mtime.jpg');
    const tier = await imageProcessor.ensurePreviewImageAtWidth(row, 640);
    const { source_mtime_ms: _omitted, ...partial } = row;
    const put = jest.spyOn(storage, 'put');
    await expect(imageProcessor.ensurePreviewImageAtWidth(partial, 640)).resolves.toBe(tier);
    expect(put).not.toHaveBeenCalled();
  });

  test('a tier named with the size alone is still served once the mtime is recorded, and cleaned up', async () => {
    const row = await externalPhotoWithMtime('size-only-tier.jpg');
    const sizeOnly = [
      `previews/preview_w640_p${row.id}_v${row.size_bytes}_size-only-tier.jpg`,
      `thumbnails/thumb_w600_p${row.id}_v${row.size_bytes}_size-only-tier.jpg`,
    ];
    const jpeg = await sharp({ create: { width: 400, height: 300, channels: 3, background: 'red' } }).jpeg().toBuffer();
    for (const key of sizeOnly) await storage.put(key, jpeg, { contentType: 'image/jpeg' });

    await expect(imageProcessor.ensurePreviewImageAtWidth(row, 640)).resolves.toBe(sizeOnly[0]);
    await expect(imageProcessor.ensureThumbnailAtWidth(row, 600)).resolves.toBe(sizeOnly[1]);
    await imageProcessor.deletePreviewTiers(row);
    await imageProcessor.deleteThumbnailTiers(row);
    for (const key of sizeOnly) expect(await storage.stat(key)).toBeFalsy();
  });

  test('a tier cut before the mtime was recorded is not kept when it lands after', async () => {
    // The scan records the mtime of a row imported before it was without a
    // refresh; a tier still rendering from the bytes it read before then
    // lands under the size-only name, which the row's keys still include.
    const row = await externalPhoto('adopted-mtime.jpg');
    expect(row.source_mtime_ms).toBeNull();
    const spy = onRenditionWrite('previews/preview_w640_', async () => {
      await writeSource('adopted-mtime.jpg', 260, 200);
      await db('photos').where({ id: row.id }).update({ source_mtime_ms: 1760000000000 });
    });

    await expect(imageProcessor.ensurePreviewImageAtWidth(row, 640)).resolves.toBeNull();
    const stale = spy.mock.calls.find(([key]) => key.startsWith('previews/preview_w640_'))[0];
    expect(await storage.stat(stale)).toBeFalsy();
    jest.restoreAllMocks();

    const fresh = await imageProcessor.ensurePreviewImageAtWidth(await db('photos').where({ id: row.id }).first(), 640);
    expect(await widthOf(fresh)).toBe(260);
  });

  test('a RAW tier named with the size alone in its cache id is cleaned up', async () => {
    const row = await externalPhotoWithMtime('size-only-raw.jpg');
    await db('photos').where({ id: row.id }).update({ filename: 'size-only-raw.dng', external_relpath: 'shoot/size-only-raw.dng' });
    const raw = await db('photos').where({ id: row.id }).first();
    const fields = ['event_id', 'path', 'filename', 'external_relpath', 'source_origin', 'processing_attempt_id'];
    const sizeOnlyId = require('crypto').createHash('sha256')
      .update(JSON.stringify([...fields.map(field => raw[field] ?? null), String(raw.size_bytes)])).digest('hex').slice(0, 24);
    const scoped = require('../../src/services/mediaAttemptService')
      .outputName(`p${raw.id}_v${raw.size_bytes}_size-only-raw.dng`, { id: sizeOnlyId });
    const keys = [`previews/preview_w640_${scoped.replace(/\.[^.]+$/, '')}.jpg`, `thumbnails/thumb_w600_${scoped}`];
    expect(imageProcessor.previewTierKeys(raw)).toContain(keys[0]);
    expect(imageProcessor.thumbnailTierKeys(raw)).toContain(keys[1]);
  });

  test('deleting the gallery sweeps the tiers of an external photo with a recorded mtime', async () => {
    const adminId = (await db('admin_users').first('id')).id;
    const otherId = resultId(await db('events').insert({ slug: 'source-mtime-delete', event_type: 'wedding', event_name: 'Delete me too',
      event_date: '2026-10-14', host_email: 'host@fixture.invalid', admin_email: 'admin@fixture.invalid',
      password_hash: 'x', share_link: '/gallery/source-mtime-delete/share', expires_at: new Date(Date.now() + 3600000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_by: adminId, source_mode: 'reference', external_path: 'shoot' }).returning('id'));
    const row = await externalPhotoWithMtime('cascade-mtime.jpg');
    await db('photos').where({ id: row.id }).update({ event_id: otherId });
    const moved = await db('photos').where({ id: row.id }).first();
    const tiers = [
      await imageProcessor.ensurePreviewImageAtWidth(moved, 640),
      await imageProcessor.ensureThumbnailAtWidth(moved, 600),
    ];
    for (const key of tiers) expect(key).toContain(`m${moved.source_mtime_ms}_`);

    await require('../../src/routes/adminEvents/helpers').deleteEventCascade(otherId, { id: adminId });
    for (const key of tiers) expect(await storage.stat(key)).toBeFalsy();
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
