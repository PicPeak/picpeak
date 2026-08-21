/**
 * CORS posture of the protected-image responses (#1116).
 *
 * secureImageMiddleware used to set its own Access-Control-Allow-Origin,
 * overwriting the one cors(corsOptions) had already computed for the request.
 * That was worse in both directions:
 *
 *   unresolved -> '*', which with the credentials:true that cors() sets is an
 *     invalid pair every browser rejects outright
 *   resolved   -> the frontend origin, even when the request legitimately came
 *     from the allowlisted ADMIN_URL
 *
 * The header now belongs to cors() alone. These tests are mounted on a real
 * Express app with the same middleware order as server.js — a unit test against
 * a response double cannot see middleware composition, which is precisely how
 * the first version of this fix looked correct while still being wrong.
 */

process.env.NODE_ENV = 'test';

const express = require('express');
const cors = require('cors');
const request = require('supertest');

jest.mock('../src/database/db', () => ({ db: jest.fn() }));

// A frontend origin IS resolvable here, deliberately. With the resolver empty
// (the default in tests) merely GUARDING the assignment looks identical to
// removing it — the admin-origin case below is what tells them apart, and it
// is the common one in production.
jest.mock('../src/utils/frontendUrl', () => ({
  getFrontendBaseUrlSync: () => 'https://gallery.example.com',
}));

jest.useFakeTimers(); // the module schedules a cleanup setInterval at require time
const secureImageMiddleware = require('../src/middleware/secureImageMiddleware');

const FRONTEND = 'https://gallery.example.com';
const ADMIN = 'https://admin.example.com';

/** Mirrors server.js: cors() on /api, then the route sets its own headers. */
function buildApp() {
  const app = express();
  app.use('/api', cors({
    origin: (origin, cb) => cb(null, !origin || [FRONTEND, ADMIN].includes(origin)),
    credentials: true,
  }));
  app.get('/api/secure-images/:id', (req, res) => {
    secureImageMiddleware.setSecurityHeaders(res);
    res.status(200).send('ok');
  });
  return app;
}

afterAll(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('protected-image CORS headers', () => {
  it('never emits a wildcard origin', async () => {
    // '*' alongside the credentials:true that cors() sets is invalid, and the
    // browser drops the whole response.
    const res = await request(buildApp()).get('/api/secure-images/1').set('Origin', FRONTEND);
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('preserves the cors() answer for an allowlisted origin', async () => {
    const res = await request(buildApp()).get('/api/secure-images/1').set('Origin', FRONTEND);
    expect(res.headers['access-control-allow-origin']).toBe(FRONTEND);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('does not repoint an allowlisted admin origin at the frontend', async () => {
    // The regression the old code caused, and the case a guarded assignment
    // still gets wrong: the resolver returns the FRONTEND origin here, so any
    // code that writes it would stamp the wrong origin on an admin request
    // that cors() had already allowed, and the browser would reject it.
    const res = await request(buildApp()).get('/api/secure-images/1').set('Origin', ADMIN);
    expect(res.headers['access-control-allow-origin']).toBe(ADMIN);
  });

  it('stays absent for a disallowed origin', async () => {
    const res = await request(buildApp()).get('/api/secure-images/1').set('Origin', 'https://evil.example.com');
    expect(res.headers).not.toHaveProperty('access-control-allow-origin');
  });

  it('stays absent when there is no Origin at all', async () => {
    const res = await request(buildApp()).get('/api/secure-images/1');
    expect(res.headers).not.toHaveProperty('access-control-allow-origin');
  });

  it('still sets the route-specific security headers', async () => {
    const res = await request(buildApp()).get('/api/secure-images/1').set('Origin', FRONTEND);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['access-control-allow-methods']).toBe('GET');
  });
});
