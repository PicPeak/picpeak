/**
 * The general_video_adaptive_streaming setting (issue 1733, D4): stored as a
 * boolean, read by the service without waiting out its cache, and switching
 * it on gives the videos whose ladder failed another try. Off leaves every
 * row alone.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-hls-setting-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'hls-setting-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-hls-setting-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const { decodeSettingValue } = require('../helpers/settingValue');

describe('general_video_adaptive_streaming (issue 1733)', () => {
  let db; let cleanup; let app; let token;
  const rows = {};
  const unwrap = r => (typeof r[0] === 'object' && r[0] !== null ? r[0].id : r[0]);
  const put = body => request(app).put('/api/admin/settings/general').set('Authorization', `Bearer ${token}`).send(body);
  const stored = async () => decodeSettingValue(db,
    (await db('app_settings').where({ setting_key: 'general_video_adaptive_streaming' }).first())?.setting_value);
  const statusOf = async name => (await db('photos').where({ id: rows[name] }).first()).hls_status ?? null;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    const role = await db('roles').where({ name: 'super_admin' }).first();
    const adminId = unwrap(await db('admin_users').insert({
      username: 'hls-root', email: 'hls-root@example.com',
      password_hash: await bcrypt.hash('Passw0rd!', 4), role_id: role.id, is_active: 1,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).returning('id'));
    token = jwt.sign({ id: adminId, username: 'hls-root', type: 'admin', role: 'super_admin', loginTime: Date.now() },
      process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' });
    const eventId = unwrap(await db('events').insert({
      slug: 'hls-setting', event_type: 'wedding', event_name: 'HLS setting', event_date: '2026-10-12',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_token: 'tok-hls-setting', share_link: '/gallery/hls-setting/tok-hls-setting', created_by: adminId,
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, created_at: new Date().toISOString(),
    }).returning('id'));
    const mk = async (name, over) => {
      rows[name] = unwrap(await db('photos').insert({
        event_id: eventId, filename: `${name}.mp4`, path: `events/active/${name}.mp4`, type: 'individual',
        media_type: 'video', mime_type: 'video/mp4', size_bytes: 10, uploaded_at: new Date().toISOString(), ...over,
      }).returning('id'));
    };
    await mk('never', {});
    await mk('failed', { hls_status: 'failed', hls_error: 'ffmpeg failed (1)', hls_attempts: 5 });
    await mk('done', { hls_status: 'complete', hls_path: 'hls/1/0b6f6d0e-5f0b-4c55-9f0e-2a4d3c1b7e9a' });
    await mk('skipped', { hls_status: 'skipped', hls_error: 'Longer than 1800 s' });
    await mk('photo', { media_type: 'image', mime_type: 'image/jpeg' });

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/settings', require('../../src/routes/adminSettings'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('is off until someone switches it on', async () => {
    expect(await db('app_settings').where({ setting_key: 'general_video_adaptive_streaming' }).first()).toBeUndefined();
    expect(await require('../../src/services/videoHlsService').isEnabled()).toBe(false);
  });

  it('switching it off stores false and touches no row', async () => {
    expect((await put({ general_video_adaptive_streaming: 'false' })).status).toBe(200);
    expect(await stored()).toBe(false);
    expect(await statusOf('never')).toBeNull();
    expect(await statusOf('failed')).toBe('failed');
  });

  it('switching it on stores true and queues the videos, the failed ones again', async () => {
    expect((await put({ general_video_adaptive_streaming: true })).status).toBe(200);
    expect(await stored()).toBe(true);
    expect(await statusOf('never')).toBe('pending');
    expect(await db('photos').where({ id: rows.failed }).first()).toMatchObject({ hls_status: 'pending', hls_error: null, hls_attempts: 0 });
    expect(await statusOf('done')).toBe('complete');
    expect(await statusOf('skipped')).toBe('skipped');
    expect(await statusOf('photo')).toBeNull();
  });

  it('the service reads the new value without waiting out its cache', async () => {
    const service = require('../../src/services/videoHlsService');
    expect(await service.isEnabled()).toBe(true);
    await put({ general_video_adaptive_streaming: false });
    expect(await service.isEnabled()).toBe(false);
  });
});
