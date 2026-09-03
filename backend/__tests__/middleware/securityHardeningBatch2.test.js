/**
 * Second security sweep on the same branch as the password-strength DoS fix.
 * Each block pins one gap the audit found:
 *
 *  - maintenance gate classified paths case-sensitively while Express routes
 *    case-insensitively, so /API/... bypassed maintenance mode
 *  - the general rate limiter skipped anyone holding ANY verified JWT,
 *    including a gallery token minted for free on password-less galleries
 *  - the admin gallery preview trusted a verified signature alone, ignoring
 *    revocation, deactivation and password changes
 *  - the multipart branch of the CSRF Content-Type gate accepted cross-site
 *    form posts
 */
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'hardening-batch2-secret';

const fake = { maintenance: 'true', revoked: false, beforeCutoff: false, admin: { id: 1, password_changed_at: null } };

jest.mock('../../src/database/db', () => {
  const db = jest.fn((table) => {
    const q = {
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      first: jest.fn(async () => {
        if (table === 'app_settings') {
          return { setting_key: 'general_maintenance_mode', setting_value: fake.maintenance };
        }
        if (table === 'admin_users') return fake.admin;
        return null;
      }),
    };
    return q;
  });
  return { db, withRetry: (fn) => fn() };
});
jest.mock('../../src/utils/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/utils/tokenRevocation', () => ({ isTokenRevoked: jest.fn(async () => fake.revoked) }));
jest.mock('../../src/utils/sessionCutoff', () => ({ isTokenBeforeCutoff: jest.fn(async () => fake.beforeCutoff) }));
jest.mock('../../src/utils/frontendUrl', () => ({ getFrontendBaseUrlSync: () => 'https://photos.example.com' }));

const { maintenanceMiddleware, clearMaintenanceCache } = require('../../src/middleware/maintenance');
const { isAuthenticated } = require('../../src/services/rateLimitService');
const { verifyAdminPreview, isAdminPreview } = require('../../src/middleware/gallery');
const { multipartOriginAllowed } = require('../../src/utils/requestOrigin');

const iat = Math.floor(Date.now() / 1000) - 10;
const adminToken = (extra = {}) => jwt.sign({ type: 'admin', id: 1, iat, ...extra }, process.env.JWT_SECRET, { issuer: 'picpeak-auth' });
const galleryToken = () => jwt.sign({ type: 'gallery', eventId: 1, iat }, process.env.JWT_SECRET, { issuer: 'picpeak-auth' });

describe('maintenance gate is case-insensitive', () => {
  async function run(path) {
    clearMaintenanceCache();
    const req = { path, method: 'GET', headers: {} };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    const next = jest.fn();
    await maintenanceMiddleware(req, res, next);
    return next.mock.calls.length === 1;
  }
  it('gates /API/gallery/... exactly like /api/gallery/...', async () => {
    expect(await run('/api/gallery/x/download-all')).toBe(false);
    expect(await run('/API/gallery/x/download-all')).toBe(false);
    expect(await run('/Og/gallery/x')).toBe(false);
  });
});

describe('general rate limiter skip', () => {
  const req = (token) => ({ path: '/api/gallery/x/photos', headers: { authorization: `Bearer ${token}` }, cookies: {} });
  it('is granted to an admin session', () => {
    expect(isAuthenticated(req(adminToken()))).toBe(true);
  });
  it('is NOT granted to a gallery token', () => {
    expect(isAuthenticated(req(galleryToken()))).toBe(false);
  });
});

describe('admin preview requires a live admin session', () => {
  const req = (token) => ({ query: { admin_preview: '1' }, cookies: { admin_token: token }, headers: {} });
  beforeEach(() => { fake.revoked = false; fake.beforeCutoff = false; fake.admin = { id: 1, password_changed_at: null }; });

  it('passes for a live session and sets req.isAdminPreview', async () => {
    const r = req(adminToken());
    expect(isAdminPreview(r)).toBe(true);
    expect(await verifyAdminPreview(r)).toBe(true);
    expect(r.isAdminPreview).toBe(true);
  });
  it('fails for a revoked token', async () => {
    fake.revoked = true;
    const r = req(adminToken());
    expect(await verifyAdminPreview(r)).toBe(false);
    expect(r.isAdminPreview).toBeUndefined();
  });
  it('fails after the restore cutoff', async () => {
    fake.beforeCutoff = true;
    expect(await verifyAdminPreview(req(adminToken()))).toBe(false);
  });
  it('fails for a deactivated or deleted admin', async () => {
    fake.admin = null;
    expect(await verifyAdminPreview(req(adminToken()))).toBe(false);
  });
  it('fails for a token minted before the last password change', async () => {
    fake.admin = { id: 1, password_changed_at: new Date((iat + 5) * 1000).toISOString() };
    expect(await verifyAdminPreview(req(adminToken()))).toBe(false);
  });
});

describe('multipart origin gate', () => {
  const req = (headers) => ({ headers: { host: 'photos.example.com', ...headers } });
  it('accepts same-origin, same-site and non-browser requests', () => {
    expect(multipartOriginAllowed(req({ 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(multipartOriginAllowed(req({ 'sec-fetch-site': 'same-site' }))).toBe(true);
    expect(multipartOriginAllowed(req({ 'sec-fetch-site': 'none' }))).toBe(true);
    expect(multipartOriginAllowed(req({}))).toBe(true);
    expect(multipartOriginAllowed(req({ origin: 'https://photos.example.com' }))).toBe(true);
    // Same-origin install without FRONTEND_URL: Origin matches the Host.
    expect(multipartOriginAllowed({ headers: { host: 'gallery.local', origin: 'http://gallery.local' } })).toBe(true);
  });
  it('rejects cross-site form posts', () => {
    expect(multipartOriginAllowed(req({ 'sec-fetch-site': 'cross-site' }))).toBe(false);
    expect(multipartOriginAllowed(req({ origin: 'https://evil.example' }))).toBe(false);
    expect(multipartOriginAllowed(req({ origin: 'null' }))).toBe(false);
  });
});
