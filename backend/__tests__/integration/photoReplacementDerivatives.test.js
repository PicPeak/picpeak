/**
 * Replacing a photo keeps its id, so everything derived from the old file
 * has to follow the new one:
 *  - preview, hero and watermark are cleared (and their files deleted), so
 *    readers regenerate them from the new picture instead of serving the old
 *  - a failed upload leaves the old photo whole (original still in storage)
 *  - a watermark job that read the old file records nothing and does not
 *    overwrite the new file's watermark
 *  - a watermark upload refused by its attempt removes its file
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

describe('Photo replacement and derived files', () => {
  let db;
  let cleanup;
  let orangeJpeg;
  let blueJpeg;
  let counter = 0;

  const storagePath = (...parts) => path.join(process.env.STORAGE_PATH, ...parts);
  const exists = (key) => fs.existsSync(storagePath(key));

  async function makeEvent() {
    counter += 1;
    const slug = `replace-derivatives-${counter}`;
    const inserted = await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: `Replace Derivatives ${counter}`,
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${slug}/share`,
      share_token: `replace-derivatives-share-${counter}`,
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    const id = inserted[0]?.id ?? inserted[0];
    await fs.promises.mkdir(storagePath('events', 'active', slug), { recursive: true });
    return db('events').where({ id }).first();
  }

  async function writeKey(key, bytes) {
    await fs.promises.mkdir(path.dirname(storagePath(key)), { recursive: true });
    await fs.promises.writeFile(storagePath(key), bytes);
  }

  async function addPhoto(event, fields = {}) {
    counter += 1;
    const filename = `p-${counter}-${Math.random().toString(36).slice(2)}.jpg`;
    await writeKey(path.posix.join('events/active', event.slug, filename), orangeJpeg);
    const r = await db('photos').insert({
      event_id: event.id,
      filename,
      original_filename: 'old.jpg',
      path: `${event.slug}/${filename}`,
      type: 'individual',
      media_type: 'image',
      mime_type: 'image/jpeg',
      size_bytes: orangeJpeg.length,
      processing_status: 'complete',
      uploaded_at: new Date().toISOString(),
      ...fields,
    }).returning('id');
    return r[0]?.id ?? r[0];
  }

  async function newTempFile(name) {
    const temp = storagePath(`${name}-${counter}.jpg`);
    await fs.promises.writeFile(temp, blueJpeg);
    return temp;
  }

  const replace = async (existing, event) => {
    const { replacePhoto } = require('../../src/services/photoReplacementService');
    return replacePhoto(existing, await newTempFile('replace'), { originalFilename: 'new.jpg', mimeType: 'image/jpeg', event });
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    orangeJpeg = await sharp({ create: { width: 60, height: 40, channels: 3, background: { r: 220, g: 120, b: 20 } } }).jpeg().toBuffer();
    blueJpeg = await sharp({ create: { width: 40, height: 60, channels: 3, background: { r: 20, g: 60, b: 220 } } }).jpeg().toBuffer();
  }, 120000);

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await require('../../src/services/isolatedSharp').shutdown();
    if (cleanup) await cleanup();
  });

  it('clears and deletes the old preview, hero and watermark', async () => {
    const event = await makeEvent();
    const id = await addPhoto(event, {
      preview_path: 'previews/old-preview.jpg',
      hero_path: 'heroes/old-hero.jpg',
      hero_anchor: '50% 20%',
      watermark_path: 'watermarks/legacy_watermarked.jpg',
      watermark_generated_at: new Date().toISOString(),
    });
    for (const key of ['previews/old-preview.jpg', 'heroes/old-hero.jpg', 'watermarks/legacy_watermarked.jpg']) {
      await writeKey(key, orangeJpeg);
    }

    const result = await replace(await db('photos').where({ id }).first(), event);
    expect(result.success).toBe(true);

    const row = await db('photos').where({ id }).first();
    expect(row.preview_path).toBeNull();
    expect(row.hero_path).toBeNull();
    expect(row.hero_anchor).toBeNull();
    expect(row.watermark_path).toBeNull();
    expect(exists('previews/old-preview.jpg')).toBe(false);
    expect(exists('heroes/old-hero.jpg')).toBe(false);
    expect(exists('watermarks/legacy_watermarked.jpg')).toBe(false);

    // The reader now cuts a preview from the new (blue) original.
    const { ensurePreviewImage } = require('../../src/services/imageProcessor');
    const previewKey = await ensurePreviewImage(row);
    expect(previewKey).toBeTruthy();
    const { channels } = await sharp(storagePath(previewKey)).stats();
    expect(channels[2].mean).toBeGreaterThan(channels[0].mean);
  }, 30000);

  it('keeps a preview another photo still points at', async () => {
    const event = await makeEvent();
    const id = await addPhoto(event, { preview_path: 'previews/shared-preview.jpg' });
    await addPhoto(event, { preview_path: 'previews/shared-preview.jpg' });
    await writeKey('previews/shared-preview.jpg', orangeJpeg);

    expect((await replace(await db('photos').where({ id }).first(), event)).success).toBe(true);
    expect(exists('previews/shared-preview.jpg')).toBe(true);
  }, 30000);

  it('a failed upload leaves the old original and row in place', async () => {
    const event = await makeEvent();
    const id = await addPhoto(event, { preview_path: 'previews/kept-preview.jpg' });
    await writeKey('previews/kept-preview.jpg', orangeJpeg);
    const before = await db('photos').where({ id }).first();

    const storage = require('../../src/services/storage').getStorage();
    jest.spyOn(storage, 'putFromFile').mockRejectedValueOnce(new Error('S3 unavailable'));

    const result = await replace(before, event);
    expect(result.success).toBe(false);

    const row = await db('photos').where({ id }).first();
    expect(row.path).toBe(before.path);
    expect(row.preview_path).toBe('previews/kept-preview.jpg');
    expect(exists(path.posix.join('events/active', before.path))).toBe(true);
    expect(exists('previews/kept-preview.jpg')).toBe(true);
  }, 30000);

  it('a commit whose acknowledgement was lost keeps the new thumbnail', async () => {
    const uploadQuota = require('../../src/services/publicUploadQuota');
    const event = await makeEvent();
    const id = await addPhoto(event);
    jest.spyOn(uploadQuota, 'prepareObject').mockResolvedValue({ id: 'held' });
    jest.spyOn(uploadQuota, 'failedObject').mockResolvedValue();
    jest.spyOn(uploadQuota, 'commitObject').mockImplementation(async (object, kind, writeRow) => {
      await writeRow(db);
      throw new Error('acknowledgement lost');
    });

    const { replacePhoto } = require('../../src/services/photoReplacementService');
    const result = await replacePhoto(await db('photos').where({ id }).first(), await newTempFile('ack'), {
      originalFilename: 'new.jpg', mimeType: 'image/jpeg', event, uploadReservation: {},
    });
    expect(result.success).toBe(false);

    const row = await db('photos').where({ id }).first();
    expect(row.thumbnail_path).toBeTruthy();
    expect(exists(row.thumbnail_path)).toBe(true);
  }, 30000);

  it('a responsive tier cut from the replaced file is not left behind', async () => {
    const { ensureThumbnailAtWidth, ensurePreviewImageAtWidth, thumbnailTierKeys, previewTierKeys } = require('../../src/services/imageProcessor');
    const event = await makeEvent();
    const id = await addPhoto(event);
    const stale = await db('photos').where({ id }).first();
    expect((await replace(stale, event)).success).toBe(true);
    // A request that read the old row before the switch, still able to read
    // the old original, finishes after the replacement swept the old tiers.
    await writeKey(path.posix.join('events/active', stale.path), orangeJpeg);

    expect(await ensureThumbnailAtWidth(stale, 600)).toBeNull();
    expect(await ensurePreviewImageAtWidth(stale, 960)).toBeNull();
    for (const key of [...thumbnailTierKeys(stale), ...previewTierKeys(stale)]) expect(exists(key)).toBe(false);

    // The current row's tiers are generated and kept.
    const current = await db('photos').where({ id }).first();
    const tier = await ensureThumbnailAtWidth(current, 600);
    expect(tier).toBeTruthy();
    expect(exists(tier)).toBe(true);
  }, 30000);

  it('a recorded watermark keeps a previous key something still names', async () => {
    const watermarkService = require('../../src/services/watermarkService');
    const generator = require('../../src/services/watermarkGeneratorService');
    const event = await makeEvent();
    const previous = 'watermarks/previous_attempt.jpg';
    await writeKey(previous, orangeJpeg);
    const id = await addPhoto(event, { watermark_path: previous });
    // Recorded again since the job read the row (here: by another row).
    await addPhoto(event, { watermark_path: previous });
    const photo = await db('photos').where({ id }).first();

    const key = watermarkService.watermarkKey(photo);
    await writeKey(key, orangeJpeg);
    expect((await generator.recordWatermark(photo, { success: true, watermarkPath: key })).success).toBe(true);
    expect(exists(previous)).toBe(true);
    expect((await db('photos').where({ id }).first()).watermark_path).toBe(key);
  }, 30000);

  it('a watermark job that read the old file neither records nor overwrites', async () => {
    const watermarkService = require('../../src/services/watermarkService');
    const generator = require('../../src/services/watermarkGeneratorService');
    const event = await makeEvent();
    const id = await addPhoto(event);
    const stale = await db('photos').where({ id }).first();

    jest.spyOn(watermarkService, 'getWatermarkSettings').mockResolvedValue({ enabled: true });
    const oldMark = Buffer.from('old-watermark');
    const newMark = Buffer.from('new-watermark');
    let replaced;
    // The job reads the old file; the replacement lands while it renders.
    jest.spyOn(watermarkService, 'applyWatermark').mockImplementation(async () => {
      if (!replaced) {
        replaced = await replace(stale, event);
        return oldMark;
      }
      return newMark;
    });

    const result = await generator.generateForPhoto(id);
    expect(replaced.success).toBe(true);
    expect(result.success).toBe(false);

    let row = await db('photos').where({ id }).first();
    expect(row.watermark_path).toBeNull();
    expect(exists(watermarkService.watermarkKey(stale))).toBe(false);

    // The new file's own watermark is not touched by a late job for the old one.
    expect((await generator.generateForPhoto(id)).success).toBe(true);
    row = await db('photos').where({ id }).first();
    expect(row.watermark_path).toBe(watermarkService.watermarkKey(row));
    expect(row.watermark_path).not.toBe(watermarkService.watermarkKey(stale));
    // The batch path, with the old original still readable (say a NAS copy).
    await writeKey(path.posix.join('events/active', stale.path), orangeJpeg);
    const late = await generator.processPhotoWatermark({ ...stale, slug: event.slug }, { enabled: true });
    expect(late.success).toBe(false);
    expect(exists(watermarkService.watermarkKey(stale))).toBe(false);
    expect(await fs.promises.readFile(storagePath(row.watermark_path))).toEqual(newMark);
    expect((await db('photos').where({ id }).first()).watermark_path).toBe(row.watermark_path);
  }, 30000);

  it('a watermark refused by its attempt after the upload removes its file', async () => {
    const watermarkService = require('../../src/services/watermarkService');
    const attemptContext = require('../../src/services/mediaAttemptContext');
    const event = await makeEvent();
    const id = await addPhoto(event);
    const photo = await db('photos').where({ id }).first();
    jest.spyOn(watermarkService, 'applyWatermark').mockResolvedValue(Buffer.from('mark'));

    let checks = 0;
    const attempt = {
      id: '00000000-0000-4000-8000-000000000001',
      assertCurrent: async () => {
        checks += 1;
        if (checks > 1) throw new Error('Media attempt was superseded');
      },
    };
    const original = storagePath(path.posix.join('events/active', photo.path));
    const result = await attemptContext.run(attempt, () =>
      watermarkService.generateAndSaveWatermark(photo, original, { enabled: true }));

    expect(result.success).toBe(false);
    expect(exists(watermarkService.watermarkKey(photo, attempt))).toBe(false);
  }, 30000);
});
