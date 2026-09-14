/**
 * iPhone DNG uploads through the real admin and guest upload routes (issue 821).
 *
 * Both routes refused a valid iPhone ProRAW DNG. The fixture carries the first
 * bytes of the reporter's file (big-endian TIFF, "MM\0*" then "APPLEDNG") and
 * is sent the way a browser without a DNG type mapping sends it: as
 * application/octet-stream.
 *
 *  - the admin route rejected it as an invalid type in multer's fileFilter,
 *    and would then have rejected the big-endian signature in its content check
 *  - the guest route rejected it as an invalid type in its fileFilter
 *
 * The control pins that normalizing the reported type did not switch off the
 * admin content check: JPEG bytes named .dng are still refused.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-dng-upload-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'dng-upload-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-dng-upload-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const SLUG = 'dng-upload-test-event';

// First 16 bytes of the reporter's iPhone 15 Pro Max ProRAW file.
const IPHONE_PRORAW_HEADER = Buffer.from([
  0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x12,
  0x41, 0x50, 0x50, 0x4C, 0x45, 0x44, 0x4E, 0x47,
]);
const iphoneDng = () => Buffer.concat([IPHONE_PRORAW_HEADER, Buffer.alloc(4096)]);

describe('iPhone DNG through the upload routes', () => {
  let db;
  let cleanup;
  let app;
  let eventId;
  let adminToken;

  const galleryToken = () => jwt.sign(
    { eventId, eventSlug: SLUG, type: 'gallery' },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' }
  );

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const inserted = await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'DNG Upload Test',
      event_date: '2026-09-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'dng-upload-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      allow_user_uploads: 1,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = inserted[0]?.id ?? inserted[0];

    const superRole = await db('roles').where({ name: 'super_admin' }).first();
    const [rootId] = await db('admin_users').insert({
      username: 'dng-upload-admin',
      email: 'dng-upload-admin@example.com',
      password_hash: await bcrypt.hash('DngUpload123', 4),
      role_id: superRole.id,
      is_active: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).returning('id').then((r) => [r[0]?.id || r[0]]);
    adminToken = jwt.sign(
      { id: rootId, username: 'dng-upload-admin', type: 'admin', role: 'super_admin', loginTime: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' }
    );

    await db('app_settings')
      .insert({
        setting_key: 'general_allowed_file_types',
        setting_value: JSON.stringify('jpg,jpeg,png,webp,dng'),
        setting_type: 'general',
        updated_at: new Date().toISOString(),
      })
      .onConflict('setting_key')
      .merge({ setting_value: JSON.stringify('jpg,jpeg,png,webp,dng') });
    require('../../src/services/uploadSettings').clearAllowedTypesCache();

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/photos', require('../../src/routes/adminPhotos'));
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('admin route accepts a big-endian DNG the browser reported as octet-stream', async () => {
    const res = await request(app)
      .post(`/api/admin/photos/${eventId}/upload`)
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('photos', iphoneDng(), { filename: 'IMG_0001.DNG', contentType: 'application/octet-stream' });

    expect(res.body.error).toBeUndefined();
    expect(res.status).toBe(202);
  });

  it('admin route still refuses JPEG bytes named .dng', async () => {
    const jpegBytes = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(4096)]);
    const res = await request(app)
      .post(`/api/admin/photos/${eventId}/upload`)
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('photos', jpegBytes, { filename: 'renamed.dng', contentType: 'application/octet-stream' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('File content does not match declared type: renamed.dng');
  });

  it('guest route accepts a DNG the browser reported as octet-stream', async () => {
    const res = await request(app)
      .post(`/api/gallery/${eventId}/upload`)
      .set('Authorization', `Bearer ${galleryToken()}`)
      .attach('photos', iphoneDng(), { filename: 'IMG_0001.DNG', contentType: 'application/octet-stream' });

    expect(res.body.error).toBeUndefined();
    expect(res.status).toBe(202);
  });
});
