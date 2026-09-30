/**
 * Video is a media type, not a special kind of photo (issue 1430).
 *
 * Pins, against a real SQLite database through the real routes:
 *  - the events list and the event detail report video_count and
 *    video_duration next to photo_count, which stays the count of both types
 *  - the dashboard reports totalVideos, scoped like every other aggregate there
 *  - the admin photo list honours media_type=photo|video. The grid has sent it
 *    since the filter was added and the route never read it.
 *
 * "Is a video" means media_type = 'video' OR a video/ MIME type. The file
 * watcher stores the MIME type but never media_type, so its videos sit in the
 * table as 'image'; and a row with no MIME type at all must stay a photo.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-media-counts-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'media-counts-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-media-counts-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

describe('media type counts and filter (issue 1430)', () => {
  let db; let cleanup; let app;
  let superToken; let editorToken;
  let mixedEventId; let photoOnlyEventId; let editorEventId;

  const unwrap = (rows) => {
    const row = rows[0];
    return typeof row === 'object' && row !== null ? row.id : row;
  };

  const mkAdmin = async (username, roleName) => {
    const role = await db('roles').where({ name: roleName }).first();
    const id = unwrap(await db('admin_users').insert({
      username,
      email: `${username}@example.com`,
      password_hash: await bcrypt.hash('Passw0rd!', 4),
      role_id: role.id,
      is_active: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).returning('id'));
    const token = jwt.sign(
      { id, username, type: 'admin', role: roleName, loginTime: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' },
    );
    return { id, token };
  };

  const mkEvent = async (slug, createdBy) => unwrap(await db('events').insert({
    slug,
    event_type: 'wedding',
    event_name: `${slug}-name`,
    event_date: '2026-08-01',
    host_email: 'h@example.com',
    admin_email: 'a@example.com',
    password_hash: 'x',
    share_token: `tok-${slug}`,
    share_link: `/gallery/${slug}/tok-${slug}`,
    created_by: createdBy,
    expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
    is_active: 1, is_archived: 0, is_draft: 0,
    created_at: new Date().toISOString(),
  }).returning('id'));

  const mkPhoto = (eventId, filename, over = {}) => db('photos').insert({
    event_id: eventId,
    filename,
    path: `events/active/${filename}`,
    type: 'individual',
    size_bytes: 1000,
    uploaded_at: new Date().toISOString(),
    ...over,
  });

  const get = (url, token = superToken) => request(app).get(url).set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const sup = await mkAdmin('media-root', 'super_admin');
    const editor = await mkAdmin('media-editor', 'editor');
    superToken = sup.token;
    editorToken = editor.token;

    mixedEventId = await mkEvent('media-mixed', sup.id);
    photoOnlyEventId = await mkEvent('media-photos', sup.id);
    editorEventId = await mkEvent('media-editor-own', editor.id);

    // Two photos: one written by the upload pipeline, one with no MIME type at
    // all (external imports leave it NULL).
    await mkPhoto(mixedEventId, 'a.jpg', { media_type: 'image', mime_type: 'image/jpeg' });
    await mkPhoto(mixedEventId, 'b.jpg', { media_type: 'image', mime_type: null });
    // Three videos: uploaded, file-watcher style ('image' + a video MIME), and
    // one whose runtime ffprobe could not read.
    await mkPhoto(mixedEventId, 'c.mp4', { media_type: 'video', mime_type: 'video/mp4', duration: 61 });
    await mkPhoto(mixedEventId, 'd.mov', { media_type: 'image', mime_type: 'video/quicktime', duration: 30 });
    await mkPhoto(mixedEventId, 'e.mp4', { media_type: 'video', mime_type: 'video/mp4', duration: null });

    await mkPhoto(photoOnlyEventId, 'p.jpg', { media_type: 'image', mime_type: 'image/jpeg' });

    await mkPhoto(editorEventId, 'own.mp4', { media_type: 'video', mime_type: 'video/mp4', duration: 10 });

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/events', require('../../src/routes/adminEvents'));
    app.use('/api/admin/dashboard', require('../../src/routes/adminDashboard'));
    app.use('/api/admin/photos', require('../../src/routes/adminPhotos'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  describe('GET /api/admin/events', () => {
    it('reports video_count and video_duration per event, photo_count staying the total', async () => {
      const res = await get('/api/admin/events');
      expect(res.status).toBe(200);
      const byId = Object.fromEntries(res.body.events.map((e) => [e.id, e]));

      expect(byId[mixedEventId]).toMatchObject({ photo_count: 5, video_count: 3, video_duration: 91 });
      expect(byId[photoOnlyEventId]).toMatchObject({ photo_count: 1, video_count: 0, video_duration: 0 });
    });

    it('reports zero for an event with no rows at all', async () => {
      const emptyId = await mkEvent('media-empty', null);
      const res = await get('/api/admin/events');
      const empty = res.body.events.find((e) => e.id === emptyId);
      expect(empty).toMatchObject({ photo_count: 0, video_count: 0, video_duration: 0 });
      await db('events').where({ id: emptyId }).del();
    });
  });

  describe('GET /api/admin/events/:id', () => {
    it('reports the same split on the event detail', async () => {
      const res = await get(`/api/admin/events/${mixedEventId}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ photo_count: 5, video_count: 3, video_duration: 91 });
    });

    it('reports numbers, not strings or null, for a photo-only event', async () => {
      const res = await get(`/api/admin/events/${photoOnlyEventId}`);
      expect(res.body.video_count).toBe(0);
      expect(res.body.video_duration).toBe(0);
    });
  });

  describe('GET /api/admin/dashboard/stats', () => {
    it('reports totalVideos across the install for an unrestricted admin', async () => {
      const res = await get('/api/admin/dashboard/stats');
      expect(res.status).toBe(200);
      expect(Number(res.body.totalPhotos)).toBe(7);
      expect(res.body.totalVideos).toBe(4);
    });

    it('scopes totalVideos to the events a restricted role can see', async () => {
      const res = await get('/api/admin/dashboard/stats', editorToken);
      expect(res.status).toBe(200);
      expect(Number(res.body.totalPhotos)).toBe(1);
      expect(res.body.totalVideos).toBe(1);
    });
  });

  describe('GET /api/admin/photos/:eventId/photos', () => {
    const names = async (query) => {
      const res = await get(`/api/admin/photos/${mixedEventId}/photos${query}`);
      expect(res.status).toBe(200);
      return res.body.photos.map((p) => p.filename).sort();
    };

    it('returns only videos for media_type=video, the file-watcher row included', async () => {
      expect(await names('?media_type=video')).toEqual(['c.mp4', 'd.mov', 'e.mp4']);
    });

    it('returns only photos for media_type=photo, the row without a MIME type included', async () => {
      expect(await names('?media_type=photo')).toEqual(['a.jpg', 'b.jpg']);
    });

    it('returns both without the parameter, or with a value it does not know', async () => {
      const all = ['a.jpg', 'b.jpg', 'c.mp4', 'd.mov', 'e.mp4'];
      expect(await names('')).toEqual(all);
      expect(await names('?media_type=everything')).toEqual(all);
    });
  });
});
