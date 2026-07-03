/**
 * Unit tests for customerAuth middleware (#354 follow-up).
 *
 * Mirrors the parity-with-adminAuth invariants the maintainer flagged
 * during the PR #403 review:
 *   - Issuer-claim verify
 *   - Token revocation lookup
 *   - Wrong-token-type rejection
 *   - Missing-customer / inactive-customer rejection
 *   - password_changed_at invalidation
 *   - IP drift logged but not rejected
 *
 * The middleware reaches into the DB, the JWT verifier, the revocation
 * cache and the cookie helper — all four are mocked so this stays a
 * fast unit test (no postgres, no real JWTs).
 */

// --- mocks --------------------------------------------------------------
jest.mock('../database/db', () => {
  const mockDb = jest.fn();
  return { db: mockDb, logActivity: jest.fn() };
});

jest.mock('../utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

jest.mock('jsonwebtoken', () => ({
  verify: jest.fn(),
}));

jest.mock('../utils/tokenRevocation', () => ({
  isTokenRevoked: jest.fn(),
}));

jest.mock('../utils/tokenUtils', () => ({
  getCustomerTokenFromRequest: jest.fn(),
}));

jest.mock('../utils/dbCompat', () => ({
  formatBoolean: (v) => (v ? 1 : 0),
}));

const jwt = require('jsonwebtoken');
const { db } = require('../database/db');
const { isTokenRevoked } = require('../utils/tokenRevocation');
const { getCustomerTokenFromRequest } = require('../utils/tokenUtils');
const logger = require('../utils/logger');
const { customerAuth } = require('../middleware/customerAuth');

// Helper: build a minimal Express-shaped req/res/next trio. The
// middleware reads req.headers, req.cookies, req.ip etc.; res.status()
// returns res so the .json() chain works; next is a jest fn so we can
// assert it was/wasn't called.
function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}
function makeReq({ token = 'tkn', cookies = {}, headers = {}, originalUrl = '/api/customer/foo', ip = '1.2.3.4' } = {}) {
  return { headers: { authorization: undefined, ...headers }, cookies, originalUrl, ip, connection: { remoteAddress: ip } };
}

// Convenience: mock db('customer_accounts').where(...).select(...).first()
// to return the given row. The middleware uses `.where().select().first()`.
function mockCustomerLookup(row) {
  const q = {};
  q.where = jest.fn().mockReturnValue(q);
  q.select = jest.fn().mockReturnValue(q);
  q.first = jest.fn().mockResolvedValue(row);
  db.mockImplementationOnce(() => q);
  return q;
}

beforeEach(() => {
  db.mockReset();
  jwt.verify.mockReset();
  isTokenRevoked.mockReset();
  getCustomerTokenFromRequest.mockReset();
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.debug.mockClear();
  logger.error.mockClear();
});

// ---- no token ----------------------------------------------------------

describe('customerAuth — no token', () => {
  it('returns 401 with NO_TOKEN code when the helper returns null', async () => {
    getCustomerTokenFromRequest.mockReturnValue(null);
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await customerAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'NO_TOKEN' }),
    );
    // Maintainer-flagged: must be debug-level for unauthenticated probes.
    // (info-level was the prod-noise bug.)
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

// ---- JWT verification --------------------------------------------------

describe('customerAuth — JWT verification', () => {
  it('returns 401 TOKEN_EXPIRED when the JWT is expired', async () => {
    getCustomerTokenFromRequest.mockReturnValue('tkn');
    const err = new Error('jwt expired');
    err.name = 'TokenExpiredError';
    jwt.verify.mockImplementation(() => { throw err; });

    const res = makeRes();
    const next = jest.fn();
    await customerAuth(makeReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TOKEN_EXPIRED' }));
  });

  it('returns 401 JWT_INVALID on any other JWT error', async () => {
    getCustomerTokenFromRequest.mockReturnValue('tkn');
    const err = new Error('invalid signature');
    err.name = 'JsonWebTokenError';
    jwt.verify.mockImplementation(() => { throw err; });

    const res = makeRes();
    const next = jest.fn();
    await customerAuth(makeReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'JWT_INVALID' }));
  });

  it('passes the issuer claim to jwt.verify', async () => {
    getCustomerTokenFromRequest.mockReturnValue('tkn');
    // Make jwt.verify succeed with a customer payload so the test gets
    // past the verify step; we only care that the call shape is right.
    jwt.verify.mockReturnValue({
      payload: { type: 'customer', customerId: 1, iat: 1000 },
    });
    isTokenRevoked.mockResolvedValue(false);
    mockCustomerLookup({
      id: 1, email: 'c@example.com', display_name: null,
      first_name: null, last_name: null,
      password_changed_at: null, preferred_language: 'en',
    });

    await customerAuth(makeReq(), makeRes(), jest.fn());

    expect(jwt.verify).toHaveBeenCalledWith(
      'tkn',
      expect.anything(),
      expect.objectContaining({ issuer: 'picpeak-auth', complete: true }),
    );
  });
});

