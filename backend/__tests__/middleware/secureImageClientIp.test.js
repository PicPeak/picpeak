/**
 * The protected-image middleware must use the trusted client address.
 *
 * getClientIP read X-Forwarded-For, then X-Real-IP, before anything Express
 * resolved. Both are set by the caller, and the result becomes
 * req.clientInfo.ip, which feeds the suspicious-IP block list and the image
 * access log. A scraper could rotate the header to escape its own block, or
 * trip the suspicious-activity check while claiming someone else's address
 * and get that address blocked.
 *
 * The address now comes from req.ip, i.e. through the `trust proxy` setting:
 * a forwarded address is honoured only when it arrives through a trusted
 * proxy hop.
 */

jest.mock('../../src/database/db', () => ({ db: jest.fn() }));
jest.mock('../../src/services/secureImageService', () => ({
  cleanup: jest.fn(),
  createClientFingerprint: jest.fn(() => 'test-fingerprint'),
  createRateLimitFingerprint: jest.fn(() => 'test-rate-fingerprint'),
}));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const express = require('express');
const request = require('supertest');
const secureImageMiddleware = require('../../src/middleware/secureImageMiddleware');

const FORGED_FORWARDED = '203.0.113.9';
const FORGED_REAL_IP = '203.0.113.10';
const RESOLVED = '198.51.100.7';

function forgedRequest() {
  const headers = {
    'x-forwarded-for': `${FORGED_FORWARDED}, 10.0.0.1`,
    'x-real-ip': FORGED_REAL_IP,
    'user-agent': 'Mozilla/5.0 (Macintosh) jest',
  };
  return {
    headers,
    ip: RESOLVED,
    socket: { remoteAddress: RESOLVED },
    connection: { remoteAddress: RESOLVED },
    params: { slug: 'gallery', photoId: '1' },
    originalUrl: '/api/secure-images/gallery/secure/1/token',
    path: '/api/secure-images/gallery/secure/1/token',
    method: 'GET',
    get: (name) => headers[String(name).toLowerCase()],
  };
}

describe('secure image middleware client address', () => {
  afterAll(() => { secureImageMiddleware.dispose(); });

  it('ignores forged X-Forwarded-For and X-Real-IP headers', () => {
    expect(secureImageMiddleware.getClientIP(forgedRequest())).toBe(RESOLVED);
  });

  it('records the trusted address as the client IP the block list and access log use', async () => {
    jest.spyOn(secureImageMiddleware, 'performSecurityChecks').mockResolvedValue({ passed: true });
    jest.spyOn(secureImageMiddleware, 'setSecurityHeaders').mockImplementation(() => {});
    const req = forgedRequest();
    const next = jest.fn();

    await secureImageMiddleware.secureImageAccess(req, { status: jest.fn().mockReturnThis(), json: jest.fn() }, next);

    expect(next).toHaveBeenCalled();
    expect(req.clientInfo.ip).toBe(RESOLVED);
  });

  describe('through Express trust proxy', () => {
    const appWith = (trustProxy) => {
      const app = express();
      app.set('trust proxy', trustProxy);
      app.get('/ip', (req, res) => res.json({ ip: secureImageMiddleware.getClientIP(req) }));
      return app;
    };

    it('honours the forwarded address when it comes through a trusted proxy hop', async () => {
      // The server default: loopback, link-local and unique-local hops are
      // trusted, and supertest connects over loopback.
      const res = await request(appWith('loopback, linklocal, uniquelocal'))
        .get('/ip')
        .set('X-Forwarded-For', FORGED_FORWARDED);

      expect(res.body.ip).toBe(FORGED_FORWARDED);
    });

    it('ignores the header when the connecting hop is not trusted', async () => {
      const res = await request(appWith(false))
        .get('/ip')
        .set('X-Forwarded-For', FORGED_FORWARDED)
        .set('X-Real-IP', FORGED_REAL_IP);

      expect(res.body.ip).not.toBe(FORGED_FORWARDED);
      expect(res.body.ip).not.toBe(FORGED_REAL_IP);
      expect(res.body.ip).toMatch(/127\.0\.0\.1|::1/);
    });
  });
});
