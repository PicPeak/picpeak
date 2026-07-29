/**
 * Admin photo view route Content-Type (#908).
 *
 * The route built `image/<ext>` from the filename, producing invalid
 * types like image/mp4 for videos. AdminAuthenticatedVideo fetches this
 * URL into a blob whose type inherits the header, and browsers refuse to
 * play a <video> blob labeled image/* — blank/grey admin video preview.
 *
 * Pins:
 *  - stored photos.mime_type wins (video/mp4 for videos)
 *  - videos without a stored mime_type still get video/mp4
 *  - images without a stored mime_type fall back to the extension
 *  - extensionless files get image/jpeg, never the invalid bare `image/`
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-admin-ct-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'admin-ct-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-admin-ct-storage-'));

const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const SLUG = 'admin-ct-test-event';

describe('admin photo view Content-Type (#908)', () => {
  let db;
  let cleanup;
  let app;
  let eventId;
  let adminToken;

  const addPhoto = async (filename, extra = {}) => {
    const dir = path.join(process.env.STORAGE_PATH, 'events/active', SLUG);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), Buffer.from(`bytes-${filename}`));
    const r = await db('photos').insert({
      event_id: eventId,
      filename,
      path: `${SLUG}/${filename}`,
      type: 'individual',
      uploaded_at: new Date().toISOString(),
      ...extra,
    }).returning('id');
    return r[0]?.id ?? r[0];
  };

  const getPhotoRes = (photoId) => request(app)
    .get(`/api/admin/photos/${eventId}/photo/${photoId}`)
    .set('Authorization', `Bearer ${adminToken}`);

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const inserted = await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Admin CT Test',
      event_date: '2026-08-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'admin-ct-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = inserted[0]?.id ?? inserted[0];

    const superRole = await db('roles').where({ name: 'super_admin' }).first();
    const [rootId] = await db('admin_users').insert({
      username: 'admin-ct-admin',
      email: 'admin-ct-admin@example.com',
      password_hash: await bcrypt.hash('AdminCt123', 4),
      role_id: superRole.id,
      is_active: 1,
      created_at: new Date(),
      updated_at: new Date(),
    }).returning('id').then((r) => [r[0]?.id || r[0]]);
    adminToken = jwt.sign(
      { id: rootId, username: 'admin-ct-admin', type: 'admin', role: 'super_admin', loginTime: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' }
    );

    app = express();
    app.use(express.json());
    app.use('/api/admin/photos', require('../../src/routes/adminPhotos'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('serves a video with its stored mime_type, not image/<ext>', async () => {
    const id = await addPhoto('clip.mp4', { media_type: 'video', mime_type: 'video/mp4' });
    const res = await getPhotoRes(id);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp4');
  });

  it('falls back to video/mp4 for a video row without a stored mime_type', async () => {
    const id = await addPhoto('clip-nomime.mov', { media_type: 'video' });
    const res = await getPhotoRes(id);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp4');
  });

  it('keeps the extension fallback for images without a stored mime_type', async () => {
    const id = await addPhoto('shot.png');
    const res = await getPhotoRes(id);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
  });

  it('extensionless files get image/jpeg, never a bare image/', async () => {
    const id = await addPhoto('noext');
    const res = await getPhotoRes(id);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
  });
});
