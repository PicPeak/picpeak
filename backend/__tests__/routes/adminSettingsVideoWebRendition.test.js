/**
 * The general_video_web_rendition setting (issue 1430, item 8): stored as a
 * boolean, and switching it on queues the back catalogue — every video never
 * looked at or whose last copy failed, never a photo, never a video whose
 * copy exists or is in flight. Switching it off leaves the rows alone.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-web-setting-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'web-setting-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-web-setting-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

describe('general_video_web_rendition (issue 1430)', () => {
  let db; let cleanup; let app; let token; let eventId;
  const rows = {};

  const unwrap = (r) => (typeof r[0] === 'object' && r[0] !== null ? r[0].id : r[0]);

  const put = (body) => request(app)
    .put('/api/admin/settings/general')
    .set('Authorization', `Bearer ${token}`)
    .send(body);

  const statusOf = async (name) => (await db('photos').where({ id: rows[name] }).first()).web_status ?? null;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const role = await db('roles').where({ name: 'super_admin' }).first();
    const adminId = unwrap(await db('admin_users').insert({
      username: 'web-root', email: 'web-root@example.com',
      password_hash: await bcrypt.hash('Passw0rd!', 4), role_id: role.id, is_active: 1,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).returning('id'));
    token = jwt.sign(
      { id: adminId, username: 'web-root', type: 'admin', role: 'super_admin', loginTime: Date.now() },
      process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' },
    );

    eventId = unwrap(await db('events').insert({
      slug: 'web-setting', event_type: 'wedding', event_name: 'Web setting', event_date: '2026-08-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_token: 'tok-web-setting', share_link: '/gallery/web-setting/tok-web-setting', created_by: adminId,
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_at: new Date().toISOString(),
    }).returning('id'));

    const mk = async (name, over) => {
      rows[name] = unwrap(await db('photos').insert({
        event_id: eventId, filename: `${name}.mp4`, path: `events/active/${name}.mp4`, type: 'individual',
        size_bytes: 10, uploaded_at: new Date().toISOString(), ...over,
      }).returning('id'));
    };
    await mk('never', { media_type: 'video', mime_type: 'video/mp4' });
    await mk('watcher', { media_type: 'image', mime_type: 'video/quicktime' });
    await mk('failed', { media_type: 'video', mime_type: 'video/mp4', web_status: 'failed', web_error: 'ffmpeg exited with code 1' });
    await mk('done', { media_type: 'video', mime_type: 'video/mp4', web_status: 'complete', web_path: 'videos/web_x.mp4' });
    await mk('skipped', { media_type: 'video', mime_type: 'video/mp4', web_status: 'skipped' });
    await mk('busy', { media_type: 'video', mime_type: 'video/mp4', web_status: 'processing', web_started_at: new Date().toISOString() });
    await mk('still-uploading', { media_type: 'video', mime_type: 'video/mp4', processing_status: 'pending' });
    await mk('photo', { media_type: 'image', mime_type: 'image/jpeg' });
    // An archived gallery: its originals are in the zip, not in storage.
    const archivedEventId = unwrap(await db('events').insert({
      slug: 'web-setting-archived', event_type: 'wedding', event_name: 'Archived', event_date: '2026-07-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_token: 'tok-web-setting-archived', share_link: '/gallery/web-setting-archived/tok', created_by: adminId,
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 0, is_archived: 1, is_draft: 0, created_at: new Date().toISOString(),
    }).returning('id'));
    await mk('archived', { event_id: archivedEventId, media_type: 'video', mime_type: 'video/mp4' });

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/settings', require('../../src/routes/adminSettings'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('switching it off stores false and queues nothing', async () => {
    const res = await put({ general_video_web_rendition: 'false' });
    expect(res.status).toBe(200);
    const stored = await db('app_settings').where({ setting_key: 'general_video_web_rendition' }).first();
    expect(JSON.parse(stored.setting_value)).toBe(false);
    expect(await statusOf('never')).toBeNull();
    expect(await statusOf('failed')).toBe('failed');
  });

  it('switching it on stores true and queues the back catalogue', async () => {
    const res = await put({ general_video_web_rendition: true });
    expect(res.status).toBe(200);
    const stored = await db('app_settings').where({ setting_key: 'general_video_web_rendition' }).first();
    expect(JSON.parse(stored.setting_value)).toBe(true);

    expect(await statusOf('never')).toBe('pending');
    // The file watcher's shape: media_type 'image', a video MIME type.
    expect(await statusOf('watcher')).toBe('pending');
    expect(await statusOf('failed')).toBe('pending');
    expect((await db('photos').where({ id: rows.failed }).first()).web_error).toBeNull();

    expect(await statusOf('done')).toBe('complete');
    expect(await statusOf('skipped')).toBe('skipped');
    expect(await statusOf('busy')).toBe('processing');
    // Not complete yet: the upload worker queues it when it is.
    expect(await statusOf('still-uploading')).toBeNull();
    expect(await statusOf('photo')).toBeNull();
    // Queuing it could only fail; the restore route backfills the event instead.
    expect(await statusOf('archived')).toBeNull();
  });

  it('the service reads the new value without waiting out its cache', async () => {
    const service = require('../../src/services/videoRenditionService');
    expect(await service.isEnabled()).toBe(true);
    await put({ general_video_web_rendition: false });
    expect(await service.isEnabled()).toBe(false);
  });
});
