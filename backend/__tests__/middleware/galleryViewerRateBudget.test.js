/**
 * A verified gallery viewer gets a request budget of their own (issue 1891).
 *
 * The lightbox reads one photo's feedback per slide and a like is a write
 * plus a read, so one guest choosing from a 1,500-photo gallery spent the
 * default 300 requests per 15 minutes alone. From then on every request
 * answered 429, the next like and the next sign-in included, and the guest
 * saw a heart that did nothing. Seen on a 1,487-photo gallery: likes in
 * bursts that stopped dead, then a 429 on the password check.
 *
 * These requests include writes, so they are counted, not exempt: against
 * GALLERY_VIEWER_BUDGET_FACTOR times the configured budget, in a bucket
 * separate from the address's anonymous requests.
 */
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'gallery-viewer-budget-secret';

let mockSettings = {};
jest.mock('../../src/database/db', () => ({
  db: jest.fn(() => ({
    whereIn: jest.fn(() => Promise.resolve(Object.entries(mockSettings)
      .map(([setting_key, value]) => ({ setting_key, setting_value: JSON.stringify(value) })))),
  })),
  withRetry: (fn) => fn(),
}));
jest.mock('../../src/utils/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/services/sessionAccessService', () => ({ admin: async () => null }));

const {
  createRateLimiter, clearSettingsCache, isOwnGalleryViewerRequest, GALLERY_VIEWER_BUDGET_FACTOR,
} = require('../../src/services/rateLimitService');

const MAX = 3;
const iat = Math.floor(Date.now() / 1000) - 10;
const token = (eventSlug) => jwt.sign({ type: 'gallery', eventId: 1, eventSlug, iat }, process.env.JWT_SECRET, { issuer: 'picpeak-auth' });
// Signed per use: the jest setup sets its own JWT_SECRET after this file loads.
const viewer = () => ({ authorization: `Bearer ${token('wedding-2026')}` });

async function buildApp(settings = {}) {
  mockSettings = { rate_limit_max_requests: MAX, ...settings };
  clearSettingsCache();
  const app = express();
  app.use(await createRateLimiter());
  app.all('*', (req, res) => res.json({ ok: true }));
  return app;
}
const statuses = async (app, count, method, path, headers = {}) => {
  const seen = [];
  for (let i = 0; i < count; i += 1) seen.push((await request(app)[method](path).set(headers)).status);
  return seen;
};
const FEEDBACK = '/api/gallery/wedding-2026/photos/42/feedback';

describe('a verified viewer working in their gallery', () => {
  it('gets the larger budget for reads and writes alike, and no more than that', async () => {
    const app = await buildApp();
    const budget = MAX * GALLERY_VIEWER_BUDGET_FACTOR;
    const half = budget / 2;
    expect(await statuses(app, half, 'get', FEEDBACK, viewer())).toEqual(Array(half).fill(200));
    expect(await statuses(app, half, 'post', FEEDBACK, viewer())).toEqual(Array(half).fill(200));
    expect(await statuses(app, 1, 'get', '/api/gallery/wedding-2026/photos', viewer())).toEqual([429]);
  });

  it('is not held back by the anonymous requests from the same address, nor the other way round', async () => {
    const app = await buildApp();
    expect(await statuses(app, MAX + 1, 'get', '/api/public/settings')).toEqual([200, 200, 200, 429]);
    expect(await statuses(app, MAX + 2, 'get', FEEDBACK, viewer())).toEqual(Array(MAX + 2).fill(200));
    expect(await statuses(app, 1, 'get', '/api/public/settings')).toEqual([429]);
  });

  // Every open tab polls photos/state (live refresh): in the viewer bucket
  // a full venue behind one address took the likes down with it.
  it('counts the live-refresh poll in a bucket of its own', async () => {
    const app = await buildApp();
    const budget = MAX * GALLERY_VIEWER_BUDGET_FACTOR;
    const POLL = '/api/gallery/wedding-2026/photos/state';
    expect(await statuses(app, budget + 1, 'get', POLL, viewer())).toEqual([...Array(budget).fill(200), 429]);
    expect(await statuses(app, budget + 1, 'post', FEEDBACK, viewer())).toEqual([...Array(budget).fill(200), 429]);
    expect(await statuses(app, 1, 'get', `${POLL}/`, viewer())).toEqual([429]);
  });

  // "Rate selected" is the same guest rating, many photos per request; on the
  // ordinary budget it answered 429 while single ratings still went through.
  it('counts a bulk rating against the viewer budget, through the limiter', async () => {
    const app = await buildApp();
    expect(await statuses(app, MAX + 2, 'post', '/api/gallery/wedding-2026/feedback/bulk', viewer())).toEqual(Array(MAX + 2).fill(200));
  });

  // photo/<id>/view is the beacon the lightbox posts for every slide: left
  // on the ordinary budget, about 300 slides still locked the guest out.
  it.each(['photos', 'photos/42/feedback', 'feedback/bulk', 'my-feedback', 'feedback-summary', 'feedback-settings', 'info', 'stats', 'people', 'photo/42/view'])(
    'covers /%s', (rest) => {
      expect(isOwnGalleryViewerRequest({ path: `/api/gallery/wedding-2026/${rest}`, headers: viewer(), cookies: {} })).toBe(true);
    });
});

describe('everything else keeps the ordinary budget', () => {
  it('downloads and uploads, even with the gallery token', async () => {
    for (const rest of ['download/42', 'download-all', 'download-selected', 'download-jobs', 'uploads', 'photo/42/view/extra', 'photo/42']) {
      const app = await buildApp();
      expect(await statuses(app, MAX + 1, 'post', `/api/gallery/wedding-2026/${rest}`, viewer())).toEqual([200, 200, 200, 429]);
    }
  });

  it('no token, a token for another gallery, a token under another secret', async () => {
    const foreign = jwt.sign({ type: 'gallery', eventSlug: 'wedding-2026', iat }, 'someone-elses-secret');
    for (const headers of [{}, { authorization: `Bearer ${token('other-gallery')}` }, { authorization: `Bearer ${foreign}` }]) {
      const app = await buildApp();
      expect(await statuses(app, MAX + 1, 'get', FEEDBACK, headers)).toEqual([200, 200, 200, 429]);
    }
  });

  it('the operator switch skip_authenticated=false counts a viewer like anyone', async () => {
    const app = await buildApp({ rate_limit_skip_authenticated: false });
    expect(await statuses(app, MAX + 1, 'get', FEEDBACK, viewer())).toEqual([200, 200, 200, 429]);
  });
});
