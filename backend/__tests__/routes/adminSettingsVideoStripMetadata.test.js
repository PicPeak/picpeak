/**
 * The general_video_strip_metadata setting (issue 2102): on when no row
 * exists, stored as a boolean, and switching it on queues the videos that
 * were skipped as browser-compatible or never looked at, for their
 * metadata-free remux, whether or not the web copies are on. Videos deferred
 * for a transcode and failed ones are left to the copies' own backfill.
 * Switching it off leaves every row and every copy as it is, so nothing
 * that plays stops playing.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-strip-setting-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'strip-setting-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-strip-setting-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const { decodeSettingValue } = require('../helpers/settingValue');

describe('general_video_strip_metadata (issue 2102)', () => {
  let db; let cleanup; let app; let token; let service;
  const rows = {};

  const unwrap = (r) => (typeof r[0] === 'object' && r[0] !== null ? r[0].id : r[0]);

  const put = (body) => request(app)
    .put('/api/admin/settings/general')
    .set('Authorization', `Bearer ${token}`)
    .send(body);

  const statusOf = async (name) => (await db('photos').where({ id: rows[name] }).first()).web_status ?? null;
  const resetRows = async () => {
    await db('photos').whereIn('id', [rows.skipped, rows.skipped2]).update({ web_status: 'skipped' });
    await db('photos').where({ id: rows.never }).update({ web_status: null });
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);

    const role = await db('roles').where({ name: 'super_admin' }).first();
    const adminId = unwrap(await db('admin_users').insert({
      username: 'strip-root', email: 'strip-root@example.com',
      password_hash: await bcrypt.hash('Passw0rd!', 4), role_id: role.id, is_active: 1,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).returning('id'));
    token = jwt.sign(
      { id: adminId, username: 'strip-root', type: 'admin', role: 'super_admin', loginTime: Date.now() },
      process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' },
    );

    const mkEvent = async (slug, archived) => unwrap(await db('events').insert({
      slug, event_type: 'wedding', event_name: slug, event_date: '2026-08-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_token: `tok-${slug}`, share_link: `/gallery/${slug}/tok`, created_by: adminId,
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: archived ? 0 : 1, is_archived: archived ? 1 : 0, is_draft: 0, created_at: new Date().toISOString(),
    }).returning('id'));
    const eventId = await mkEvent('strip-setting', false);
    const archivedId = await mkEvent('strip-setting-archived', true);

    const mk = async (name, over) => {
      rows[name] = unwrap(await db('photos').insert({
        event_id: eventId, filename: `${name}.mp4`, path: `events/active/${name}.mp4`, type: 'individual',
        size_bytes: 10, uploaded_at: new Date().toISOString(), media_type: 'video', mime_type: 'video/mp4', ...over,
      }).returning('id'));
    };
    await mk('skipped', { web_status: 'skipped' });
    await mk('skipped2', { web_status: 'skipped', media_type: 'image', mime_type: 'video/quicktime' });
    await mk('remuxed', { web_status: 'complete', web_path: 'videos/web_1_remux_x.mp4' });
    await mk('failed', { web_status: 'failed', web_error: 'ffmpeg exited with code 1' });
    await mk('never', {});
    await mk('deferred', { web_status: 'deferred' });
    await mk('photo', { web_status: 'skipped', media_type: 'image', mime_type: 'image/jpeg' });
    await mk('archived', { event_id: archivedId, web_status: 'skipped' });

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/settings', require('../../src/routes/adminSettings'));
    service = require('../../src/services/videoRenditionService');
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('is on by default: no row means strip', async () => {
    expect(await db('app_settings').where({ setting_key: 'general_video_strip_metadata' }).first()).toBeUndefined();
    service.clearCache();
    expect(await service.isStripEnabled()).toBe(true);
  });

  it('switching it on with the web copies off queues the skipped and never-seen videos, and the workers run', async () => {
    await put({ general_video_web_rendition: false });
    const res = await put({ general_video_strip_metadata: 'true' });
    expect(res.status).toBe(200);
    const stored = await db('app_settings').where({ setting_key: 'general_video_strip_metadata' }).first();
    expect(decodeSettingValue(db, stored.setting_value)).toBe(true);

    expect(await statusOf('skipped')).toBe('pending');
    // The file watcher's shape: media_type 'image', a video MIME type.
    expect(await statusOf('skipped2')).toBe('pending');
    expect(await statusOf('never')).toBe('pending');
    expect(await statusOf('remuxed')).toBe('complete');
    // Needs a transcode the copies would make, or a retry they own.
    expect(await statusOf('deferred')).toBe('deferred');
    expect(await statusOf('failed')).toBe('failed');
    expect(await statusOf('photo')).toBe('skipped');
    expect(await statusOf('archived')).toBe('skipped');
    expect(await service.isEnabled()).toBe(false);
    expect(await service.queuesVideos()).toBe(true);
  });

  it('the once-per-start backfill queues the same rows, and is a no-op with stripping off', async () => {
    await resetRows();
    service.clearCache();
    expect(await service.queueForMetadataStrip()).toBe(3);
    expect(await statusOf('skipped')).toBe('pending');
    expect(await statusOf('never')).toBe('pending');

    await resetRows();
    const res = await put({ general_video_strip_metadata: false });
    expect(res.status).toBe(200);
    const stored = await db('app_settings').where({ setting_key: 'general_video_strip_metadata' }).first();
    expect(decodeSettingValue(db, stored.setting_value)).toBe(false);
    expect(await service.isStripEnabled()).toBe(false);
    expect(await service.queueForMetadataStrip()).toBe(0);
    expect(await statusOf('skipped')).toBe('skipped');
    expect(await service.queuesVideos()).toBe(false);
  });

  it('switching it off keeps the remux already written: the video goes on playing it', async () => {
    const row = await db('photos').where({ id: rows.remuxed }).first();
    expect(row.web_status).toBe('complete');
    expect(row.web_path).toBe('videos/web_1_remux_x.mp4');
  });

  it('the janitor re-queues a row a worker deferred or skipped just before the setting changed', async () => {
    // Stripping is off and the copies are off here.
    await db('photos').where({ id: rows.deferred }).update({ web_status: 'deferred' });
    service.clearCache();
    expect(await service.requeueStranded()).toBe(0);
    // The copies were switched on while a worker, still reading "off",
    // deferred this video: the switch-on backfill could not take it.
    await db('app_settings').insert({ setting_key: 'general_video_web_rendition', setting_value: JSON.stringify(true), setting_type: 'general' })
      .onConflict('setting_key').merge();
    service.clearCache();
    expect(await service.requeueStranded()).toBe(1);
    expect(await statusOf('deferred')).toBe('pending');
    // Skipped rows stay: stripping is off.
    expect(await statusOf('skipped')).toBe('skipped');
    await db('photos').where({ id: rows.deferred }).update({ web_status: 'deferred' });
    await db('app_settings').where({ setting_key: 'general_video_web_rendition' }).update({ setting_value: JSON.stringify(false) });
    service.clearCache();
  });

  it('with stripping off, switching the copies on queues deferred, failed and never-seen videos, not skipped ones', async () => {
    const res = await put({ general_video_web_rendition: true });
    expect(res.status).toBe(200);
    expect(await statusOf('skipped')).toBe('skipped');
    expect(await statusOf('deferred')).toBe('pending');
    expect(await statusOf('failed')).toBe('pending');
    expect(await statusOf('never')).toBe('pending');
  });
});