// ---- revocation --------------------------------------------------------

describe('customerAuth — revocation', () => {
  it('rejects revoked tokens with TOKEN_REVOKED', async () => {
    getCustomerTokenFromRequest.mockReturnValue('tkn');
    jwt.verify.mockReturnValue({
      payload: { type: 'customer', customerId: 1, iat: 1000 },
    });
    isTokenRevoked.mockResolvedValue(true);

    const res = makeRes();
    const next = jest.fn();
    await customerAuth(makeReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TOKEN_REVOKED' }));
  });
});

// ---- wrong token type --------------------------------------------------

describe('customerAuth — token type', () => {
  it('rejects an admin token with WRONG_TOKEN_TYPE', async () => {
    getCustomerTokenFromRequest.mockReturnValue('tkn');
    jwt.verify.mockReturnValue({
      payload: { type: 'admin', id: 99, iat: 1000 },
    });
    isTokenRevoked.mockResolvedValue(false);

    const res = makeRes();
    const next = jest.fn();
    await customerAuth(makeReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'WRONG_TOKEN_TYPE' }));
  });

  it('rejects a gallery token with WRONG_TOKEN_TYPE', async () => {
    getCustomerTokenFromRequest.mockReturnValue('tkn');
    jwt.verify.mockReturnValue({
      payload: { type: 'gallery', eventId: 1, iat: 1000 },
    });
    isTokenRevoked.mockResolvedValue(false);

    const res = makeRes();
    const next = jest.fn();
    await customerAuth(makeReq(), res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'WRONG_TOKEN_TYPE' }));
  });
});

// ---- customer existence + active check ---------------------------------

describe('customerAuth — customer lookup', () => {
  it('rejects when the customer row is missing', async () => {
    getCustomerTokenFromRequest.mockReturnValue('tkn');
    jwt.verify.mockReturnValue({
      payload: { type: 'customer', customerId: 1, iat: 1000 },
    });
    isTokenRevoked.mockResolvedValue(false);
    mockCustomerLookup(null); // not found

    const res = makeRes();
    const next = jest.fn();
    await customerAuth(makeReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CUSTOMER_NOT_FOUND' }));
  });

  it('rejects when the customer is inactive (the where-clause filters them out)', async () => {
    // Active filter is part of the query (.where({ ..., is_active: true })),
    // so an inactive customer surfaces as a missing row — same code path
    // as CUSTOMER_NOT_FOUND. This test guards the active filter itself
    // by asserting the where call shape.
    getCustomerTokenFromRequest.mockReturnValue('tkn');
    jwt.verify.mockReturnValue({
      payload: { type: 'customer', customerId: 1, iat: 1000 },
    });
    isTokenRevoked.mockResolvedValue(false);
    const q = mockCustomerLookup(null);

    await customerAuth(makeReq(), makeRes(), jest.fn());

    expect(q.where).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, is_active: 1 }),
    );
  });
});

// ---- password_changed_at invalidation ----------------------------------

