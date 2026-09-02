/**
 * Per-file upload size limit on the admin photo routes.
 *
 * `general_max_file_size_mb` (Settings → General, default 50MB) is what the
 * dropzone advertises ("max. 50MB per file"), but the admin upload route
 * hardcoded multer's cap at 10GB and the chunked-upload init route at 10GB
 * too — so the advertised limit was never enforced anywhere server-side and a
 * 50.74MB JPEG uploaded cleanly.
 *
 * Pins:
 *  - a file over the configured cap is rejected with a 400 naming the limit
 *  - the chunked-upload init route honours the same cap (it would otherwise
 *    be a trivial bypass of the multipart route's cap)
 *  - the chunk route enforces the cap on the bytes actually received, so a
 *    client can't declare `fileSize: 1` at init and stream past the limit
 *  - a file under the cap still gets past the size gate
 *  - the limit is read per request, so an admin raising it takes effect
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-upload-size-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'upload-size-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-upload-size-storage-'));

const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const SLUG = 'upload-size-test-event';

describe('admin upload per-file size limit (general_max_file_size_mb)', () => {
  let db;
  let cleanup;
  let app;
  let eventId;
  let adminToken;
  let uploadSettings;

  const setLimitMb = async (mb) => {
    await db('app_settings')
      .insert({
        setting_key: 'general_max_file_size_mb',
        setting_value: JSON.stringify(mb),
        setting_type: 'general',
        updated_at: new Date().toISOString(),
      })
      .onConflict('setting_key')
      .merge({ setting_value: JSON.stringify(mb) });
    uploadSettings.clearMaxFileSizeCache();
  };

  const postUpload = (bytes, filename = 'shot.jpg') => request(app)
    .post(`/api/admin/photos/${eventId}/upload`)
    .set('Authorization', `Bearer ${adminToken}`)
    .attach('photos', Buffer.alloc(bytes, 0x41), { filename, contentType: 'image/jpeg' });

  const postChunkedInit = (fileSize) => request(app)
    .post(`/api/admin/photos/${eventId}/chunked-upload/init`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ filename: 'clip.mp4', fileSize, mimeType: 'video/mp4', totalChunks: 1 });

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const inserted = await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Upload Size Test',
      event_date: '2026-09-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'upload-size-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = inserted[0]?.id ?? inserted[0];

    const superRole = await db('roles').where({ name: 'super_admin' }).first();
    const [rootId] = await db('admin_users').insert({
      username: 'upload-size-admin',
      email: 'upload-size-admin@example.com',
      password_hash: await bcrypt.hash('UploadSize123', 4),
      role_id: superRole.id,
      is_active: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).returning('id').then((r) => [r[0]?.id || r[0]]);
    adminToken = jwt.sign(
      { id: rootId, username: 'upload-size-admin', type: 'admin', role: 'super_admin', loginTime: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' }
    );

    uploadSettings = require('../../src/services/uploadSettings');

    app = express();
    app.use(express.json());
    app.use('/api/admin/photos', require('../../src/routes/adminPhotos'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('rejects a file over the configured limit with a 400 naming the limit', async () => {
    await setLimitMb(1);
    const res = await postUpload(2 * 1024 * 1024);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('File too large. Maximum size is 1 MB per file.');
  });

  it('rejects an over-limit chunked upload at init instead of allowing 10GB', async () => {
    await setLimitMb(1);
    const res = await postChunkedInit(200 * 1024 * 1024);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('File too large. Maximum size is 1 MB per file.');
  });

  it('rejects chunk bytes over the limit regardless of the declared fileSize', async () => {
    await setLimitMb(1);
    const initRes = await postChunkedInit(1);
    expect(initRes.status).toBe(200);

    const res = await request(app)
      .post(`/api/admin/photos/${eventId}/chunked-upload/${initRes.body.uploadId}/chunk/0`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(2 * 1024 * 1024, 0x41));
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('File too large. Maximum size is 1 MB per file.');
  });

  it('lets a file under the limit past the size gate', async () => {
    await setLimitMb(1);
    // Junk bytes, so it still fails downstream on the content check — that is
    // the point: the failure is no longer about size.
    const res = await postUpload(64 * 1024);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('File content does not match declared type: shot.jpg');
  });

  it('reads the limit per request, so raising it takes effect immediately', async () => {
    await setLimitMb(1);
    expect((await postUpload(2 * 1024 * 1024)).status).toBe(400);

    await setLimitMb(10);
    const res = await postUpload(2 * 1024 * 1024);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('File content does not match declared type: shot.jpg');
  });
});
