/**
 * Client PIN login is a two-part capability: the current private-link token
 * plus the PIN. Rotating the link must revoke the ability to authenticate
 * again even when an old PIN has leaked.
 */
const express = require('express');
const request = require('supertest');

process.env.JWT_SECRET = 'client-link-token-test-secret-at-least-32-characters';

const mockEvents = [];
const mockComparePassword = jest.fn(async (password, hash) => password === '2468' && hash === 'pin-hash');
jest.mock('bcrypt', () => ({ compare: (...args) => mockComparePassword(...args) }));

jest.mock('../../src/database/db', () => {
  function dbFn(table) {
    if (table === 'events') {
      let filter = () => true;
      return {
        where(criteria) {
          filter = (row) => Object.entries(criteria).every(([key, value]) => {
            if (key === 'is_active' || key === 'is_archived') {
              return Boolean(row[key]) === Boolean(value);
            }
            return row[key] === value;
          });
          return this;
        },
        async first() { return mockEvents.find(filter); },
      };
    }
    return { where() { return this; }, async first() { return undefined; } };
  }
  dbFn.raw = async () => {};
  return { db: dbFn, logActivity: async () => {} };
});

const mockTrackFailedAttempt = jest.fn(async () => {});
const mockTrackSuccessfulLogin = jest.fn(async () => {});
jest.mock('../../src/utils/authSecurity', () => ({
  trackFailedAttempt: (...args) => mockTrackFailedAttempt(...args),
  trackSuccessfulLogin: (...args) => mockTrackSuccessfulLogin(...args),
  checkAccountLockout: jest.fn(async () => ({ isLocked: false })),
  resetLockout: jest.fn(async () => {}),
}));

const mockSetGalleryAuthCookies = jest.fn();
jest.mock('../../src/utils/tokenUtils', () => ({
  setGalleryAuthCookies: (...args) => mockSetGalleryAuthCookies(...args),
  clearGalleryAuthCookies: jest.fn(),
  getGalleryTokenFromRequest: jest.fn(),
  setAdminAuthCookies: jest.fn(),
}));

jest.mock('../../src/services/recaptcha', () => ({ verifyRecaptcha: async () => true }));
jest.mock('../../src/services/mfaService', () => ({}));
jest.mock('../../src/middleware/sessionTimeout', () => ({
  endSession: jest.fn(), sessionTimeoutMiddleware: (req, res, next) => next(),
}));
jest.mock('../../src/utils/tokenRevocation', () => ({
  revokeToken: jest.fn(async () => {}), isTokenRevoked: async () => false,
}));

const authRouter = require('../../src/routes/auth');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  return app;
}

const CURRENT_TOKEN = 'a'.repeat(64);

beforeEach(() => {
  mockEvents.length = 0;
  mockComparePassword.mockClear();
  mockTrackFailedAttempt.mockClear();
  mockTrackSuccessfulLogin.mockClear();
  mockSetGalleryAuthCookies.mockClear();
  mockEvents.push({
    id: 1,
    slug: 'private-client',
    is_active: 1,
    is_archived: 0,
    is_draft: 0,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    client_access_enabled: 1,
    client_password_hash: 'pin-hash',
    client_share_token: CURRENT_TOKEN,
    event_name: 'Private client gallery',
  });
});

describe('POST /auth/gallery/:slug/client-login private-link binding', () => {
  const login = (body) => request(makeApp())
    .post('/auth/gallery/private-client/client-login')
    .send(body);

  it('requires the current link token together with the PIN', async () => {
    const res = await login({ password: '2468', token: CURRENT_TOKEN });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(mockSetGalleryAuthCookies).toHaveBeenCalledTimes(1);
    expect(mockTrackSuccessfulLogin).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing', undefined],
    ['stale', 'b'.repeat(64)],
    ['malformed', { old: CURRENT_TOKEN }],
  ])('uniformly rejects a %s link token before checking the PIN', async (_label, token) => {
    const body = { password: '2468' };
    if (token !== undefined) body.token = token;
    const res = await login(body);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid credentials' });
    expect(mockComparePassword).not.toHaveBeenCalled();
    expect(mockTrackFailedAttempt).toHaveBeenCalledWith(
      'client:private-client', expect.any(String), expect.any(String),
    );
    expect(mockSetGalleryAuthCookies).not.toHaveBeenCalled();
  });
});
