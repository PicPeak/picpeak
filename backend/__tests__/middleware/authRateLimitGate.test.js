/**
 * The credential endpoints need a per-IP limit — and nothing else may get one.
 *
 * The five `app.use('/api/auth', authRateLimiter)`-style registrations inside
 * initializeRateLimiters() were inert for the same reason the general limiter
 * was: they run after the routers and the error handler are already mounted.
 * They could not just be moved up, either — `/api/auth` is a prefix, so a
 * 5-per-window budget would have covered GET /api/auth/session and POST
 * /api/auth/password-strength, which the frontend calls far more than five
 * times per window. Moving them as written would have locked users out.
 *
 * So these tests pin both directions: the credential endpoints ARE limited,
 * and the benign high-frequency endpoints under the same prefixes are NOT,
 * even after many times the auth budget. Plus the two properties that make the
 * budget survivable in production — only failures count, and the auth bucket is
 * separate from the general /api bucket.
 *
 * The source half pins registration DEPTH, which is what was broken and which
 * no unit test of the gate itself can catch.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

let mockSettingsRows = [];

jest.mock('../../src/database/db', () => ({
  db: jest.fn(() => ({
    whereIn: jest.fn().mockImplementation(() => Promise.resolve(mockSettingsRows))
  }))
}));

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

const { createAuthRateLimitGate } = require('../../src/middleware/authRateLimitGate');
const { createApiRateLimitGate } = require('../../src/middleware/apiRateLimitGate');
const {
  createAuthRateLimiter,
  createRateLimiter,
  clearSettingsCache
} = require('../../src/services/rateLimitService');

const setting = (key, value) => ({ setting_key: key, setting_value: JSON.stringify(value) });

// Mirrors the real stack: gates above the routers, unmounted so req.path keeps
// its /api prefix. `loginSucceeds` lets a test drive the skipSuccessfulRequests
// behaviour without a database.
let loginSucceeds = false;

function mountRoutes(app) {
  const fail = (res) => res.status(401).json({ error: 'Invalid credentials' });

  // Credential endpoints — the group that must be limited.
  app.post('/api/auth/admin/login', (req, res) =>
    (loginSucceeds ? res.json({ user: {} }) : fail(res)));
  app.post('/api/auth/admin/login/mfa', (req, res) => fail(res));
  app.post('/api/auth/gallery/verify', (req, res) => fail(res));
  app.post('/api/auth/gallery/share-login', (req, res) => fail(res));
  app.post('/api/auth/gallery/:slug/client-login', (req, res) => fail(res));
  app.post('/api/setup/verify-token', (req, res) => fail(res));
  app.post('/api/setup/admin', (req, res) => fail(res));
  app.post('/api/customer/auth/login', (req, res) => fail(res));
  app.post('/api/customer/auth/password-reset', (req, res) => fail(res));

  // Benign endpoints living under the very same prefixes the old registrations
  // covered. Every one of these is called more than five times per window by a
  // normal session.
  app.get('/api/auth/session', (req, res) => res.json({ authenticated: false }));
  app.post('/api/auth/password-strength', (req, res) => res.json({ score: 3 }));
  app.post('/api/auth/logout', (req, res) => res.json({ ok: true }));
  app.post('/api/auth/gallery/logout', (req, res) => res.json({ ok: true }));
  app.post('/api/auth/admin/change-password', (req, res) => res.json({ ok: true }));
  app.get('/api/auth/admin/sso/callback', (req, res) => res.json({ ok: true }));
  app.get('/api/setup/status', (req, res) => res.json({ needsSetup: false }));
  app.get('/api/customer/auth/session', (req, res) => res.json({ ok: true }));
  app.get('/api/gallery/:slug/verify-token/:token', (req, res) => res.json({ valid: true }));
  app.get('/api/public/settings', (req, res) => res.json({ ok: true }));
}

async function buildApp({ withGeneralGate = false } = {}) {
  const app = express();
  if (withGeneralGate) {
    const generalLimiter = await createRateLimiter();
    app.use(createApiRateLimitGate(() => generalLimiter));
  }
  const authLimiter = await createAuthRateLimiter();
  app.use(createAuthRateLimitGate(() => authLimiter));
  app.use(express.json());
  mountRoutes(app);
  return app;
}

beforeEach(() => {
  mockSettingsRows = [];
  loginSucceeds = false;
  clearSettingsCache();
});

describe('authRateLimitGate — credential endpoints are limited', () => {
  it('429s admin login on the 6th failed attempt in the window', async () => {
    const app = await buildApp();
    for (let i = 0; i < 5; i++) {
      expect((await request(app).post('/api/auth/admin/login').send({})).status).toBe(401);
    }
    const blocked = await request(app).post('/api/auth/admin/login').send({});
    expect(blocked.status).toBe(429);
    // Shape the frontend already branches on (AdminLoginPage, GalleryPage,
    // CustomerLoginPage and SetupPage all check status === 429).
    expect(blocked.body.error).toBe('Too many authentication attempts, please try again later.');
    expect(blocked.headers['ratelimit-limit']).toBe('5');
  });

  it.each([
    ['/api/auth/admin/login/mfa'],
    ['/api/auth/gallery/verify'],
    ['/api/auth/gallery/share-login'],
    ['/api/auth/gallery/some-slug/client-login'],
    ['/api/setup/verify-token'],
    ['/api/setup/admin'],
    ['/api/customer/auth/login'],
    ['/api/customer/auth/password-reset']
  ])('429s %s once the budget is spent', async (endpoint) => {
    const app = await buildApp();
    for (let i = 0; i < 5; i++) {
      expect((await request(app).post(endpoint).send({})).status).toBe(401);
    }
    expect((await request(app).post(endpoint).send({})).status).toBe(429);
  });

  it('shares one budget across the credential endpoints, so spraying is bounded', async () => {
    const app = await buildApp();
    const sprayed = [
      '/api/auth/admin/login',
      '/api/auth/gallery/verify',
      '/api/customer/auth/login',
      '/api/setup/verify-token',
      '/api/auth/gallery/share-login'
    ];
    for (const endpoint of sprayed) {
      expect((await request(app).post(endpoint).send({})).status).toBe(401);
    }
    expect((await request(app).post('/api/auth/admin/login').send({})).status).toBe(429);
  });

  it('honours rate_limit_auth_max_requests from app_settings', async () => {
    mockSettingsRows = [setting('rate_limit_auth_max_requests', 2)];
    const app = await buildApp();
    expect((await request(app).post('/api/auth/admin/login').send({})).status).toBe(401);
    expect((await request(app).post('/api/auth/admin/login').send({})).status).toBe(401);
    expect((await request(app).post('/api/auth/admin/login').send({})).status).toBe(429);
  });

  it('does nothing when rate_limit_enabled is false', async () => {
    mockSettingsRows = [setting('rate_limit_enabled', false)];
    const app = await buildApp();
    for (let i = 0; i < 20; i++) {
      expect((await request(app).post('/api/auth/admin/login').send({})).status).toBe(401);
    }
  });

  it('only counts failures, so successful logins never consume the budget', async () => {
    // This is what makes a 5-per-window per-IP budget safe behind NAT: a room
    // of guests on one venue IP who all type the right password count zero.
    const app = await buildApp();
    loginSucceeds = true;
    for (let i = 0; i < 30; i++) {
      expect((await request(app).post('/api/auth/admin/login').send({})).status).toBe(200);
    }
    // The budget is still fully intact for real failures.
    loginSucceeds = false;
    for (let i = 0; i < 5; i++) {
      expect((await request(app).post('/api/auth/admin/login').send({})).status).toBe(401);
    }
    expect((await request(app).post('/api/auth/admin/login').send({})).status).toBe(429);
  });

  it('passes through during the boot window, before the limiter exists', async () => {
    const app = express();
    app.use(createAuthRateLimitGate(() => undefined));
    mountRoutes(app);
    for (let i = 0; i < 10; i++) {
      expect((await request(app).post('/api/auth/admin/login').send({})).status).toBe(401);
    }
  });
});

describe('authRateLimitGate — benign endpoints are never limited', () => {
  // 40 calls each: eight times the 5-per-window auth budget. Every one of these
  // would have been covered by the old app.use('/api/auth', ...) prefix.
  it.each([
    ['GET', '/api/auth/session'],
    ['POST', '/api/auth/password-strength'],
    ['POST', '/api/auth/logout'],
    ['POST', '/api/auth/gallery/logout'],
    ['POST', '/api/auth/admin/change-password'],
    ['GET', '/api/auth/admin/sso/callback'],
    ['GET', '/api/setup/status'],
    ['GET', '/api/customer/auth/session'],
    ['GET', '/api/gallery/some-slug/verify-token/abc']
  ])('%s %s stays available after 40 calls', async (method, endpoint) => {
    const app = await buildApp();
    for (let i = 0; i < 40; i++) {
      const res = await request(app)[method.toLowerCase()](endpoint).send({});
      expect(res.status).toBe(200);
    }
  });

  it('does not treat a GET on a credential path as an attempt', async () => {
    // The table is method-specific: only the POST spends budget.
    const app = await buildApp();
    for (let i = 0; i < 20; i++) {
      // No GET handler is mounted, so a 404 proves the gate let it through
      // rather than answering 429.
      expect((await request(app).get('/api/auth/admin/login')).status).toBe(404);
    }
    expect((await request(app).post('/api/auth/admin/login').send({})).status).toBe(401);
  });

  it('matches case-insensitively, since Express routing is case-insensitive', async () => {
    const app = await buildApp();
    for (let i = 0; i < 5; i++) {
      expect((await request(app).post('/api/auth/admin/LOGIN').send({})).status).toBe(401);
    }
    expect((await request(app).post('/api/auth/admin/login').send({})).status).toBe(429);
  });
});

describe('authRateLimitGate — its bucket is independent of the general /api bucket', () => {
  it('an exhausted general budget still leaves the login budget intact', async () => {
    mockSettingsRows = [
      setting('rate_limit_max_requests', 3),
      setting('rate_limit_auth_max_requests', 5)
    ];
    const app = await buildApp({ withGeneralGate: true });

    for (let i = 0; i < 3; i++) {
      expect((await request(app).get('/api/public/settings')).status).toBe(200);
    }
    expect((await request(app).get('/api/public/settings')).status).toBe(429);

    // The exact failure the old wiring would have produced: the branding and
    // settings fetches a login page makes before anyone types a password
    // 429ing the login itself. Separate stores mean it cannot happen.
    expect((await request(app).post('/api/auth/admin/login').send({})).status).toBe(401);
  });

  it('an exhausted login budget still leaves the general budget intact', async () => {
    mockSettingsRows = [
      setting('rate_limit_max_requests', 3),
      setting('rate_limit_auth_max_requests', 5)
    ];
    const app = await buildApp({ withGeneralGate: true });

    for (let i = 0; i < 5; i++) {
      expect((await request(app).post('/api/auth/admin/login').send({})).status).toBe(401);
    }
    expect((await request(app).post('/api/auth/admin/login').send({})).status).toBe(429);

    for (let i = 0; i < 3; i++) {
      expect((await request(app).get('/api/public/settings')).status).toBe(200);
    }
  });
});

describe('server.js — the auth gate is registered above the routers', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../server.js'), 'utf8');
  const lines = source.split('\n');
  const lineOf = (re) => {
    const i = lines.findIndex((l) => re.test(l));
    expect(i).toBeGreaterThan(-1);
    return i;
  };

  it('registers the gate before the first router mount', () => {
    expect(lineOf(/createAuthRateLimitGate\(/))
      .toBeLessThan(lineOf(/^app\.use\('\/api\/setup'/));
  });

  it('registers the gate unmounted, so req.path keeps its /api prefix', () => {
    expect(source).toMatch(/app\.use\(createAuthRateLimitGate\(/);
  });

  it('no longer registers authRateLimiter on a prefix from initializeRateLimiters', () => {
    // This is the regression: an app.use() there runs after the error handler
    // and can never see a request — and '/api/auth' as a prefix would have
    // covered GET /api/auth/session at the 5-per-window auth budget.
    expect(source).not.toMatch(/app\.use\('\/api\/auth',\s*authRateLimiter\)/);
    expect(source).not.toMatch(/app\.use\('[^']*',\s*authRateLimiter\)/);
  });
});
