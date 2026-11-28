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

test('website subpages and the sitemap are compressed like the home page', async () => {
  await setSetting('seo_allow_indexing', true, 'seo');
  const about = await request(app).get('/about').set('Accept-Encoding', 'gzip');
  expect(about.status).toBe(200);
  expect(about.headers['content-encoding']).toBe('gzip');
  const sitemap = await request(app).get('/sitemap.xml').set('Accept-Encoding', 'gzip');
  // Below compression's 1 KB threshold it is sent plain, but it went through it.
  expect(sitemap.headers.vary).toMatch(/Accept-Encoding/);
  // The API keeps its behaviour.
  const api = await request(app).get('/api/public/settings').set('Accept-Encoding', 'gzip');
  expect(api.headers['content-encoding']).toBeUndefined();
  const health = await request(app).get('/health').set('Accept-Encoding', 'gzip');
  expect(health.headers.vary || '').not.toMatch(/Accept-Encoding/);
});

test('paths the app owns still reach the SPA; legal pages and unknown slugs take the website design', async () => {
  for (const p of ['/admin', '/setup', '/book', '/not-found']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await request(app).get(p);
    expect(res.text).toContain('<div id="root">SPA</div>');
  }
  const now = new Date().toISOString();
  for (const [slug, title] of [['impressum', 'Legal Notice'], ['not-found', 'Page Not Found']]) {
    // eslint-disable-next-line no-await-in-loop
    await db('cms_pages').where({ slug }).del();
    // eslint-disable-next-line no-await-in-loop
    await db('cms_pages').insert({ slug, title_en: title, title_de: title, content_en: `<p>${title} text</p>`, content_de: '', updated_at: now });
  }
  require('../src/services/website/cache').clearWebsiteCache();
  const legal = await request(app).get('/impressum');
  expect(legal.status).toBe(200);
  expect(legal.text).toContain('Legal Notice text');
  expect(legal.text).toContain('class="pp-header"');
  expect(legal.headers['content-security-policy']).toContain('script-src \'none\'');
  const missing = await request(app).get('/no-such-page');
  expect(missing.text).toContain('Page Not Found text');
  expect(missing.headers['x-robots-tag']).toBe('noindex');
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

describe('website page views', () => {
  const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
  const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
  const rows = () => db('website_page_views').select('page', 'referrer', 'device', 'views');
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

  beforeAll(async () => {
    await setFeatureFlags(db, { websiteBuilder: true });
    await publish({ pages: [{ id: 'home', slug: 'home', title: 'Home', isHome: true, blocks: [] }, { id: 'about', slug: 'about', title: 'About', blocks: [] }] });
    await db('website_page_views').del();
  });

  test('a visit counts per page, referrer domain and device class, with nothing about the visitor', async () => {
    await request(app).get('/').set('User-Agent', BROWSER).set('Referer', 'https://www.instagram.com/studio/p/xyz?igsh=abc');
    await request(app).get('/').set('User-Agent', BROWSER).set('Referer', 'https://instagram.com/other');
    await request(app).get('/about').set('User-Agent', PHONE).set('X-Forwarded-For', '203.0.113.9');
    // Moving between the site's own pages has no outside referrer.
    await request(app).get('/about').set('Host', 'studio.example').set('User-Agent', BROWSER).set('Referer', 'https://studio.example/');
    await settle();
    const counted = await rows();
    expect(counted).toEqual(expect.arrayContaining([
      { page: '', referrer: 'instagram.com', device: 'desktop', views: 2 },
      { page: 'about', referrer: '', device: 'mobile', views: 1 },
      { page: 'about', referrer: '', device: 'desktop', views: 1 },
    ]));
    // No column could hold an address, an agent string or a cookie.
    const columns = Object.keys(await db('website_page_views').columnInfo());
    expect(columns.sort()).toEqual(['day', 'device', 'id', 'page', 'referrer', 'views'].sort());
    const set = (await request(app).get('/').set('User-Agent', BROWSER)).headers['set-cookie'];
    expect(set).toBeUndefined();
  });

  test('crawlers, HEAD requests and pages nobody can see are not counted', async () => {
    await db('website_page_views').del();
    await request(app).get('/').set('User-Agent', 'Mozilla/5.0 (compatible; Googlebot/2.1)');
    await request(app).head('/').set('User-Agent', BROWSER);
    await request(app).get('/impressum').set('User-Agent', BROWSER);
    await settle();
    expect(await rows()).toEqual([]);
  });

  test('every address with no page counts in one bucket, so made-up addresses add no rows', async () => {
    await db('website_page_views').del();
    for (const slug of ['nope', 'random-a1', 'random-b2', 'random-c3']) {
      // eslint-disable-next-line no-await-in-loop
      await request(app).get(`/${slug}`).set('User-Agent', BROWSER);
    }
    await settle();
    expect(await rows()).toEqual([{ page: '(not found)', referrer: '', device: 'desktop', views: 4 }]);
  });
});

describe('website page views sent to the configured analytics, when chosen', () => {
  const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
  let collector; let received = [];
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

  beforeAll(async () => {
    process.env.ANALYTICS_ALLOW_INSECURE_HTTP = 'true';
    const http = require('http');
    collector = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => { received.push({ path: req.url, headers: req.headers, body: JSON.parse(body || '{}') }); res.end('{}'); });
    });
    await new Promise((resolve) => collector.listen(0, '127.0.0.1', resolve));
    await setSetting('analytics_tracker_provider', 'umami', 'analytics');
    await setSetting('analytics_umami_url', `http://127.0.0.1:${collector.address().port}`, 'analytics');
    await setSetting('analytics_umami_website_id', 'site-123', 'analytics');
    await setFeatureFlags(db, { websiteBuilder: true });
    await publish({ pages: [{ id: 'home', slug: 'home', title: 'Home', isHome: true, blocks: [] }, { id: 'about', slug: 'about', title: 'About', blocks: [] }] });
  });
  afterAll(async () => {
    delete process.env.ANALYTICS_ALLOW_INSECURE_HTTP;
    await new Promise((resolve) => collector.close(resolve));
  });

  test('off by default: nothing leaves the server', async () => {
    await request(app).get('/about').set('User-Agent', BROWSER);
    await settle();
    expect(received).toEqual([]);
  });

  test('on: a page view goes to the tracker from the server, never for crawlers or Do Not Track', async () => {
    await setSetting('analytics_website_forward', true, 'analytics');
    await request(app).get('/about').set('User-Agent', BROWSER).set('X-Forwarded-For', '198.51.100.7');
    await request(app).get('/about').set('User-Agent', 'Mozilla/5.0 (compatible; Googlebot/2.1)');
    await request(app).get('/about').set('User-Agent', BROWSER).set('DNT', '1');
    await request(app).get('/about').set('User-Agent', BROWSER).set('Sec-GPC', '1');
    await settle();
    expect(received).toHaveLength(1);
    expect(received[0].path).toBe('/api/send');
    expect(received[0].body.payload).toMatchObject({ website: 'site-123', url: '/about' });
    expect(received[0].headers['user-agent']).toBe(BROWSER);
    await setSetting('analytics_website_forward', false, 'analytics');
  });

  test('the global "Enable Analytics" switch off: nothing is forwarded and nothing is counted', async () => {
    await setSetting('analytics_website_forward', true, 'analytics');
    await setSetting('general_enable_analytics', false);
    received = [];
    await db('website_page_views').del();
    try {
      await request(app).get('/about').set('User-Agent', BROWSER).set('X-Forwarded-For', '198.51.100.8');
      await settle();
      expect(received).toEqual([]);
      expect(await db('website_page_views').count({ c: '*' }).first()).toMatchObject({ c: 0 });
    } finally {
      await setSetting('general_enable_analytics', true);
      await setSetting('analytics_website_forward', false, 'analytics');
    }
  });
});
