// Real sockets verify the mandatory per-connection DNS policy and the closed
// collector protocol. HTTPS trusts only this disposable fixture certificate.
const express = require('express');
const http = require('http');
const https = require('https');
const dns = require('dns').promises;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const request = require('supertest');
const settings = {};
jest.mock('../../src/utils/appSettings', () => ({
  getAppSetting: async (key, fallback = null) => Object.hasOwn(settings, key) ? settings[key] : fallback,
}));
jest.mock('../../src/utils/logger', () => ({ warn: jest.fn(), debug: jest.fn() }));
const EVENT = { type: 'pageview', path: '/gallery/wedding/short?token=SECRET', hostname: 'picpeak.example',
  language: 'en', screenWidth: 1280, screenHeight: 800 };
const LOOPBACK = [{ address: '127.0.0.1', family: 4 }];
const originalEnv = { NODE_ENV: process.env.NODE_ENV, INTEGRATION_PRIVATE_ORIGINS: process.env.INTEGRATION_PRIVATE_ORIGINS,
  ANALYTICS_ALLOW_INSECURE_HTTP: process.env.ANALYTICS_ALLOW_INSECURE_HTTP };
let tlsServer; let plainServer; let port; let plainPort; let directory; let cert; let hits = [];
const sockets = new Set();
function handler(req, res) {
  const hit = { url: req.url, method: req.method, headers: req.headers, body: '' };
  hits.push(hit);
  req.on('data', chunk => { hit.body += chunk; });
  req.on('end', () => {
    if (req.url.startsWith('/redirect/')) { res.writeHead(302, { location: '/trap' }); res.end(); return; }
    if (req.url.startsWith('/large/')) { res.writeHead(200); res.end(Buffer.alloc(16 * 1024 + 1)); return; }
    if (req.url.startsWith('/slow/')) return; // timeout must destroy the socket
    res.writeHead(200, { 'content-type': 'application/javascript', 'set-cookie': 'evil=1' });
    res.end('fetch("/api/admin/users", {credentials:"include"})');
  });
}
function buildApp() {
  jest.resetModules();
  const app = express();
  app.use('/api/analytics/tracker', require('../../src/routes/analyticsTrackerProxy'));
  return app;
}
function post(app = buildApp()) { return request(app).post('/api/analytics/tracker/events').set('user-agent', 'Mozilla/5.0').send(EVENT); }
beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-analytics-tls-'));
  const key = path.join(directory, 'key.pem'); const certificate = path.join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-keyout', key, '-out', certificate, '-subj', '/CN=tracker.example',
    '-addext', 'subjectAltName=DNS:tracker.example'], { stdio: 'ignore' });
  cert = fs.readFileSync(certificate);
  tlsServer = https.createServer({ key: fs.readFileSync(key), cert }, handler);
  plainServer = http.createServer(handler);
  for (const server of [tlsServer, plainServer]) {
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  }
  port = tlsServer.address().port; plainPort = plainServer.address().port;
});
afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  for (const server of [tlsServer, plainServer]) if (server) await new Promise(resolve => server.close(resolve));
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});
beforeEach(() => {
  hits = []; for (const key of Object.keys(settings)) delete settings[key];
  process.env.NODE_ENV = 'production'; delete process.env.INTEGRATION_PRIVATE_ORIGINS; delete process.env.ANALYTICS_ALLOW_INSECURE_HTTP;
  settings.analytics_tracker_provider = 'umami';
  settings.analytics_umami_url = 'https://tracker.example:' + port;
  settings.analytics_umami_website_id = '11111111-1111-4111-8111-111111111111';
  jest.spyOn(dns, 'lookup').mockResolvedValue(LOOPBACK);
  const nativeRequest = https.request;
  jest.spyOn(https, 'request').mockImplementation((url, options, callback) => nativeRequest(url, { ...options, ca: cert }, callback));
});
afterEach(() => {
  jest.restoreAllMocks();
  for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
it('refuses a private DNS answer at socket creation, before reaching the server', async () => {
  await post().expect(502);
  expect(dns.lookup).toHaveBeenCalledTimes(1); expect(hits).toHaveLength(0);
});
it('refuses a mixed public/private answer set rather than choosing a public result', async () => {
  dns.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }, ...LOOPBACK]);
  await post().expect(502); expect(hits).toHaveLength(0);
});
it('supports an explicitly approved internal HTTPS collector without a conflicting preflight', async () => {
  process.env.INTEGRATION_PRIVATE_ORIGINS = settings.analytics_umami_url;
  const response = await post().set('cookie', 'admin_token=SECRET').set('authorization', 'Bearer SECRET')
    .set('referer', 'https://picpeak.example/gallery/wedding/SECRET').expect(200);
  expect(response.body).toEqual({}); expect(response.headers['set-cookie']).toBeUndefined();
  expect(hits).toHaveLength(1);
  expect(hits[0].headers.host).toBe('tracker.example:' + port);
  expect(hits[0].headers.cookie).toBeUndefined(); expect(hits[0].headers.authorization).toBeUndefined();
  expect(hits[0].headers.referer).toBeUndefined(); expect(hits[0].headers['user-agent']).toBe('Mozilla/5.0');
  expect(JSON.parse(hits[0].body).payload.url).toBe('/gallery/wedding/[redacted]');
  expect(hits[0].body).not.toContain('SECRET');
});
it('rechecks policy on every connection even while configuration is cached', async () => {
  process.env.INTEGRATION_PRIVATE_ORIGINS = settings.analytics_umami_url;
  const app = buildApp(); await post(app).expect(200);
  delete process.env.INTEGRATION_PRIVATE_ORIGINS;
  await post(app).expect(502);
  expect(dns.lookup).toHaveBeenCalledTimes(2); expect(hits).toHaveLength(1);
});
it('never follows redirects or returns their target content', async () => {
  process.env.INTEGRATION_PRIVATE_ORIGINS = settings.analytics_umami_url;
  settings.analytics_umami_url += '/redirect';
  await post().expect(502); expect(hits.map(hit => hit.url)).toEqual(['/redirect/api/send']);
});
it('rejects an oversized upstream body', async () => {
  process.env.INTEGRATION_PRIVATE_ORIGINS = settings.analytics_umami_url;
  settings.analytics_umami_url += '/large'; await post().expect(502);
});
it('keeps the deadline armed while waiting for an upstream response', async () => {
  process.env.INTEGRATION_PRIVATE_ORIGINS = settings.analytics_umami_url;
  settings.analytics_umami_url += '/slow';
  const start = Date.now(); await post().expect(502); expect(Date.now() - start).toBeLessThan(7000);
});
it('permits explicit HTTP testing only on a non-production backend', async () => {
  settings.analytics_umami_url = 'http://tracker.example:' + plainPort;
  process.env.NODE_ENV = 'test';
  await post().expect(404); expect(hits).toHaveLength(0);
  process.env.ANALYTICS_ALLOW_INSECURE_HTTP = 'true';
  await post().expect(200); expect(hits).toHaveLength(1);
  process.env.NODE_ENV = 'production';
  await post().expect(404); expect(hits).toHaveLength(1);
});
