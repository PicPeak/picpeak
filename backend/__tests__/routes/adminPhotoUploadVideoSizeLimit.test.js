/**
 * Separate per-file cap for videos (general_max_video_size_mb) and temp-file
 * cleanup on rejected uploads.
 *
 * `general_max_file_size_mb` was a single cap for photos AND videos, so with
 * the 50MB default an admin could not upload a normal clip through the Photos
 * tab without raising a limit that also governs photos. Videos now have their
 * own cap; multer's (type-blind) limit is the larger of the two and the
 * per-kind decision happens after multer, where the MIME type is known.
 *
 * Pins:
 *  - a video between the photo cap and the video cap gets past the size gate
 *  - a photo is still held to the photo cap even though multer streamed
 *    against the (larger) video cap
 *  - a video over the video cap is rejected naming the video cap
 *  - both caps are read per request
 *  - a rejected upload leaves nothing behind in the temp directory
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-video-size-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'video-size-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-video-size-storage-'));

const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

const SLUG = 'video-size-test-event';
// Resolved lazily: bootCrmDb() repoints STORAGE_PATH at its own tmp dir, so a
// path captured at module load is not the one the route uploads into.
const tempRoot = () => path.join(process.env.STORAGE_PATH, 'temp');

describe('admin upload per-file video size limit (general_max_video_size_mb)', () => {
  let db;
  let cleanup;
  let app;
  let eventId;
  let adminToken;
  let uploadSettings;

  const setSetting = async (key, value) => {
    await db('app_settings')
      .insert({
        setting_key: key,
        setting_value: JSON.stringify(value),
        setting_type: 'general',
        updated_at: new Date().toISOString(),
      })
      .onConflict('setting_key')
      .merge({ setting_value: JSON.stringify(value) });
  };

  const setCaps = async ({ photoMb, videoMb }) => {
    await setSetting('general_max_file_size_mb', photoMb);
    await setSetting('general_max_video_size_mb', videoMb);
    uploadSettings.clearMaxFileSizeCache();
    uploadSettings.clearMaxVideoSizeCache();
  };

  const postUpload = (bytes, filename, contentType) => request(app)
    .post(`/api/admin/photos/${eventId}/upload`)
    .set('Authorization', `Bearer ${adminToken}`)
    .attach('photos', Buffer.alloc(bytes, 0x41), { filename, contentType });

  const postVideo = (bytes) => postUpload(bytes, 'clip.mp4', 'video/mp4');
  const postPhoto = (bytes) => postUpload(bytes, 'shot.jpg', 'image/jpeg');

  // res.on('finish') cleanup is async, so give it a moment to land.
  const tempEntriesAfterSettle = async () => {
    let entries = [];
    for (let i = 0; i < 40; i++) {
      entries = fs.existsSync(tempRoot()) ? fs.readdirSync(tempRoot()) : [];
      if (entries.length === 0) return entries;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return entries;
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const inserted = await db('events').insert({
      slug: SLUG,
      event_type: 'wedding',
      event_name: 'Video Size Test',
      event_date: '2026-09-01',
      host_email: 'host@example.com',
      admin_email: 'admin@example.com',
      password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`,
      share_token: 'video-size-share',
      expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      is_active: 1,
      is_archived: 0,
      is_draft: 0,
      created_at: new Date().toISOString(),
    }).returning('id');
    eventId = inserted[0]?.id ?? inserted[0];

    const superRole = await db('roles').where({ name: 'super_admin' }).first();
    const [rootId] = await db('admin_users').insert({
      username: 'video-size-admin',
      email: 'video-size-admin@example.com',
      password_hash: await bcrypt.hash('VideoSize123', 4),
      role_id: superRole.id,
      is_active: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).returning('id').then((r) => [r[0]?.id || r[0]]);
    adminToken = jwt.sign(
      { id: rootId, username: 'video-size-admin', type: 'admin', role: 'super_admin', loginTime: Date.now() },
      process.env.JWT_SECRET,
      { expiresIn: '1h', issuer: 'picpeak-auth' }
    );

    uploadSettings = require('../../src/services/uploadSettings');
    // mp4 has to be an allowed type for the video to reach the size gate.
    await setSetting('general_allowed_file_types', 'jpg,jpeg,png,webp,mp4');
    uploadSettings.clearAllowedTypesCache();

    app = express();
    app.use(express.json());
    app.use('/api/admin/photos', require('../../src/routes/adminPhotos'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('lets a video past the size gate that the photo cap would have rejected', async () => {
    await setCaps({ photoMb: 1, videoMb: 10 });
    const res = await postVideo(2 * 1024 * 1024);
    // Junk bytes, so it still fails on the content check — that is the point:
    // the failure is no longer about size.
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('File content does not match declared type: clip.mp4');
  });

  it('still holds a photo to the photo cap even though multer streamed against the video cap', async () => {
    await setCaps({ photoMb: 1, videoMb: 10 });
    const res = await postPhoto(2 * 1024 * 1024);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('File too large. Maximum size is 1 MB per file.');
  });

  it('rejects a video over the video cap, naming the video cap', async () => {
    // Video cap deliberately BELOW the photo cap, so multer's limit is the
    // photo cap and only the MIME-aware gate can reject this.
    await setCaps({ photoMb: 10, videoMb: 2 });
    const res = await postVideo(3 * 1024 * 1024);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('File too large. Maximum size is 2 MB per file.');
  });

  it('reads the video cap per request, so raising it takes effect immediately', async () => {
    await setCaps({ photoMb: 1, videoMb: 1 });
    expect((await postVideo(2 * 1024 * 1024)).body.error)
      .toBe('File too large. Maximum size is 1 MB per file.');

    await setCaps({ photoMb: 1, videoMb: 10 });
    const res = await postVideo(2 * 1024 * 1024);
    expect(res.body.error).toBe('File content does not match declared type: clip.mp4');
  });

  it('defaults the video cap to 500MB when the setting is absent', async () => {
    await db('app_settings').where({ setting_key: 'general_max_video_size_mb' }).del();
    await setSetting('general_max_file_size_mb', 1);
    uploadSettings.clearMaxFileSizeCache();
    uploadSettings.clearMaxVideoSizeCache();

    expect(await uploadSettings.getMaxVideoSizeMb()).toBe(500);
    const res = await postVideo(2 * 1024 * 1024);
    expect(res.body.error).toBe('File content does not match declared type: clip.mp4');
  });

  it('leaves no temp files behind when an upload is rejected', async () => {
    await setCaps({ photoMb: 1, videoMb: 10 });

    // Rejected on size (the MIME-aware gate)…
    expect((await postPhoto(2 * 1024 * 1024)).status).toBe(400);
    expect(await tempEntriesAfterSettle()).toEqual([]);

    // …and rejected on content, with two files in the batch so the shared
    // per-request temp directory is exercised.
    const res = await request(app)
      .post(`/api/admin/photos/${eventId}/upload`)
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('photos', Buffer.alloc(1024, 0x41), { filename: 'a.jpg', contentType: 'image/jpeg' })
      .attach('photos', Buffer.alloc(1024, 0x41), { filename: 'b.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(400);
    expect(await tempEntriesAfterSettle()).toEqual([]);
  });
});
