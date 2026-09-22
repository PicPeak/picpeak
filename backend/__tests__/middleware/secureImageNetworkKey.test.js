/**
 * Issue 1564: the secure-image limiter used one fingerprint both as the
 * rate-limit key and as the identity a secure image token is bound to. Keyed
 * on the full address, an IPv6 client rotating through its /64 got a fresh
 * budget per address and escaped a fingerprint block. (The feedback limiter's
 * per-network budget already keys on rateLimitKey; see
 * integration/feedbackAbuseLimits.test.js.)
 *
 * Pinned here: two addresses in one /64 share a rate-limit key and get the 429
 * together, while the token fingerprint still differs per address. IPv4
 * behaviour is unchanged.
 */
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));
jest.mock('../../src/database/db', () => ({ db: jest.fn() }));

const express = require('express');
const request = require('supertest');
const secureImageMiddleware = require('../../src/middleware/secureImageMiddleware');
const secureImageService = require('../../src/services/secureImageService');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15';

afterAll(() => { secureImageMiddleware.dispose(); });

describe('secure image limiter (secureImageMiddleware.js)', () => {
  const buildApp = () => {
    const app = express();
    app.set('trust proxy', true);
    app.get('/img', secureImageMiddleware.secureImageAccess, (req, res) => res.json({
      fingerprint: req.clientInfo.fingerprint,
      rateLimitFingerprint: req.clientInfo.rateLimitFingerprint,
    }));
    return app;
  };
  const get = (app, ip) => request(app).get('/img')
    .set('X-Forwarded-For', ip)
    .set('User-Agent', UA)
    .set('Accept', 'image/*')
    .set('Accept-Language', 'en')
    .set('Accept-Encoding', 'gzip');

  beforeEach(() => {
    secureImageService.rateLimitCache.clear();
    secureImageMiddleware.blockedFingerprints.clear();
    secureImageMiddleware.suspiciousIPs.clear();
    secureImageMiddleware.rateLimitViolations.clear();
    jest.spyOn(secureImageMiddleware, 'getRateLimitSettings')
      .mockResolvedValue({ perMinute: 3, per5Minutes: 100, perHour: 500 });
  });

  it('counts an IPv6 /64 as one client, while the token fingerprint stays per address', async () => {
    const app = buildApp();
    const tokenFingerprints = new Set();
    const rateFingerprints = new Set();
    for (let i = 1; i <= 3; i++) {
      const res = await get(app, `2001:db8:1:2::${i}`);
      expect(res.status).toBe(200);
      tokenFingerprints.add(res.body.fingerprint);
      rateFingerprints.add(res.body.rateLimitFingerprint);
    }
    // Token binding still tells the three devices apart...
    expect(tokenFingerprints.size).toBe(3);
    // ...the limiter does not.
    expect(rateFingerprints.size).toBe(1);

    expect((await get(app, '2001:db8:1:2::ff')).status).toBe(429);
    expect((await get(app, '2001:db8:1:3::1')).status).toBe(200);
  });

  it('a fingerprint block covers the whole /64', async () => {
    const app = buildApp();
    const first = await get(app, '2001:db8:1:2::1');
    secureImageMiddleware.blockedFingerprints.add(first.body.rateLimitFingerprint);
    expect((await get(app, '2001:db8:1:2::abcd')).status).toBe(403);
  });

  it('an IP block covers the whole /64', async () => {
    const app = buildApp();
    secureImageMiddleware.suspiciousIPs.add('2001:db8:1:2::/64');
    expect((await get(app, '2001:db8:1:2::77')).status).toBe(403);
    expect((await get(app, '2001:db8:1:3::77')).status).toBe(200);
  });

  it('leaves IPv4 as it was: the rate-limit fingerprint is the token fingerprint', async () => {
    const res = await get(buildApp(), '203.0.113.7');
    expect(res.body.rateLimitFingerprint).toBe(res.body.fingerprint);
  });
});

describe('admin IP block list (adminImageSecurity.js)', () => {
  let app;
  // The route's own module instance: isolateModules gives it a fresh one.
  let blocked;
  beforeAll(() => {
    jest.isolateModules(() => {
      jest.doMock('../../src/middleware/auth', () => ({
        adminAuth: (req, res, next) => { req.admin = { id: 1, username: 'root' }; next(); },
      }));
      jest.doMock('../../src/middleware/permissions', () => ({ requirePermission: () => (req, res, next) => next() }));
      app = express();
      app.use(express.json());
      app.use('/sec', require('../../src/routes/adminImageSecurity'));
      blocked = require('../../src/middleware/secureImageMiddleware');
    });
  });
  afterAll(() => blocked.dispose());
  beforeEach(() => blocked.suspiciousIPs.clear());

  it('stores a blocked address in the form the middleware checks', async () => {
    await request(app).post('/sec/block-ip').send({ ip: '2001:db8:1:2::5' }).expect(200);
    await request(app).post('/sec/block-ip').send({ ip: '::ffff:203.0.113.9' }).expect(200);
    expect([...blocked.suspiciousIPs].sort()).toEqual(['2001:db8:1:2::/64', '203.0.113.9']);
  });

  it('accepts a /64 in the CIDR form the list stores', async () => {
    await request(app).post('/sec/block-ip').send({ ip: '2001:db8:1:2::/64' }).expect(200);
    expect([...blocked.suspiciousIPs]).toEqual(['2001:db8:1:2::/64']);
    await request(app).post('/sec/block-ip').send({ ip: '2001:db8:1:2:0::/64', action: 'unblock' }).expect(200);
    expect(blocked.suspiciousIPs.size).toBe(0);
  });

  it('accepts the bracketed form a proxy forwards', async () => {
    await request(app).post('/sec/block-ip').send({ ip: '[2001:db8:1:2::5]:443' }).expect(200);
    expect([...blocked.suspiciousIPs]).toEqual(['2001:db8:1:2::/64']);
  });

  it('refuses input that is not an address instead of reporting it blocked', async () => {
    for (const ip of ['not-an-ip', '203.0.113.0/24', '2001:db8::/48', { a: 1 }, '   ']) {
      await request(app).post('/sec/block-ip').send({ ip }).expect(400);
    }
    expect(blocked.suspiciousIPs.size).toBe(0);
  });

  it('unblocks by any address in the /64', async () => {
    await request(app).post('/sec/block-ip').send({ ip: '2001:db8:1:2::5' }).expect(200);
    await request(app).post('/sec/block-ip').send({ ip: '2001:db8:1:2::9', action: 'unblock' }).expect(200);
    expect(blocked.suspiciousIPs.size).toBe(0);
  });
});
