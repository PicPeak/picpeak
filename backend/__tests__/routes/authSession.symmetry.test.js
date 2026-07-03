/**
 * Regression test for the /admin/login → /admin/dashboard → /admin/login
 * redirect loop reported on v3.32.4-beta.0.
 *
 * Cause: GET /auth/session was less strict than the adminAuth middleware.
 * The session endpoint accepted tokens that the protected endpoints
 * subsequently rejected with 401, which the frontend's interceptor
 * translated into a hard redirect to /admin/login. /auth/session then
 * said "valid: true" again on the next page load and the cycle closed.
 *
 * /auth/session must reject the same admin tokens adminAuth would
 * reject, specifically: deactivated admin user, deleted admin user,
 * password changed since iat. Same for gallery: archived event.
 */

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'session-symmetry-test-secret';

const fakeDb = {
  adminUsers: [],
  events: [],
  revokedTokens: [],
};

jest.mock('../../src/database/db', () => {
  const formatBoolean = (v) => (v ? 1 : 0);
  void formatBoolean;
  function dbFn(table) {
    if (table === 'admin_users') {
      let rowFilter = () => true;
      return {
        where(criteria) {
          rowFilter = (row) => {
            return Object.entries(criteria).every(([k, v]) => {
              if (k === 'is_active') return Boolean(row.is_active) === Boolean(v);
              return row[k] === v;
            });
          };
          return this;
        },
        select(...cols) {
          this._cols = cols;
          return this;
        },
        async first() {
          const row = fakeDb.adminUsers.find(rowFilter);
          if (!row) return undefined;
          if (!this._cols) return row;
          const out = {};
          for (const c of this._cols) out[c] = row[c];
          return out;
        },
      };
    }
    if (table === 'events') {
      let rowFilter = () => true;
      return {
        where(criteria) {
          rowFilter = (row) =>
            Object.entries(criteria).every(([k, v]) => {
              if (k === 'is_active') return Boolean(row.is_active) === Boolean(v);
              if (k === 'is_archived') return Boolean(row.is_archived) === Boolean(v);
              return row[k] === v;
            });
          return this;
        },
        async first() {
          return fakeDb.events.find(rowFilter);
        },
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  }
  return { db: dbFn, formatBoolean: () => 1 };
});

jest.mock('../../src/utils/dbCompat', () => ({
  formatBoolean: (v) => (v ? 1 : 0),
}));

jest.mock('../../src/utils/tokenRevocation', () => ({
  isTokenRevoked: jest.fn(async (decoded) => fakeDb.revokedTokens.includes(decoded.id)),
  revokeToken: jest.fn(),
}));

jest.mock('../../src/utils/tokenUtils', () => ({
  getAdminTokenFromRequest: (req) => {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
    return null;
  },
  getGalleryTokenFromRequest: () => null,
  setAdminAuthCookie: jest.fn(),
  setGalleryAuthCookies: jest.fn(),
  clearAdminAuthCookie: jest.fn(),
  clearGalleryAuthCookies: jest.fn(),
  buildCookieOptionsWithExpiry: () => ({}),
}));

jest.mock('../../src/services/recaptcha', () => ({ verifyRecaptcha: () => Promise.resolve(true) }));
// Mock sessionTimeout's isSessionExpired so each test controls the return.
// Default: not expired (so existing tests keep passing without setup).
jest.mock('../../src/middleware/sessionTimeout', () => ({
  endSession: jest.fn(),
  isSessionExpired: jest.fn(() => Promise.resolve(false)),
}));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const authRouter = require('../../src/routes/auth');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  return app;
}

function signAdminToken({ id = 1, username = 'admin', iat, exp }) {
  const issuedAt = iat ?? Math.floor(Date.now() / 1000);
  // Note: do NOT pass noTimestamp:true here — that strips iat from the
  // payload entirely, defeating the password-change comparison. Provide
  // iat (and exp) via the payload directly instead.
  return jwt.sign(
    { id, username, type: 'admin', iat: issuedAt, exp: exp ?? issuedAt + 3600 },
    process.env.JWT_SECRET,
    { issuer: 'picpeak-auth' }
  );
}

function signGalleryToken({ eventId = 100, eventSlug = 'wedding' } = {}) {
  return jwt.sign(
    { eventId, eventSlug, type: 'gallery' },
    process.env.JWT_SECRET,
    { expiresIn: '1h', issuer: 'picpeak-auth' }
  );
}

describe('GET /auth/session — symmetry with protected middleware', () => {
  beforeEach(() => {
    fakeDb.adminUsers = [];
    fakeDb.events = [];
    fakeDb.revokedTokens = [];
  });

  it('returns valid:true for an active admin token', async () => {
    fakeDb.adminUsers.push({
      id: 1,
      username: 'admin',
      email: 'a@b.com',
      is_active: true,
      password_changed_at: null,
    });
    const token = signAdminToken({ id: 1 });

    const res = await request(makeApp())
      .get('/auth/session')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.type).toBe('admin');
  });

  it('returns valid:false when the admin user has been deactivated', async () => {
    fakeDb.adminUsers.push({
      id: 1,
      username: 'admin',
      email: 'a@b.com',
      is_active: false,
      password_changed_at: null,
    });
    const token = signAdminToken({ id: 1 });

    const res = await request(makeApp())
      .get('/auth/session')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
  });

  it('returns valid:false when the admin user no longer exists', async () => {
    // adminUsers is empty
    const token = signAdminToken({ id: 999 });

    const res = await request(makeApp())
      .get('/auth/session')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
  });

  it('returns valid:false when password was changed after the token was issued', async () => {
    // iat must be in the past, exp must be in the future so jwt.verify
    // doesn't reject the token before /auth/session even gets to look
    // at password_changed_at.
    const tokenIssuedAt = Math.floor(Date.now() / 1000) - 60; // 1 min ago
    const tokenExp = tokenIssuedAt + 86400;
    fakeDb.adminUsers.push({
      id: 1,
      username: 'admin',
      email: 'a@b.com',
      is_active: true,
      password_changed_at: new Date((tokenIssuedAt + 30) * 1000), // 30s after iat
    });
    const token = signAdminToken({ id: 1, iat: tokenIssuedAt, exp: tokenExp });

    const res = await request(makeApp())
      .get('/auth/session')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
  });

  it('returns valid:true when password was changed BEFORE the token was issued', async () => {
    const tokenIssuedAt = Math.floor(Date.now() / 1000) - 60;
    const tokenExp = tokenIssuedAt + 86400;
    fakeDb.adminUsers.push({
      id: 1,
      username: 'admin',
      email: 'a@b.com',
      is_active: true,
      password_changed_at: new Date((tokenIssuedAt - 3600) * 1000), // 1h before iat
    });
    const token = signAdminToken({ id: 1, iat: tokenIssuedAt, exp: tokenExp });

    const res = await request(makeApp())
      .get('/auth/session')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  it('returns valid:false for a gallery token whose event is archived', async () => {
    fakeDb.events.push({
      id: 100,
      slug: 'wedding',
      is_active: true,
      is_archived: true,
      expires_at: null,
    });
    const token = signGalleryToken();

    const res = await request(makeApp())
      .get('/auth/session?slug=wedding')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
  });

  it('returns valid:false for a gallery token whose event is expired', async () => {
    fakeDb.events.push({
      id: 100,
      slug: 'wedding',
      is_active: true,
      is_archived: false,
      expires_at: new Date(Date.now() - 86400_000),
    });
    const token = signGalleryToken();

    const res = await request(makeApp())
      .get('/auth/session?slug=wedding')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
  });

  it('returns valid:true for an active gallery token', async () => {
    fakeDb.events.push({
      id: 100,
      slug: 'wedding',
      is_active: true,
      is_archived: false,
      expires_at: new Date(Date.now() + 86400_000),
    });
    const token = signGalleryToken();

    const res = await request(makeApp())
      .get('/auth/session?slug=wedding')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  it('returns valid:false when the token is revoked', async () => {
    fakeDb.adminUsers.push({
      id: 1,
      username: 'admin',
      is_active: true,
      password_changed_at: null,
    });
    fakeDb.revokedTokens.push(1);
    const token = signAdminToken({ id: 1 });

    const res = await request(makeApp())
      .get('/auth/session')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.valid).toBe(false);
  });

  // Session-timeout symmetry — issue #350 recurrence on v3.39.1-beta.0.
  // sessionTimeoutMiddleware (mounted on /api/admin) rejects idle/old-iat
  // tokens with 401 SESSION_TIMEOUT, but /auth/session previously didn't.
  // The new isSessionExpired helper closes that asymmetry.
  describe('session-timeout symmetry', () => {
    const { isSessionExpired } = require('../../src/middleware/sessionTimeout');

    beforeEach(() => {
      isSessionExpired.mockReset();
      // Default to "active session" so the other admin checks above also
      // pass when this branch runs.
      isSessionExpired.mockResolvedValue(false);
    });

    it('returns valid:false when isSessionExpired reports the token has timed out', async () => {
      fakeDb.adminUsers.push({
        id: 1,
        username: 'admin',
        is_active: true,
        password_changed_at: null,
      });
      isSessionExpired.mockResolvedValue(true);
      const token = signAdminToken({ id: 1 });

      const res = await request(makeApp())
        .get('/auth/session')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(res.body.error).toBe('Session expired');
    });

    it('returns valid:true for an active admin token (helper says not expired)', async () => {
      fakeDb.adminUsers.push({
        id: 1,
        username: 'admin',
        is_active: true,
        password_changed_at: null,
      });
      isSessionExpired.mockResolvedValue(false);
      const token = signAdminToken({ id: 1 });

      const res = await request(makeApp())
        .get('/auth/session')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(isSessionExpired).toHaveBeenCalledTimes(1);
    });

    it('does not call isSessionExpired for gallery tokens', async () => {
      fakeDb.events.push({
        id: 100,
        slug: 'wedding',
        is_active: true,
        is_archived: false,
        expires_at: new Date(Date.now() + 86400_000),
      });
      const token = signGalleryToken();

      const res = await request(makeApp())
        .get('/auth/session?slug=wedding')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(isSessionExpired).not.toHaveBeenCalled();
    });

    it('falls through (treats as valid) if the helper itself throws', async () => {
      // Defensive: the require() in auth.js is wrapped in try/catch so a
      // missing/broken helper doesn't fail-closed during early bootstrap.
      fakeDb.adminUsers.push({
        id: 1,
        username: 'admin',
        is_active: true,
        password_changed_at: null,
      });
      isSessionExpired.mockRejectedValue(new Error('boom'));
      const token = signAdminToken({ id: 1 });

      const res = await request(makeApp())
        .get('/auth/session')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
    });
  });
});
