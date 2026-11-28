/**
 * The photo editor's API and what guests receive after an edit (issue 2619).
 *
 * Real routes, real sharp, SQLite. Pins:
 *  - the photoEditor flag gates the editor and the presets (403 while off)
 *  - photos.edit and gallery ownership; videos and photos still processing refused
 *  - the edit JSON is validated strictly: unknown keys, out-of-range values,
 *    another version, a crop off the photo or too small are refused
 *  - the base image is the unedited photo, whatever the edit
 *  - after a save and the background apply, guests get the edit everywhere:
 *    the listing (size, `e` in every image URL), the photo route, the single
 *    download (a .jpg name), the streamed and the prebuilt download-all ZIP;
 *    a URL naming another revision is not cached
 *  - the admin's download is the original; ?edited=1 the edit
 *  - batch copy carries only the parts asked for; presets round-trip; the
 *    RAW auto-develop setting is off by default and needs settings.edit
 *  - flag off: saved edits keep applying, the API answers 403
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-editor-route-')), 'db.sqlite');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'editor-route-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-editor-route-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const StreamZip = require('node-stream-zip');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp, setFeatureFlags,
} = require('../integration/helpers/crmDb');
const svc = require('../../src/services/userManagementService');
const { clearPermissionCache } = require('../../src/middleware/permissions');
const { invalidateFeatureFlagCache } = require('../../src/middleware/requireFeatureFlag');

jest.setTimeout(120000);

let db; let cleanup; let adminApp; let presetApp; let galleryApp;
let token; let readerToken; let outsiderToken; let event; let photoId; let secondId; let videoId; let originalBytes;

const unwrap = (rows) => (typeof rows[0] === 'object' && rows[0] !== null ? rows[0].id : rows[0]);
const auth = (req, tok = token) => req.set('Authorization', `Bearer ${tok}`);
const binary = (req) => req.buffer(true).parse((res, done) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => done(null, Buffer.concat(chunks)));
});
const editUrl = (id, suffix = '') => `/api/admin/photos/${event.id}/photos/${id}/edit${suffix}`;
const guest = (method, url) => request(galleryApp)[method](`/api/gallery/${event.slug}${url}`)
  .set('Authorization', `Bearer ${jwt.sign(
    { eventId: event.id, eventSlug: event.slug, type: 'gallery', accessLevel: 'client' },
    process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' })}`);
const row = (id = photoId) => db('photos').where({ id }).first();
const applyEdits = () => require('../../src/services/photoEdits').runPass({ active: () => true, sleep: async () => {} });
const size = async (buffer) => {
  const meta = await sharp(buffer).metadata();
  return [meta.width, meta.height];
};
const zipEntries = async (buffer) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-editor-zip-')), 'all.zip');
  fs.writeFileSync(file, buffer);
  const zip = new StreamZip.async({ file });
  try {
    const out = {};
    for (const entry of Object.values(await zip.entries())) out[path.basename(entry.name)] = await zip.entryData(entry.name);
    return out;
  } finally {
    await zip.close();
  }
};

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  const { adminId } = await seedMinimal(db);
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  const reader = await svc.createRole({ name: 'edit_reader', permissions: ['photos.view'] }, adminId);
  readerToken = mintAdminToken(unwrap(await db('admin_users').insert({
    username: 'reader', email: 'reader@example.com', password_hash: 'x',
    role_id: reader.id, must_change_password: false, created_at: new Date().toISOString(),
  }).returning('id')));
  const editor = await svc.createRole({ name: 'edit_editor', permissions: ['photos.view', 'photos.edit'] }, adminId);
  outsiderToken = mintAdminToken(unwrap(await db('admin_users').insert({
    username: 'outsider', email: 'outsider@example.com', password_hash: 'x',
    role_id: editor.id, must_change_password: false, created_at: new Date().toISOString(),
  }).returning('id')));
  clearPermissionCache();

  const eventId = unwrap(await db('events').insert({
    slug: 'edit-route', event_type: 'wedding', event_name: 'Edit route', event_date: '2026-08-01',
    host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
    share_token: 'tok-edit-route', share_link: '/gallery/edit-route/tok-edit-route',
    created_by: adminId, expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
    is_active: 1, is_archived: 0, is_draft: 0, allow_downloads: 1, created_at: new Date().toISOString(),
  }).returning('id'));
  event = await db('events').where({ id: eventId }).first();

  const dir = path.join(process.env.STORAGE_PATH, 'events/active/edit-route');
  fs.mkdirSync(dir, { recursive: true });
  originalBytes = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 90, g: 120, b: 150 } } })
    .jpeg({ quality: 90 }).toBuffer();
  fs.writeFileSync(path.join(dir, 'beach.jpg'), originalBytes);
  fs.writeFileSync(path.join(dir, 'dunes.jpg'), originalBytes);
  fs.writeFileSync(path.join(dir, 'clip.mp4'), 'video');
  const insert = async (filename, over) => unwrap(await db('photos').insert({
    event_id: eventId, filename, original_filename: filename.replace('.jpg', '.JPG'), path: `edit-route/${filename}`,
    type: 'individual', size_bytes: originalBytes.length, processing_status: 'complete',
    uploaded_at: new Date().toISOString(), width: 800, height: 600, ...over,
  }).returning('id'));
  photoId = await insert('beach.jpg', { media_type: 'image', mime_type: 'image/jpeg' });
  secondId = await insert('dunes.jpg', { media_type: 'image', mime_type: 'image/jpeg' });
  videoId = await insert('clip.mp4', { media_type: 'video', mime_type: 'video/mp4', width: null, height: null });

  adminApp = buildRouteApp('/api/admin/photos', require('../../src/routes/adminPhotoEditor'));
  adminApp.use('/api/admin/photos', require('../../src/routes/adminPhotos'));
  presetApp = buildRouteApp('/api/admin/photo-edit-presets', require('../../src/routes/adminPhotoEditPresets'));
  galleryApp = express();
  galleryApp.use(express.json());
  galleryApp.use(cookieParser());
  galleryApp.use('/api/gallery', require('../../src/routes/gallery'));
}, 120000);

afterAll(async () => {
  await require('../../src/services/downloadZipService').stop?.();
  await require('../../src/services/isolatedSharp').shutdown();
  if (cleanup) await cleanup();
});

const setFlag = async (on) => {
  await setFeatureFlags(db, { photoEditor: on });
  invalidateFeatureFlagCache();
};

describe('flag, permissions, validation', () => {
  it('answers 403 while the photoEditor flag is off', async () => {
    await setFlag(false);
    expect((await auth(request(adminApp).get(editUrl(photoId)))).status).toBe(403);
    expect((await auth(request(adminApp).put(editUrl(photoId)).send({ params: { exposure: 1 } }))).status).toBe(403);
    expect((await auth(request(presetApp).get('/api/admin/photo-edit-presets'))).status).toBe(403);
    await setFlag(true);
  });

  it('needs photos.edit and the gallery', async () => {
    expect((await auth(request(adminApp).put(editUrl(photoId)).send({ params: { exposure: 1 } }), readerToken)).status).toBe(403);
    expect([403, 404]).toContain((await auth(request(adminApp).put(editUrl(photoId)).send({ params: { exposure: 1 } }), outsiderToken)).status);
    expect((await row()).edit_rev).toBe(0);
  });

  it('refuses videos', async () => {
    expect((await auth(request(adminApp).put(editUrl(videoId)).send({ params: { exposure: 1 } }))).status).toBe(400);
  });

  it.each([
    [{ exposure: 1, sneaky: true }, /Unknown edit setting/],
    [{ exposure: 6 }, /exposure must be/],
    [{ contrast: '50' }, /contrast must be/],
    [{ v: 2 }, /Unsupported edit version/],
    [{ rotate: 45 }, /rotate must be/],
    [{ straighten: 60 }, /straighten must be/],
    [{ crop: { x: 0.9, y: 0, w: 0.5, h: 0.5 } }, /crop must lie inside/],
    [{ crop: { x: 0, y: 0, w: 0.001, h: 0.5 } }, /crop must lie inside/],
    [{ crop: { x: 0, y: 0, w: 0.5 } }, /crop must be/],
    [{ bw: 'yes' }, /bw must be/],
    ['exposure=1', /must be an object/],
  ])('refuses %j', async (params, message) => {
    const res = await auth(request(adminApp).put(editUrl(photoId)).send({ params }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
  });
});

describe('an edit, saved and applied', () => {
  const edit = { crop: { x: 0, y: 0, w: 0.5, h: 0.5 }, exposure: 0.5, rotate: 90 };

  it('saves, queues, and the pass applies it', async () => {
    const res = await auth(request(adminApp).put(editUrl(photoId)).send({ params: edit }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ edit_rev: 1, edit_applied_rev: 0, width: 800, height: 600 });
    expect(res.body.params).toMatchObject({ rotate: 90, exposure: 0.5 });
    const listed = (await auth(request(adminApp).get(`/api/admin/photos/${event.id}/photos`))).body.photos;
    expect(listed.find((p) => p.id === photoId)).toMatchObject({ edit_rev: 1, edit_applied_rev: 0, edit_failed: false });
    // A preview-only job's identity follows the revision whose previews are
    // in place: one built now packages the old previews and must not be
    // reused once the edit lands. A full-size one follows the saved edit.
    const jobs = require('../../src/services/downloadJobService');
    expect(await jobs.editStamp([photoId], { applied: true })).toBe(0);
    expect(await jobs.editStamp([photoId])).toBe(1);
    const zip = require('../../src/services/downloadZipService');
    const invalidate = jest.spyOn(zip, 'invalidateIfBuilt');
    await applyEdits();
    expect(await jobs.editStamp([photoId], { applied: true })).toBe(1);
    expect(invalidate).toHaveBeenCalledWith(event.id);
    invalidate.mockRestore();
    expect(await row()).toMatchObject({ edit_rev: 1, edit_applied_rev: 1, edit_width: 300, edit_height: 400 });
  });

  it('serves the editor the unedited photo, versioned by its source', async () => {
    const state = await auth(request(adminApp).get(editUrl(photoId)));
    expect(state.body.source_version).toMatch(/^[0-9a-f]{10}$/);
    const res = await binary(auth(request(adminApp).get(editUrl(photoId, `/base?v=${state.body.source_version}`)))).expect(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers.etag).toBe(`"${state.body.source_version}"`);
    expect(await size(res.body)).toEqual([800, 600]);
    const again = await auth(request(adminApp).get(editUrl(photoId, '/base')).set('If-None-Match', res.headers.etag));
    expect(again.status).toBe(304);
    // Another source (a replaced or rewritten original): another version.
    await db('photos').where({ id: photoId }).update({ size_bytes: originalBytes.length + 1 });
    const moved = await auth(request(adminApp).get(editUrl(photoId)));
    expect(moved.body.source_version).not.toBe(state.body.source_version);
    expect((await auth(request(adminApp).get(editUrl(photoId, '/base')).set('If-None-Match', res.headers.etag))).status).toBe(200);
    await db('photos').where({ id: photoId }).update({ size_bytes: originalBytes.length });
  });

  it('lists the edited size and names the revision in every image URL', async () => {
    const res = await guest('get', '/photos').expect(200);
    const photo = res.body.photos.find((p) => p.id === photoId);
    expect(photo).toMatchObject({ width: 300, height: 400 });
    for (const key of ['url', 'hero_url', 'slideshow_url']) expect(photo[key]).toMatch(/[?&]e=1(&|$)/);
    const other = res.body.photos.find((p) => p.id === secondId);
    expect(other).toMatchObject({ width: 800, height: 600 });
    expect(other.url).not.toMatch(/[?&]e=/);
  });

  it('serves the edit on the photo route and the single download, named .jpg', async () => {
    const view = await binary(guest('get', `/photo/${photoId}?e=1`)).expect(200);
    expect(await size(view.body)).toEqual([300, 400]);
    const download = await binary(guest('get', `/download/${photoId}`)).expect(200);
    expect(download.headers['content-type']).toBe('image/jpeg');
    expect(download.headers['content-disposition']).toMatch(/beach\.jpg/);
    expect(await size(download.body)).toEqual([300, 400]);
  });

  it('caches a thumbnail only under the applied revision', async () => {
    expect((await guest('get', `/thumbnail/${photoId}?e=1`)).headers['cache-control']).toMatch(/max-age/);
    expect((await guest('get', `/thumbnail/${photoId}`)).headers['cache-control']).toBe('no-store');
    expect((await guest('get', `/preview/${photoId}?e=0`)).headers['cache-control']).toBe('no-store');
  });

  it('puts the edit into the streamed and the prebuilt download-all ZIP', async () => {
    const streamed = await zipEntries((await binary(guest('get', '/download-all'))).body);
    const name = Object.keys(streamed).find((entry) => entry.startsWith('beach'));
    expect(name).toMatch(/\.jpg$/);
    expect(await size(streamed[name])).toEqual([300, 400]);
    const zip = require('../../src/services/downloadZipService');
    expect((await zip.generateZip(event.id)).success).toBe(true);
    const info = await zip.getZipInfo(event.id);
    const key = info?.path || info?.storageKey || zip.getCacheKey(event.slug);
    const prebuilt = await zipEntries(fs.readFileSync(path.join(process.env.STORAGE_PATH, key)));
    expect(await size(prebuilt[Object.keys(prebuilt).find((entry) => entry.startsWith('beach'))])).toEqual([300, 400]);
  });

  it('gives the admin the original, and the edit on request', async () => {
    const original = await binary(auth(request(adminApp).get(`/api/admin/photos/${event.id}/photos/${photoId}/download`))).expect(200);
    expect(original.body.equals(originalBytes)).toBe(true);
    const edited = await binary(auth(request(adminApp).get(`/api/admin/photos/${event.id}/photos/${photoId}/download?edited=1`))).expect(200);
    expect(await size(edited.body)).toEqual([300, 400]);
  });

  it('keeps applying the edit with the flag off; only the API is closed', async () => {
    await setFlag(false);
    const download = await binary(guest('get', `/download/${photoId}`)).expect(200);
    expect(await size(download.body)).toEqual([300, 400]);
    expect((await auth(request(adminApp).put(editUrl(photoId)).send({ params: null }))).status).toBe(403);
    await setFlag(true);
  });

  it('a reset gives guests the original again', async () => {
    const res = await auth(request(adminApp).put(editUrl(photoId)).send({ params: null }));
    expect(res.body).toMatchObject({ params: null, edit_rev: 2 });
    await applyEdits();
    const download = await binary(guest('get', `/download/${photoId}`)).expect(200);
    expect(download.body.equals(originalBytes)).toBe(true);
  });
});

describe('batch copy and presets', () => {
  it('copies only the parts asked for', async () => {
    await auth(request(adminApp).put(editUrl(secondId)).send({ params: { crop: { x: 0.25, y: 0, w: 0.5, h: 1 } } })).expect(200);
    const res = await auth(request(adminApp).post(`/api/admin/photos/${event.id}/photos/edit/batch`)
      .send({ photo_ids: [photoId, secondId, videoId], params: { exposure: 1, bw: true, rotate: 180 }, parts: ['tone'] }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ queued: 2, skipped: [videoId] });
    const second = JSON.parse((await row(secondId)).edit_params);
    expect(second).toMatchObject({ exposure: 1, bw: true, rotate: 0, crop: { x: 0.25, y: 0, w: 0.5, h: 1 } });
    expect(JSON.parse((await row(photoId)).edit_params)).toMatchObject({ exposure: 1, bw: true, rotate: 0, crop: null });
    expect((await auth(request(adminApp).post(`/api/admin/photos/${event.id}/photos/edit/batch`)
      .send({ photo_ids: [photoId], params: { exposure: 1 }, parts: ['everything'] }))).status).toBe(400);
    expect((await auth(request(adminApp).post(`/api/admin/photos/${event.id}/photos/edit/batch`)
      .send({ photo_ids: [photoId], params: { exposure: 10 } }))).status).toBe(400);
    await applyEdits();
    expect(await db('photos').where({ event_id: event.id }).whereRaw('edit_rev > edit_applied_rev').count({ n: '*' }).first()).toMatchObject({ n: 0 });
  });

  it('keeps the auto-develop setting off by default; changing it needs settings.edit', async () => {
    const base = '/api/admin/photo-edit-presets/settings';
    expect((await auth(request(presetApp).get(base))).body).toEqual({ auto_develop_raw: false });
    expect((await auth(request(presetApp).put(base).send({ auto_develop_raw: true }), outsiderToken)).status).toBe(403);
    expect((await auth(request(presetApp).put(base).send({ auto_develop_raw: 'yes' }))).status).toBe(400);
    expect((await auth(request(presetApp).put(base).send({ auto_develop_raw: true }))).body).toEqual({ auto_develop_raw: true });
    expect((await auth(request(presetApp).get(base))).body).toEqual({ auto_develop_raw: true });
    await auth(request(presetApp).put(base).send({ auto_develop_raw: false })).expect(200);
  });

  it('saves, lists, renames and deletes a preset; validates its params', async () => {
    const base = '/api/admin/photo-edit-presets';
    const created = await auth(request(presetApp).post(base).send({ name: '  Warm\u0007 ', params: { temperature: 30 } }));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Warm', params: { temperature: 30, v: 1 } });
    expect((await auth(request(presetApp).post(base).send({ name: 'Bad', params: { temperature: 300 } }))).status).toBe(400);
    expect((await auth(request(presetApp).post(base).send({ name: '', params: {} }))).status).toBe(400);
    await auth(request(presetApp).put(`${base}/${created.body.id}`).send({ name: 'Warm skin' })).expect(200);
    expect((await auth(request(presetApp).get(base))).body.presets).toEqual([expect.objectContaining({ name: 'Warm skin' })]);
    expect((await auth(request(presetApp).get(base), readerToken)).status).toBe(403);
    await auth(request(presetApp).delete(`${base}/${created.body.id}`)).expect(204);
    expect((await auth(request(presetApp).get(base))).body.presets).toEqual([]);
  });
});

describe('an edited photo whose render fails', () => {
  it('is left out of the archives, which still go out; never its unedited original', async () => {
    const dir = path.join(process.env.STORAGE_PATH, 'events/active/edit-route');
    fs.writeFileSync(path.join(dir, 'broken.jpg'), Buffer.from('not an image at all'));
    const brokenId = unwrap(await db('photos').insert({
      event_id: event.id, filename: 'broken.jpg', path: 'edit-route/broken.jpg', type: 'individual', media_type: 'image',
      mime_type: 'image/jpeg', size_bytes: 19, processing_status: 'complete', uploaded_at: new Date().toISOString(),
      width: 800, height: 600, edit_params: JSON.stringify({ v: 1, exposure: 1 }), edit_rev: 1, edit_applied_rev: 1,
    }).returning('id'));
    try {
      const streamed = await zipEntries((await binary(guest('get', '/download-all')).expect(200)).body);
      expect(Object.keys(streamed).some((name) => name.startsWith('broken'))).toBe(false);
      expect(Object.keys(streamed).some((name) => name.startsWith('beach'))).toBe(true);
      const selected = await binary(guest('post', '/download-selected').send({ photo_ids: [brokenId, photoId] }));
      expect(selected.status).toBe(200);
      const entries = await zipEntries(selected.body);
      expect(Object.keys(entries).some((name) => name.startsWith('broken'))).toBe(false);
      const zip = require('../../src/services/downloadZipService');
      expect((await zip.generateZip(event.id)).success).toBe(true);
      const jobs = require('../../src/services/downloadJobService');
      const fresh = await db('events').where({ id: event.id }).first();
      const job = await jobs.createJob({ event: fresh, resolution: 'original', photoIds: [brokenId, photoId], accessLevel: 'guest' });
      await jobs.liveBuilds.get(job.id);
      expect((await db('download_jobs').where({ id: job.id }).first()).status).toBe('ready');
    } finally {
      await db('photos').where({ id: brokenId }).delete();
    }
  });

  it('is listed as failed, apart from pending ones, until a retry asks for it again', async () => {
    const dir = path.join(process.env.STORAGE_PATH, 'events/active/edit-route');
    fs.writeFileSync(path.join(dir, 'broken.jpg'), Buffer.from('not an image at all'));
    const brokenId = unwrap(await db('photos').insert({
      event_id: event.id, filename: 'broken.jpg', path: 'edit-route/broken.jpg', type: 'individual', media_type: 'image',
      mime_type: 'image/jpeg', size_bytes: 19, processing_status: 'complete', uploaded_at: new Date().toISOString(),
      width: 800, height: 600, edit_params: JSON.stringify({ v: 1, exposure: 1 }), edit_rev: 1, edit_applied_rev: 0,
    }).returning('id'));
    const listed = async () => (await auth(request(adminApp).get(`/api/admin/photos/${event.id}/photos`))).body.photos
      .find((p) => p.id === brokenId);
    try {
      expect(await listed()).toMatchObject({ edit_rev: 1, edit_applied_rev: 0, edit_failed: false });
      await applyEdits();
      expect(await listed()).toMatchObject({ edit_rev: 1, edit_applied_rev: 0, edit_failed: true });
      const retry = await auth(request(adminApp).post(`/api/admin/photos/${event.id}/photos/edit/retry`).send({ photo_ids: [brokenId] }));
      expect(retry.status).toBe(200);
      expect(retry.body).toEqual({ retried: 1 });
      // Tracked as pending again until the pass has tried it.
      expect(await listed()).toMatchObject({ edit_failed: false });
      await applyEdits();
      expect(await listed()).toMatchObject({ edit_failed: true });
      expect((await auth(request(adminApp).post(`/api/admin/photos/${event.id}/photos/edit/retry`).send({ photo_ids: [] }))).status).toBe(400);
    } finally {
      await db('photos').where({ id: brokenId }).delete();
    }
  });
});

describe('admin image URLs follow the applied revision', () => {
  it('names it in the preview URL of a reset RAW and caches only that version', async () => {
    const dir = path.join(process.env.STORAGE_PATH, 'events/active/edit-route');
    fs.writeFileSync(path.join(dir, 'reset.jpg'), originalBytes);
    // A RAW whose edit was reset and applied (revision 2), and a JPEG one.
    const insert = async (filename, mime) => unwrap(await db('photos').insert({
      event_id: event.id, filename, original_filename: filename, path: `edit-route/${filename === 'reset.cr3' ? 'reset.jpg' : filename}`,
      type: 'individual', media_type: 'image', mime_type: mime, size_bytes: originalBytes.length, processing_status: 'complete',
      uploaded_at: new Date().toISOString(), width: 800, height: 600, edit_params: null, edit_rev: 2, edit_applied_rev: 2,
    }).returning('id'));
    const rawId = await insert('reset.cr3', 'image/x-canon-cr3');
    const jpegId = await insert('reset.jpg', 'image/jpeg');
    try {
      const listed = (await auth(request(adminApp).get(`/api/admin/photos/${event.id}/photos`))).body.photos;
      expect(listed.find((p) => p.id === rawId).url).toBe(`/admin/photos/${event.id}/preview/${rawId}?e=2`);
      const preview = (query) => auth(request(adminApp).get(`/api/admin/photos/${event.id}/preview/${jpegId}${query}`));
      expect((await preview('?e=2')).headers['cache-control']).toBe('private, max-age=3600');
      // Another version (an old URL, or none) is answered but never kept.
      expect((await preview('')).headers['cache-control']).toBe('no-store');
      expect((await preview('?e=1')).headers['cache-control']).toBe('no-store');
      const photo = (query) => auth(request(adminApp).get(`/api/admin/photos/${event.id}/photo/${jpegId}${query}`));
      expect((await photo('')).headers['cache-control']).toBe('private, max-age=3600');
      // A URL naming an edit the photo no longer has is not cached under that name.
      expect((await photo('?e=1')).headers['cache-control']).toBe('no-store');
      expect((await photo('?original=1')).headers['cache-control']).toBe('private, max-age=3600');
    } finally {
      await db('photos').whereIn('id', [rawId, jpegId]).delete();
    }
  });
});

describe('a download job with slow edited renders', () => {
  it('keeps making progress while it renders them one entry at a time', async () => {
    const jobs = require('../../src/services/downloadJobService');
    const photoEdits = require('../../src/services/photoEdits');
    // Each render takes most of the idle deadline; together they exceed it.
    const worker = new jobs.constructor({ stallTimeoutMs: 1000 });
    const deliver = photoEdits.deliveredPhoto;
    const slow = jest.spyOn(photoEdits, 'deliveredPhoto').mockImplementation(async (row, options) => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      return deliver(row, options);
    });
    try {
      const fresh = await db('events').where({ id: event.id }).first();
      const job = await worker.createJob({ event: fresh, resolution: 'original', photoIds: [photoId, secondId], accessLevel: 'guest' });
      await worker.liveBuilds.get(job.id);
      const done = await worker.getStatus(job.token);
      expect(done.status).toBe('ready');
      expect(slow).toHaveBeenCalledTimes(2);
    } finally {
      slow.mockRestore();
    }
  }, 30000);
});

describe('a streamed download-all with slow edited renders', () => {
  it('sends the first entry before it renders the second', async () => {
    const photoEdits = require('../../src/services/photoEdits');
    const deliver = photoEdits.deliveredPhoto;
    let firstBytes;
    const bytesArrived = new Promise((resolve) => { firstBytes = resolve; });
    let renders = 0;
    let secondRenderSawBytes = null;
    const slow = jest.spyOn(photoEdits, 'deliveredPhoto').mockImplementation(async (row, options) => {
      renders += 1;
      if (renders === 2) {
        // Has the client had any of the archive yet? Waits a while for it.
        secondRenderSawBytes = await Promise.race([bytesArrived.then(() => true), new Promise((r) => setTimeout(() => r(false), 3000))]);
      }
      return deliver(row, options);
    });
    const server = galleryApp.listen(0);
    try {
      const token = jwt.sign({ eventId: event.id, eventSlug: event.slug, type: 'gallery', accessLevel: 'client' },
        process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' });
      const status = await new Promise((resolve, reject) => {
        require('http').get({
          port: server.address().port, path: `/api/gallery/${event.slug}/download-all`, headers: { Authorization: `Bearer ${token}` },
        }, (res) => {
          res.on('data', () => firstBytes());
          res.on('end', () => resolve(res.statusCode));
          res.on('error', reject);
        }).on('error', reject);
      });
      expect(status).toBe(200);
      expect(renders).toBeGreaterThanOrEqual(2);
      expect(secondRenderSawBytes).toBe(true);
    } finally {
      slow.mockRestore();
      await new Promise((resolve) => server.close(resolve));
    }
  }, 30000);
});

describe('listed sizes while an edit is pending', () => {
  it('describe the previews: the applied edit\'s size, or the original\'s when nothing is applied', async () => {
    const insert = async (filename, over) => unwrap(await db('photos').insert({
      event_id: event.id, filename, path: 'edit-route/beach.jpg', type: 'individual', media_type: 'image', mime_type: 'image/jpeg',
      size_bytes: originalBytes.length, processing_status: 'complete', uploaded_at: new Date().toISOString(), width: 600, height: 400, ...over,
    }).returning('id'));
    // A turn applied (400 x 600), a crop pending (400 x 300).
    const turned = await insert('pending-turned.jpg', {
      edit_params: JSON.stringify({ v: 1, rotate: 90, crop: { x: 0, y: 0, w: 1, h: 0.5 } }), edit_rev: 2, edit_applied_rev: 1,
      edit_width: 400, edit_height: 300, edit_applied_params: JSON.stringify({ v: 1, rotate: 90 }), edit_applied_width: 400, edit_applied_height: 600,
    });
    // A first edit, not applied yet: the previews are the original's.
    const fresh = await insert('pending-first.jpg', {
      edit_params: JSON.stringify({ v: 1, rotate: 90 }), edit_rev: 1, edit_applied_rev: 0, edit_width: 400, edit_height: 600,
    });
    try {
      const guestRows = (await guest('get', '/photos').expect(200)).body.photos;
      const adminRows = (await auth(request(adminApp).get(`/api/admin/photos/${event.id}/photos`))).body.photos;
      for (const rows of [guestRows, adminRows]) {
        expect(rows.find((p) => p.id === turned)).toMatchObject({ width: 400, height: 600 });
        expect(rows.find((p) => p.id === fresh)).toMatchObject({ width: 600, height: 400 });
      }
    } finally {
      await db('photos').whereIn('id', [turned, fresh]).delete();
    }
  });
});

describe('archives after an edit is saved', () => {
  it('a full-size archive is not reused once an edit is saved, even if its render then fails', async () => {
    const jobs = require('../../src/services/downloadJobService');
    const zip = require('../../src/services/downloadZipService');
    const fresh = await db('events').where({ id: event.id }).first();
    const first = await jobs.createJob({ event: fresh, resolution: 'original', photoIds: [secondId], accessLevel: 'guest' });
    await jobs.liveBuilds.get(first.id);
    const invalidate = jest.spyOn(zip, 'invalidateIfBuilt');
    try {
      await auth(request(adminApp).put(editUrl(secondId)).send({ params: { exposure: 0.3 } })).expect(200);
      // The prebuilt download-all ZIP goes at once, not when the render lands.
      expect(invalidate).toHaveBeenCalledWith(event.id);
      // No pass has run: the saved revision is not applied, and no job of the old one is handed out.
      const second = await jobs.createJob({ event: fresh, resolution: 'original', photoIds: [secondId], accessLevel: 'guest' });
      expect(second.id).not.toBe(first.id);
      await jobs.liveBuilds.get(second.id);
      // A preview-only archive keeps following the applied revision.
      expect(await jobs.editStamp([secondId], { applied: true })).toBe(Number((await row(secondId)).edit_applied_rev));
    } finally {
      invalidate.mockRestore();
      await auth(request(adminApp).put(editUrl(secondId)).send({ params: null }));
      await applyEdits();
    }
  });
});

describe('a geometry edit whose render keeps failing', () => {
  it('withholds the unedited picture from guests (503, no-store), unless only light and colour failed or nothing failed yet', async () => {
    const insert = async (filename, over) => unwrap(await db('photos').insert({
      event_id: event.id, filename, path: 'edit-route/beach.jpg', type: 'individual', media_type: 'image', mime_type: 'image/jpeg',
      size_bytes: originalBytes.length, processing_status: 'complete', uploaded_at: new Date().toISOString(), width: 800, height: 600, ...over,
    }).returning('id'));
    const crop = JSON.stringify({ v: 1, crop: { x: 0, y: 0, w: 0.5, h: 1 } });
    const failedCrop = await insert('failed-crop.jpg', { edit_params: crop, edit_rev: 1, edit_applied_rev: 0, edit_failed_rev: 1, edit_error: 'render' });
    const failedTone = await insert('failed-tone.jpg', { edit_params: JSON.stringify({ v: 1, exposure: 1 }), edit_rev: 1, edit_applied_rev: 0, edit_failed_rev: 1 });
    const pendingCrop = await insert('pending-crop.jpg', { edit_params: crop, edit_rev: 1, edit_applied_rev: 0 });
    try {
      for (const route of ['thumbnail', 'preview', 'hero']) {
        const res = await guest('get', `/${route}/${failedCrop}`);
        expect(res.status).toBe(503);
        expect(res.headers['cache-control']).toBe('no-store');
        expect((await guest('get', `/${route}/${failedTone}`)).status).toBe(200);
        expect((await guest('get', `/${route}/${pendingCrop}`)).status).toBe(200);
      }
      // A preview-size download of it is refused too (an archive skips it).
      const { renderPreviewForDownload } = require('../../src/services/downloadRendition');
      await expect(renderPreviewForDownload(await row(failedCrop), null)).rejects.toMatchObject({ status: 503 });
      // A download of it neither (503, try again later).
      const download = await guest('get', `/download/${failedCrop}`);
      expect(download.status).toBe(503);
      expect(download.headers['cache-control']).toBe('no-store');
      // Nor is the full-size photo rendered again on a guest's request.
      const full = await guest('get', `/photo/${failedCrop}`);
      expect(full.status).toBe(503);
      expect(full.headers['cache-control']).toBe('no-store');
      // The admin still sees it.
      expect((await auth(request(adminApp).get(`/api/admin/photos/${event.id}/preview/${failedCrop}`))).status).toBe(200);
    } finally {
      await db('photos').whereIn('id', [failedCrop, failedTone, pendingCrop]).delete();
    }
  });
});

describe('a HEAD request for an edited photo not rendered yet', () => {
  it('answers 503 without drawing the render; GET draws it', async () => {
    const id = unwrap(await db('photos').insert({
      event_id: event.id, filename: 'head.jpg', path: 'edit-route/beach.jpg', type: 'individual', media_type: 'image', mime_type: 'image/jpeg',
      size_bytes: originalBytes.length, processing_status: 'complete', uploaded_at: new Date().toISOString(), width: 800, height: 600,
      edit_params: JSON.stringify({ v: 1, exposure: 0.5 }), edit_rev: 1, edit_applied_rev: 1,
      edit_applied_params: JSON.stringify({ v: 1, exposure: 0.5 }), edit_applied_width: 800, edit_applied_height: 600,
    }).returning('id'));
    try {
      for (const url of [`/download/${id}`, `/photo/${id}`]) {
        const head = await guest('head', url);
        expect(head.status).toBe(503);
        expect(head.headers['cache-control']).toBe('no-store');
        expect((await row(id)).edit_render_path).toBeNull();
      }
      const adminHead = await auth(request(adminApp).head(`/api/admin/photos/${event.id}/photo/${id}`));
      expect(adminHead.status).toBe(503);
      expect((await row(id)).edit_render_path).toBeNull();
      expect((await guest('get', `/photo/${id}`)).status).toBe(200);
      expect((await row(id)).edit_render_path).toBeTruthy();
      expect((await guest('head', `/photo/${id}`)).status).toBe(200);
    } finally {
      await db('photos').where({ id }).delete();
    }
  });
});

describe('a preview-only archive and a failed light-and-colour edit', () => {
  it('still has the photo: its preview shows the applied revision and needs no full-size render', async () => {
    const id = unwrap(await db('photos').insert({
      event_id: event.id, filename: 'tone-failed.jpg', path: 'edit-route/beach.jpg', type: 'individual', media_type: 'image', mime_type: 'image/jpeg',
      size_bytes: originalBytes.length, processing_status: 'complete', uploaded_at: new Date().toISOString(), width: 800, height: 600,
      edit_params: JSON.stringify({ v: 1, exposure: 1 }), edit_rev: 1, edit_applied_rev: 0, edit_failed_rev: 1, edit_error: 'render',
    }).returning('id'));
    // A share-link guest of a gallery with a download limit gets previews.
    await db('events').where({ id: event.id }).update({ download_limit: 50 });
    const token = jwt.sign({ eventId: event.id, eventSlug: event.slug, type: 'gallery', accessLevel: 'guest' },
      process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' });
    try {
      const res = await binary(request(galleryApp).get(`/api/gallery/${event.slug}/download-all`).set('Authorization', `Bearer ${token}`));
      expect(res.status).toBe(200);
      expect(Object.keys(await zipEntries(res.body)).some((name) => name.startsWith('tone-failed'))).toBe(true);
      const selected = await binary(request(galleryApp).post(`/api/gallery/${event.slug}/download-selected`)
        .set('Authorization', `Bearer ${token}`).send({ photo_ids: [id] }));
      expect(Object.keys(await zipEntries(selected.body)).some((name) => name.startsWith('tone-failed'))).toBe(true);
      const jobs = require('../../src/services/downloadJobService');
      const fresh = await db('events').where({ id: event.id }).first();
      const job = await jobs.createJob({ event: fresh, resolution: 'original', photoIds: [id], accessLevel: 'guest', previewOnly: true });
      await jobs.liveBuilds.get(job.id);
      expect((await jobs.getStatus(job.token)).status).toBe('ready');
    } finally {
      await db('events').where({ id: event.id }).update({ download_limit: null });
      await db('photos').where({ id }).delete();
    }
  });
});

describe('a cached preview archive and a crop that then fails', () => {
  it('is neither reused nor delivered; the prebuilt ZIP goes when the failure is recorded', async () => {
    const jobs = require('../../src/services/downloadJobService');
    const zip = require('../../src/services/downloadZipService');
    const id = unwrap(await db('photos').insert({
      event_id: event.id, filename: 'crop-later.jpg', path: 'edit-route/beach.jpg', type: 'individual', media_type: 'image', mime_type: 'image/jpeg',
      size_bytes: originalBytes.length, processing_status: 'complete', uploaded_at: new Date().toISOString(), width: 800, height: 600,
    }).returning('id'));
    try {
      const fresh = await db('events').where({ id: event.id }).first();
      const job = await jobs.createJob({ event: fresh, resolution: 'original', photoIds: [id], accessLevel: 'guest', previewOnly: true });
      await jobs.liveBuilds.get(job.id);
      // A crop saved: the previews (and the archive) still show the applied, unedited photo.
      await db('photos').where({ id }).update({ edit_params: JSON.stringify({ v: 1, crop: { x: 0, y: 0, w: 0.5, h: 1 } }), edit_rev: 1 });
      const ready = await db('download_jobs').where({ id: job.id }).first();
      expect(await jobs.deliveryPhotos(ready, fresh, 'guest')).toBeTruthy();
      // The crop fails to render: the uncropped archive must not go out any more.
      const invalidate = jest.spyOn(zip, 'invalidateIfBuilt');
      const brokenPath = (await row(id)).path;
      await db('photos').where({ id }).update({ path: 'edit-route/missing.jpg' });
      await applyEdits();
      await db('photos').where({ id }).update({ path: brokenPath });
      expect((await row(id)).edit_failed_rev).toBe(1);
      expect(invalidate).toHaveBeenCalledWith(event.id);
      invalidate.mockRestore();
      expect(await jobs.deliveryPhotos(ready, fresh, 'guest')).toBeFalsy();
      const again = await jobs.createJob({ event: fresh, resolution: 'original', photoIds: [id], accessLevel: 'guest', previewOnly: true }).catch((e) => e);
      expect(again.id).not.toBe(job.id);
      if (again.id) await jobs.liveBuilds.get(again.id);
    } finally {
      await db('photos').where({ id }).delete();
    }
  });
});

describe('jobs packaged around a failed edit', () => {
  it('deliver what they hold, and a recovered edit makes a new full-size job', async () => {
    const jobs = require('../../src/services/downloadJobService');
    const crop = JSON.stringify({ v: 1, crop: { x: 0, y: 0, w: 0.5, h: 1 } });
    const id = unwrap(await db('photos').insert({
      event_id: event.id, filename: 'failing-crop.jpg', path: 'edit-route/beach.jpg', type: 'individual', media_type: 'image', mime_type: 'image/jpeg',
      size_bytes: originalBytes.length, processing_status: 'complete', uploaded_at: new Date().toISOString(), width: 800, height: 600,
      edit_params: crop, edit_rev: 1, edit_applied_rev: 0, edit_failed_rev: 1, edit_error: 'render',
    }).returning('id'));
    try {
      const fresh = await db('events').where({ id: event.id }).first();
      // A preview job built while the crop is withheld skips it: what it holds may go out.
      const preview = await jobs.createJob({ event: fresh, resolution: 'original', photoIds: [secondId, id], accessLevel: 'guest', previewOnly: true });
      await jobs.liveBuilds.get(preview.id);
      const ready = await db('download_jobs').where({ id: preview.id }).first();
      expect(JSON.parse(ready.delivered_photo_ids)).toEqual([secondId]);
      expect(await jobs.deliveryPhotos(ready, fresh, 'guest')).toBeTruthy();
      // A full-size job skips the photo whose render failed...
      const full = await jobs.createJob({ event: fresh, resolution: 'original', photoIds: [secondId, id], accessLevel: 'guest' });
      await jobs.liveBuilds.get(full.id);
      expect(JSON.parse((await db('download_jobs').where({ id: full.id }).first()).delivered_photo_ids)).toEqual([secondId]);
      // ...and once the edit is applied after all, a new one has it.
      await auth(request(adminApp).post(`/api/admin/photos/${event.id}/photos/edit/retry`).send({ photo_ids: [id] })).expect(200);
      await applyEdits();
      expect((await row(id)).edit_applied_rev).toBe(1);
      const again = await jobs.createJob({ event: fresh, resolution: 'original', photoIds: [secondId, id], accessLevel: 'guest' });
      expect(again.id).not.toBe(full.id);
      await jobs.liveBuilds.get(again.id);
      expect(JSON.parse((await db('download_jobs').where({ id: again.id }).first()).delivered_photo_ids).sort()).toEqual([secondId, id].sort());
    } finally {
      await db('photos').where({ id }).delete();
    }
  });
});

describe('public pictures of a photo withheld for a failing crop', () => {
  it('the link preview (OG) shows no cover of it and its cover route answers no picture', async () => {
    const og = require('../../src/services/galleryOgService');
    const id = unwrap(await db('photos').insert({
      event_id: event.id, filename: 'og-hero.jpg', path: 'edit-route/beach.jpg', type: 'individual', media_type: 'image', mime_type: 'image/jpeg',
      size_bytes: originalBytes.length, processing_status: 'complete', uploaded_at: new Date().toISOString(), width: 800, height: 600,
    }).returning('id'));
    const app = express();
    app.get('/og/gallery/:slug/cover', og.handleGalleryOgCover);
    try {
      await require('../../src/services/imageProcessor').ensureThumbnail(await row(id), { force: true });
      await db('events').where({ id: event.id }).update({ og_image_share_enabled: true, hero_photo_id: id, expires_at: new Date(Date.now() + 864e5).toISOString() });
      expect((await request(app).get(`/og/gallery/${event.slug}/cover`)).status).toBe(200);
      expect((await og.buildOgMetadata(event.slug, `/gallery/${event.slug}`)).image).toMatch(/\/cover$/);
      await db('photos').where({ id }).update({
        edit_params: JSON.stringify({ v: 1, crop: { x: 0, y: 0, w: 0.5, h: 1 } }), edit_rev: 1, edit_applied_rev: 0, edit_failed_rev: 1,
      });
      const cover = await request(app).get(`/og/gallery/${event.slug}/cover`);
      expect(cover.status).toBe(404);
      expect(cover.headers['cache-control']).toBe('no-store');
      expect((await og.buildOgMetadata(event.slug, `/gallery/${event.slug}`)).image).not.toMatch(/\/cover$/);
      // The guest listing's blurred placeholder is of the uncropped picture too.
      const listed = (await guest('get', '/photos').expect(200)).body.photos.find((p) => p.id === id);
      expect(listed.thumb_hash ?? null).toBeNull();
    } finally {
      await db('events').where({ id: event.id }).update({ og_image_share_enabled: false, hero_photo_id: null });
      await db('photos').where({ id }).delete();
    }
  });

  it('every public path that hands out a photo\'s picture checks the withholding', () => {
    const fsm = require('fs');
    const read = (file) => fsm.readFileSync(path.join(__dirname, '../../src', file), 'utf8');
    for (const file of ['services/galleryOgService.js', 'routes/gallery/media.js', 'services/downloadRendition.js', 'services/galleryQueryService.js']) {
      expect(read(file)).toContain('withheldFromGuests');
    }
  });
});

describe('the watermark batch over edited photos', () => {
  it('marks an edited photo from its edit under the revision, and skips one withheld for a failing crop', async () => {
    const watermarkService = require('../../src/services/watermarkService');
    const generator = require('../../src/services/watermarkGeneratorService');
    const settings = jest.spyOn(watermarkService, 'getWatermarkSettings')
      .mockResolvedValue({ enabled: true, logoPath: null, position: 'bottom-right', opacity: 50, size: 15, companyName: 'Studio' });
    const insert = async (filename, over = {}) => unwrap(await db('photos').insert({
      event_id: event.id, filename, path: 'edit-route/beach.jpg', type: 'individual', media_type: 'image', mime_type: 'image/jpeg',
      size_bytes: originalBytes.length, processing_status: 'complete', uploaded_at: new Date().toISOString(), width: 800, height: 600, ...over,
    }).returning('id'));
    const others = (await db('photos').where({ event_id: event.id }).pluck('id'));
    const edited = await insert('wm-edited.jpg');
    const withheld = await insert('wm-withheld.jpg');
    // Only these two in the batch.
    await db('photos').whereIn('id', others).update({ event_id: event.id + 100000 });
    try {
      const math = require('../../src/utils/photoEditMath');
      await require('../../src/services/photoEdits').saveEdits([{ photo: await row(edited), params: math.validateEditParams({ exposure: 0.4 }).params }]);
      await applyEdits();
      // A crop that failed to render: guests are kept from the picture.
      await db('photos').where({ id: withheld }).update({
        edit_params: JSON.stringify({ v: 1, crop: { x: 0, y: 0, w: 0.5, h: 1 } }), edit_rev: 1, edit_applied_rev: 0, edit_failed_rev: 1,
      });
      await generator.generateForEvent(event.id);
      const marked = await row(edited);
      expect(marked.watermark_path).toMatch(/_e1_/);
      expect((await row(withheld)).watermark_path).toBeNull();
    } finally {
      settings.mockRestore();
      await db('photos').whereIn('id', others).update({ event_id: event.id });
      await db('photos').whereIn('id', [edited, withheld]).delete();
    }
  });
});

describe('the gallery photo route while an edit is pending', () => {
  it('shows the applied revision, the one the listing describes; a download gets the saved edit', async () => {
    const id = unwrap(await db('photos').insert({
      event_id: event.id, filename: 'pending-photo.jpg', path: 'edit-route/beach.jpg', type: 'individual', media_type: 'image', mime_type: 'image/jpeg',
      size_bytes: originalBytes.length, processing_status: 'complete', uploaded_at: new Date().toISOString(), width: 800, height: 600,
      edit_params: JSON.stringify({ v: 1, crop: { x: 0, y: 0, w: 0.5, h: 1 } }), edit_rev: 1, edit_applied_rev: 0,
    }).returning('id'));
    try {
      const shown = await binary(guest('get', `/photo/${id}`)).expect(200);
      expect(await size(shown.body)).toEqual([800, 600]);
      const downloaded = await binary(guest('get', `/download/${id}`)).expect(200);
      expect(await size(downloaded.body)).toEqual([400, 600]);
    } finally {
      await db('photos').where({ id }).delete();
    }
  });
});

describe('the admin viewer while an edit is pending', () => {
  it('shows the applied revision, the one its annotations are placed on; the Edited download gets the saved edit', async () => {
    const insert = async (filename, over) => unwrap(await db('photos').insert({
      event_id: event.id, filename, path: 'edit-route/beach.jpg', type: 'individual', media_type: 'image', mime_type: 'image/jpeg',
      size_bytes: originalBytes.length, processing_status: 'complete', uploaded_at: new Date().toISOString(), width: 800, height: 600, ...over,
    }).returning('id'));
    // A first crop, not applied yet; and a crop applied with a turn pending.
    const fresh = await insert('admin-pending-first.jpg', {
      edit_params: JSON.stringify({ v: 1, crop: { x: 0, y: 0, w: 0.5, h: 1 } }), edit_rev: 1, edit_applied_rev: 0,
    });
    const turned = await insert('admin-pending-turn.jpg', {
      edit_params: JSON.stringify({ v: 1, rotate: 90, crop: { x: 0, y: 0, w: 0.5, h: 1 } }), edit_rev: 2, edit_applied_rev: 1,
      edit_applied_params: JSON.stringify({ v: 1, crop: { x: 0, y: 0, w: 0.5, h: 1 } }), edit_applied_width: 400, edit_applied_height: 600,
    });
    const admin = (url) => binary(auth(request(adminApp).get(`/api/admin/photos/${event.id}${url}`)));
    try {
      const rows = (await auth(request(adminApp).get(`/api/admin/photos/${event.id}/photos`))).body.photos;
      const listed = (id) => rows.find((p) => p.id === id);
      expect(listed(fresh).url).toBe(`/admin/photos/${event.id}/photo/${fresh}`);
      expect(listed(turned).url).toBe(`/admin/photos/${event.id}/photo/${turned}?e=1`);

      expect(await size((await admin(`/photo/${fresh}`).expect(200)).body)).toEqual([800, 600]);
      const shown = await admin(`/photo/${turned}?e=1`).expect(200);
      expect(await size(shown.body)).toEqual([400, 600]);
      expect(shown.headers['cache-control']).toBe('private, max-age=3600');

      // The downloads are as before: the saved edit, or the original.
      expect(await size((await admin(`/photos/${fresh}/download?edited=1`).expect(200)).body)).toEqual([400, 600]);
      // The crop is taken in the turned frame (600 x 800).
      expect(await size((await admin(`/photos/${turned}/download?edited=1`).expect(200)).body)).toEqual([300, 800]);
      expect(await size((await admin(`/photos/${turned}/download`).expect(200)).body)).toEqual([800, 600]);
      expect(await size((await admin(`/photo/${turned}?original=1`).expect(200)).body)).toEqual([800, 600]);
    } finally {
      await db('photos').whereIn('id', [fresh, turned]).delete();
    }
  });
});

describe('a stored watermark copy while a first edit is pending', () => {
  it('is not served with the unedited picture the gallery shows', async () => {
    const watermarkService = require('../../src/services/watermarkService');
    const settings = jest.spyOn(watermarkService, 'getWatermarkSettings')
      .mockResolvedValue({ enabled: true, logoPath: null, position: 'bottom-right', opacity: 50, size: 15, companyName: 'Studio' });
    const id = unwrap(await db('photos').insert({
      event_id: event.id, filename: 'wm-pending.jpg', path: 'edit-route/beach.jpg', type: 'individual', media_type: 'image', mime_type: 'image/jpeg',
      size_bytes: originalBytes.length, processing_status: 'complete', uploaded_at: new Date().toISOString(), width: 800, height: 600,
      edit_params: JSON.stringify({ v: 1, crop: { x: 0, y: 0, w: 0.5, h: 1 } }), edit_rev: 1, edit_applied_rev: 0,
    }).returning('id'));
    // The copy the watermark job cut from the saved crop, tagged with its revision.
    const copy = `watermarks/${id}_watermarked_0123456789ab_e1_.jpg`;
    fs.mkdirSync(path.join(process.env.STORAGE_PATH, 'watermarks'), { recursive: true });
    fs.writeFileSync(path.join(process.env.STORAGE_PATH, copy),
      await sharp({ create: { width: 400, height: 600, channels: 3, background: '#ff00ff' } }).jpeg().toBuffer());
    await db('photos').where({ id }).update({ watermark_path: copy });
    const { watermarkCopyCurrent } = require('../../src/services/photoEdits');
    try {
      const shown = await binary(guest('get', `/photo/${id}`)).expect(200);
      expect(await size(shown.body)).toEqual([800, 600]);
      // The rule: a copy of the revision an edited view shows, an untagged one for an unedited view.
      const edited = { edit_rev: 2, edit_params: '{"v":1,"exposure":0.2}' };
      const unedited = { edit_rev: 2, edit_params: null };
      expect(watermarkCopyCurrent(edited, 'watermarks/5_watermarked_0123456789ab_e2_.jpg')).toBe(true);
      expect(watermarkCopyCurrent(edited, 'watermarks/5_watermarked_0123456789ab_e1_.jpg')).toBe(false);
      expect(watermarkCopyCurrent(unedited, 'watermarks/5_watermarked_0123456789ab.jpg')).toBe(true);
      expect(watermarkCopyCurrent(unedited, 'watermarks/5_watermarked_0123456789ab_e2_.jpg')).toBe(false);
    } finally {
      settings.mockRestore();
      await db('photos').where({ id }).delete();
    }
  });
});

describe('the gallery photo route\'s cache lifetime for an edited photo', () => {
  it('is kept only under the URL naming the applied revision, and not while a newer one is pending', async () => {
    const params = JSON.stringify({ v: 1, exposure: 0.4 });
    const id = unwrap(await db('photos').insert({
      event_id: event.id, filename: 'cache-photo.jpg', path: 'edit-route/beach.jpg', type: 'individual', media_type: 'image', mime_type: 'image/jpeg',
      size_bytes: originalBytes.length, processing_status: 'complete', uploaded_at: new Date().toISOString(), width: 800, height: 600,
      edit_params: params, edit_rev: 1, edit_applied_rev: 1, edit_applied_params: params, edit_applied_width: 800, edit_applied_height: 600,
    }).returning('id'));
    try {
      expect((await guest('get', `/photo/${id}?e=1`).expect(200)).headers['cache-control']).toBe('private, max-age=1800');
      for (const stale of ['', '?e=2']) {
        expect((await guest('get', `/photo/${id}${stale}`).expect(200)).headers['cache-control']).toBe('no-store');
      }
      // A newer save pending: nothing is kept under any URL until it lands.
      await db('photos').where({ id }).update({ edit_params: JSON.stringify({ v: 1, exposure: 0.8 }), edit_rev: 2 });
      expect((await guest('get', `/photo/${id}?e=1`).expect(200)).headers['cache-control']).toBe('no-store');
    } finally {
      await db('photos').where({ id }).delete();
    }
  });
});
