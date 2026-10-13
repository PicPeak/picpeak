/**
 * refundRateLimit (issue 1733): a request the route has authorised itself
 * gives its slot back, so the many segment requests of one video playback do
 * not use up the address's API budget. Everything the route refuses stays
 * counted, and an address over its budget is stopped before the route.
 */
const express = require('express');
const request = require('supertest');

let mockSettings = {};
jest.mock('../../src/database/db', () => ({
  db: jest.fn(() => ({
    whereIn: jest.fn(() => Promise.resolve(Object.entries(mockSettings)
      .map(([setting_key, value]) => ({ setting_key, setting_value: JSON.stringify(value) })))),
  })),
  withRetry: fn => fn(),
}));
jest.mock('../../src/utils/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/services/sessionAccessService', () => ({ admin: async () => null }));

const { createRateLimiter, clearSettingsCache, refundRateLimit } = require('../../src/services/rateLimitService');

const MAX = 3;
const SEGMENT = '/api/gallery/open-gallery/hls/7/720p/seg_00000.m4s';

async function buildApp() {
  mockSettings = { rate_limit_max_requests: MAX };
  clearSettingsCache();
  const app = express();
  app.use(await createRateLimiter());
  // Stands in for the stream route: `?ok` is a request its access chain let through.
  app.get('/api/gallery/:slug/hls/:id/:rung/:file', (req, res) => {
    if (req.query.ok === undefined) return res.status(403).json({ error: 'Photo not available' });
    refundRateLimit(req);
    refundRateLimit(req);
    return res.json({ ok: true });
  });
  app.all('*', (req, res) => res.json({ ok: true }));
  return app;
}
const statuses = async (app, count, path) => {
  const seen = [];
  for (let i = 0; i < count; i += 1) seen.push((await request(app).get(path)).status);
  return seen;
};

describe('refundRateLimit', () => {
  it('lets a token-less viewer fetch far more authorised segments than the budget', async () => {
    const app = await buildApp();
    expect(await statuses(app, MAX * 10, `${SEGMENT}?ok`)).toEqual(Array(MAX * 10).fill(200));
    // And the budget is still whole for everything else, not below zero or above the limit.
    expect(await statuses(app, MAX + 1, '/api/public/settings')).toEqual([200, 200, 200, 429]);
  });

  it('gives nothing back for a request the route refuses', async () => {
    const app = await buildApp();
    expect(await statuses(app, MAX + 2, SEGMENT)).toEqual([403, 403, 403, 429, 429]);
  });

  it('does not open the route to an address that is already over its budget', async () => {
    const app = await buildApp();
    expect(await statuses(app, MAX + 1, '/api/public/settings')).toEqual([200, 200, 200, 429]);
    expect(await statuses(app, 2, `${SEGMENT}?ok`)).toEqual([429, 429]);
  });

  it('is a no-op for a request no limiter counted', () => {
    expect(() => refundRateLimit({})).not.toThrow();
  });
});
