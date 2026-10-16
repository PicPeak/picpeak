/**
 * Both app-wide limiters keyed on the raw req.ip. For IPv4 that is one client;
 * for IPv6 it is not — a single host is routinely handed a whole /64, so an
 * attacker can present a fresh address per request and never spend a budget.
 * The 5-failed-logins limit was therefore unlimited for anyone on IPv6.
 *
 * These tests pin the key to the /64 for IPv6 while leaving IPv4 untouched,
 * and drive the real limiters to show the bypass is closed.
 */
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

const { rateLimitKey } = require('../../src/utils/rateLimitKey');
const { createAuthRateLimitGate } = require('../../src/middleware/authRateLimitGate');
const { createApiRateLimitGate } = require('../../src/middleware/apiRateLimitGate');
const {
  createAuthRateLimiter,
  createRateLimiter,
  clearSettingsCache
} = require('../../src/services/rateLimitService');

const setting = (key, value) => ({ setting_key: key, setting_value: JSON.stringify(value) });

describe('rateLimitKey', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['2001:db8:1:2:aaaa:bbbb:cccc:dddd', '2001:db8:1:2::/64'],
    ['2001:db8:1:2::1', '2001:db8:1:2::/64'],
    ['2001:0db8:0001:0002:0000:0000:0000:0001', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    // IPv4-mapped, dotted and hex: the same client as the plain IPv4 address.
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['::ffff:cb00:7107', '203.0.113.7'],
    // Deprecated IPv4-compatible form, dotted only — ::1 above stays loopback.
    ['::203.0.113.7', '203.0.113.7'],
    ['0:0:0:0:0:0:203.0.113.7', '203.0.113.7'],
    // URI form a proxy may forward: brackets, optionally a port.
    ['[2001:db8:1:2::1]', '2001:db8:1:2::/64'],
    ['[2001:db8:1:2:aaaa::1]:443', '2001:db8:1:2::/64'],
    ['[::ffff:203.0.113.7]', '203.0.113.7'],
  ])('%s → %s', (ip, key) => {
    expect(rateLimitKey({ ip })).toBe(key);
  });

  it('puts two hosts in the same /64 in one bucket and neighbours in another', () => {
    expect(rateLimitKey({ ip: '2001:db8:1:2::1' })).toBe(rateLimitKey({ ip: '2001:db8:1:2:ffff:ffff:ffff:ffff' }));
    expect(rateLimitKey({ ip: '2001:db8:1:2::1' })).not.toBe(rateLimitKey({ ip: '2001:db8:1:3::1' }));
  });

  it('falls back to the raw value for anything it cannot parse', () => {
    expect(rateLimitKey({ ip: 'not-an-ip' })).toBe('not-an-ip');
    expect(rateLimitKey({ ip: undefined })).toBe('');
    expect(rateLimitKey({})).toBe('');
    expect(rateLimitKey({ ip: '[not-an-ip]' })).toBe('[not-an-ip]');
  });
});

// trust proxy on, so X-Forwarded-For drives req.ip the way nginx does in production.
async function buildApp() {
  const app = express();
  app.set('trust proxy', true);
  const generalLimiter = await createRateLimiter();
  app.use(createApiRateLimitGate(() => generalLimiter));
  const authLimiter = await createAuthRateLimiter();
  app.use(createAuthRateLimitGate(() => authLimiter));
  app.post('/api/auth/admin/login', (req, res) => res.status(401).json({ error: 'Invalid credentials' }));
  app.get('/api/public/settings', (req, res) => res.json({ ok: true }));
  return app;
}

const login = (app, ip) => request(app).post('/api/auth/admin/login').set('X-Forwarded-For', ip).send({});

beforeEach(() => {
  mockSettingsRows = [];
  clearSettingsCache();
});

describe('limiters count an IPv6 /64 as one client', () => {
  it('429s the 6th failed login even when every attempt comes from a fresh address in the /64', async () => {
    const app = await buildApp();
    for (let i = 1; i <= 5; i++) {
      expect((await login(app, `2001:db8:1:2::${i.toString(16)}`)).status).toBe(401);
    }
    expect((await login(app, '2001:db8:1:2:dead:beef:0:1')).status).toBe(429);
  });

  it('collapses a bracketed X-Forwarded-For address to the same /64', async () => {
    const app = await buildApp();
    for (let i = 1; i <= 5; i++) {
      expect((await login(app, `[2001:db8:1:2::${i.toString(16)}]`)).status).toBe(401);
    }
    expect((await login(app, '[2001:db8:1:2:dead:beef:0:1]:443')).status).toBe(429);
  });

  it('does not charge a different /64 for it', async () => {
    const app = await buildApp();
    for (let i = 1; i <= 5; i++) await login(app, `2001:db8:1:2::${i.toString(16)}`);
    expect((await login(app, '2001:db8:1:3::1')).status).toBe(401);
  });

  it('still counts IPv4 clients one address at a time', async () => {
    const app = await buildApp();
    for (let i = 0; i < 5; i++) await login(app, '203.0.113.7');
    expect((await login(app, '203.0.113.7')).status).toBe(429);
    expect((await login(app, '203.0.113.8')).status).toBe(401);
  });

  it('applies the same key to the general /api budget', async () => {
    mockSettingsRows = [setting('rate_limit_max_requests', 10)];
    const app = await buildApp();
    const get = (ip) => request(app).get('/api/public/settings').set('X-Forwarded-For', ip);
    for (let i = 1; i <= 10; i++) {
      expect((await get(`2001:db8:1:2::${i.toString(16)}`)).status).toBe(200);
    }
    expect((await get('2001:db8:1:2::ffff')).status).toBe(429);
    expect((await get('2001:db8:9:9::1')).status).toBe(200);
  });
});
