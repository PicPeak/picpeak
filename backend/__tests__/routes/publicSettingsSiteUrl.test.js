/**
 * Issue 2630: the admin panel may run on an internal domain while guests reach
 * the install on its public one. Links the admin copies for guests are built
 * on `public_site_url` from the public settings, so it must carry the same
 * address the emails use, and null when nothing usable is configured (the
 * frontend then falls back to its own origin).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-pubsettings-siteurl-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'pubsettings-siteurl-test-secret';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-pubsettings-siteurl-storage-'));

const request = require('supertest');
const { bootCrmDb, buildRouteApp } = require('../integration/helpers/crmDb');

describe('public settings — public_site_url', () => {
  let db; let cleanup; let app; let frontendUrl;
  const savedEnv = process.env.FRONTEND_URL;

  const setSiteUrl = async (value) => {
    await db('app_settings').where({ setting_key: 'general_site_url' }).del();
    if (value !== null) {
      await db('app_settings').insert({
        setting_key: 'general_site_url', setting_value: JSON.stringify(value), setting_type: 'general',
        updated_at: new Date().toISOString(),
      });
    }
    await frontendUrl.primeSiteUrlCache();
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    frontendUrl = require('../../src/utils/frontendUrl');
    app = buildRouteApp('/api/public/settings', require('../../src/routes/publicSettings'));
  }, 120000);

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = savedEnv;
  });

  afterAll(async () => { if (cleanup) await cleanup(); });

  it('returns the Site URL setting', async () => {
    delete process.env.FRONTEND_URL;
    await setSiteUrl('https://galerie.example.com/');
    const res = await request(app).get('/api/public/settings').set('Host', 'galerie.int.example.com').expect(200);
    expect(res.body.public_site_url).toBe('https://galerie.example.com');
  });

  it('prefers a pinned FRONTEND_URL over the setting', async () => {
    process.env.FRONTEND_URL = 'https://public.example.com';
    await setSiteUrl('https://galerie.example.com');
    const res = await request(app).get('/api/public/settings').expect(200);
    expect(res.body.public_site_url).toBe('https://public.example.com');
  });

  it('is null when nothing is configured, never the request host', async () => {
    delete process.env.FRONTEND_URL;
    await setSiteUrl(null);
    const res = await request(app).get('/api/public/settings').set('Host', 'galerie.int.example.com').expect(200);
    expect(res.body.public_site_url).toBeNull();
  });

  it('is null for a loopback address (the old compose default)', async () => {
    process.env.FRONTEND_URL = 'http://localhost:3000';
    await setSiteUrl(null);
    const res = await request(app).get('/api/public/settings').expect(200);
    expect(res.body.public_site_url).toBeNull();
  });
});