describe('customerAuth — password_changed_at', () => {
  it('rejects tokens issued before password_changed_at with PASSWORD_CHANGED', async () => {
    getCustomerTokenFromRequest.mockReturnValue('tkn');
    // Token issued at unix 1000; password changed at 2000.
    jwt.verify.mockReturnValue({
      payload: { type: 'customer', customerId: 1, iat: 1000 },
    });
    isTokenRevoked.mockResolvedValue(false);
    mockCustomerLookup({
      id: 1, email: 'c@example.com', display_name: null,
      first_name: null, last_name: null,
      password_changed_at: new Date(2000 * 1000), // unix 2000
      preferred_language: 'en',
    });

    const res = makeRes();
    const next = jest.fn();
    await customerAuth(makeReq(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PASSWORD_CHANGED' }));
  });

  it('accepts tokens issued at exactly password_changed_at', async () => {
    // Boundary: iat === passwordChangedSeconds → the strict-less-than
    // check should NOT reject. Token is still valid in this edge case.
    getCustomerTokenFromRequest.mockReturnValue('tkn');
    jwt.verify.mockReturnValue({
      payload: { type: 'customer', customerId: 1, iat: 2000 },
    });
    isTokenRevoked.mockResolvedValue(false);
    mockCustomerLookup({
      id: 1, email: 'c@example.com', display_name: null,
      first_name: null, last_name: null,
      password_changed_at: new Date(2000 * 1000),
      preferred_language: 'en',
    });

    const next = jest.fn();
    await customerAuth(makeReq(), makeRes(), next);

    expect(next).toHaveBeenCalled();
  });

  it('accepts tokens when password_changed_at is null', async () => {
    getCustomerTokenFromRequest.mockReturnValue('tkn');
    jwt.verify.mockReturnValue({
      payload: { type: 'customer', customerId: 1, iat: 1000 },
    });
    isTokenRevoked.mockResolvedValue(false);
    mockCustomerLookup({
      id: 1, email: 'c@example.com', display_name: null,
      first_name: null, last_name: null,
      password_changed_at: null,
      preferred_language: 'en',
    });

    const next = jest.fn();
    await customerAuth(makeReq(), makeRes(), next);

    expect(next).toHaveBeenCalled();
  });
});

// ---- IP drift ----------------------------------------------------------

describe('customerAuth — IP drift', () => {
  it('logs but does not reject when token IP differs from request IP', async () => {
    // Mirrors adminAuth: customers may roam between mobile networks
    // mid-session, so IP drift is a log-and-continue, not a denial.
    getCustomerTokenFromRequest.mockReturnValue('tkn');
    jwt.verify.mockReturnValue({
      payload: { type: 'customer', customerId: 1, iat: 1000, ip: '8.8.8.8' },
    });
    isTokenRevoked.mockResolvedValue(false);
    mockCustomerLookup({
      id: 1, email: 'c@example.com', display_name: null,
      first_name: null, last_name: null,
      password_changed_at: null,
      preferred_language: 'en',
    });

    const next = jest.fn();
    await customerAuth(makeReq({ ip: '4.4.4.4' }), makeRes(), next);

    expect(next).toHaveBeenCalled();
    // The drift line uses logger.info on adminAuth and customerAuth;
    // we don't assert level here, just that something was logged.
    expect(logger.info).toHaveBeenCalled();
  });
});

// ---- happy path --------------------------------------------------------

describe('customerAuth — happy path', () => {
  it('attaches req.customer and calls next() on a valid token', async () => {
    getCustomerTokenFromRequest.mockReturnValue('tkn');
    jwt.verify.mockReturnValue({
      payload: { type: 'customer', customerId: 7, iat: 1000 },
    });
    isTokenRevoked.mockResolvedValue(false);
    mockCustomerLookup({
      id: 7,
      email: 'c@example.com',
      display_name: 'Charlie',
      first_name: 'Charlie',
      last_name: 'Customer',
      password_changed_at: null,
      preferred_language: 'de',
    });

    const req = makeReq();
    const next = jest.fn();
    await customerAuth(req, makeRes(), next);

    expect(next).toHaveBeenCalled();
    expect(req.customer).toEqual({
      id: 7,
      email: 'c@example.com',
      displayName: 'Charlie',
      firstName: 'Charlie',
      lastName: 'Customer',
      preferredLanguage: 'de',
    });
    expect(req.token).toBe('tkn');
  });

  it('defaults preferredLanguage to en when the column is null', async () => {
    getCustomerTokenFromRequest.mockReturnValue('tkn');
    jwt.verify.mockReturnValue({
      payload: { type: 'customer', customerId: 7, iat: 1000 },
    });
    isTokenRevoked.mockResolvedValue(false);
    mockCustomerLookup({
      id: 7, email: 'c@example.com',
      display_name: null, first_name: null, last_name: null,
      password_changed_at: null,
      preferred_language: null,
    });

    const req = makeReq();
    await customerAuth(req, makeRes(), jest.fn());

    expect(req.customer.preferredLanguage).toBe('en');
  });
});
