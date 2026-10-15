/**
 * Watermarks of an external file edited in place (issue 2059).
 *
 * The stored watermark was named after the photo id and filename and its
 * record fenced on them, neither of which an in-place edit changes; the
 * in-memory cache was keyed by the path read. The import pass evicted that
 * cache in its own process only, so every other process went on serving the
 * old picture's watermark. Both now carry the source's version.
 */
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

describe('watermarks of an external file edited in place', () => {
  let db, cleanup, tmpDir, eventId, watermarkService, generator;
  const resultId = rows => rows[0]?.id ?? rows[0];

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'picpeak-wmversion-'));
    eventId = resultId(await db('events').insert({ slug: 'wm-version', event_type: 'wedding', event_name: 'Watermark version',
      event_date: '2026-10-15', host_email: 'host@fixture.invalid', admin_email: 'admin@fixture.invalid',
      password_hash: 'x', share_link: '/gallery/wm-version/share', expires_at: new Date(Date.now() + 3600000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_by: adminId, source_mode: 'reference', external_path: 'shoot' }).returning('id'));
    watermarkService = require('../../src/services/watermarkService');
    generator = require('../../src/services/watermarkGeneratorService');
  }, 60000);
  afterAll(async () => {
    await require('../../src/services/isolatedSharp').shutdown();
    if (cleanup) await cleanup();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });
  afterEach(() => jest.restoreAllMocks());

  async function externalPhoto(name, fields = {}) {
    const id = resultId(await db('photos').insert({ event_id: eventId, filename: name, path: `shoot/${name}`,
      external_relpath: `shoot/${name}`, type: 'individual', mime_type: 'image/jpeg', media_type: 'image',
      size_bytes: 1000, source_mtime_ms: 1760000000000, processing_status: 'complete', source_origin: 'reference', ...fields })
      .returning('id'));
    return db('photos').where({ id }).first();
  }

  test('the stored watermark key changes with the source version', async () => {
    const row = await externalPhoto('key.jpg');
    const key = watermarkService.watermarkKey(row);
    expect(watermarkService.watermarkKey({ ...row, source_mtime_ms: Number(row.source_mtime_ms) + 1000 })).not.toBe(key);
    expect(watermarkService.watermarkKey({ ...row, size_bytes: 1001 })).not.toBe(key);
    // A managed row is never edited in place: its key stays as it was.
    const managed = { id: 7, filename: 'm.jpg', source_origin: 'managed', size_bytes: 5 };
    expect(watermarkService.watermarkKey({ ...managed, size_bytes: 6, source_mtime_ms: 1 }))
      .toBe(watermarkService.watermarkKey(managed));
  });

  test('a watermark cut from the old version is not recorded after an edit that kept the byte count', async () => {
    const stale = await externalPhoto('fence.jpg');
    await db('photos').where({ id: stale.id }).update({ source_mtime_ms: Number(stale.source_mtime_ms) + 1000 });
    const key = watermarkService.watermarkKey(stale);
    const remove = jest.spyOn(watermarkService, 'deleteWatermarkFile').mockResolvedValue(true);

    const result = await generator.recordWatermark(stale, { success: true, watermarkPath: key });
    expect(result.success).toBe(false);
    expect((await db('photos').where({ id: stale.id }).first()).watermark_path).toBeNull();
    expect(remove).toHaveBeenCalledWith(key);
  });

  test('the in-memory watermark of a file is not served once the file changed under the same path', async () => {
    const full = path.join(tmpDir, 'cached.jpg');
    const write = color => sharp({ create: { width: 200, height: 120, channels: 3, background: color } }).jpeg().toFile(full);
    const settings = { enabled: true, logoPath: null, position: 'bottom-right', opacity: 50, size: 15, companyName: 'Studio' };
    const centre = async buffer => {
      const { data } = await sharp(buffer).extract({ left: 20, top: 20, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
      return Array.from(data);
    };

    await write({ r: 200, g: 0, b: 0 });
    const first = await watermarkService.applyWatermark(full, settings);
    expect(await watermarkService.applyWatermark(full, settings)).toBe(first);

    // Another process edits nothing here and evicts nothing: only the file moves.
    await write({ r: 0, g: 0, b: 200 });
    const later = new Date(Date.now() + 5000);
    await fsp.utimes(full, later, later);
    const second = await watermarkService.applyWatermark(full, settings);
    expect(second).not.toBe(first);
    const [r, , b] = await centre(second);
    expect(b).toBeGreaterThan(150);
    expect(r).toBeLessThan(60);
  });
});
