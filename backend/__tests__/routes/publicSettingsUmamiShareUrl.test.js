/**
 * GET /api/public/settings is anonymous. The Umami share URL is the bearer
 * link to the whole analytics dashboard; only the tracker bootstrap values
 * (URL, website id) belong in the public response. The admin analytics page
 * reads the share URL from the authenticated /admin/settings instead.
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

  it('exposes the tracker bootstrap but never the share URL', async () => {
    const res = await request(app).get('/api/public/settings');
    expect(res.status).toBe(200);
    expect(res.body.umami_enabled).toBe(true);
    expect(res.body.umami_url).toBe('https://umami.example');
    expect(res.body.umami_website_id).toBe('site-1');
    expect(res.body).not.toHaveProperty('umami_share_url');
    expect(JSON.stringify(res.body)).not.toContain('SECRET-TOKEN');
  });
});
