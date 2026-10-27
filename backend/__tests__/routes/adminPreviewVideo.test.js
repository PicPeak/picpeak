/**
 * The admin preview route and videos (issue 2286).
 *
 * GET /admin/photos/:eventId/preview/:photoId had no video branch: it handed
 * any row to the preview generator, which treats the source as a still, so a
 * video's clip was read from storage (all of it, on S3) only for Sharp to
 * fail, and the route answered 404. A video now redirects to its poster, the
 * admin thumbnail route under the version the admin lists use, without the
 * generator or any storage read. Images are unchanged.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'admin-preview-video-secret-at-least-thirty-two';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-admin-preview-video-'));

jest.mock('../../src/services/imageProcessor', () => {
  const actual = jest.requireActual('../../src/services/imageProcessor');
  return {
    ...actual,
    ensurePreviewImage: jest.fn(async (photo) => photo.preview_path),
    ensurePreviewImageAtWidth: jest.fn(async (photo) => photo.preview_path),
  };
});

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const SLUG = 'admin-preview-video';
const unwrap = (rows) => rows[0]?.id ?? rows[0];

describe('admin preview route and videos (issue 2286)', () => {
  let db; let cleanup; let app; let storage; let adminToken; let eventId;
  let imageProcessor;

  const get = (url) => request(app).get(url).set('Authorization', `Bearer ${adminToken}`).redirects(0);
  const addPhoto = async (fields) => unwrap(await db('photos').insert({
    event_id: eventId, type: 'individual', uploaded_at: new Date().toISOString(), ...fields,
  }).returning('id'));

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    storage = require('../../src/services/storage').getStorage();
    imageProcessor = require('../../src/services/imageProcessor');

    eventId = unwrap(await db('events').insert({
      slug: SLUG, event_type: 'wedding', event_name: SLUG, event_date: '2026-10-15',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `/gallery/${SLUG}/s`, share_token: `${SLUG}-share`,
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_at: new Date().toISOString(),
    }).returning('id'));

    const superRole = await db('roles').where({ name: 'super_admin' }).first();
    const adminId = unwrap(await db('admin_users').insert({
      username: 'preview-video-admin', email: 'preview-video-admin@example.com', password_hash: 'x',
      role_id: superRole.id, is_active: 1,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).returning('id'));
    adminToken = jwt.sign(
      { id: adminId, username: 'preview-video-admin', type: 'admin', role: 'super_admin', loginTime: Date.now() },
      process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' },
    );

    app = express();
    app.use(express.json());
    app.use('/api/admin/photos', require('../../src/routes/adminPhotos'));
  }, 120000);

  beforeEach(() => {
    imageProcessor.ensurePreviewImage.mockClear();
    imageProcessor.ensurePreviewImageAtWidth.mockClear();
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => { if (cleanup) await cleanup(); });

  it.each([
    ['by media type', { media_type: 'video', mime_type: 'video/mp4' }],
    ['by MIME type alone', { media_type: 'image', mime_type: 'video/quicktime' }],
  ])('redirects a video %s to its poster without generating or reading storage', async (_label, kind) => {
    const id = await addPhoto({ filename: `clip-${kind.mime_type.replace('/', '-')}`, path: `${SLUG}/clip`, ...kind });
    const stat = jest.spyOn(storage, 'stat');
    const read = jest.spyOn(storage, 'get');

    for (const query of ['', '?w=1280']) {
      const res = await get(`/api/admin/photos/${eventId}/preview/${id}${query}`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`/api/admin/photos/${eventId}/thumbnail/${id}`);
    }
    expect(imageProcessor.ensurePreviewImage).not.toHaveBeenCalled();
    expect(imageProcessor.ensurePreviewImageAtWidth).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('names a picked poster frame in the redirect, as the admin lists do', async () => {
    const id = await addPhoto({
      filename: 'picked.mp4', path: `${SLUG}/picked.mp4`, media_type: 'video', mime_type: 'video/mp4',
      poster_offset_seconds: 4,
    });
    const res = await get(`/api/admin/photos/${eventId}/preview/${id}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/api/admin/photos/${eventId}/thumbnail/${id}?v=p4`);
  });

  it('still serves an image its preview', async () => {
    const key = 'previews/preview_still.jpg';
    await storage.put(key, Buffer.from('preview bytes'));
    const id = await addPhoto({
      filename: 'still.jpg', path: `${SLUG}/still.jpg`, media_type: 'image', mime_type: 'image/jpeg', preview_path: key,
    });
    const res = await get(`/api/admin/photos/${eventId}/preview/${id}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(imageProcessor.ensurePreviewImage).toHaveBeenCalledTimes(1);
  });
});
