/**
 * A video that completed on the placeholder tile is visible as such, and can
 * be retried (issue 1430, item 6).
 *
 * The row completes — the guest gallery lists only complete rows — but it now
 * carries processing_error, which the admin photo list exposes and the Retry
 * route accepts. Pins, through the real routes against SQLite:
 *  - the list reports processing_error, and no longer invents an English
 *    category name for an uncategorised row
 *  - Retry takes a complete row with a note, still takes a failed one, and
 *    still refuses a clean complete row
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-poster-note-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'poster-note-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-poster-note-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

describe('video poster-frame note and retry (issue 1430)', () => {
  let db; let cleanup; let app; let token; let eventId;
  let noteId; let cleanId; let failedId; let categorisedId;

  const unwrap = (rows) => {
    const row = rows[0];
    return typeof row === 'object' && row !== null ? row.id : row;
  };

  const mkPhoto = async (filename, over = {}) => unwrap(await db('photos').insert({
    event_id: eventId,
    filename,
    path: `events/active/${filename}`,
    type: 'individual',
    size_bytes: 1000,
    uploaded_at: new Date().toISOString(),
    ...over,
  }).returning('id'));

  const retry = (id) => request(app)
    .post(`/api/admin/photos/photos/${id}/retry`)
    .set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const role = await db('roles').where({ name: 'super_admin' }).first();
    const adminId = unwrap(await db('admin_users').insert({
      username: 'poster-root',
      email: 'poster-root@example.com',
      password_hash: await bcrypt.hash('Passw0rd!', 4),
      role_id: role.id,
      is_active: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).returning('id'));
    token = jwt.sign(
      { id: adminId, username: 'poster-root', type: 'admin', role: 'super_admin', loginTime: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' },
    );

    eventId = unwrap(await db('events').insert({
      slug: 'poster-note',
      event_type: 'wedding',
      event_name: 'Poster note',
      event_date: '2026-08-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_token: 'tok-poster-note',
      share_link: '/gallery/poster-note/tok-poster-note',
      created_by: adminId,
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id'));

    noteId = await mkPhoto('hevc.mov', {
      media_type: 'video', mime_type: 'video/quicktime',
      processing_status: 'complete', processing_error: 'No poster frame: ffmpeg seek failed',
    });
    cleanId = await mkPhoto('fine.mp4', { media_type: 'video', mime_type: 'video/mp4', processing_status: 'complete' });
    failedId = await mkPhoto('broken.jpg', { processing_status: 'failed', processing_error: 'sharp: bad header' });

    const categoryId = unwrap(await db('photo_categories').insert({
      event_id: eventId, name: 'Ceremony', slug: 'ceremony', is_global: 0,
    }).returning('id'));
    categorisedId = await mkPhoto('cat.jpg', { category_id: categoryId });

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/photos', require('../../src/routes/adminPhotos'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  describe('GET /api/admin/photos/:eventId/photos', () => {
    let byId;

    beforeAll(async () => {
      const res = await request(app)
        .get(`/api/admin/photos/${eventId}/photos`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      byId = Object.fromEntries(res.body.photos.map((p) => [p.id, p]));
    });

    it('reports the note on a complete video, and null elsewhere', () => {
      expect(byId[noteId]).toMatchObject({
        processing_status: 'complete',
        processing_error: 'No poster frame: ffmpeg seek failed',
      });
      expect(byId[cleanId]).toMatchObject({ processing_status: 'complete', processing_error: null });
      expect(byId[failedId]).toMatchObject({ processing_status: 'failed', processing_error: 'sharp: bad header' });
    });

    it('gives the placeholder tile a thumbnail URL of its own, so a retried frame is not served from cache', () => {
      // The thumbnail route caches for an hour and the real frame lands under
      // the placeholder's key; the note is what tells the two apart.
      expect(byId[noteId].thumbnail_url).toBe(`/admin/photos/${eventId}/thumbnail/${noteId}?v=note`);
      expect(byId[cleanId].thumbnail_url).toBe(`/admin/photos/${eventId}/thumbnail/${cleanId}`);
    });

    it('names only a real category; the grid derives the default label', () => {
      expect(byId[categorisedId]).toMatchObject({ category_name: 'Ceremony', category_slug: 'ceremony' });
      // Used to be the English "Individual Photos", even for a video.
      expect(byId[noteId]).toMatchObject({ category_name: null, category_slug: 'individual' });
    });
  });

  describe('POST /api/admin/photos/photos/:photoId/retry', () => {
    it('refuses a complete row without a note', async () => {
      const res = await retry(cleanId);
      expect(res.status).toBe(409);
    });

    it('still takes a failed row', async () => {
      const res = await retry(failedId);
      expect(res.status).toBe(200);
      expect(await db('photos').where({ id: failedId }).first()).toMatchObject({
        processing_status: 'pending', processing_error: null,
      });
    });

    it('takes a complete video with a note and queues it again', async () => {
      const res = await retry(noteId);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: noteId, status: 'pending' });
      expect(await db('photos').where({ id: noteId }).first()).toMatchObject({
        processing_status: 'pending', processing_error: null, processing_started_at: null,
      });
    });
  });
});
