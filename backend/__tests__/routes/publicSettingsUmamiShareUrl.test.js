/**
 * GET /api/public/settings is anonymous. The Umami share URL is the bearer
 * link to the whole analytics dashboard; the data-only client needs only the
 * provider, so collector URLs and site IDs stay out of the public response
 * too. The admin analytics page reads the share URL from the authenticated
 * /admin/settings instead.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-pubsettings-umami-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'pubsettings-umami-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-pubsettings-umami-storage-'));

const request = require('supertest');
const { bootCrmDb, buildRouteApp } = require('../integration/helpers/crmDb');

describe('public settings — Umami share URL stays private', () => {
  let db; let cleanup; let app;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    for (const [key, value] of Object.entries({
      analytics_umami_enabled: true,
      analytics_umami_url: 'https://umami.example',
      analytics_umami_website_id: 'site-1',
      analytics_umami_share_url: 'https://umami.example/share/SECRET-TOKEN/picpeak',
    })) {
      await db('app_settings').insert({
        setting_key: key, setting_value: JSON.stringify(value), setting_type: 'analytics',
        updated_at: new Date().toISOString(),
      });
    }
    app = buildRouteApp('/api/public/settings', require('../../src/routes/publicSettings'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('exposes which provider is on, never the collector config or the share URL', async () => {
    const res = await request(app).get('/api/public/settings');
    expect(res.status).toBe(200);
    expect(res.body.umami_enabled).toBe(true);
    expect(res.body.analytics_tracker_provider).toBe('umami');
    for (const key of ['umami_url', 'umami_website_id', 'rybbit_url', 'rybbit_website_id']) {
      expect(res.body).not.toHaveProperty(key);
    }
    expect(JSON.stringify(res.body)).not.toContain('umami.example');
    expect(JSON.stringify(res.body)).not.toContain('site-1');
    expect(res.body).not.toHaveProperty('umami_share_url');
    expect(JSON.stringify(res.body)).not.toContain('SECRET-TOKEN');
  });

  it('never exposes legacy custom executable HTML, even with a stale Umami enabled flag', async () => {
    for (const [key, value] of Object.entries({
      analytics_tracker_provider: 'custom',
      analytics_custom_head_html: '<script>fetch("/api/admin/users")</script>',
    })) {
      await db('app_settings').insert({
        setting_key: key, setting_value: JSON.stringify(value), setting_type: 'analytics',
      }).onConflict('setting_key').merge({ setting_value: JSON.stringify(value) });
    }
    const res = await request(app).get('/api/public/settings').expect(200);
    expect(res.body.analytics_tracker_provider).toBe('none');
    expect(res.body.analytics_custom_head_html).toBe('');
    expect(JSON.stringify(res.body)).not.toContain('fetch(');
  });
});
