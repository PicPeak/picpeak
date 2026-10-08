const express = require('express');
const request = require('supertest');
const settings = {};
const mockRelay = jest.fn();
jest.mock('../utils/appSettings', () => ({
  getAppSetting: jest.fn(async (key, fallback = null) => Object.hasOwn(settings, key) ? settings[key] : fallback),
}));
jest.mock('../utils/integrationHttp', () => ({ integrationRelay: (...args) => mockRelay(...args) }));
jest.mock('../utils/logger', () => ({ warn: jest.fn(), debug: jest.fn() }));
const mockSiteUrl = jest.fn();
jest.mock('../utils/frontendUrl', () => ({ getFrontendBaseUrl: (...args) => mockSiteUrl(...args) }));
const SITE = '11111111-1111-4111-8111-111111111111';
const EVENT = { type: 'pageview', path: '/gallery/wedding/short-secret?token=QUERY#HASH',
  hostname: 'picpeak.example', language: 'de-DE', screenWidth: 1920, screenHeight: 1080 };
const savedEnv = { NODE_ENV: process.env.NODE_ENV, ANALYTICS_ALLOW_INSECURE_HTTP: process.env.ANALYTICS_ALLOW_INSECURE_HTTP };
function buildApp() {
  jest.resetModules();
  const app = express();
  app.use('/api/analytics/tracker', require('../routes/analyticsTrackerProxy'));
  return app;
}
function configured(provider = 'umami') {
  settings.analytics_tracker_provider = provider;
  settings['analytics_' + provider + '_url'] = 'https://collector.example/base/';
  settings['analytics_' + provider + '_website_id'] = SITE;
}
function post(app = buildApp(), data = EVENT) { return request(app).post('/api/analytics/tracker/events').send(data); }
beforeEach(() => {
  for (const key of Object.keys(settings)) delete settings[key];
  delete process.env.ANALYTICS_ALLOW_INSECURE_HTTP;
  mockRelay.mockReset();
  mockSiteUrl.mockReset();
  mockSiteUrl.mockResolvedValue('https://site.example');
  mockRelay.mockResolvedValue({ status: 200, headers: { 'content-type': 'application/javascript', 'set-cookie': 'admin_token=evil' },
    body: Buffer.from('fetch("/api/admin/users")') });
});
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

