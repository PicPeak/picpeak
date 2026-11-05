/**
 * The admin sets where a photo's crops keep its subject (issue 2377).
 *
 * Through the real route, the real thumbnail rebuild, real sharp and SQLite
 * (thumbnail_fit is 'cover', as migration 040 seeds it). The photo is a grey
 * field with a red subject at its right edge, which a centred square misses.
 * Pins:
 *  - a manual point is stored and the thumbnail cut around it, its tiers
 *    dropped, under a thumbnail URL that names the point
 *  - a later rebuild, from a row read without the columns as the regenerate
 *    sweep reads it, keeps the manual point and does not detect over it
 *  - null resets to the detected point, which lands with its crop
 *  - a rebuild of a photo with no point detects and records one
 *  - photos.edit, event ownership, images only, fractions only
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-focal-route-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'focal-route-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-focal-route-storage-'));

const request = require('supertest');
const sharp = require('sharp');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('../integration/helpers/crmDb');
const svc = require('../../src/services/userManagementService');
const { clearPermissionCache } = require('../../src/middleware/permissions');

jest.setTimeout(120000);

let db; let cleanup; let app; let token; let outsiderToken; let readerToken;
let eventId; let photoId; let videoId; let processingId;

const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);
const auth = (req, tok = token) => req.set('Authorization', `Bearer ${tok}`);
const setFocal = (id, body, tok) => auth(request(app).put(`/api/admin/photos/${eventId}/photos/${id}/focal-point`).send(body), tok);
const row = () => db('photos').where({ id: photoId }).first();
// Mean red-minus-green of the stored thumbnail: high where the subject is.
const thumbnailRedness = async () => {
  const { thumbnail_path: key } = await row();
  const { channels } = await sharp(fs.readFileSync(path.join(process.env.STORAGE_PATH, key))).stats();
  return channels[0].mean - channels[1].mean;
};

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  const { adminId } = await seedMinimal(db);
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);

  const editor = await svc.createRole({ name: 'focal_editor', permissions: ['photos.view', 'photos.edit'] }, adminId);
  outsiderToken = mintAdminToken(unwrap(await db('admin_users').insert({
    username: 'outsider', email: 'outsider@example.com', password_hash: 'x',
    role_id: editor.id, must_change_password: false, created_at: new Date().toISOString(),
  }).returning('id')));
  const reader = await svc.createRole({ name: 'focal_reader', permissions: ['photos.view'] }, adminId);
  readerToken = mintAdminToken(unwrap(await db('admin_users').insert({
    username: 'reader', email: 'reader@example.com', password_hash: 'x',
    role_id: reader.id, must_change_password: false, created_at: new Date().toISOString(),
  }).returning('id')));
  clearPermissionCache();

  eventId = unwrap(await db('events').insert({
    slug: 'focal-pick', event_type: 'wedding', event_name: 'Focal pick', event_date: '2026-08-01',
    host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
    share_token: 'tok-focal-pick', share_link: '/gallery/focal-pick/tok-focal-pick',
    created_by: adminId, expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
    is_active: 1, is_archived: 0, is_draft: 0, created_at: new Date().toISOString(),
  }).returning('id'));

  const dir = path.join(process.env.STORAGE_PATH, 'events/active/focal-pick');
  fs.mkdirSync(dir, { recursive: true });
  const subject = await sharp({ create: { width: 240, height: 240, channels: 3, background: { r: 230, g: 20, b: 20 } } }).png().toBuffer();
  await sharp({ create: { width: 1200, height: 600, channels: 3, background: { r: 128, g: 128, b: 128 } } })
    .composite([{ input: subject, left: 940, top: 180 }]).jpeg({ quality: 95 }).toFile(path.join(dir, 'couple.jpg'));
  fs.writeFileSync(path.join(dir, 'clip.mp4'), 'video');

  const insert = async (filename, over) => unwrap(await db('photos').insert({
    event_id: eventId, filename, path: `focal-pick/${filename}`, type: 'individual',
    size_bytes: 5, processing_status: 'complete', uploaded_at: new Date().toISOString(), ...over,
  }).returning('id'));
  photoId = await insert('couple.jpg', { media_type: 'image', mime_type: 'image/jpeg' });
  videoId = await insert('clip.mp4', { media_type: 'video', mime_type: 'video/mp4', duration: 10 });
  processingId = await insert('late.jpg', { media_type: 'image', mime_type: 'image/jpeg', processing_status: 'processing' });

  app = buildRouteApp('/api/admin/photos', require('../../src/routes/adminPhotos'));
}, 120000);

afterAll(async () => { if (cleanup) await cleanup(); });

describe('rebuilding a photo without a point', () => {
  it('detects one, records it with its crop, and the crop keeps the subject', async () => {
    const { ensureThumbnail } = require('../../src/services/imageProcessor');
    expect(await ensureThumbnail(await row(), { force: true })).toBeTruthy();
    const after = await row();
    expect(after.focal_source).toBe('auto');
    expect(after.focal_x).toBeGreaterThan(0.75);
    expect(await thumbnailRedness()).toBeGreaterThan(20);
  });
});

describe('PUT focal-point', () => {
  it('stores a manual point and cuts the thumbnail and its tiers around it', async () => {
    const { thumbnailTierKeys } = require('../../src/services/imageProcessor');
    const tier = path.join(process.env.STORAGE_PATH, thumbnailTierKeys(await row())[1]);
    fs.mkdirSync(path.dirname(tier), { recursive: true });
    fs.writeFileSync(tier, 'old crop');

    // The far left: nothing there, which proves the crop follows the admin.
    const res = await setFocal(photoId, { focal_point: { x: 0, y: 0.5 } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ focal_point: { x: 0, y: 0.5 }, focal_source: 'manual' });
    expect(res.body.thumbnail_url).toBe(`/admin/photos/${eventId}/thumbnail/${photoId}?v=f0-500`);
    expect(await row()).toMatchObject({ focal_x: 0, focal_y: 0.5, focal_source: 'manual' });
    expect(await thumbnailRedness()).toBeLessThan(5);
    expect(fs.existsSync(tier)).toBe(false);

    const list = await auth(request(app).get(`/api/admin/photos/${eventId}/photos`));
    expect(list.body.photos.find((p) => p.id === photoId)).toMatchObject({
      focal_point: { x: 0, y: 0.5 }, focal_source: 'manual', thumbnail_url: res.body.thumbnail_url,
    });
  });

  it('keeps the manual point on a later rebuild from a row read without the columns', async () => {
    const { ensureThumbnail } = require('../../src/services/imageProcessor');
    // The columns the admin regenerate sweep selects (adminThumbnails.js).
    const narrow = await db('photos').where({ id: photoId })
      .first('id', 'event_id', 'path', 'media_type', 'mime_type', 'thumbnail_path', 'processing_status',
        'source_origin', 'external_relpath', 'filename', 'size_bytes', 'source_mtime_ms', 'source_filename');
    expect(await ensureThumbnail({ ...narrow, thumbnail_path: null }, { force: true })).toBeTruthy();
    expect(await row()).toMatchObject({ focal_x: 0, focal_y: 0.5, focal_source: 'manual' });
    expect(await thumbnailRedness()).toBeLessThan(5);
  });

  it('null goes back to the detected point', async () => {
    const res = await setFocal(photoId, { focal_point: null });
    expect(res.status).toBe(200);
    expect(res.body.focal_source).toBe('auto');
    expect(res.body.focal_point.x).toBeGreaterThan(0.75);
    expect(res.body.thumbnail_url).toMatch(/\?v=f\d+-\d+$/);
    expect(await thumbnailRedness()).toBeGreaterThan(20);
  });

  it('refuses values outside 0..1, other shapes, and a missing body', async () => {
    for (const body of [{}, { focal_point: { x: 1.2, y: 0.5 } }, { focal_point: { x: -0.1, y: 0 } },
      { focal_point: { x: '0.5', y: 0.5 } }, { focal_point: [0.5, 0.5] }, { focal_point: 'center' }]) {
      expect((await setFocal(photoId, body)).status).toBe(400);
    }
    expect((await row()).focal_source).toBe('auto');
  });

  it('refuses a video, a photo still processing, and a photo of another event', async () => {
    expect((await setFocal(videoId, { focal_point: { x: 0.5, y: 0.5 } })).status).toBe(400);
    expect((await setFocal(processingId, { focal_point: { x: 0.5, y: 0.5 } })).status).toBe(409);
    expect((await setFocal(999999, { focal_point: { x: 0.5, y: 0.5 } })).status).toBe(404);
  });

  it('needs photos.edit and the event', async () => {
    expect((await setFocal(photoId, { focal_point: { x: 0.5, y: 0.5 } }, readerToken)).status).toBe(403);
    expect([403, 404]).toContain((await setFocal(photoId, { focal_point: { x: 0.5, y: 0.5 } }, outsiderToken)).status);
    expect((await request(app).put(`/api/admin/photos/${eventId}/photos/${photoId}/focal-point`).send({ focal_point: null })).status).toBe(401);
    expect((await row()).focal_source).toBe('auto');
  });
});

describe('a point lands with its crop', () => {
  const thumbBytes = async () => fs.readFileSync(path.join(process.env.STORAGE_PATH, (await row()).thumbnail_path));

  it('keeps the old point on the row until the new crop is stored', async () => {
    const storage = require('../../src/services/storage').getStorage();
    const before = await row();
    const seen = [];
    const original = storage.put.bind(storage);
    const put = jest.spyOn(storage, 'put').mockImplementation(async (...args) => {
      seen.push(await row());
      return original(...args);
    });
    try {
      expect((await setFocal(photoId, { focal_point: { x: 0.2, y: 0.5 } })).status).toBe(200);
    } finally {
      put.mockRestore();
    }
    expect(seen.length).toBeGreaterThan(0);
    // While the thumbnail was written, listings still named the old point.
    for (const during of seen) {
      expect([during.focal_x, during.focal_y, during.focal_source]).toEqual([before.focal_x, before.focal_y, before.focal_source]);
    }
    expect(await row()).toMatchObject({ focal_x: 0.2, focal_y: 0.5, focal_source: 'manual' });
  });

  it('leaves the point and the crop as they were when the rebuild throws', async () => {
    const before = await row();
    const bytes = await thumbBytes();
    const source = path.join(process.env.STORAGE_PATH, 'events/active/focal-pick/couple.jpg');
    fs.renameSync(source, `${source}.away`);
    try {
      expect((await setFocal(photoId, { focal_point: { x: 0.9, y: 0.1 } })).status).not.toBe(200);
    } finally {
      fs.renameSync(`${source}.away`, source);
    }
    expect(await row()).toMatchObject({ focal_x: before.focal_x, focal_y: before.focal_y, focal_source: before.focal_source });
    expect((await thumbBytes()).equals(bytes)).toBe(true);
  });

  it('a render that read an older point leaves the row\'s point and its crop', async () => {
    const { ensureThumbnail } = require('../../src/services/imageProcessor');
    await db('photos').where({ id: photoId }).update({ focal_x: 0, focal_y: 0.5, focal_source: 'manual' });
    // Read before an admin moved the point to the left (another replica's
    // sweep): it would cut around the subject on the right.
    const stale = { ...(await row()), focal_x: 1, focal_y: 0.5, focal_source: 'manual' };
    expect(await ensureThumbnail(stale, { force: true })).toBeTruthy();
    expect(await row()).toMatchObject({ focal_x: 0, focal_y: 0.5, focal_source: 'manual' });
    expect(await thumbnailRedness()).toBeLessThan(5);
  });

  it('cuts the crop again when the point moved after this render wrote it', async () => {
    const { ensureThumbnail } = require('../../src/services/imageProcessor');
    const storage = require('../../src/services/storage').getStorage();
    await db('photos').where({ id: photoId }).update({ focal_x: 1, focal_y: 0.5, focal_source: 'manual' });
    const original = storage.put.bind(storage);
    let moved = false;
    // The other replica saves the left edge just after this render's write.
    const put = jest.spyOn(storage, 'put').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (!moved) {
        moved = true;
        await db('photos').where({ id: photoId }).update({ focal_x: 0, focal_y: 0.5, focal_source: 'manual' });
      }
      return result;
    });
    try {
      expect(await ensureThumbnail(await row(), { force: true })).toBeTruthy();
    } finally {
      put.mockRestore();
    }
    expect(await row()).toMatchObject({ focal_x: 0, focal_y: 0.5, focal_source: 'manual' });
    expect(await thumbnailRedness()).toBeLessThan(5);
  });

  it('deletes the thumbnail a save replaced under another key', async () => {
    // On S3 every rebuild of a managed photo writes a new key: the row names
    // one the rebuild does not write to.
    const { thumbnail_path: current } = await row();
    const old = 'thumbnails/thumb_superseded-couple.jpg';
    fs.copyFileSync(path.join(process.env.STORAGE_PATH, current), path.join(process.env.STORAGE_PATH, old));
    await db('photos').where({ id: photoId }).update({ thumbnail_path: old });
    expect((await setFocal(photoId, { focal_point: { x: 0.3, y: 0.5 } })).status).toBe(200);
    expect((await row()).thumbnail_path).not.toBe(old);
    expect(fs.existsSync(path.join(process.env.STORAGE_PATH, old))).toBe(false);
  });

  it('never deletes the original a legacy row names as its thumbnail', async () => {
    // Rows from before rendition columns were checked can point at the original.
    const original = 'events/active/focal-pick/couple.jpg';
    await db('photos').where({ id: photoId }).update({ thumbnail_path: original });
    expect((await setFocal(photoId, { focal_point: { x: 0.4, y: 0.5 } })).status).toBe(200);
    expect((await row()).thumbnail_path).not.toBe(original);
    expect(fs.existsSync(path.join(process.env.STORAGE_PATH, original))).toBe(true);
  });

  it('drops the tiers cut before a point was detected', async () => {
    const { ensureThumbnail, thumbnailTierKeys } = require('../../src/services/imageProcessor');
    await db('photos').where({ id: photoId }).update({ focal_x: null, focal_y: null, focal_source: null });
    // A centred tier, cut while the row had no point.
    const tier = path.join(process.env.STORAGE_PATH, thumbnailTierKeys(await row())[1]);
    fs.mkdirSync(path.dirname(tier), { recursive: true });
    fs.writeFileSync(tier, 'centred crop');

    expect(await ensureThumbnail(await row(), { force: true })).toBeTruthy();
    expect((await row()).focal_source).toBe('auto');
    expect(fs.existsSync(tier)).toBe(false);
  });
});

describe('responsive tiers and the gallery listing', () => {
  const tierRedness = async (key) => {
    const { channels } = await sharp(fs.readFileSync(path.join(process.env.STORAGE_PATH, key))).stats();
    return channels[0].mean - channels[1].mean;
  };
  const gallery = async () => require('../../src/services/galleryQueryService').getGalleryPhotos({
    event: await db('events').where({ id: eventId }).first(), slug: 'focal-pick',
    query: {}, identity: { guestIdentifier: 'x' }, accessLevel: 'guest',
  });
  const setFit = async (fit) => {
    await db('app_settings').where({ setting_key: 'thumbnail_fit' }).del();
    await db('app_settings').insert({ setting_key: 'thumbnail_fit', setting_value: JSON.stringify(fit), setting_type: 'general' });
  };

  it('never finds a tier of the old point once the row has the new one', async () => {
    const { ensureThumbnailAtWidth } = require('../../src/services/imageProcessor');
    await db('photos').where({ id: photoId }).update({ focal_x: 1, focal_y: 0.5, focal_source: 'manual' });
    const old = await ensureThumbnailAtWidth(await row(), 600);
    expect(await tierRedness(old)).toBeGreaterThan(20);
    // Published, its old tiers not deleted yet: a listing already names the
    // left edge in the URL, so the tier it gets must be cut there.
    await db('photos').where({ id: photoId }).update({ focal_x: 0, focal_y: 0.5, focal_source: 'manual' });
    const current = await ensureThumbnailAtWidth(await row(), 600);
    expect(current).not.toBe(old);
    expect(await tierRedness(current)).toBeLessThan(5);
  });

  it('names the point to the gallery, except under a contain thumbnail', async () => {
    const photo = async () => (await gallery()).photos.find((p) => p.id === photoId);
    expect((await photo()).focal_point).toEqual({ x: 0, y: 0.5 });
    await setFit('contain');
    try {
      expect((await photo()).focal_point).toBeNull();
    } finally {
      await setFit('cover');
    }
  });
});

describe('Detect again for a gallery', () => {
  const redetect = (tok) => auth(request(app).post(`/api/admin/photos/${eventId}/photos/focal-points/redetect`), tok);

  it('queues every photo but those with a point set by hand, and the pass cuts them', async () => {
    const backfill = require('../../src/services/focalPointBackfill');
    const requested = jest.spyOn(backfill, 'requestPass').mockImplementation(() => {});
    try {
      await db('photos').update({ focal_checked: 1 });
      // A wrong automatic point (the empty left edge), and a manual one.
      await db('photos').where({ id: photoId }).update({ focal_x: 0, focal_y: 0.5, focal_source: 'auto' });
      await db('photos').where({ id: processingId }).update({ focal_x: 0.3, focal_y: 0.3, focal_source: 'manual' });
      const res = await redetect();
      expect(res.status).toBe(200);
      expect(requested).toHaveBeenCalledTimes(1);
      const rows = await db('photos').whereIn('id', [photoId, videoId, processingId]).select('id', 'focal_checked');
      expect(Object.fromEntries(rows.map((r) => [r.id, r.focal_checked]))).toEqual({ [photoId]: 0, [videoId]: 1, [processingId]: 1 });
      expect(res.body).toEqual({ queued: 1 });

      // The pass waits while a photo is processing; this suite keeps one so.
      await db('photos').where({ id: processingId }).update({ processing_status: 'complete' });
      try {
        expect(await backfill.runPass({ active: () => true, sleep: async () => {} })).toEqual({ done: 1, failed: 0 });
      } finally {
        await db('photos').where({ id: processingId }).update({ processing_status: 'processing' });
      }
      expect(await row()).toMatchObject({ focal_source: 'auto', focal_checked: 1 });
      expect((await row()).focal_x).toBeGreaterThan(0.75);
      expect(await thumbnailRedness()).toBeGreaterThan(20);
    } finally {
      requested.mockRestore();
    }
  });

  it('needs photos.edit and a gallery that is not archived', async () => {
    expect((await redetect(readerToken)).status).toBe(403);
    await db('events').where({ id: eventId }).update({ is_archived: 1 });
    try {
      expect((await redetect()).status).toBe(409);
    } finally {
      await db('events').where({ id: eventId }).update({ is_archived: 0 });
    }
  });
});

describe('a saved point is not lost', () => {
  it('a save whose snapshot predates another save still applies', async () => {
    const { ensureThumbnail } = require('../../src/services/imageProcessor');
    // Read before a save that queued ahead of this one landed (x=0.2).
    const snapshot = { ...(await row()), focal_x: 0.5, focal_y: 0.5, focal_source: 'auto' };
    await db('photos').where({ id: photoId }).update({ focal_x: 0.2, focal_y: 0.5, focal_source: 'manual' });
    expect(await ensureThumbnail(snapshot, { force: true, focalPoint: { point: { x: 1, y: 0.5 } } })).toBeTruthy();
    expect(await row()).toMatchObject({ focal_x: 1, focal_y: 0.5, focal_source: 'manual' });
    expect(await thumbnailRedness()).toBeGreaterThan(20);
  });

  it('a Retry of the processing keeps a point set by hand', async () => {
    const { processPhoto } = require('../../src/services/photoProcessor');
    await db('photos').where({ id: photoId }).update({
      focal_x: 0, focal_y: 0.5, focal_source: 'manual', processing_status: 'pending',
    });
    await processPhoto(photoId);
    expect(await row()).toMatchObject({ focal_x: 0, focal_y: 0.5, focal_source: 'manual', processing_status: 'complete' });
    expect(await thumbnailRedness()).toBeLessThan(5);
  });
});
