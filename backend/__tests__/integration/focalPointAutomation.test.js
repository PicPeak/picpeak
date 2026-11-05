/**
 * Focal points without an admin (issue 2377): from the faces the face scan
 * found, and for the photos from before focal points, a background pass.
 *
 * Real rebuild, real sharp, SQLite. The photo is a grey field with a red
 * block at its right edge, which sharp's attention pass picks; the faces are
 * put on the left, where there is nothing red, so a crop that follows them
 * shows no red.
 * Pins:
 *  - the point is the middle of the faces, a small background face ignored
 *  - a face scan moves an automatic point to the faces, never a manual one
 *  - a redetect whose snapshot predates a manual save keeps the manual point
 *  - going back to automatic takes the faces over sharp's guess
 *  - the backfill cuts a photo without a point, only marks one with a point
 *    or a video, and leaves a photo it could not cut for the next pass
 *  - and never deletes an original a legacy row names as its thumbnail
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-focal-auto-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'focal-auto-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-focal-auto-storage-'));
process.env.FOCAL_BACKFILL_PAUSE_MS = '0';

const sharp = require('sharp');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

jest.setTimeout(120000);

let db; let cleanup; let eventId;

const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);
const row = (id) => db('photos').where({ id }).first();
// Mean red-minus-green of the stored thumbnail: high where the red block is.
const thumbnailRedness = async (id) => {
  const { thumbnail_path: key } = await row(id);
  const { channels } = await sharp(fs.readFileSync(path.join(process.env.STORAGE_PATH, key))).stats();
  return channels[0].mean - channels[1].mean;
};

let seq = 0;
async function insertPhoto(over = {}) {
  seq += 1;
  const filename = `shot-${seq}.jpg`;
  fs.copyFileSync(
    path.join(process.env.STORAGE_PATH, 'events/active/focal-auto/source.jpg'),
    path.join(process.env.STORAGE_PATH, `events/active/focal-auto/${filename}`),
  );
  return unwrap(await db('photos').insert({
    event_id: eventId, filename, path: `focal-auto/${filename}`, type: 'individual',
    media_type: 'image', mime_type: 'image/jpeg', width: 1200, height: 600,
    size_bytes: 5, processing_status: 'complete', uploaded_at: new Date().toISOString(), ...over,
  }).returning('id'));
}

// Two faces on the left, and a small one by the red block (a guest far back).
async function addFaces(photoId) {
  const face = (x, y, w, h) => ({
    photo_id: photoId, event_id: eventId, bbox_x: x, bbox_y: y, bbox_w: w, bbox_h: h,
    created_at: new Date().toISOString(),
  });
  await db('photo_faces').insert([face(100, 200, 120, 120), face(300, 220, 100, 100), face(1000, 250, 20, 20)]);
}
// The two large faces span x 100..400, y 200..320. A square crop of the
// 1200x600 photo is 600 wide: centring them would start it left of the
// edge, so it starts at the edge (x 0). It spans the height, so y is their
// middle.
const FACES_POINT = { x: 0, y: 0.433 };

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  const { adminId } = await seedMinimal(db);
  eventId = unwrap(await db('events').insert({
    slug: 'focal-auto', event_type: 'wedding', event_name: 'Focal auto', event_date: '2026-08-01',
    host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
    share_token: 'tok-focal-auto', share_link: '/gallery/focal-auto/tok-focal-auto',
    created_by: adminId, expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
    is_active: 1, is_archived: 0, is_draft: 0, created_at: new Date().toISOString(),
  }).returning('id'));
  const dir = path.join(process.env.STORAGE_PATH, 'events/active/focal-auto');
  fs.mkdirSync(dir, { recursive: true });
  const block = await sharp({ create: { width: 240, height: 240, channels: 3, background: { r: 230, g: 20, b: 20 } } }).png().toBuffer();
  await sharp({ create: { width: 1200, height: 600, channels: 3, background: { r: 128, g: 128, b: 128 } } })
    .composite([{ input: block, left: 940, top: 180 }]).jpeg({ quality: 95 }).toFile(path.join(dir, 'source.jpg'));
}, 120000);

afterAll(async () => { if (cleanup) await cleanup(); });

describe('a focal point from faces', () => {
  const { faceFocalPoint, refocusFromFaces } = require('../../src/services/faceFocalPoint');

  it('is the middle of the faces, without the small one far back', async () => {
    const id = await insertPhoto();
    expect(await faceFocalPoint(id)).toBeNull();
    await addFaces(id);
    expect(await faceFocalPoint(id)).toEqual(FACES_POINT);
    await db('photos').where({ id }).update({ width: null });
    expect(await faceFocalPoint(id)).toBeNull();
  });

  it('a face scan moves an automatic point to the faces', async () => {
    const { ensureThumbnail } = require('../../src/services/imageProcessor');
    const id = await insertPhoto();
    expect(await ensureThumbnail(await row(id), { force: true })).toBeTruthy();
    expect((await row(id)).focal_x).toBeGreaterThan(0.75);
    await addFaces(id);
    expect(await refocusFromFaces(await row(id))).toBe(true);
    expect(await row(id)).toMatchObject({ focal_x: FACES_POINT.x, focal_y: FACES_POINT.y, focal_source: 'auto' });
    expect(await thumbnailRedness(id)).toBeLessThan(5);
    // Already there: nothing is cut again.
    const storage = require('../../src/services/storage').getStorage();
    const put = jest.spyOn(storage, 'put');
    try {
      expect(await refocusFromFaces(await row(id))).toBe(true);
      expect(put).not.toHaveBeenCalled();
    } finally {
      put.mockRestore();
    }
  });

  it('a later scan is cut after an older scan\'s rebuild, not skipped against it', async () => {
    const storage = require('../../src/services/storage').getStorage();
    const id = await insertPhoto({ focal_x: FACES_POINT.x, focal_y: FACES_POINT.y, focal_source: 'auto' });
    // Scan A found faces further right; its rebuild stops at the write.
    await db('photo_faces').insert({
      photo_id: id, event_id: eventId, bbox_x: 700, bbox_y: 200, bbox_w: 120, bbox_h: 120, created_at: new Date().toISOString(),
    });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const original = storage.put.bind(storage);
    let first = true;
    const put = jest.spyOn(storage, 'put').mockImplementation(async (...args) => {
      if (first) { first = false; await gate; }
      return original(...args);
    });
    try {
      const a = refocusFromFaces(await row(id));
      await new Promise((resolve) => { setTimeout(resolve, 200); });
      // Scan B replaced them with faces on the point the row still has.
      await db('photo_faces').where({ photo_id: id }).del();
      await addFaces(id);
      const b = refocusFromFaces(await row(id));
      release();
      await Promise.all([a, b]);
    } finally {
      put.mockRestore();
    }
    expect(await row(id)).toMatchObject({ focal_x: FACES_POINT.x, focal_y: FACES_POINT.y, focal_source: 'auto' });
  });

  it('keeps an off-centre group whole in the square crop', async () => {
    const { faceFocalPoint } = require('../../src/services/faceFocalPoint');
    const { focalCoverWindow } = require('../../src/utils/focalPoint');
    const id = await insertPhoto();
    const face = (x) => ({
      photo_id: id, event_id: eventId, bbox_x: x, bbox_y: 200, bbox_w: 120, bbox_h: 120, created_at: new Date().toISOString(),
    });
    // Their middle (x 0.25) would place the square at 150..750 and cut off
    // the face at 0..120.
    await db('photo_faces').insert([face(0), face(480)]);
    const point = await faceFocalPoint(id);
    const crop = focalCoverWindow(1200, 600, 300, 300, point);
    expect(crop.left).toBeLessThanOrEqual(0);
    expect(crop.left + crop.width).toBeGreaterThanOrEqual(600);
    // A pair off to the right, the other way.
    await db('photo_faces').where({ photo_id: id }).del();
    await db('photo_faces').insert([face(700), face(1080)]);
    const right = focalCoverWindow(1200, 600, 300, 300, await faceFocalPoint(id));
    expect(right.left).toBeLessThanOrEqual(700);
    expect(right.left + right.width).toBeGreaterThanOrEqual(1200);
  });

  it('places the faces for the configured thumbnail shape, not a square', async () => {
    const { faceFocalPoint } = require('../../src/services/faceFocalPoint');
    const { focalCoverWindow } = require('../../src/utils/focalPoint');
    const keys = ['thumbnail_width', 'thumbnail_height'];
    const before = await db('app_settings').whereIn('setting_key', keys);
    const id = await insertPhoto();
    await db('photo_faces').insert({
      photo_id: id, event_id: eventId, bbox_x: 200, bbox_y: 200, bbox_w: 120, bbox_h: 120, created_at: new Date().toISOString(),
    });
    // Portrait thumbnails: the crop of the 1200x600 photo is 300 wide.
    await db('app_settings').whereIn('setting_key', keys).del();
    await db('app_settings').insert([
      { setting_key: 'thumbnail_width', setting_value: '200', setting_type: 'number' },
      { setting_key: 'thumbnail_height', setting_value: '400', setting_type: 'number' },
    ]);
    try {
      const crop = focalCoverWindow(1200, 600, 200, 400, await faceFocalPoint(id));
      expect(crop.left).toBeLessThanOrEqual(200);
      expect(crop.left + crop.width).toBeGreaterThanOrEqual(320);
    } finally {
      await db('app_settings').whereIn('setting_key', keys).del();
      if (before.length) await db('app_settings').insert(before.map(({ id: _id, ...rest }) => rest));
    }
  });

  it('leaves faces that do not fit the stored size to sharp', async () => {
    const { faceFocalPoint } = require('../../src/services/faceFocalPoint');
    // An EXIF-rotated photo whose size was stored unrotated: boxes scaled
    // against the wrong width run past the bottom.
    const id = await insertPhoto();
    await db('photo_faces').insert({
      photo_id: id, event_id: eventId, bbox_x: 480, bbox_y: 480, bbox_w: 240, bbox_h: 240, created_at: new Date().toISOString(),
    });
    expect(await faceFocalPoint(id)).toBeNull();
  });

  it('never moves a point set by hand, even from a snapshot read before it', async () => {
    const { ensureThumbnail } = require('../../src/services/imageProcessor');
    const id = await insertPhoto({ focal_x: 0.9, focal_y: 0.5, focal_source: 'manual' });
    await addFaces(id);
    const storage = require('../../src/services/storage').getStorage();
    const { ensureThumbnail: cut } = require('../../src/services/imageProcessor');
    expect(await cut(await row(id), { force: true })).toBeTruthy();
    const put = jest.spyOn(storage, 'put');
    try {
      // Kept, and nothing is cut for it.
      expect(await refocusFromFaces(await row(id))).toBe(true);
      expect(put).not.toHaveBeenCalled();
    } finally {
      put.mockRestore();
    }
    const snapshot = { ...(await row(id)), focal_x: 0.5, focal_y: 0.5, focal_source: 'auto' };
    expect(await ensureThumbnail(snapshot, { force: true, focalPoint: { redetect: true } })).toBeTruthy();
    expect(await row(id)).toMatchObject({ focal_x: 0.9, focal_y: 0.5, focal_source: 'manual' });
    expect(await thumbnailRedness(id)).toBeGreaterThan(20);
  });

  it('a scan read while the point was manual follows the faces once it is automatic again', async () => {
    const id = await insertPhoto({ focal_x: 0.9, focal_y: 0.5, focal_source: 'manual' });
    const readByTheScan = await row(id);
    // The admin goes back to automatic while the scan runs.
    await db('photos').where({ id }).update({ focal_x: 0.8, focal_y: 0.5, focal_source: 'auto' });
    await addFaces(id);
    expect(await refocusFromFaces(readByTheScan)).toBe(true);
    expect(await row(id)).toMatchObject({ focal_x: FACES_POINT.x, focal_y: FACES_POINT.y, focal_source: 'auto' });
  });

  it('a point set by hand while a redetect writes gets its own crop back', async () => {
    const storage = require('../../src/services/storage').getStorage();
    const { ensureThumbnail } = require('../../src/services/imageProcessor');
    const id = await insertPhoto({ focal_x: 0.5, focal_y: 0.5, focal_source: 'auto' });
    // A thumbnail under the key every render of this photo writes.
    expect(await ensureThumbnail(await row(id), { force: true })).toBeTruthy();
    await addFaces(id);
    const original = storage.put.bind(storage);
    let saved = false;
    // The admin saves the red block while the redetect's crop around the
    // faces is being written over the shared key.
    const put = jest.spyOn(storage, 'put').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (!saved) {
        saved = true;
        await db('photos').where({ id }).update({ focal_x: 0.9, focal_y: 0.5, focal_source: 'manual' });
      }
      return result;
    });
    try {
      expect(await ensureThumbnail(await row(id), { force: true, focalPoint: { redetect: true } })).toBeTruthy();
    } finally {
      put.mockRestore();
    }
    expect(await row(id)).toMatchObject({ focal_x: 0.9, focal_y: 0.5, focal_source: 'manual' });
    expect(await thumbnailRedness(id)).toBeGreaterThan(20);
  });

  it('back to automatic takes the faces over sharp\'s guess', async () => {
    const { ensureThumbnail } = require('../../src/services/imageProcessor');
    const id = await insertPhoto({ focal_x: 0.9, focal_y: 0.5, focal_source: 'manual' });
    await addFaces(id);
    expect(await ensureThumbnail(await row(id), { force: true, focalPoint: { point: null } })).toBeTruthy();
    expect(await row(id)).toMatchObject({ focal_x: FACES_POINT.x, focal_y: FACES_POINT.y, focal_source: 'auto' });
  });
});

describe('the backfill', () => {
  const backfill = require('../../src/services/focalPointBackfill');
  const pass = () => backfill.runPass({ active: () => true, sleep: async () => {} });

  it('cuts photos without a point, marks the rest, and keeps a failure for the next pass', async () => {
    await db('photos').update({ focal_checked: 1 });
    const plain = await insertPhoto({ focal_checked: 0 });
    const withFaces = await insertPhoto({ focal_checked: 0 });
    await addFaces(withFaces);
    const manual = await insertPhoto({ focal_x: 0.1, focal_y: 0.1, focal_source: 'manual', focal_checked: 0 });
    const video = await insertPhoto({ media_type: 'video', mime_type: 'video/mp4', focal_checked: 0 });
    const missing = await insertPhoto({ focal_checked: 0 });
    fs.rmSync(path.join(process.env.STORAGE_PATH, `events/active/focal-auto/${(await row(missing)).filename}`));

    expect(await pass()).toEqual({ done: 4, failed: 1 });
    expect(await row(plain)).toMatchObject({ focal_source: 'auto', focal_checked: 1 });
    expect((await row(plain)).focal_x).toBeGreaterThan(0.75);
    expect(await thumbnailRedness(plain)).toBeGreaterThan(20);
    expect(await row(withFaces)).toMatchObject({ focal_x: FACES_POINT.x, focal_y: FACES_POINT.y, focal_checked: 1 });
    expect(await row(manual)).toMatchObject({ focal_x: 0.1, focal_y: 0.1, focal_source: 'manual', focal_checked: 1 });
    expect(await row(video)).toMatchObject({ focal_source: null, focal_checked: 1 });
    expect((await row(missing)).focal_checked).toBe(0);

    // The next pass finds only the one it could not cut.
    expect(await pass()).toEqual({ done: 0, failed: 1 });
  });

  it('keeps the original a legacy row names as its thumbnail', async () => {
    await db('photos').update({ focal_checked: 1 });
    const id = await insertPhoto({ focal_checked: 0 });
    const original = `events/active/focal-auto/${(await row(id)).filename}`;
    await db('photos').where({ id }).update({ thumbnail_path: original });
    expect(await pass()).toEqual({ done: 1, failed: 0 });
    expect((await row(id)).thumbnail_path).not.toBe(original);
    expect(fs.existsSync(path.join(process.env.STORAGE_PATH, original))).toBe(true);
  });
});