describe('closed data-only boundary', () => {
  it('fails closed when collector settings cannot be read without relaying', async () => {
    const app = buildApp();
    require('../utils/appSettings').getAppSetting.mockRejectedValueOnce(new Error('database unavailable'));
    await post(app).expect(502);
    expect(mockRelay).not.toHaveBeenCalled();
  });
  it.each(['none', 'custom', 'unsupported'])('does not contact %s or re-enable legacy Umami', async (provider) => {
    configured(provider);
    settings.analytics_umami_enabled = true;
    await post().expect(404);
    expect(mockRelay).not.toHaveBeenCalled();
  });
  it('keeps legacy enabled Umami and configured base subpaths', async () => {
    configured(); delete settings.analytics_tracker_provider; settings.analytics_umami_enabled = true;
    await post().expect(200);
    expect(mockRelay.mock.calls[0][0]).toBe('https://collector.example/base/api/send');
  });
  it.each(['umami', 'rybbit'])('rejects every legacy executable/config/beacon route for %s', async provider => {
    configured(provider);
    const app = buildApp();
    for (const path of ['/script.js', '/api/send', '/track', '/site/tracking-config/123',
      '/site/123/feature-flags/evaluate', '/session-replay/record/123', '/index.html', '/events']) {
      await request(app).get('/api/analytics/tracker' + path).expect(404);
      if (path !== '/events') await request(app).post('/api/analytics/tracker' + path).send(EVENT).expect(404);
    }
    expect(mockRelay).not.toHaveBeenCalled();
  });
  it.each(['application/javascript', 'text/html', 'image/svg+xml', 'application/json'])('discards hostile %s responses', async contentType => {
    configured();
    mockRelay.mockResolvedValue({ status: 200, headers: { 'content-type': contentType, 'set-cookie': 'evil=1' },
      body: Buffer.from('{"cache":"<script>evil()</script>","html":"evil","redirect":"/api/admin/users"}') });
    const response = await post().expect(200);
    expect(response.body).toEqual({});
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.text).not.toContain('evil');
  });
  it('forwards only our sanitized provider schemas with configured identity', async () => {
    configured();
    await post().expect(200);
    expect(JSON.parse(mockRelay.mock.calls[0][1].body)).toEqual({
      type: 'event', payload: { website: SITE, hostname: 'site.example', language: 'de-DE',
        screen: '1920x1080', url: '/gallery/wedding/[redacted]', title: '', referrer: '' },
    });
    configured('rybbit');
    await post().expect(200);
    expect(mockRelay.mock.calls[1][0]).toBe('https://collector.example/base/api/track');
    expect(JSON.parse(mockRelay.mock.calls[1][1].body)).toEqual({
      site_id: SITE, hostname: 'site.example', pathname: '/gallery/wedding/[redacted]', querystring: '',
      screenWidth: 1920, screenHeight: 1080, language: 'de-DE', page_title: '', referrer: '', type: 'pageview',
    });
  });
  it.each(['umami', 'rybbit'])('reports the site hostname for %s, never the client-supplied one', async provider => {
    configured(provider);
    const sent = () => JSON.parse(mockRelay.mock.calls.at(-1)[1].body);
    const reported = () => (provider === 'umami' ? sent().payload.hostname : sent().hostname);
    await post(buildApp(), { ...EVENT, hostname: 'attacker.example' }).expect(200);
    expect(reported()).toBe('site.example');
    const { hostname: _omitted, ...withoutHostname } = EVENT;
    await post(buildApp(), withoutHostname).expect(200);
    expect(reported()).toBe('site.example');
    // No public origin known: the host this request arrived on.
    mockSiteUrl.mockResolvedValue('');
    await post(buildApp(), { ...EVENT, hostname: 'attacker.example' }).set('Host', 'direct.example').expect(200);
    expect(reported()).toBe('direct.example');
    expect(JSON.stringify(mockRelay.mock.calls)).not.toContain('attacker.example');
  });
  it.each(['umami', 'rybbit'])('preserves gallery events for %s without identifiers/free text', async provider => {
    configured(provider);
    await post(buildApp(), { ...EVENT, type: 'event', name: 'gallery_bulk_download', data: { photo_count: 7, is_download_all: true } }).expect(200);
    const body = JSON.parse(mockRelay.mock.calls[0][1].body);
    const properties = provider === 'umami' ? body.payload.data : JSON.parse(body.properties);
    expect(properties).toEqual({ photo_count: 7, is_download_all: true });
    expect(provider === 'umami' ? body.payload.name : body.event_name).toBe('gallery_bulk_download');
  });
  it('returns only a bounded site-scoped opaque Umami token and reuses it', async () => {
    configured();
    mockRelay.mockResolvedValue({ status: 200, headers: {}, body: Buffer.from(JSON.stringify({ cache: 'header.payload.signature',
      sessionId: 'private-session', visitId: 'private-visit', code: 'evil()' })) });
    const app = buildApp(); const first = await post(app).expect(200);
    expect(first.body).toEqual({ cache: { site: SITE, token: 'header.payload.signature' } });
    await post(app, { ...EVENT, cache: first.body.cache }).expect(200);
    expect(mockRelay.mock.calls[1][1].headers['x-umami-cache']).toBe('header.payload.signature');
    await post(app, { ...EVENT, cache: { ...first.body.cache, site: 'another-site' } }).expect(200);
    expect(mockRelay.mock.calls[2][1].headers['x-umami-cache']).toBeUndefined();
  });
});

describe('input and privacy enforcement on every event', () => {
  beforeEach(() => configured());
  it.each(['/ADMIN/login', '/%61dmin', '//customer/dashboard', '/CUSTOMER', '/s/short',
    '/invite/abc', '/quote/abc', '/contract/signing', '/payment-check/abc', '/transfer/abc',
    '/transfer-upload/abc', '/slideshow/abc', '/gallery/wedding/client-access',
    '/gallery/wedding/show/short', '/gallery/wedding/%73how/%61bc', '/gallery/wedding/SHOW/short',
    '/gallery/wedding/%252fsecret', '/gallery/wedding/%3Fsecret', '/gallery/wedding/%00secret',
    '/gallery/../admin', 'https://elsewhere.example/gallery/wedding/secret', '/unknown/nested'])('rejects excluded/ambiguous path %s', async path => {
    await post(buildApp(), { ...EVENT, path }).expect(400);
    expect(mockRelay).not.toHaveBeenCalled();
  });
  it.each(['/gallery/wedding/abc', '/GALLERY/wedding/%61bc', '/gallery/wedding/a/b',
    '/gallery/wedding/[redacted]'])('structurally redacts %s', async path => {
    await post(buildApp(), { ...EVENT, path }).expect(200);
    expect(JSON.parse(mockRelay.mock.calls[0][1].body).payload.url).toBe('/gallery/wedding/[redacted]');
  });
  it.each([
    { title: 'private title' }, { referrer: '/gallery/wedding/SECRET' }, { query: 'SECRET' },
    { user_id: 'private' }, { website: 'attacker' }, { provider: 'custom' }, { type: 'identify' },
    { type: 'event', name: 'private-password', data: {} },
    { type: 'event', name: 'photo_download', data: { photo_id: 123 } },
    { type: 'event', name: 'photo_download', data: { gallery: 'SECRET' } },
    { type: 'event', name: 'photo_download', data: { success: 'SECRET' } },
    { type: 'event', name: 'photo_download', data: { photo_count: Infinity } },
    { cache: { site: SITE, token: 'evil()' } }, { screenWidth: 10000 }, { hostname: 'user:secret@elsewhere' },
  ])('rejects unexpected or unsafe representation %j', async variant => {
    await post(buildApp(), { ...EVENT, ...variant }).expect(400);
    expect(mockRelay).not.toHaveBeenCalled();
  });
  it.each(['DNT', 'Sec-GPC'])('respects %s independently of the client', async header => {
    await post().set(header, '1').expect(204);
    expect(mockRelay).not.toHaveBeenCalled();
  });
  it('rejects oversized and malformed bodies before any outbound request', async () => {
    await post(buildApp(), { ...EVENT, padding: 'x'.repeat(4096) }).expect(413);
    await request(buildApp()).post('/api/analytics/tracker/events').set('content-type', 'application/json').send('{bad').expect(400);
    expect(mockRelay).not.toHaveBeenCalled();
  });
});

