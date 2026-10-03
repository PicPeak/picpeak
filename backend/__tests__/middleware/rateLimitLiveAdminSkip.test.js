/**
 * The general limiter's authenticated skip requires a live admin session,
 * not just a signature that verifies.
 *
 * Before, any signed, unexpired admin JWT skipped the per-IP budget until
 * its signed expiry — after logout, deactivation, a password change, a
 * global session cutoff, while a password change was mandatory, and after
 * the idle timeout. The skip now goes through the same checks adminAuth
 * applies (liveAdminSession). Scanner finding 4020ee96.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-ratelimit-live-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'ratelimit-live-secret-with-32-chars!!';

const { bootCrmDb, seedMinimal, mintAdminToken } = require('../integration/helpers/crmDb');
const { shouldSkipRateLimit } = require('../../src/services/rateLimitService');

const config = { enabled: true, skipAuthenticated: true, publicEndpointsOnly: false };
const req = (token) => ({ path: '/api/admin/events', method: 'GET', cookies: {}, headers: { authorization: `Bearer ${token}` } });

describe('general rate limiter skip requires a live admin session', () => {
  let db; let cleanup; let adminId;
  // Each case mints its own token (distinct jti) so the per-token eligibility
  // cache cannot carry a verdict across cases.
  const fresh = (extra = {}) => mintAdminToken(adminId, { expiresIn: '24h', extraClaims: { jti: crypto.randomUUID(), ...extra } });

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId } = await seedMinimal(db));
  }, 120000);
  afterAll(async () => {
    await require('../../src/services/serviceShutdown').stopServices();
    if (cleanup) await cleanup();
  });
  afterEach(async () => {
    await db('admin_users').where({ id: adminId }).update({ is_active: 1, password_changed_at: null, must_change_password: 0 });
    await require('../../src/utils/sessionCutoff').setSessionsValidAfter(0);
  });

  it('skips for a live session and records the token on the request', async () => {
    const r = req(fresh());
    expect(await shouldSkipRateLimit(r, config)).toBe(true);
    expect(r.tokenType).toBe('admin');
  });

  it('does not skip after logout (token revoked)', async () => {
    const token = fresh();
    await require('../../src/utils/tokenRevocation').revokeToken(token, 'test');
    expect(await shouldSkipRateLimit(req(token), config)).toBe(false);
  });

  it('does not skip after the account is deactivated', async () => {
    await db('admin_users').where({ id: adminId }).update({ is_active: 0 });
    expect(await shouldSkipRateLimit(req(fresh()), config)).toBe(false);
  });

  it('does not skip after a password change', async () => {
    const token = fresh({ iat: Math.floor(Date.now() / 1000) - 120 });
    await db('admin_users').where({ id: adminId }).update({ password_changed_at: new Date().toISOString() });
    expect(await shouldSkipRateLimit(req(token), config)).toBe(false);
  });

  it('does not skip after a global session cutoff', async () => {
    const token = fresh({ iat: Math.floor(Date.now() / 1000) - 120 });
    await require('../../src/utils/sessionCutoff').setSessionsValidAfter(Math.floor(Date.now() / 1000));
    expect(await shouldSkipRateLimit(req(token), config)).toBe(false);
  });

  it('does not skip while a password change is mandatory', async () => {
    await db('admin_users').where({ id: adminId }).update({ must_change_password: 1 });
    expect(await shouldSkipRateLimit(req(fresh()), config)).toBe(false);
  });

  it('does not skip after the idle timeout', async () => {
    expect(await shouldSkipRateLimit(req(fresh({ iat: Math.floor(Date.now() / 1000) - 7200 })), config)).toBe(false);
  });

  it('reuses the verdict for the same token within the cache window', async () => {
    const token = fresh();
    expect(await shouldSkipRateLimit(req(token), config)).toBe(true);
    const seen = [];
    const onQuery = (q) => { if (/admin_users|revoked_tokens/.test(q.sql)) seen.push(q.sql); };
    db.on('query', onQuery);
    try {
      expect(await shouldSkipRateLimit(req(token), config)).toBe(true);
      expect(seen).toHaveLength(0);
    } finally {
      db.removeListener('query', onQuery);
    }
  });
});
