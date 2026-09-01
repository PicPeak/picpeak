/**
 * The app-wide /api rate limiter has to actually be on the stack.
 *
 * It used to be registered from inside initializeRateLimiters(), which runs
 * after the database is up — by which time every router, the /api 404 handler
 * and the error handler are already mounted. Express dispatches middleware in
 * registration order, so `app.use('/api/', generalRateLimiter)` landed below
 * everything that answers a request and never executed for a matched route:
 * the limit was silently inert on every deployment.
 *
 * Two halves here. The behavioural half pins what the gate delegates and what
 * it deliberately lets past. The source half pins the thing that was actually
 * broken — registration DEPTH — because that only exists in server.js and no
 * unit test of the gate itself can catch a regression of it.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const { createApiRateLimitGate } = require('../../src/middleware/apiRateLimitGate');

describe('apiRateLimitGate — delegation', () => {
  let limiterCalls;
  let limiter;

  // Mirrors the real stack: health above the gate, gate above the routers.
  const buildApp = () => {
    const app = express();
    app.get(['/health', '/api/health'], (req, res) => res.json({ status: 'ok' }));
    app.use(createApiRateLimitGate(() => limiter));
    app.get('/api/admin/events', (req, res) => res.json({ ok: true }));
    app.get('/api/public/transfer-upload/:token', (req, res) => res.json({ ok: true }));
    app.post('/api/admin/auth/login', (req, res) => res.json({ ok: true }));
    app.get('/api/gallery/:slug/verify', (req, res) => res.json({ ok: true }));
    app.get('/photos/x.jpg', (req, res) => res.json({ ok: true }));
    return app;
  };

  beforeEach(() => {
    limiterCalls = [];
    limiter = (req, res) => {
      limiterCalls.push(req.path);
      res.status(429).json({ error: 'Too many requests, please try again later.' });
    };
  });

  it('sends a plain /api request through the limiter', async () => {
    const res = await request(buildApp()).get('/api/admin/events');
    expect(res.status).toBe(429);
    // The full path reaches the limiter — the gate must not be mounted on
    // '/api', or Express would strip the prefix and break the limiter's own
    // public-endpoint and gallery-slug checks.
    expect(limiterCalls).toEqual(['/api/admin/events']);
  });

  it('leaves non-/api requests alone', async () => {
    const res = await request(buildApp()).get('/photos/x.jpg');
    expect(res.status).toBe(200);
    expect(limiterCalls).toEqual([]);
  });

  it('never counts the health probes, which poll every few seconds', async () => {
    const app = buildApp();
    expect((await request(app).get('/health')).status).toBe(200);
    expect((await request(app).get('/api/health')).status).toBe(200);
    expect(limiterCalls).toEqual([]);
  });

  it('exempts bulk client transfer, which has its own per-minute limiters', async () => {
    const res = await request(buildApp()).get('/api/public/transfer-upload/abc');
    expect(res.status).toBe(200);
    expect(limiterCalls).toEqual([]);
  });

  it('exempts login and gallery-verify, which would 429 on the shared bucket', async () => {
    const app = buildApp();
    expect((await request(app).post('/api/admin/auth/login')).status).toBe(200);
    expect((await request(app).get('/api/gallery/some-slug/verify')).status).toBe(200);
    expect(limiterCalls).toEqual([]);
  });

  it('passes through during the boot window, before the limiter exists', async () => {
    limiter = undefined;
    const res = await request(buildApp()).get('/api/admin/events');
    expect(res.status).toBe(200);
  });
});

describe('server.js — the gate is registered above the routers', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../server.js'), 'utf8');
  const lines = source.split('\n');
  const lineOf = (re) => {
    const i = lines.findIndex((l) => re.test(l));
    expect(i).toBeGreaterThan(-1);
    return i;
  };

  it('registers the gate before the first router mount', () => {
    expect(lineOf(/createApiRateLimitGate\(/))
      .toBeLessThan(lineOf(/^app\.use\('\/api\/setup'/));
  });

  it('registers the health routes above the gate so probes are never counted', () => {
    expect(lineOf(/app\.get\(\[.\/health., .\/api\/health.\]/))
      .toBeLessThan(lineOf(/createApiRateLimitGate\(/));
  });

  it('no longer registers the general limiter from initializeRateLimiters', () => {
    // This is the regression: an app.use() there runs after the error handler
    // and can never see a request.
    expect(source).not.toMatch(/app\.use\('\/api\/?',\s*generalRateLimiter\)/);
  });

  it('registers the gate unmounted, so req.path keeps its /api prefix', () => {
    expect(source).toMatch(/app\.use\(createApiRateLimitGate\(/);
  });
});
