/**
 * Website builder (issue 2618) through the real server.js routing, without
 * nginx: `/` and `/<slug>` belong to the builder only while it is live, and
 * every other path, and every path while it is not, behaves as before.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { bootCrmDb, setFeatureFlags } = require('./integration/helpers/crmDb');

let app; let db; let cleanup;

async function setSetting(key, value, type = 'general') {
  await db('app_settings').where({ setting_key: key }).del();
  await db('app_settings').insert({ setting_key: key, setting_value: JSON.stringify(value), setting_type: type, updated_at: new Date().toISOString() });
}

async function publish(document) {
  const now = new Date().toISOString();
  for (const state of ['draft', 'published']) {
    // eslint-disable-next-line no-await-in-loop
    await db('website_documents').where({ state }).del();
    // eslint-disable-next-line no-await-in-loop
    await db('website_documents').insert({ state, document: JSON.stringify(document), revision: 1, updated_at: now, published_at: now });
  }
  require('../src/services/website/cache').clearWebsiteCache();
}

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-website-dist-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>${BRAND_TITLE}</title><div id="root">SPA</div>');
  process.env.SERVE_FRONTEND = 'true';
  process.env.FRONTEND_DIR = dist;
  process.env.JWT_SECRET = 'website-builder-server-test-secret-0123456789';
  process.env.PICPEAK_EVIDENCE_KEY = 'a'.repeat(64);
  await setSetting('general_public_site_enabled', true);
  await setSetting('general_public_site_html', '<h1>Legacy landing</h1>');
  app = require('../server');
}, 120000);

afterAll(async () => { if (cleanup) await cleanup(); });

test('with the flag off, / is the single-page site and slugs reach the SPA', async () => {
  await setFeatureFlags(db, { websiteBuilder: false });
  await publish({ pages: [{ id: 'home', slug: 'home', title: 'Home', isHome: true, blocks: [{ type: 'hero', heading: 'Builder home' }] }, { id: 'about', slug: 'about', title: 'About', blocks: [] }] });
  const root = await request(app).get('/');
  expect(root.status).toBe(200);
  expect(root.text).toContain('Legacy landing');
  expect(root.text).not.toContain('Builder home');
  const about = await request(app).get('/about');
  expect(about.text).toContain('<div id="root">SPA</div>');
  expect((await request(app).get('/sitemap.xml')).text).toContain('<div id="root">SPA</div>');
});

test('with the flag on and a published site, / and /<slug> are server-rendered pages', async () => {
  await setFeatureFlags(db, { websiteBuilder: true });
  require('../src/services/website/cache').clearWebsiteCache();
  const root = await request(app).get('/');
  expect(root.status).toBe(200);
  expect(root.text).toContain('Builder home');
  expect(root.text).not.toContain('<div id="root">');
  expect(root.headers['content-security-policy']).toContain('script-src \'none\'');
  expect(root.headers['cache-control']).toBe('public, max-age=30, must-revalidate');
  // Indexing is off by default.
  expect(root.headers['x-robots-tag']).toBe('noindex');

  const again = await request(app).get('/').set('If-None-Match', root.headers.etag);
  expect(again.status).toBe(304);
  // A revalidation carries the page's own headers, or the browser merges
  // Helmet's generic policy into its cached copy.
  for (const header of ['content-security-policy', 'cache-control', 'etag', 'x-robots-tag', 'vary']) {
    expect(again.headers[header]).toBe(root.headers[header]);
  }

  const about = await request(app).get('/about');
  expect(about.status).toBe(200);
  expect(about.text).toContain('<title>About');

  const home = await request(app).get('/home');
  // Which page is home can change: a temporary, unstored redirect.
  expect(home.status).toBe(302);
  expect(home.headers['cache-control']).toBe('no-store');
  expect(home.headers.location).toBe('/');
});

test('paths the app owns and unknown slugs still reach the SPA', async () => {
  for (const p of ['/admin', '/setup', '/impressum', '/no-such-page', '/book']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await request(app).get(p);
    expect(res.text).toContain('<div id="root">SPA</div>');
  }
});

test('the public site switch still turns the website off', async () => {
  await setSetting('general_public_site_enabled', false);
  require('../src/services/website/cache').clearWebsiteCache();
  require('../src/services/publicSiteService').clearPublicSiteCache();
  const root = await request(app).get('/');
  expect(root.status).toBe(302);
  expect((await request(app).get('/about')).text).toContain('<div id="root">SPA</div>');
  await setSetting('general_public_site_enabled', true);
});

test('the image endpoint is mounted and refuses an unsigned path', async () => {
  const res = await request(app).get('/site-media/p1.00000000000000000000000000000000/640');
  expect(res.status).toBe(404);
  // Loadable from the admin's origin in a split-origin install, like /fonts.
  expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
});
