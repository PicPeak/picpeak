/**
 * Regression test for GHSA-9hmx-68vc-qpqw — share-link login must not bypass
 * the gallery password.
 *
 * POST /auth/gallery/share-login validates only the share token. For a
 * password-protected gallery it previously minted a full `type:'gallery'`
 * access token on the share token alone, letting anyone holding the share URL
 * read the gallery without the password. The fix: when the gallery requires a
 * password, return `{ requires_password: true }` with NO token and NO cookie.
 */

const express = require('express');
const request = require('supertest');

process.env.JWT_SECRET = 'share-login-test-secret';

const events = [];

jest.mock('../../src/database/db', () => {
  function dbFn(table) {
    if (table === 'events') {
      let filter = () => true;
      return {
        where(criteria) {
          filter = (row) => Object.entries(criteria).every(([k, v]) => {
            if (k === 'is_active') return Boolean(row.is_active) === Boolean(v);
            if (k === 'is_archived') return Boolean(row.is_archived) === Boolean(v);
            return row[k] === v;
          });
          return this;
        },
        async first() { return events.find(filter); },
      };
    }
    return { where() { return this; }, async first() { return undefined; } };
  }
  dbFn.raw = async () => {};
  return { db: dbFn, logActivity: async () => {} };
});

// Share token is stored plainly on the fake event row.
jest.mock('../../src/services/shareLinkService', () => ({
  getEventShareToken: (event) => event.share_token,
  resolveShareIdentifier: async () => ({ event: null }),
}));

const mockSetGalleryAuthCookies = jest.fn();
jest.mock('../../src/utils/tokenUtils', () => ({
  setGalleryAuthCookies: (...args) => mockSetGalleryAuthCookies(...args),
  clearGalleryAuthCookies: jest.fn(),
  getGalleryTokenFromRequest: jest.fn(),
  setAdminAuthCookies: jest.fn(),
}));

jest.mock('../../src/utils/authSecurity', () => ({
  trackFailedAttempt: jest.fn(async () => {}),
  trackSuccessfulLogin: jest.fn(async () => {}),
  checkAccountLockout: jest.fn(async () => ({ isLocked: false })),
  resetLockout: jest.fn(async () => {}),
}));

// Collaborators the router imports at load but the share-login path doesn't hit.
jest.mock('../../src/services/recaptcha', () => ({ verifyRecaptcha: async () => true }));
jest.mock('../../src/services/mfaService', () => ({}));
jest.mock('../../src/middleware/sessionTimeout', () => ({ endSession: jest.fn(), sessionTimeoutMiddleware: (req, res, next) => next() }));
jest.mock('../../src/utils/tokenRevocation', () => ({ revokeToken: jest.fn(async () => {}), isTokenRevoked: async () => false }));

const authRouter = require('../../src/routes/auth');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  return app;
}

const SHARE_TOKEN = 'a'.repeat(64);

beforeEach(() => {
  events.length = 0;
  mockSetGalleryAuthCookies.mockClear();
});

describe('POST /auth/gallery/share-login password enforcement', () => {
  it('does NOT mint a token for a password-protected gallery', async () => {
    events.push({
      id: 1, slug: 'private-gallery', is_active: 1, is_archived: 0,
      require_password: 1, share_token: SHARE_TOKEN, event_name: 'Private',
    });
    const res = await request(makeApp())
      .post('/auth/gallery/share-login')
      .send({ slug: 'private-gallery', token: SHARE_TOKEN });

    expect(res.status).toBe(200);
    expect(res.body.requires_password).toBe(true);
    expect(res.body.token).toBeUndefined();
    expect(mockSetGalleryAuthCookies).not.toHaveBeenCalled();
  });

  it('mints a token for a public (no-password) gallery', async () => {
    events.push({
      id: 2, slug: 'public-gallery', is_active: 1, is_archived: 0,
      require_password: false, share_token: SHARE_TOKEN, event_name: 'Public',
    });
    const res = await request(makeApp())
      .post('/auth/gallery/share-login')
      .send({ slug: 'public-gallery', token: SHARE_TOKEN });

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.event).toBeDefined();
    expect(mockSetGalleryAuthCookies).toHaveBeenCalledTimes(1);
  });

  it('rejects a wrong share token regardless of password setting', async () => {
    events.push({
      id: 3, slug: 'public-gallery', is_active: 1, is_archived: 0,
      require_password: false, share_token: SHARE_TOKEN, event_name: 'Public',
    });
    const res = await request(makeApp())
      .post('/auth/gallery/share-login')
      .send({ slug: 'public-gallery', token: 'b'.repeat(64) });

    expect(res.status).toBe(401);
    expect(mockSetGalleryAuthCookies).not.toHaveBeenCalled();
  });
});
