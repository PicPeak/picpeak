/**
 * The auth middleware verifies every token with `algorithms: ['HS256']` and
 * `issuer: 'picpeak-auth'`. The auxiliary path that hands out something on the
 * strength of a token (the "authenticated" rate-limit budget) must apply the
 * same rule, or a token adminAuth would refuse still buys that.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'issuer-aux-secret-at-least-32-characters-long';
jest.mock('../../src/database/db', () => ({ db: jest.fn() }));
// The skip now also requires a live session (revocation, account state, idle
// timeout); that is pinned elsewhere. Here only the JWT rules are under test.
jest.mock('../../src/services/sessionAccessService', () => ({ admin: async () => ({ id: 1, must_change_password: false }) }));

const jwt = require('jsonwebtoken');
const { isAuthenticated } = require('../../src/services/rateLimitService');

const iat = Math.floor(Date.now() / 1000) - 5;
const admin = (opts) => jwt.sign({ type: 'admin', id: 1, iat }, process.env.JWT_SECRET, opts);
const req = (token, path = '/api/admin/events') => ({ path, headers: { authorization: `Bearer ${token}` }, cookies: {} });

test('a properly issued admin token is recognised', async () => {
  const token = admin({ issuer: 'picpeak-auth', algorithm: 'HS256' });
  expect(await isAuthenticated(req(token))).toBe(true);
});

test('a token from another issuer does not buy the budget', async () => {
  const token = admin({ issuer: 'other', algorithm: 'HS256' });
  expect(await isAuthenticated(req(token))).toBe(false);
});

test('a token without any issuer is refused too', async () => {
  const token = admin({ algorithm: 'HS256' });
  expect(await isAuthenticated(req(token))).toBe(false);
});

test('a token signed with another HMAC algorithm is refused', async () => {
  const token = admin({ issuer: 'picpeak-auth', algorithm: 'HS512' });
  expect(await isAuthenticated(req(token))).toBe(false);
});
