/**
 * Protected-key boundary on the generic settings writers (migration 175).
 *
 * A role with settings.edit but NOT settings.domains (the "office manager" this
 * PR enables) must be able to save the General tab — which re-posts
 * general_site_url on every save — as long as the URL is UNCHANGED, and must be
 * 403'd only when it actually tries to change a protected key. Regression pin for
 * the change-detection fix (the presence-only check over-fired on every save).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-setkeys-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'setkeys-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-setkeys-storage-'));

const request = require('supertest');
const express = require('express');
const cookieParser = require('cookie-parser');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken,
} = require('../integration/helpers/crmDb');
const svc = require('../../src/services/userManagementService');
const { clearPermissionCache } = require('../../src/middleware/permissions');

const STORED_URL = 'https://stored.example';

describe('settings protected-key boundary (/general)', () => {
  let db; let cleanup; let app;
  let superTok; let mgrTok;

  const auth = (req, tok) => req.set('Authorization', `Bearer ${tok}`);
  const readSiteUrl = async () => {
    const row = await db('app_settings').where({ setting_key: 'general_site_url' }).first();
    return row ? JSON.parse(row.setting_value) : null;
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId: superId } = await seedMinimal(db);
    await assignAdminRole(db, superId, 'super_admin');
    superTok = mintAdminToken(superId);

    // Office-manager role: settings.view + settings.edit, NOT settings.domains.
    const mgrRole = await svc.createRole(
      { name: 'office_mgr', permissions: ['settings.view', 'settings.edit'] },
      superId,
    );
    const ins = await db('admin_users').insert({
      username: 'office', email: 'office@example.com', password_hash: 'x',
      role_id: mgrRole.id, must_change_password: false, created_at: new Date(),
    }).returning('id');
    mgrTok = mintAdminToken(ins[0]?.id ?? ins[0]);

    await db('app_settings').insert({
      setting_key: 'general_site_url', setting_value: JSON.stringify(STORED_URL), setting_type: 'general',
    });
    clearPermissionCache();

    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/admin/settings', require('../../src/routes/adminSettings'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('settings.edit role can save /general when general_site_url is unchanged', async () => {
    const res = await auth(request(app).put('/api/admin/settings/general'), mgrTok)
      .send({ general_site_url: STORED_URL, general_max_file_size_mb: 50 });
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
    expect(await readSiteUrl()).toBe(STORED_URL);
  });

  it('settings.edit role is 403d when it actually changes general_site_url', async () => {
    const res = await auth(request(app).put('/api/admin/settings/general'), mgrTok)
      .send({ general_site_url: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(res.body.keys.map((k) => k.key)).toContain('general_site_url');
    expect(await readSiteUrl()).toBe(STORED_URL); // unchanged
  });

  it('super_admin can change general_site_url', async () => {
    const res = await auth(request(app).put('/api/admin/settings/general'), superTok)
      .send({ general_site_url: 'https://new.example' });
    expect(res.status).toBe(200);
    expect(await readSiteUrl()).toBe('https://new.example');
  });

  const readSetting = async (key) => {
    const row = await db('app_settings').where({ setting_key: key }).first();
    return row ? JSON.parse(row.setting_value) : undefined;
  };

  it('settings.edit role can save the Analytics tab unchanged on an install with no tracker settings yet', async () => {
    // The exact payload the tab sends on first save: every analytics_* key,
    // the provider derived client-side ('none') and the legacy umami flag.
    const res = await auth(request(app).put('/api/admin/settings/analytics'), mgrTok)
      .send({
        analytics_tracker_provider: 'none',
        analytics_umami_enabled: false,
        analytics_umami_url: '',
        analytics_umami_website_id: '',
        analytics_umami_share_url: '',
        analytics_rybbit_url: '',
        analytics_rybbit_website_id: '',
        analytics_custom_head_html: '',
      });
    expect(res.status).toBe(200);
  });

  // The tracker proxy re-serves the configured tracker's script from the app
  // origin, so choosing the tracker host is choosing what JavaScript runs in
  // every admin's session. settings.edit alone must not reach it.
  it('settings.edit role is 403d when it changes the tracker URL, on every generic writer', async () => {
    for (const endpoint of ['analytics', 'general', 'seo']) {
      const res = await auth(request(app).put(`/api/admin/settings/${endpoint}`), mgrTok)
        .send({ analytics_tracker_provider: 'umami', analytics_umami_url: 'https://tracker.evil.example' });
      expect(res.status).toBe(403);
      expect(res.body.keys.map((k) => k.key)).toEqual(
        expect.arrayContaining(['analytics_tracker_provider', 'analytics_umami_url']),
      );
    }
    expect(await readSetting('analytics_umami_url')).toBeUndefined();
  });

  it('settings.edit role can still save other analytics settings', async () => {
    const res = await auth(request(app).put('/api/admin/settings/analytics'), mgrTok)
      .send({ analytics_umami_website_id: 'site-1' });
    expect(res.status).toBe(200);
    expect(await readSetting('analytics_umami_website_id')).toBe('site-1');
  });

  it('super_admin can change the tracker URL', async () => {
    const res = await auth(request(app).put('/api/admin/settings/analytics'), superTok)
      .send({ analytics_tracker_provider: 'umami', analytics_umami_url: 'https://tracker.example' });
    expect(res.status).toBe(200);
    expect(await readSetting('analytics_umami_url')).toBe('https://tracker.example');
  });

  // Backup destinations and the manifest location are owned by
  // /admin/backup/config, which keeps them super_admin-only. The generic
  // writers refuse them loudly, whoever calls, and store nothing.
  it('generic writers refuse backup_* keys with a 400 that names them', async () => {
    const manifestBefore = await readSetting('backup_manifest_path');
    const destinationBefore = await readSetting('backup_destination_type');
    for (const tok of [mgrTok, superTok]) {
      const res = await auth(request(app).put('/api/admin/settings/general'), tok)
        .send({ backup_manifest_path: '/data/db', backup_destination_type: 's3', general_max_file_size_mb: 60 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BACKUP_SETTINGS_ELSEWHERE');
      expect(res.body.keys).toEqual(expect.arrayContaining(['backup_manifest_path', 'backup_destination_type']));
    }
    expect(await readSetting('backup_manifest_path')).toBe(manifestBefore);
    expect(await readSetting('backup_destination_type')).toBe(destinationBefore);
  });
});