describe('bounded pinned transport and header boundary', () => {
  beforeEach(() => configured());
  it.each([undefined, null, ''])('stays quiet while no collector URL is configured (%p)', async url => {
    settings.analytics_umami_url = url;
    const app = buildApp();
    await post(app).expect(404);
    expect(require('../utils/logger').warn).not.toHaveBeenCalled();
    expect(mockRelay).not.toHaveBeenCalled();
    settings.analytics_umami_url = 'not a URL';
    await post(buildApp()).expect(404);
    expect(require('../utils/logger').warn).toHaveBeenCalledWith('Analytics: invalid collector URL');
  });
  it.each(['http://collector.example', 'file:///tmp/data', 'not a URL'])('rejects %s without dev opt-in', async url => {
    settings.analytics_umami_url = url;
    await post().expect(404); expect(mockRelay).not.toHaveBeenCalled();
  });
  it('accepts explicit HTTP development testing, never production', async () => {
    settings.analytics_umami_url = 'http://localhost:3000';
    process.env.ANALYTICS_ALLOW_INSECURE_HTTP = 'true';
    await post().expect(200);
    process.env.NODE_ENV = 'production';
    await post().expect(404);
    expect(mockRelay).toHaveBeenCalledTimes(1);
  });
  it('strips pasted upstream userinfo/query/fragment while preserving subpaths', async () => {
    settings.analytics_umami_url = 'https://user:secret@collector.example/base/?secret=1#secret';
    await post().expect(200);
    expect(mockRelay.mock.calls[0][0]).toBe('https://collector.example/base/api/send');
  });
  it('keeps actual IP/UA attribution but never app credentials or raw URL headers', async () => {
    await post().set('user-agent', 'Mozilla/5.0').set('cookie', 'admin_token=SECRET')
      .set('authorization', 'Bearer SECRET').set('referer', 'https://picpeak.example/gallery/x/SECRET')
      .set('x-umami-cache', 'SECRET').expect(200);
    const options = mockRelay.mock.calls[0][1];
    expect(options.headers).toEqual({ 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0',
      'x-forwarded-for': expect.any(String), 'x-real-ip': expect.any(String) });
    expect(options.signal).toBeDefined();
    expect(options.maxBytes).toBe(16 * 1024);
    expect(options.allowPrivate).toBe(true);
    expect(options.body.toString()).not.toContain('SECRET');
    process.env.NODE_ENV = 'production';
    await post().expect(200);
    expect(mockRelay.mock.calls[1][1].allowPrivate).toBe(false);
  });
  it('rate limits anonymous forwarding', async () => {
    const app = buildApp();
    for (let i = 0; i < 120; i++) await post(app).expect(200);
    await post(app).expect(429); expect(mockRelay).toHaveBeenCalledTimes(120);
  });
  it.each([302, 401, 500])('does not expose upstream status/body %s', async status => {
    mockRelay.mockResolvedValue({ status, headers: {}, body: Buffer.from('SECRET') });
    const response = await post().expect(502); expect(response.text).not.toContain('SECRET');
  });
  it('turns network/size/timeout failures into an inert failure', async () => {
    mockRelay.mockRejectedValue(new Error('Response too large'));
    await post().expect(502);
  });
});
