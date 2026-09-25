/**
 * The auth middleware verifies every token with `algorithms: ['HS256']` and
 * `issuer: 'picpeak-auth'`. The auxiliary paths that hand out something on the
 * strength of a token (a rate-limit skip, the "authenticated" budget) must
 * apply the same rule, or a token adminAuth would refuse still buys that.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'issuer-aux-secret-at-least-32-characters-long';
jest.mock('../../src/database/db', () => ({ db: jest.fn() }));

const jwt = require('jsonwebtoken');
const { isAuthenticated } = require('../../src/services/rateLimitService');
const { hasValidAdminToken } = require('../../src/utils/rateLimitSecurity');

const iat = Math.floor(Date.now() / 1000) - 5;
const admin = (opts) => jwt.sign({ type: 'admin', id: 1, iat }, process.env.JWT_SECRET, opts);
const req = (token, path = '/api/admin/events') => ({ path, headers: { authorization: `Bearer ${token}` }, cookies: {} });

test('a properly issued admin token is recognised by both paths', () => {
  const token = admin({ issuer: 'picpeak-auth', algorithm: 'HS256' });
  expect(isAuthenticated(req(token))).toBe(true);
  expect(hasValidAdminToken(req(token))).toBe(true);
});

test('a token from another issuer buys neither the budget nor the skip', () => {
  const token = admin({ issuer: 'other', algorithm: 'HS256' });
  expect(isAuthenticated(req(token))).toBe(false);
  expect(hasValidAdminToken(req(token))).toBe(false);
});

test('a token without any issuer is refused too', () => {
  const token = admin({ algorithm: 'HS256' });
  expect(isAuthenticated(req(token))).toBe(false);
  expect(hasValidAdminToken(req(token))).toBe(false);
});

test('a token signed with another HMAC algorithm is refused', () => {
  const token = admin({ issuer: 'picpeak-auth', algorithm: 'HS512' });
  expect(isAuthenticated(req(token))).toBe(false);
  expect(hasValidAdminToken(req(token))).toBe(false);
});
