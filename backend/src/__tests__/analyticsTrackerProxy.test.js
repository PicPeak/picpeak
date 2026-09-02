/**
 * Contract tests for the same-origin analytics-tracker proxy.
 *
 * The proxy exists so an admin-configured self-hosted Umami/Rybbit instance
 * actually loads under the shipped `script-src 'self'` / `connect-src 'self'`
 * CSP without anyone hand-editing nginx.conf. Because the upstream base URL
 * comes from an admin-editable setting, most of what is pinned here is the
 * SSRF/abuse boundary rather than the happy path: which paths are reachable,
 * which headers cross the boundary, and what a hostile upstream can make the
 * browser see.
 */

const express = require('express');
const request = require('supertest');

const settings = {};

jest.mock('../utils/appSettings', () => ({
  getAppSetting: jest.fn(async (key, defaultValue = null) => (
    Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : defaultValue
  )),
}));

const mockIsHostAllowed = jest.fn(async () => true);
jest.mock('../utils/networkValidation', () => ({ isHostAllowed: (...a) => mockIsHostAllowed(...a) }));

jest.mock('../utils/logger', () => ({
  warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn(),
}));

function buildApp() {
  // Fresh require per test: the route memoises the resolved upstream for 30s.
  jest.resetModules();
  const app = express();
  app.use('/api/analytics/tracker', require('../routes/analyticsTrackerProxy'));
  return app;
}

function upstreamReply(body, { status = 200, contentType = 'text/javascript', headers = {} } = {}) {
  return new Response(body, { status, headers: { 'content-type': contentType, ...headers } });
}

let fetchMock;

beforeEach(() => {
  for (const key of Object.keys(settings)) delete settings[key];
  mockIsHostAllowed.mockClear();
  mockIsHostAllowed.mockResolvedValue(true);
  fetchMock = jest.fn(async () => upstreamReply('/* tracker */'));
  global.fetch = fetchMock;
});

