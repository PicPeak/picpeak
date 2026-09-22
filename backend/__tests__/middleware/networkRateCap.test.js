/**
 * The per-network cap above the per-device limits (follow-up to issue 1564).
 *
 * The secure-image device buckets hash request headers, so a client rotating
 * them got a fresh budget each time.
 * Every request now also counts against the network key alone, at
 * RATE_LIMIT_NETWORK_MULTIPLIER times the device budget.
 */
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

jest.mock('../../src/database/db', () => ({ db: jest.fn() }));

const express = require('express');
const request = require('supertest');
const secureImageMiddleware = require('../../src/middleware/secureImageMiddleware');
const secureImageService = require('../../src/services/secureImageService');
const { networkMultiplier, networkLimit, DEFAULT_NETWORK_MULTIPLIER } = require('../../src/utils/networkRateCap');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15';
const ua = (i) => `${UA} device/${i}`;

const ORIGINAL_MULTIPLIER = process.env.RATE_LIMIT_NETWORK_MULTIPLIER;
afterAll(() => {
  if (ORIGINAL_MULTIPLIER === undefined) delete process.env.RATE_LIMIT_NETWORK_MULTIPLIER;
  else process.env.RATE_LIMIT_NETWORK_MULTIPLIER = ORIGINAL_MULTIPLIER;
  secureImageMiddleware.dispose();
});

describe('networkRateCap', () => {
  afterEach(() => { delete process.env.RATE_LIMIT_NETWORK_MULTIPLIER; });

  it('defaults to 20 and multiplies the device budget', () => {
    expect(networkMultiplier()).toBe(DEFAULT_NETWORK_MULTIPLIER);
    expect(DEFAULT_NETWORK_MULTIPLIER).toBe(20);
    expect(networkLimit(30)).toBe(600);
  });

  it('takes RATE_LIMIT_NETWORK_MULTIPLIER, and ignores nonsense', () => {
    process.env.RATE_LIMIT_NETWORK_MULTIPLIER = '50';
    expect(networkLimit(30)).toBe(1500);
    for (const bad of ['0', '-3', 'lots', '']) {
      process.env.RATE_LIMIT_NETWORK_MULTIPLIER = bad;
      expect(networkMultiplier()).toBe(DEFAULT_NETWORK_MULTIPLIER);
    }
  });
});

describe('secure image network cap', () => {
  const buildApp = () => {
    const app = express();
    app.set('trust proxy', true);
    app.get('/img', secureImageMiddleware.secureImageAccess, (req, res) => res.sendStatus(200));
    return app;
  };
  const get = (app, ip, agent) => request(app).get('/img')
    .set('X-Forwarded-For', ip)
    .set('User-Agent', agent)
    .set('Accept', 'image/*')
    .set('Accept-Language', 'en')
    .set('Accept-Encoding', 'gzip');

  beforeEach(() => {
    process.env.RATE_LIMIT_NETWORK_MULTIPLIER = '2';
    secureImageService.rateLimitCache.clear();
    secureImageMiddleware.blockedFingerprints.clear();
    secureImageMiddleware.suspiciousIPs.clear();
    secureImageMiddleware.rateLimitViolations.clear();
    jest.spyOn(secureImageMiddleware, 'getRateLimitSettings')
      .mockResolvedValue({ perMinute: 3, per5Minutes: 100, perHour: 500 });
  });

  it('stops a client rotating headers at the network cap, and blocks nobody for it', async () => {
    const app = buildApp();
    for (let i = 0; i < 6; i++) {
      expect((await get(app, '203.0.113.7', ua(i))).status).toBe(200);
    }
    for (let i = 0; i < 10; i++) {
      expect((await get(app, '203.0.113.7', ua(100 + i))).status).toBe(429);
    }
    // The network cap is a 429, never a block: at a venue the network is
    // every guest.
    expect(secureImageMiddleware.blockedFingerprints.size).toBe(0);
    expect(secureImageMiddleware.suspiciousIPs.size).toBe(0);
    expect((await get(app, '203.0.113.8', ua(1))).status).toBe(200);
  });

  it('lets a room of guests on one network browse under the cap', async () => {
    const app = buildApp();
    // Two guests, three images each: within 3 per device and 6 per network.
    for (const guest of [1, 2]) {
      for (let i = 0; i < 3; i++) {
        expect((await get(app, '203.0.113.7', ua(guest))).status).toBe(200);
      }
    }
  });
});
