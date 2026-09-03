/**
 * Second security sweep on the same branch as the password-strength DoS fix
 * (stable port: the maintenance and admin-preview cases do not apply here).
 * Each block pins one gap the audit found:
 *
 *  - the general rate limiter skipped anyone holding ANY verified JWT,
 *    including a gallery token minted for free on password-less galleries
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
process.env.FRONTEND_URL = 'https://photos.example.com';

const { isAuthenticated } = require('../../src/services/rateLimitService');
const { multipartOriginAllowed } = require('../../src/utils/requestOrigin');

const iat = Math.floor(Date.now() / 1000) - 10;
const adminToken = (extra = {}) => jwt.sign({ type: 'admin', id: 1, iat, ...extra }, process.env.JWT_SECRET, { issuer: 'picpeak-auth' });
const galleryToken = () => jwt.sign({ type: 'gallery', eventId: 1, iat }, process.env.JWT_SECRET, { issuer: 'picpeak-auth' });

describe('general rate limiter skip', () => {
  const req = (token) => ({ path: '/api/gallery/x/photos', headers: { authorization: `Bearer ${token}` }, cookies: {} });
  it('is granted to an admin session', () => {
    expect(isAuthenticated(req(adminToken()))).toBe(true);
  });
  it('is NOT granted to a gallery token', () => {
    expect(isAuthenticated(req(galleryToken()))).toBe(false);
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
