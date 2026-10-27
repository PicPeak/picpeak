/**
 * The admin picks a video's preview image (issue 2263, item 4).
 *
 * Through the real routes, the real poster rebuild and SQLite; only the
 * supervised ffmpeg/ffprobe boundary is stood in for. Pins:
 *  - three candidate frames at 10/50/90% of the clip, returned inline
 *  - picking one stores the offset and rebuilds the poster at it, with a
 *    thumbnail URL the browser has not cached; reset goes back to 1 s
 *  - every later rebuild keeps the pick, including one whose row was read
 *    without the column
 *  - photos.edit, event ownership, videos only, offsets inside the clip
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-poster-pick-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'poster-pick-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-poster-pick-storage-'));

// The clip as ffmpeg sees it: a seek at or past its end writes no frame.
let mockClipLength = 10;
const mockRun = jest.fn();
jest.mock('../../src/services/mediaProcessService', () => ({
  ...jest.requireActual('../../src/services/mediaProcessService'),
  withSnapshot: (source, _kind, callback) => callback(source, {
    format: 'mov,mp4', policy: { threads: 1, nativeBytes: 256 * 1024 * 1024, thumbnailMs: 5000 },
  }),
  probeSnapshot: async () => ({ format: { duration: String(mockClipLength) } }),
  run: (...args) => mockRun(...args),
}));

const request = require('supertest');
const sharp = require('sharp');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('../integration/helpers/crmDb');
const svc = require('../../src/services/userManagementService');
const { clearPermissionCache } = require('../../src/middleware/permissions');

jest.setTimeout(120000);

let db; let cleanup; let app; let token; let outsiderToken; let readerToken;
let eventId; let videoId; let imageId; let processingId;
let frameJpeg;

const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);
const auth = (req, tok = token) => req.set('Authorization', `Bearer ${tok}`);
const candidates = (id, tok) => auth(request(app).get(`/api/admin/photos/${eventId}/photos/${id}/poster-candidates`), tok);
const pick = (id, body, tok) => auth(request(app).put(`/api/admin/photos/${eventId}/photos/${id}/poster`).send(body), tok);
const seeks = () => mockRun.mock.calls
  .filter(([command]) => command === 'ffmpeg')
  .map(([, args]) => args[args.indexOf('-ss') + 1]);

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  const { adminId } = await seedMinimal(db);
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);

  // May edit photos, but not in a gallery someone else owns.
  const editor = await svc.createRole({ name: 'poster_editor', permissions: ['photos.view', 'photos.edit'] }, adminId);
  outsiderToken = mintAdminToken(unwrap(await db('admin_users').insert({
    username: 'outsider', email: 'outsider@example.com', password_hash: 'x',
    role_id: editor.id, must_change_password: false, created_at: new Date().toISOString(),
  }).returning('id')));
  // Sees the photos, may not change them.
  const reader = await svc.createRole({ name: 'poster_reader', permissions: ['photos.view'] }, adminId);
  readerToken = mintAdminToken(unwrap(await db('admin_users').insert({
    username: 'reader', email: 'reader@example.com', password_hash: 'x',
    role_id: reader.id, must_change_password: false, created_at: new Date().toISOString(),
  }).returning('id')));
  clearPermissionCache();

  eventId = unwrap(await db('events').insert({
    slug: 'poster-pick', event_type: 'wedding', event_name: 'Poster pick', event_date: '2026-08-01',
    host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
    share_token: 'tok-poster-pick', share_link: '/gallery/poster-pick/tok-poster-pick',
    created_by: adminId, expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
    is_active: 1, is_archived: 0, is_draft: 0, created_at: new Date().toISOString(),
  }).returning('id'));

  const dir = path.join(process.env.STORAGE_PATH, 'events/active/poster-pick');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'clip.mp4'), 'video');
  const insert = async (filename, over) => unwrap(await db('photos').insert({
    event_id: eventId, filename, path: `poster-pick/${filename}`, type: 'individual',
    size_bytes: 5, processing_status: 'complete', uploaded_at: new Date().toISOString(), ...over,
  }).returning('id'));
  videoId = await insert('clip.mp4', { media_type: 'video', mime_type: 'video/mp4', duration: 10 });
  imageId = await insert('photo.jpg', { media_type: 'image', mime_type: 'image/jpeg' });
  processingId = await insert('late.mp4', { media_type: 'video', mime_type: 'video/mp4', processing_status: 'processing' });

  frameJpeg = await sharp({ create: { width: 32, height: 18, channels: 3, background: '#468' } }).jpeg().toBuffer();
  app = buildRouteApp('/api/admin/photos', require('../../src/routes/adminPhotos'));
}, 120000);

afterAll(async () => { if (cleanup) await cleanup(); });

beforeEach(() => {
  mockClipLength = 10;
  mockRun.mockReset();
  mockRun.mockImplementation(async (_command, args) => {
    if (Number(args[args.indexOf('-ss') + 1]) < mockClipLength) fs.writeFileSync(args[args.length - 1], frameJpeg);
    return { stdout: Buffer.alloc(0) };
  });
});

describe('GET poster-candidates', () => {
  it('returns three frames at 10%, 50% and 90% of the clip as inline JPEGs', async () => {
    const res = await candidates(videoId);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ duration: 10, poster_offset_seconds: null, default_offset_seconds: 1 });
    expect(res.body.candidates.map((c) => c.offset_seconds)).toEqual([1, 5, 9]);
    for (const c of res.body.candidates) {
      expect(Buffer.from(c.image.replace(/^data:image\/jpeg;base64,/, ''), 'base64').equals(frameJpeg)).toBe(true);
    }
    expect(seeks()).toEqual(['1', '5', '9']);
    // Nothing is kept: no new file under thumbnails/.
    expect(fs.existsSync(path.join(process.env.STORAGE_PATH, 'thumbnails'))).toBe(false);
  });

  it('refuses an image, a video still processing, and a photo of another event', async () => {
    expect((await candidates(imageId)).status).toBe(400);
    expect((await candidates(processingId)).status).toBe(409);
    expect((await candidates(999999)).status).toBe(404);
  });

  it('needs photos.edit and the event', async () => {
    expect((await candidates(videoId, readerToken)).status).toBe(403);
    expect([403, 404]).toContain((await candidates(videoId, outsiderToken)).status);
    expect((await request(app).get(`/api/admin/photos/${eventId}/photos/${videoId}/poster-candidates`)).status).toBe(401);
    expect(mockRun).not.toHaveBeenCalled();
  });
});

describe('PUT poster', () => {
  it('stores the pick and rebuilds the poster at it, under a URL the browser has not cached', async () => {
    const res = await pick(videoId, { offset_seconds: 5 });
    expect(res.status).toBe(200);
    expect(res.body.poster_offset_seconds).toBe(5);
    expect(res.body.thumbnail_url).toBe(`/admin/photos/${eventId}/thumbnail/${videoId}?v=p5`);
    expect(seeks()).toEqual(['5']);

    const row = await db('photos').where({ id: videoId }).first();
    expect(row.poster_offset_seconds).toBe(5);
    expect(row.thumbnail_path).toMatch(/^thumbnails\/thumb_clip.*\.jpg$/);
    expect(row.thumb_hash).toBeTruthy();
    expect(fs.existsSync(path.join(process.env.STORAGE_PATH, row.thumbnail_path))).toBe(true);

    const list = await auth(request(app).get(`/api/admin/photos/${eventId}/photos`));
    const listed = list.body.photos.find((p) => p.id === videoId);
    expect(listed).toMatchObject({ poster_offset_seconds: 5, thumbnail_url: res.body.thumbnail_url });
  });

  it('keeps the pick on every later rebuild, also from a row read without the column', async () => {
    await db('photos').where({ id: videoId }).update({ poster_offset_seconds: 9 });
    const { ensureThumbnail, queueVideoThumbnail } = require('../../src/services/imageProcessor');
    const narrow = await db('photos').where({ id: videoId })
      .first('id', 'event_id', 'path', 'filename', 'media_type', 'mime_type', 'thumbnail_path', 'processing_status');

    expect(await ensureThumbnail(narrow, { force: true })).toBeTruthy();
    // The queued gallery rebuild goes through the same path.
    await new Promise((resolve) => {
      queueVideoThumbnail(narrow, { force: true }, { build: async (...args) => { const key = await ensureThumbnail(...args); resolve(); return key; } });
    });
    expect(seeks()).toEqual(['9', '9']);
  });

  it('takes the pick saved since a sweep read its row, not the row\'s stale one', async () => {
    await db('photos').where({ id: videoId }).update({ poster_offset_seconds: 9 });
    const { ensureThumbnail } = require('../../src/services/imageProcessor');
    const stale = { ...(await db('photos').where({ id: videoId }).first()), poster_offset_seconds: 5 };

    expect(await ensureThumbnail(stale, { force: true })).toBeTruthy();
    expect(seeks()).toEqual(['9']);
  });

  it('records the pick only with its poster, so no listing names the new frame early', async () => {
    expect((await pick(videoId, { offset_seconds: 5 })).status).toBe(200);
    const during = [];
    const base = mockRun.getMockImplementation();
    mockRun.mockImplementation(async (command, args) => {
      if (command === 'ffmpeg') during.push((await db('photos').where({ id: videoId }).first()).poster_offset_seconds);
      return base(command, args);
    });

    expect((await pick(videoId, { offset_seconds: 3 })).status).toBe(200);
    expect(during).toEqual([5]);
    expect((await db('photos').where({ id: videoId }).first()).poster_offset_seconds).toBe(3);
  });

  it('refuses a pick the clip turns out too short for, rather than storing it over the middle frame', async () => {
    expect((await pick(videoId, { offset_seconds: 5 })).status).toBe(200);
    mockClipLength = 10;
    const res = await pick(videoId, { offset_seconds: 10.5 });
    expect(res.status).toBe(422);
    expect((await db('photos').where({ id: videoId }).first()).poster_offset_seconds).toBe(5);
    // No frame was rendered at the middle in its place.
    expect(seeks()).toEqual(['5']);
  });

  it('does not record a rebuild of a pick another replica changed meanwhile', async () => {
    expect((await pick(videoId, { offset_seconds: 5 })).status).toBe(200);
    const before = await db('photos').where({ id: videoId }).first();
    const base = mockRun.getMockImplementation();
    mockRun.mockImplementation(async (command, args) => {
      // Another process saves a new pick while this one renders the old.
      if (command === 'ffmpeg') await db('photos').where({ id: videoId }).update({ poster_offset_seconds: 9 });
      return base(command, args);
    });

    const { ensureThumbnail } = require('../../src/services/imageProcessor');
    const posters = () => fs.readdirSync(path.join(process.env.STORAGE_PATH, 'thumbnails')).sort();
    const postersBefore = posters();
    // Refused as a superseded rendition: the new file is dropped.
    await expect(ensureThumbnail(before, { force: true })).rejects.toMatchObject({ code: 'MEDIA_SUPERSEDED' });
    const after = await db('photos').where({ id: videoId }).first();
    expect(after.poster_offset_seconds).toBe(9);
    expect(after.thumbnail_path).toBe(before.thumbnail_path);
    expect(fs.existsSync(path.join(process.env.STORAGE_PATH, before.thumbnail_path))).toBe(true);
    // The stale frame's file is not left behind.
    expect(posters()).toEqual(postersBefore);
  });

  it('keeps the current poster and pick when no frame can be taken', async () => {
    expect((await pick(videoId, { offset_seconds: 5 })).status).toBe(200);
    const before = await db('photos').where({ id: videoId }).first();
    const posterFile = path.join(process.env.STORAGE_PATH, before.thumbnail_path);
    const posterBytes = fs.readFileSync(posterFile);
    mockRun.mockReset();
    mockRun.mockImplementation(async (command) => {
      if (command === 'ffmpeg') throw new Error('decoder failed');
      return { stdout: Buffer.alloc(0) };
    });

    const res = await pick(videoId, { offset_seconds: 2 });
    expect(res.status).toBe(422);
    const after = await db('photos').where({ id: videoId }).first();
    expect(after.poster_offset_seconds).toBe(5);
    expect(after.thumbnail_path).toBe(before.thumbnail_path);
    expect(after.processing_error).toBeNull();
    // Not the placeholder over the frame it had.
    expect(fs.readFileSync(posterFile).equals(posterBytes)).toBe(true);
  });

  it('caches the admin tile only under the URL naming the current pick', async () => {
    expect((await pick(videoId, { offset_seconds: 5 })).status).toBe(200);
    const tile = (query) => auth(request(app).get(`/api/admin/photos/${eventId}/thumbnail/${videoId}${query}`));
    expect((await tile('?v=p5')).headers['cache-control']).toBe('private, max-age=3600');
    expect((await tile('?v=p9')).headers['cache-control']).toBe('no-store');
    expect((await tile('')).headers['cache-control']).toBe('no-store');
  });

  it('leaves one poster behind two overlapping picks, not the one in between', async () => {
    expect((await pick(videoId, { offset_seconds: 5 })).status).toBe(200);
    const old = (await db('photos').where({ id: videoId }).first()).thumbnail_path;
    const posters = () => new Set(fs.readdirSync(path.join(process.env.STORAGE_PATH, 'thumbnails')));
    const before = posters();

    const [first, second] = await Promise.all([pick(videoId, { offset_seconds: 3 }), pick(videoId, { offset_seconds: 7 })]);
    expect([first.status, second.status]).toEqual([200, 200]);

    const row = await db('photos').where({ id: videoId }).first();
    const after = posters();
    expect(after.has(path.basename(row.thumbnail_path))).toBe(true);
    expect(after.has(path.basename(old))).toBe(false);
    // Nothing else new: the poster of whichever pick ran first is gone too.
    expect([...after].filter((name) => !before.has(name))).toEqual([path.basename(row.thumbnail_path)]);
  });

  it('resets to the default frame with null', async () => {
    const res = await pick(videoId, { offset_seconds: null });
    expect(res.status).toBe(200);
    expect(res.body.poster_offset_seconds).toBeNull();
    expect(res.body.thumbnail_url).toBe(`/admin/photos/${eventId}/thumbnail/${videoId}`);
    expect(seeks()).toEqual(['1']);
    expect((await db('photos').where({ id: videoId }).first()).poster_offset_seconds).toBeNull();
  });

  it('takes a frame of the last, rounded-off second, and nothing past the end', async () => {
    mockClipLength = 10.8;
    expect((await pick(videoId, { offset_seconds: 10.5 })).status).toBe(200);
    for (const offset_seconds of [-1, 11.5, '5', [5], true]) {
      expect((await pick(videoId, { offset_seconds })).status).toBe(400);
    }
    expect((await pick(videoId, {})).status).toBe(400);
    expect((await db('photos').where({ id: videoId }).first()).poster_offset_seconds).toBe(10.5);
  });

  it('refuses an image, a video still processing, another admin\'s event and a reader', async () => {
    expect((await pick(imageId, { offset_seconds: 1 })).status).toBe(400);
    expect((await pick(processingId, { offset_seconds: 1 })).status).toBe(409);
    expect((await pick(videoId, { offset_seconds: 1 }, readerToken)).status).toBe(403);
    expect([403, 404]).toContain((await pick(videoId, { offset_seconds: 1 }, outsiderToken)).status);
    expect(mockRun).not.toHaveBeenCalled();
    expect((await db('photos').where({ id: imageId }).first()).poster_offset_seconds).toBeNull();
  });
});
