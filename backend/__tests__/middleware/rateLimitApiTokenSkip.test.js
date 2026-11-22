/**
 * An API v1 token earns the general limiter's authenticated skip (issue
 * 2586), as an admin session does, but only a token apiTokenAuth would
 * accept: the row exists, is not revoked or expired, and its owner is active.
 * Anything else with the right prefix is counted. The skip rides on
 * rate_limit_skip_authenticated and only applies on /api/v1.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-ratelimit-apitoken-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'ratelimit-apitoken-secret-32-chars!!';

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');
const { shouldSkipRateLimit } = require('../../src/services/rateLimitService');
const { generateApiToken, apiTokenAuth } = require('../../src/middleware/apiTokenAuth');

const on = { enabled: true, skipAuthenticated: true, publicEndpointsOnly: false };
const off = { ...on, skipAuthenticated: false };
const req = (token, p = '/api/v1/transfers') => ({
  path: p, method: 'GET', cookies: {}, headers: { authorization: `Bearer ${token}` },
});

describe('general rate limiter skip for API tokens', () => {
  let db; let cleanup; let adminId;

  async function mint(extra = {}) {
    const generated = generateApiToken();
    await db('api_tokens').insert({ name: 'rl', hashed_token: generated.hashed, scopes: 'read', created_by: adminId, ...extra });
    return generated.plaintext;
  }

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId } = await seedMinimal(db));
  }, 120000);
  afterAll(async () => {
    await require('../../src/services/serviceShutdown').stopServices();
    if (cleanup) await cleanup();
  });
  afterEach(async () => {
    await db('admin_users').where({ id: adminId }).update({ is_active: 1, must_change_password: 0 });
  });

  it('skips a valid token on /api/v1 and records it on the request', async () => {
    const r = req(await mint());
    expect(await shouldSkipRateLimit(r, on)).toBe(true);
    expect(r.tokenType).toBe('api');
  });

  it('lets apiTokenAuth reuse the lookup instead of reading the token again', async () => {
    const token = await mint();
    const r = req(token);
    expect(await shouldSkipRateLimit(r, on)).toBe(true);
    const tokenReads = [];
    const onQuery = (q) => { if (/api_tokens/.test(q.sql) && /^select/i.test(q.sql)) tokenReads.push(q.sql); };
    db.on('query', onQuery);
    const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
    const next = jest.fn();
    try {
      await apiTokenAuth(r, res, next);
    } finally {
      db.removeListener('query', onQuery);
    }
    expect(next).toHaveBeenCalled();
    expect(r.admin.id).toBe(adminId);
    expect(tokenReads).toEqual([]);
  });

  it('counts a token with the right prefix and no row', async () => {
    expect(await shouldSkipRateLimit(req('pp_live_notarealtokenatallxxxxxxxxxxxxx'), on)).toBe(false);
    expect(await shouldSkipRateLimit(req('pp_live_'), on)).toBe(false);
  });

  it('counts a revoked or expired token', async () => {
    expect(await shouldSkipRateLimit(req(await mint({ revoked_at: new Date().toISOString() })), on)).toBe(false);
    expect(await shouldSkipRateLimit(req(await mint({ expires_at: new Date(Date.now() - 1000).toISOString() })), on)).toBe(false);
  });

  it('counts a token whose owner is deactivated or must change the password', async () => {
    const token = await mint();
    await db('admin_users').where({ id: adminId }).update({ is_active: 0 });
    expect(await shouldSkipRateLimit(req(token), on)).toBe(false);
    await db('admin_users').where({ id: adminId }).update({ is_active: 1, must_change_password: 1 });
    expect(await shouldSkipRateLimit(req(token), on)).toBe(false);
  });

  it('counts a valid token when the authenticated skip is switched off', async () => {
    expect(await shouldSkipRateLimit(req(await mint()), off)).toBe(false);
  });

  it('counts a valid token outside /api/v1, where it authenticates nothing', async () => {
    expect(await shouldSkipRateLimit(req(await mint(), '/api/admin/events'), on)).toBe(false);
  });

  it('still counts the auth endpoints', async () => {
    expect(await shouldSkipRateLimit(req(await mint(), '/api/v1/auth'), on)).toBe(false);
  });
});
