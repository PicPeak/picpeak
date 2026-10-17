/**
 * Same-named watch-folder files in two galleries get their own thumbnails.
 *
 * The thumbnail key is `thumbnails/thumb_<name>` with no gallery in it, and
 * the watcher named it after the camera's file name. Two galleries that each
 * received an IMG_0001.JPG pointed at one file: the later import overwrote it,
 * so one gallery showed the other's picture. Regenerating the thumbnail,
 * preview or hero from the source name had the same collision, and rows
 * imported that way stayed shared until repaired.
 *
 * Real SQLite database, real files on disk; each gallery's file is a solid
 * colour so a rendition can be traced back to the photo it came from.
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

const RED = { r: 220, g: 20, b: 20 };
const BLUE = { r: 20, g: 20, b: 220 };

let db;
let cleanup;
// Required after bootCrmDb, which sets STORAGE_PATH.
let processNewPhoto;
let repairSharedThumbnails;
let ensureThumbnail;
let ensurePreviewImage;
let ensureHeroImage;

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

async function writeSolid(key, width, height, background) {
  fs.mkdirSync(path.dirname(abs(key)), { recursive: true });
  await sharp({ create: { width, height, channels: 3, background } }).jpeg().toFile(abs(key));
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  await seedMinimal(db);
  ({ processNewPhoto, repairSharedThumbnails } = require('../../src/services/fileWatcher'));
  ({ ensureThumbnail, ensurePreviewImage, ensureHeroImage } = require('../../src/services/imageProcessor'));
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

  it('writes nothing for a file it has already imported (the boot rescan)', async () => {
    const a = await makeEvent('thumbs-rescan');
    const file = await dropJpeg(a, 'IMG_0006.JPG', RED);
    await processNewPhoto(file);
    const before = fs.readdirSync(abs('thumbnails')).length;

    await processNewPhoto(file);

    expect(await db('photos').where({ event_id: a.id })).toHaveLength(1);
    expect(fs.readdirSync(abs('thumbnails')).length).toBe(before);
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

  it('regenerates each photo\'s lightbox preview and hero under its own name', async () => {
    const a = await makeEvent('thumbs-preview-a');
    const b = await makeEvent('thumbs-preview-b');
    await processNewPhoto(await dropJpeg(a, 'IMG_0004.JPG', RED));
    await processNewPhoto(await dropJpeg(b, 'IMG_0004.JPG', BLUE));
    const photoA = await db('photos').where({ event_id: a.id }).first();
    const photoB = await db('photos').where({ event_id: b.id }).first();

    const previewA = await ensurePreviewImage(photoA);
    const previewB = await ensurePreviewImage(photoB);
    expect(previewA).not.toBe(previewB);
    expect(await redOf(previewA)).toBeGreaterThan(150);
    expect(await redOf(previewB)).toBeLessThan(80);

    const heroA = await ensureHeroImage(photoA);
    const heroB = await ensureHeroImage(photoB);
    expect(heroA).not.toBe(heroB);
    expect(await redOf(heroA)).toBeGreaterThan(150);
    expect(await redOf(heroB)).toBeLessThan(80);
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
    await writeSolid(shared, 300, 225, BLUE);
    const sharedPreview = 'previews/preview_IMG_0003.jpg';
    await writeSolid(sharedPreview, 800, 600, BLUE);
    const sharedHero = 'heroes/hero_IMG_0003.jpg';
    await writeSolid(sharedHero, 1920, 1080, BLUE);
    const legacyRow = (event) => ({
      event_id: event.id, filename: 'IMG_0003.JPG', source_filename: 'IMG_0003.JPG',
      path: `${event.slug}/individual/IMG_0003.JPG`, thumbnail_path: shared, preview_path: sharedPreview,
      hero_path: sharedHero, type: 'individual', media_type: 'image', source_origin: 'managed',
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
    expect(photoA.hero_path).not.toBe(photoB.hero_path);
    expect(await redOf(photoA.hero_path)).toBeGreaterThan(150);
    // Not left showing another gallery's picture: rebuilt on its next view.
    const photoMissing = await db('photos').where({ event_id: missing.id }).first();
    expect(photoMissing.thumbnail_path).toBeNull();
    expect(photoMissing.preview_path).toBeNull();
    expect(photoMissing.hero_path).toBeNull();
    // The archived row is not touched, so the key it holds stays on disk.
    expect((await db('photos').where({ event_id: archived.id }).first()).thumbnail_path).toBe(shared);
    expect(fs.existsSync(abs(shared))).toBe(true);

    // A second run finds nothing left to do.
    await repairSharedThumbnails();
    expect((await db('photos').where({ event_id: a.id }).first()).thumbnail_path).toBe(photoA.thumbnail_path);
  });

  it('removes a shared file once no row points at it any more', async () => {
    const a = await makeEvent('thumbs-drop-a');
    const b = await makeEvent('thumbs-drop-b');
    await dropJpeg(a, 'IMG_0007.JPG', RED);
    await dropJpeg(b, 'IMG_0007.JPG', BLUE);
    const shared = 'thumbnails/thumb_IMG_0007.JPG';
    await writeSolid(shared, 300, 225, BLUE);
    const legacyRow = (event) => ({
      event_id: event.id, filename: 'IMG_0007.JPG', source_filename: 'IMG_0007.JPG',
      path: `${event.slug}/individual/IMG_0007.JPG`, thumbnail_path: shared,
      type: 'individual', media_type: 'image', source_origin: 'managed',
      processing_status: 'complete', size_bytes: 1, mime_type: 'image/jpeg',
    });
    await db('photos').insert([legacyRow(a), legacyRow(b)]);

    await repairSharedThumbnails();

    expect(await db('photos').where('thumbnail_path', shared).first()).toBeUndefined();
    expect(fs.existsSync(abs(shared))).toBe(false);
  });

  it('admin regenerate moves a photo off a shared key without deleting the other gallery\'s file', async () => {
    const express = require('express');
    const request = require('supertest');
    const { assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');
    const a = await makeEvent('thumbs-admin-a');
    const b = await makeEvent('thumbs-admin-b');
    await dropJpeg(a, 'IMG_0008.JPG', RED);
    await dropJpeg(b, 'IMG_0008.JPG', BLUE);
    const shared = 'thumbnails/thumb_IMG_0008.JPG';
    await writeSolid(shared, 300, 225, BLUE);
    const legacyRow = (event) => ({
      event_id: event.id, filename: 'IMG_0008.JPG', source_filename: 'IMG_0008.JPG',
      path: `${event.slug}/individual/IMG_0008.JPG`, thumbnail_path: shared,
      type: 'individual', media_type: 'image', source_origin: 'managed',
      processing_status: 'complete', size_bytes: 1, mime_type: 'image/jpeg',
    });
    await db('photos').insert([legacyRow(a), legacyRow(b)]);
    const adminId = (await db('admin_users').where({ username: 'tester' }).first()).id;
    await assignAdminRole(db, adminId, 'super_admin');
    const app = express();
    app.use(express.json());
    app.use('/api/admin/thumbnails', require('../../src/routes/adminThumbnails'));

    const res = await request(app).post('/api/admin/thumbnails/regenerate')
      .set('Authorization', `Bearer ${mintAdminToken(adminId)}`).send({ eventId: a.id });
    expect(res.status).toBe(200);
    await require('../../src/services/activeApplicationWork').drain();

    const photoA = await db('photos').where({ event_id: a.id }).first();
    expect(photoA.thumbnail_path).not.toBe(shared);
    expect(await redOf(photoA.thumbnail_path)).toBeGreaterThan(150);
    expect((await db('photos').where({ event_id: b.id }).first()).thumbnail_path).toBe(shared);
    expect(fs.existsSync(abs(shared))).toBe(true);
  });

  it('separates a live photo that shares its thumbnail only with an archived gallery', async () => {
    const live = await makeEvent('thumbs-mixed-live');
    const archived = await makeEvent('thumbs-mixed-archived', { archived: true });
    await dropJpeg(live, 'IMG_0005.JPG', RED);
    const shared = 'thumbnails/thumb_IMG_0005.JPG';
    await writeSolid(shared, 300, 225, BLUE);
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
    expect(fs.existsSync(abs(shared))).toBe(true);
  });
});
