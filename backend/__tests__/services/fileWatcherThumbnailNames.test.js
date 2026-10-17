/**
 * Same-named watch-folder files in two galleries get their own thumbnails.
 *
 * The thumbnail key is `thumbnails/thumb_<name>` with no gallery in it, and
 * the watcher named it after the camera's file name. Two galleries that each
 * received an IMG_0001.JPG pointed at one file: the later import overwrote it,
 * so one gallery showed the other's picture. Regenerating the thumbnail from
 * the source name had the same collision, and rows imported that way stayed
 * shared until repaired.
 *
 * Real SQLite database, real files on disk; each gallery's file is a solid
 * colour so a thumbnail can be traced back to the photo it came from.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-watcher-thumbs-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'watcher-thumbs-test-secret';
process.env.STORAGE_BACKEND = 'local';

const sharp = require('sharp');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const { processNewPhoto, repairSharedThumbnails } = require('../../src/services/fileWatcher');
const { ensureThumbnail, ensurePreviewImage } = require('../../src/services/imageProcessor');

const RED = { r: 220, g: 20, b: 20 };
const BLUE = { r: 20, g: 20, b: 220 };

let db;
let cleanup;

async function makeEvent(slug, { archived = false } = {}) {
  const inserted = await db('events').insert({
    slug,
    event_type: 'wedding',
    event_name: slug,
    event_date: '2026-10-14',
    host_email: 'host@example.com',
    admin_email: 'admin@example.com',
    password_hash: 'x',
    share_link: `/gallery/${slug}/share`,
    share_token: `${slug}-share`,
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    is_active: 1,
    is_archived: archived ? 1 : 0,
    is_draft: 0,
    created_at: new Date().toISOString(),
  }).returning('id');
  const id = inserted[0]?.id ?? inserted[0];
  const dir = path.join(process.env.STORAGE_PATH, 'events/active', slug, 'individual');
  fs.mkdirSync(dir, { recursive: true });
  return { id, slug, dir };
}

async function dropJpeg(event, name, background) {
  const filePath = path.join(event.dir, name);
  await sharp({ create: { width: 400, height: 300, channels: 3, background } }).jpeg().toFile(filePath);
  return filePath;
}

const abs = (key) => path.join(process.env.STORAGE_PATH, key);

// Red channel mean: high for the red source, low for the blue one.
async function redOf(key) {
  const { channels } = await sharp(abs(key)).stats();
  return channels[0].mean;
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  await seedMinimal(db);
}, 120000);

afterAll(async () => {
  if (cleanup) await cleanup();
});

describe('watch-folder thumbnail names', () => {
  it('gives same-named files in two galleries their own thumbnail', async () => {
    const a = await makeEvent('thumbs-import-a');
    const b = await makeEvent('thumbs-import-b');

    await processNewPhoto(await dropJpeg(a, 'IMG_0001.JPG', RED));
    await processNewPhoto(await dropJpeg(b, 'IMG_0001.JPG', BLUE));

    const photoA = await db('photos').where({ event_id: a.id }).first();
    const photoB = await db('photos').where({ event_id: b.id }).first();
    expect(photoA.thumbnail_path).not.toBe(photoB.thumbnail_path);
    expect(photoA.filename).toBe('IMG_0001.JPG');
    expect(await redOf(photoA.thumbnail_path)).toBeGreaterThan(150);
    expect(await redOf(photoB.thumbnail_path)).toBeLessThan(80);
  });

  it('still writes a thumbnail for a file name near the length limit', async () => {
    const a = await makeEvent('thumbs-long-name');
    const name = `${'x'.repeat(240)}.JPG`;
    await processNewPhoto(await dropJpeg(a, name, RED));

    const photo = await db('photos').where({ event_id: a.id }).first();
    expect(photo.filename).toBe(name);
    expect(path.basename(photo.thumbnail_path).length).toBeLessThan(255);
    expect(await redOf(photo.thumbnail_path)).toBeGreaterThan(150);
  });

  it('gives same-named videos their own placeholder', async () => {
    const a = await makeEvent('thumbs-video-a');
    const b = await makeEvent('thumbs-video-b');
    fs.writeFileSync(path.join(a.dir, 'MVI_0001.mp4'), Buffer.from('not a real video'));
    fs.writeFileSync(path.join(b.dir, 'MVI_0001.mp4'), Buffer.from('not a real video'));

    await processNewPhoto(path.join(a.dir, 'MVI_0001.mp4'));
    await processNewPhoto(path.join(b.dir, 'MVI_0001.mp4'));

    const rows = await db('photos').whereIn('event_id', [a.id, b.id]);
    expect(rows).toHaveLength(2);
    expect(rows[0].thumbnail_path).toBeTruthy();
    expect(rows[0].thumbnail_path).not.toBe(rows[1].thumbnail_path);
  });

  it('regenerates each photo under its own name', async () => {
    const a = await makeEvent('thumbs-regen-a');
    const b = await makeEvent('thumbs-regen-b');
    await processNewPhoto(await dropJpeg(a, 'IMG_0002.JPG', RED));
    await processNewPhoto(await dropJpeg(b, 'IMG_0002.JPG', BLUE));
    const photoA = await db('photos').where({ event_id: a.id }).first();
    const photoB = await db('photos').where({ event_id: b.id }).first();

    // The admin "Regenerate thumbnails" job passes the row with no key.
    const keyA = await ensureThumbnail({ ...photoA, thumbnail_path: null }, { force: true });
    const keyB = await ensureThumbnail({ ...photoB, thumbnail_path: null }, { force: true });

    expect(keyA).not.toBe(keyB);
    expect(await redOf(keyA)).toBeGreaterThan(150);
    expect(await redOf(keyB)).toBeLessThan(80);
  });

  it('regenerates each photo\'s lightbox preview under its own name', async () => {
    const a = await makeEvent('thumbs-preview-a');
    const b = await makeEvent('thumbs-preview-b');
    await processNewPhoto(await dropJpeg(a, 'IMG_0004.JPG', RED));
    await processNewPhoto(await dropJpeg(b, 'IMG_0004.JPG', BLUE));
    const photoA = await db('photos').where({ event_id: a.id }).first();
    const photoB = await db('photos').where({ event_id: b.id }).first();

    const keyA = await ensurePreviewImage(photoA);
    const keyB = await ensurePreviewImage(photoB);

    expect(keyA).not.toBe(keyB);
    expect(await redOf(keyA)).toBeGreaterThan(150);
    expect(await redOf(keyB)).toBeLessThan(80);
  });

  it('keeps an uploaded photo\'s thumbnail key when it is the only one on it', async () => {
    const a = await makeEvent('thumbs-own-key');
    await dropJpeg(a, 'own_individual_0001_abcdef.jpg', RED);
    const key = 'thumbnails/thumb_own_individual_0001_abcdef.jpg';
    const [row] = await db('photos').insert({
      event_id: a.id, filename: 'own_individual_0001_abcdef.jpg', source_filename: 'IMG_0001.JPG',
      path: `${a.slug}/individual/own_individual_0001_abcdef.jpg`, thumbnail_path: key,
      type: 'individual', media_type: 'image', source_origin: 'managed', processing_status: 'complete',
      size_bytes: 1, mime_type: 'image/jpeg',
    }).returning('id');
    const photo = await db('photos').where({ id: row?.id ?? row }).first();

    expect(await ensureThumbnail(photo, { force: true })).toBe(key);
  });

  it('separates rows that already share one thumbnail and keeps archived galleries out', async () => {
    const a = await makeEvent('thumbs-legacy-a');
    const b = await makeEvent('thumbs-legacy-b');
    const missing = await makeEvent('thumbs-legacy-missing');
    const archived = await makeEvent('thumbs-legacy-archived', { archived: true });
    await dropJpeg(a, 'IMG_0003.JPG', RED);
    await dropJpeg(b, 'IMG_0003.JPG', BLUE);
    // What the watcher wrote before: one key for all, holding the latest import.
    const shared = 'thumbnails/thumb_IMG_0003.JPG';
    await sharp({ create: { width: 300, height: 225, channels: 3, background: BLUE } }).jpeg().toFile(abs(shared));
    const sharedPreview = 'previews/preview_IMG_0003.jpg';
    fs.mkdirSync(path.dirname(abs(sharedPreview)), { recursive: true });
    await sharp({ create: { width: 800, height: 600, channels: 3, background: BLUE } }).jpeg().toFile(abs(sharedPreview));
    const legacyRow = (event) => ({
      event_id: event.id, filename: 'IMG_0003.JPG', source_filename: 'IMG_0003.JPG',
      path: `${event.slug}/individual/IMG_0003.JPG`, thumbnail_path: shared, preview_path: sharedPreview,
      type: 'individual', media_type: 'image', source_origin: 'managed',
      processing_status: 'complete', size_bytes: 1, mime_type: 'image/jpeg',
    });
    // `missing` has a row but its original is gone, so it cannot be rebuilt.
    await db('photos').insert([legacyRow(a), legacyRow(b), legacyRow(missing), legacyRow(archived)]);

    await repairSharedThumbnails();

    const photoA = await db('photos').where({ event_id: a.id }).first();
    const photoB = await db('photos').where({ event_id: b.id }).first();
    expect(photoA.thumbnail_path).not.toBe(photoB.thumbnail_path);
    expect(await redOf(photoA.thumbnail_path)).toBeGreaterThan(150);
    expect(await redOf(photoB.thumbnail_path)).toBeLessThan(80);
    expect(photoA.preview_path).not.toBe(photoB.preview_path);
    expect(await redOf(photoA.preview_path)).toBeGreaterThan(150);
    // Not left showing another gallery's picture: rebuilt on its next view.
    const photoMissing = await db('photos').where({ event_id: missing.id }).first();
    expect(photoMissing.thumbnail_path).toBeNull();
    expect(photoMissing.preview_path).toBeNull();
    // The archived row is not touched, so the key it holds stays on disk.
    expect((await db('photos').where({ event_id: archived.id }).first()).thumbnail_path).toBe(shared);
    expect(fs.existsSync(abs(shared))).toBe(true);

    // A second run finds nothing left to do.
    await repairSharedThumbnails();
    expect((await db('photos').where({ event_id: a.id }).first()).thumbnail_path).toBe(photoA.thumbnail_path);
  });

  it('separates a live photo that shares its thumbnail only with an archived gallery', async () => {
    const live = await makeEvent('thumbs-mixed-live');
    const archived = await makeEvent('thumbs-mixed-archived', { archived: true });
    await dropJpeg(live, 'IMG_0005.JPG', RED);
    const shared = 'thumbnails/thumb_IMG_0005.JPG';
    await sharp({ create: { width: 300, height: 225, channels: 3, background: BLUE } }).jpeg().toFile(abs(shared));
    const legacyRow = (event) => ({
      event_id: event.id, filename: 'IMG_0005.JPG', source_filename: 'IMG_0005.JPG',
      path: `${event.slug}/individual/IMG_0005.JPG`, thumbnail_path: shared,
      type: 'individual', media_type: 'image', source_origin: 'managed',
      processing_status: 'complete', size_bytes: 1, mime_type: 'image/jpeg',
    });
    await db('photos').insert([legacyRow(live), legacyRow(archived)]);

    await repairSharedThumbnails();

    const photo = await db('photos').where({ event_id: live.id }).first();
    expect(photo.thumbnail_path).not.toBe(shared);
    expect(await redOf(photo.thumbnail_path)).toBeGreaterThan(150);
  });

  it('keeps a shared file another row still names in a different column', async () => {
    const a = await makeEvent('thumbs-cross-a');
    const b = await makeEvent('thumbs-cross-b');
    const c = await makeEvent('thumbs-cross-c');
    await dropJpeg(a, 'IMG_0011.JPG', RED);
    await dropJpeg(b, 'IMG_0011.JPG', BLUE);
    const shared = 'thumbnails/thumb_IMG_0011.JPG';
    await sharp({ create: { width: 300, height: 225, channels: 3, background: BLUE } }).jpeg().toFile(abs(shared));
    const legacyRow = (event, extra) => ({
      event_id: event.id, filename: 'IMG_0011.JPG', source_filename: 'IMG_0011.JPG',
      path: `${event.slug}/individual/IMG_0011.JPG`,
      type: 'individual', media_type: 'image', source_origin: 'managed',
      processing_status: 'complete', size_bytes: 1, mime_type: 'image/jpeg', ...extra,
    });
    await db('photos').insert([
      legacyRow(a, { thumbnail_path: shared }),
      legacyRow(b, { thumbnail_path: shared }),
      // A third row names the same file as its preview only.
      legacyRow(c, { preview_path: shared }),
    ]);

    await repairSharedThumbnails();

    expect(await db('photos').where('thumbnail_path', shared).first()).toBeUndefined();
    expect(fs.existsSync(abs(shared))).toBe(true);
  });
});
