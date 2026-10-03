/**
 * The analytics tracker proxy must connect only to addresses that passed the
 * private/internal check — at connection time, for every request.
 *
 * Before this, the hostname was vetted once when the config was (re)loaded
 * and native fetch resolved it again for the socket, so a tracker host whose
 * DNS flipped to a private address between the two (rebinding) gave any
 * anonymous visitor a bounded read of internal HTTP endpoints for up to the
 * config TTL. The proxy now routes through integrationHttp, whose lookup
 * validates every DNS answer inside the socket connect and passes only vetted
 * addresses on.
 *
 * Real local HTTP servers stand in for the "internal" target; the resolver is
 * mocked at both APIs (dns.promises.lookup for the pinned lookup and the
 * preflight, dns.lookup for whatever an unpinned connector would use).
 */

const express = require('express');
const http = require('http');
const dns = require('dns');
const dnsPromises = require('dns').promises;
const request = require('supertest');

const settings = {};

jest.mock('../../src/utils/appSettings', () => ({
  getAppSetting: jest.fn(async (key, defaultValue = null) => (
    Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : defaultValue
  )),
}));

jest.mock('../../src/utils/logger', () => ({
  warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn(),
}));

function buildApp() {
  // Fresh require per test: the route memoises the resolved upstream for 30s.
  jest.resetModules();
  const app = express();
  app.use('/api/analytics/tracker', require('../../src/routes/analyticsTrackerProxy'));
  return app;
}

const PUBLIC = [{ address: '8.8.8.8', family: 4 }];
const LOOPBACK = [{ address: '127.0.0.1', family: 4 }];

// Answer every resolver API from `answers`, consumed in order (the last one
// repeats). Covers the callback API with and without `all`.
function mockResolver(answers) {
  let i = 0;
  const next = () => answers[Math.min(i++, answers.length - 1)];
  jest.spyOn(dnsPromises, 'lookup').mockImplementation(async () => next());
  jest.spyOn(dns, 'lookup').mockImplementation((hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    const records = next();
    if (options && options.all) return callback(null, records);
    return callback(null, records[0].address, records[0].family);
  });
}

let server; let hits; let port;
const originalEnv = process.env.NODE_ENV;
const originalOrigins = process.env.INTEGRATION_PRIVATE_ORIGINS;

beforeAll(async () => {
  hits = [];
  server = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url, host: req.headers.host, body: '' });
    const hit = hits[hits.length - 1];
    req.on('data', (part) => { hit.body += part; });
    req.on('end', () => {
      if (req.url === '/redirect/script.js') { res.writeHead(302, { Location: '/trap' }); res.end(); return; }
      if (req.url === '/large/script.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end(Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));
        return;
      }
      if (req.url === '/api/send') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('cache-token'); return; }
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end('/* tracker */');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  ({ port } = server.address());
});

afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

beforeEach(() => {
  for (const key of Object.keys(settings)) delete settings[key];
  hits.length = 0;
  delete process.env.INTEGRATION_PRIVATE_ORIGINS;
});

afterEach(() => {
  jest.restoreAllMocks();
  process.env.NODE_ENV = originalEnv;
  if (originalOrigins === undefined) delete process.env.INTEGRATION_PRIVATE_ORIGINS;
  else process.env.INTEGRATION_PRIVATE_ORIGINS = originalOrigins;
});

describe('analytics tracker proxy — connection pinning (production)', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    settings.analytics_tracker_provider = 'umami';
    settings.analytics_umami_url = `http://tracker.example:${port}`;
  });

  it('refuses to connect when the host rebinds to a private address after the preflight', async () => {
    // Preflight sees a public answer; the connection-time lookup sees loopback.
    mockResolver([PUBLIC, LOOPBACK]);

    await request(buildApp()).get('/api/analytics/tracker/script.js').expect(502);

    expect(hits).toHaveLength(0);
    expect(dnsPromises.lookup).toHaveBeenCalledTimes(2);
  });

  it('refuses a mixed answer set where one record is private', async () => {
    mockResolver([PUBLIC, [...PUBLIC, ...LOOPBACK]]);

    await request(buildApp()).get('/api/analytics/tracker/script.js').expect(502);
    expect(hits).toHaveLength(0);
  });

  it('re-validates on every request, not only when the config is loaded', async () => {
    const app = buildApp();
    mockResolver([PUBLIC, LOOPBACK]);

    await request(app).get('/api/analytics/tracker/script.js').expect(502);
    expect(dnsPromises.lookup).toHaveBeenCalledTimes(2); // preflight + connection

    await request(app).get('/api/analytics/tracker/script.js').expect(502);
    // The config is cached (no second preflight) but the connection-time
    // lookup ran again, so a flip after the first request is still caught.
    expect(dnsPromises.lookup).toHaveBeenCalledTimes(3);
    expect(hits).toHaveLength(0);
  });

  it('connects to an approved private origin, keeping the configured Host header', async () => {
    // INTEGRATION_PRIVATE_ORIGINS is the operator's explicit approval for a
    // self-hosted tracker, honoured by the connection-time policy. The config
    // preflight (isHostAllowed) is a plain private check that does not read
    // the allowlist, so give it a public answer and let the pinned connection
    // decide what the socket may reach.
    process.env.INTEGRATION_PRIVATE_ORIGINS = `http://tracker.example:${port}`;
    mockResolver([PUBLIC, LOOPBACK]);

    const res = await request(buildApp()).get('/api/analytics/tracker/script.js').expect(200);

    expect(res.text).toBe('/* tracker */');
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(hits).toHaveLength(1);
    expect(hits[0].host).toBe(`tracker.example:${port}`);
  });
});

describe('analytics tracker proxy — relay behaviour over the pinned connection', () => {
  beforeEach(() => {
    // Outside production a localhost tracker is allowed (dev parity), which is
    // what lets these run against the local server without an allowlist.
    process.env.NODE_ENV = 'test';
    settings.analytics_tracker_provider = 'umami';
    mockResolver([LOOPBACK]);
  });

  it('serves a dev tracker on localhost without an allowlist entry', async () => {
    settings.analytics_umami_url = `http://localhost:${port}`;
    const res = await request(buildApp()).get('/api/analytics/tracker/script.js').expect(200);
    expect(res.text).toBe('/* tracker */');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('never follows an upstream redirect', async () => {
    settings.analytics_umami_url = `http://localhost:${port}/redirect`;
    await request(buildApp()).get('/api/analytics/tracker/script.js').expect(502);
    expect(hits.map((h) => h.url)).toEqual(['/redirect/script.js']);
  });

  it('502s rather than relaying a body over the size cap', async () => {
    settings.analytics_umami_url = `http://localhost:${port}/large`;
    await request(buildApp()).get('/api/analytics/tracker/script.js').expect(502);
  });

  it('relays the beacon POST body and the fixed header set', async () => {
    settings.analytics_umami_url = `http://localhost:${port}`;
    const res = await request(buildApp())
      .post('/api/analytics/tracker/api/send')
      .set('content-type', 'application/json')
      .set('user-agent', 'Mozilla/5.0 (test)')
      .set('cookie', 'picpeak_admin_token=secret')
      .send({ type: 'event' })
      .expect(200);

    expect(res.text).toBe('cache-token');
    expect(hits).toHaveLength(1);
    expect(hits[0].method).toBe('POST');
    expect(hits[0].body).toBe(JSON.stringify({ type: 'event' }));
  });
});
