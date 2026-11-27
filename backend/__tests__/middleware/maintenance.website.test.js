/**
 * Website builder paths in maintenance mode (issue 2618). nginx proxies them
 * to the backend like `/`, so they are gated like `/`: a published page,
 * the sitemap and the website's images are not served while the site is
 * down. With the builder off, a slug-shaped path is the SPA shell as before
 * (a CMS page, the not-found page). The editor's preview is an admin API call
 * and stays reachable.
 */
const mockFlag = jest.fn(async () => true);
jest.mock('../../src/middleware/requireFeatureFlag', () => ({ isFeatureEnabled: (key) => mockFlag(key) }));
jest.mock('../../src/database/db', () => {
  const settings = { setting_key: 'general_maintenance_mode', setting_value: 'true' };
  const db = jest.fn(() => ({ where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(settings) }));
  return { db };
});
jest.mock('../../src/utils/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }));

const { maintenanceMiddleware, clearMaintenanceCache } = require('../../src/middleware/maintenance');

async function run(path, { method = 'GET', authorization } = {}) {
  clearMaintenanceCache();
  const req = { path, method, headers: authorization ? { authorization } : {} };
  const res = { statusCode: null, status(code) { this.statusCode = code; return this; }, json() { return this; } };
  const next = jest.fn();
  await maintenanceMiddleware(req, res, next);
  return { passed: next.mock.calls.length === 1, status: res.statusCode };
}

beforeEach(() => mockFlag.mockClear());

test.each(['/about', '/about/', '/sitemap.xml', '/site-media/p1.0123456789abcdef0123456789abcdef/640'])('%s is gated like the site root', async (path) => {
  expect(await run(path)).toEqual({ passed: false, status: 503 });
});

test('the app\'s own single-segment paths stay the SPA shell', async () => {
  for (const path of ['/admin', '/impressum', '/setup', '/book']) {
    // eslint-disable-next-line no-await-in-loop
    expect((await run(path)).passed).toBe(true);
  }
});

test('with the builder off a slug-shaped path is the SPA shell, as before', async () => {
  mockFlag.mockResolvedValue(false);
  expect((await run('/about')).passed).toBe(true);
  mockFlag.mockResolvedValue(true);
});

test('the editor preview, an admin API call, still works', async () => {
  expect((await run('/api/admin/website/preview', { method: 'POST', authorization: 'Bearer x' })).passed).toBe(true);
});
