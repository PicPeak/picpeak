/**
 * A gallery admin preview refused for a pending password rotation must say so.
 *
 * galleryAccessService denies the preview with 403 MUST_CHANGE_PASSWORD, and
 * verifyGalleryAccess already reports that denial instead of falling through.
 * The metadata routes did not: verifyAdminPreview answers a refusal with
 * `false`, and /resolve, /verify-token and /info turned that into "not found"
 * for a draft (and a plain guest view of a published gallery on /info). The
 * admin landed on the gallery-not-found page with nothing pointing them at
 * the password change.
 *
 * Only that one refusal is surfaced. It is about the account, not the gallery;
 * any other refusal (FORBIDDEN for a scoped admin, a revoked session) keeps
 * reading as not found, so it reveals nothing about a draft the caller cannot
 * open. The controls below pin that half.
 */

const express = require('express');
const request = require('supertest');

let mockDenial = null;
let mockEvent = null;

jest.mock('../../src/database/db', () => {
  const db = jest.fn(() => ({
    where() { return this; },
    select() { return this; },
    first: async () => mockEvent,
  }));
  db.schema = { hasTable: async () => false };
  return { db, withRetry: (fn) => fn() };
});
jest.mock('../../src/middleware/gallery', () => ({
  verifyAdminPreview: jest.fn(async (req) => {
    if (mockDenial) req.adminPreviewDenied = mockDenial;
    return false;
  }),
}));
jest.mock('../../src/services/shareLinkService', () => ({
  getEventShareToken: () => 'share-token',
  // Published lookups miss; the draft lookup finds the event, so /resolve
  // reaches the admin-preview check.
  resolveShareIdentifier: async (_identifier, options) => (options?.includeDrafts
    ? { event: { slug: 'draft-gallery' }, matchType: 'token', shareToken: 'share-token' }
    : null),
  buildShareLinkVariants: async () => ({}),
}));
jest.mock('../../src/utils/appSettings', () => ({ getAppSetting: async (_key, fallback) => fallback }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { AppError } = require('../../src/utils/errors');
const { errorHandler } = require('../../src/middleware/errorHandler');
const router = require('../../src/routes/gallery/metadata');

const app = express();
app.use('/gallery', router);
app.use(errorHandler);

const draftEvent = { id: 5, slug: 'draft-gallery', is_active: 1, is_archived: 0, is_draft: 1, share_token: 'share-token' };
const publishedEvent = { ...draftEvent, is_draft: 0 };

const routes = [
  ['/resolve', () => request(app).get('/gallery/resolve/abcdef0123456789abcdef0123456789?admin_preview=1')],
  ['/verify-token', () => request(app).get('/gallery/draft-gallery/verify-token/share-token?admin_preview=1')],
  ['/info', () => request(app).get('/gallery/draft-gallery/info?admin_preview=1')],
];

describe('gallery metadata routes report a pending password change on admin preview', () => {
  beforeEach(() => {
    mockDenial = null;
    mockEvent = draftEvent;
  });

  it.each(routes)('%s answers 403 MUST_CHANGE_PASSWORD for a draft instead of 404', async (_route, send) => {
    mockDenial = new AppError('Password change required before continuing', 403, 'MUST_CHANGE_PASSWORD');

    const res = await send();

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MUST_CHANGE_PASSWORD');
  });

  it('/info answers 403 for a published gallery rather than the guest view', async () => {
    mockDenial = new AppError('Password change required before continuing', 403, 'MUST_CHANGE_PASSWORD');
    mockEvent = publishedEvent;

    const res = await request(app).get('/gallery/draft-gallery/info?admin_preview=1');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MUST_CHANGE_PASSWORD');
  });

  it.each(routes)('%s answers 401 SESSION_TIMEOUT for an idled-out admin instead of 404', async (_route, send) => {
    mockDenial = new AppError('Session expired', 401, 'SESSION_TIMEOUT');

    const res = await send();

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SESSION_TIMEOUT');
  });

  it('/info answers 401 SESSION_TIMEOUT for a published gallery rather than the guest view', async () => {
    mockDenial = new AppError('Session expired', 401, 'SESSION_TIMEOUT');
    mockEvent = publishedEvent;

    const res = await request(app).get('/gallery/draft-gallery/info?admin_preview=1');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SESSION_TIMEOUT');
  });

  it.each(routes)('%s still reads as not found for any other refusal', async (_route, send) => {
    mockDenial = new AppError('Access denied', 403, 'FORBIDDEN');

    const res = await send();

    expect(res.status).toBe(404);
    expect(res.body.code).not.toBe('FORBIDDEN');
  });

  it.each(routes)('%s still reads as not found for a guest', async (_route, send) => {
    const res = await send();

    expect(res.status).toBe(404);
  });
});