describe('analytics tracker proxy — reachability', () => {
  it('404s when no tracker provider is configured', async () => {
    await request(buildApp()).get('/api/analytics/tracker/script.js').expect(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('404s when the provider is set but has no URL', async () => {
    settings.analytics_tracker_provider = 'umami';
    await request(buildApp()).get('/api/analytics/tracker/script.js').expect(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serves Umami from the configured instance', async () => {
    settings.analytics_tracker_provider = 'umami';
    settings.analytics_umami_url = 'https://umami.example.com';

    const res = await request(buildApp()).get('/api/analytics/tracker/script.js').expect(200);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://umami.example.com/script.js');
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.text).toBe('/* tracker */');
  });

  it('honours a legacy umami_enabled install with no explicit provider', async () => {
    settings.analytics_umami_enabled = true;
    settings.analytics_umami_url = 'https://umami.example.com';

    await request(buildApp()).get('/api/analytics/tracker/script.js').expect(200);
    expect(fetchMock.mock.calls[0][0]).toBe('https://umami.example.com/script.js');
  });

  it('maps Rybbit paths onto the upstream /api prefix', async () => {
    settings.analytics_tracker_provider = 'rybbit';
    settings.analytics_rybbit_url = 'https://rybbit.example.com/';
    const app = buildApp();

    await request(app).get('/api/analytics/tracker/script.js').expect(200);
    expect(fetchMock.mock.calls[0][0]).toBe('https://rybbit.example.com/api/script.js');

    // mockImplementation, not mockResolvedValue: a Response body is a stream
    // and can only be consumed once, so each call needs a fresh one.
    fetchMock.mockImplementation(async () => upstreamReply('{}', { contentType: 'application/json' }));
    await request(app)
      .post('/api/analytics/tracker/track')
      .set('content-type', 'application/json')
      .send({ type: 'pageview' })
      .expect(200);
    expect(fetchMock.mock.calls[1][0]).toBe('https://rybbit.example.com/api/track');

    await request(app).get('/api/analytics/tracker/site/tracking-config/abc-123').expect(200);
    expect(fetchMock.mock.calls[2][0])
      .toBe('https://rybbit.example.com/api/site/tracking-config/abc-123');
  });

  it('preserves a sub-path in the configured URL', async () => {
    settings.analytics_tracker_provider = 'umami';
    settings.analytics_umami_url = 'https://example.com/umami/';

    await request(buildApp()).get('/api/analytics/tracker/script.js').expect(200);
    expect(fetchMock.mock.calls[0][0]).toBe('https://example.com/umami/script.js');
  });
});

describe('analytics tracker proxy — path allowlist', () => {
  beforeEach(() => {
    settings.analytics_tracker_provider = 'umami';
    settings.analytics_umami_url = 'https://umami.example.com';
  });

  it.each([
    ['/api/analytics/tracker/track'],
    ['/api/analytics/tracker/api/auth/login'],
    ['/api/analytics/tracker/site/tracking-config/abc'],
    ['/api/analytics/tracker/'],
    ['/api/analytics/tracker/script.js/../../secret'],
    ['/api/analytics/tracker/%2e%2e/%2e%2e/secret'],
    ['/api/analytics/tracker/index.html'],
  ])('404s on a path outside the provider allowlist: %s', async (path) => {
    await request(buildApp()).get(path).expect(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('404s when the method does not match the allowlisted path', async () => {
    // /api/send is POST-only; a GET must not be relayed.
    await request(buildApp()).get('/api/analytics/tracker/api/send').expect(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('relays the Umami beacon POST', async () => {
    fetchMock.mockResolvedValue(upstreamReply('cache-token', { contentType: 'text/plain' }));

    const res = await request(buildApp())
      .post('/api/analytics/tracker/api/send')
      .set('content-type', 'application/json')
      .send({ type: 'event' })
      .expect(200);

    expect(fetchMock.mock.calls[0][0]).toBe('https://umami.example.com/api/send');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(fetchMock.mock.calls[0][1].body.toString()).toBe(JSON.stringify({ type: 'event' }));
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('analytics tracker proxy — SSRF boundary', () => {
  it('refuses a non-HTTP tracker URL', async () => {
    settings.analytics_tracker_provider = 'umami';
    settings.analytics_umami_url = 'file:///etc/passwd';

    await request(buildApp()).get('/api/analytics/tracker/script.js').expect(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an unparseable tracker URL', async () => {
    settings.analytics_tracker_provider = 'umami';
    settings.analytics_umami_url = 'not a url';

    await request(buildApp()).get('/api/analytics/tracker/script.js').expect(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a private/internal host in production', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    mockIsHostAllowed.mockResolvedValue(false);
    settings.analytics_tracker_provider = 'umami';
    settings.analytics_umami_url = 'http://169.254.169.254';

    try {
      await request(buildApp()).get('/api/analytics/tracker/script.js').expect(404);
      expect(mockIsHostAllowed).toHaveBeenCalledWith('169.254.169.254');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('allows a localhost tracker outside production (dev parity with s3Storage)', async () => {
    settings.analytics_tracker_provider = 'umami';
    settings.analytics_umami_url = 'http://localhost:3000';

    await request(buildApp()).get('/api/analytics/tracker/script.js').expect(200);
    expect(mockIsHostAllowed).not.toHaveBeenCalled();
  });

  it('strips credentials, query and fragment from the configured URL', async () => {
    settings.analytics_tracker_provider = 'umami';
    settings.analytics_umami_url = 'https://user:secret@umami.example.com/?a=1#frag';

    await request(buildApp()).get('/api/analytics/tracker/script.js').expect(200);
    expect(fetchMock.mock.calls[0][0]).toBe('https://umami.example.com/script.js');
  });

  it('never follows an upstream redirect', async () => {
    settings.analytics_tracker_provider = 'umami';
    settings.analytics_umami_url = 'https://umami.example.com';

    await request(buildApp()).get('/api/analytics/tracker/script.js').expect(200);
    expect(fetchMock.mock.calls[0][1].redirect).toBe('error');
    expect(fetchMock.mock.calls[0][1].signal).toBeDefined();
  });

  it('rate-limits an unauthenticated client hammering the beacon', async () => {
    settings.analytics_tracker_provider = 'umami';
    settings.analytics_umami_url = 'https://umami.example.com';
    fetchMock.mockImplementation(async () => upstreamReply('ok', { contentType: 'text/plain' }));
    const app = buildApp();

    for (let i = 0; i < 120; i += 1) {
      await request(app).get('/api/analytics/tracker/script.js').expect(200);
    }
    await request(app).get('/api/analytics/tracker/script.js').expect(429);
    expect(fetchMock).toHaveBeenCalledTimes(120);
  });

  it('502s when the upstream request fails', async () => {
    settings.analytics_tracker_provider = 'umami';
    settings.analytics_umami_url = 'https://umami.example.com';
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await request(buildApp()).get('/api/analytics/tracker/script.js').expect(502);
  });

  it('502s rather than relaying an oversized upstream body', async () => {
    settings.analytics_tracker_provider = 'umami';
    settings.analytics_umami_url = 'https://umami.example.com';
    fetchMock.mockResolvedValue(upstreamReply('x', {
      headers: { 'content-length': String(50 * 1024 * 1024) },
    }));

    await request(buildApp()).get('/api/analytics/tracker/script.js').expect(502);
  });
});

describe('analytics tracker proxy — header and content-type handling', () => {
  beforeEach(() => {
    settings.analytics_tracker_provider = 'umami';
    settings.analytics_umami_url = 'https://umami.example.com';
  });

  it('forwards the visitor IP and user agent, but not credentials', async () => {
    await request(buildApp())
      .get('/api/analytics/tracker/script.js')
      .set('user-agent', 'Mozilla/5.0 (test)')
      .set('accept-language', 'de-DE')
      .set('cookie', 'picpeak_admin_token=secret')
      .set('authorization', 'Bearer secret')
      .set('referer', 'https://picpeak.example/gallery/wedding/SHARETOKEN')
      .expect(200);

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['user-agent']).toBe('Mozilla/5.0 (test)');
    expect(headers['accept-language']).toBe('de-DE');
    // req.ip on a supertest connection is loopback — the point is that the
    // client IP is forwarded at all, so the tracker keeps attributing visits.
    expect(headers['x-forwarded-for']).toBeTruthy();
    expect(headers['x-real-ip']).toBe(headers['x-forwarded-for']);
    expect(Object.keys(headers).map((k) => k.toLowerCase()))
      .toEqual(expect.not.arrayContaining(['cookie', 'authorization', 'referer', 'host']));
  });

  it('neutralises an HTML response from a hostile tracker host', async () => {
    // Without this a tracker host could serve `<script>` HTML through
    // PicPeak's own origin and get it rendered as same-origin content.
    fetchMock.mockResolvedValue(upstreamReply('<html><body>xss</body></html>', {
      contentType: 'text/html',
    }));

    const res = await request(buildApp()).get('/api/analytics/tracker/script.js').expect(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('passes the upstream status through', async () => {
    fetchMock.mockResolvedValue(upstreamReply('nope', { status: 404, contentType: 'text/plain' }));
    await request(buildApp()).get('/api/analytics/tracker/script.js').expect(404);
  });
});
