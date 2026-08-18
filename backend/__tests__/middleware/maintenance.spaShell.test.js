/**
 * Regression test for the maintenance-mode lockout in single-container mode.
 *
 * In the compose stack nginx serves the frontend, so a request for /admin/login
 * or /gallery/<slug> never reaches Express. The all-in-one image (#1042) has no
 * nginx: server.js serves the SPA itself, and maintenanceMiddleware is mounted
 * far ahead of that static block. Gating those paths therefore answered the
 * HTML document with 503 JSON, which broke two things at once —
 *
 *   1. an admin who enabled maintenance mode could never disable it, because
 *      /admin/login and its /assets/ bundle would not load (the login *API* was
 *      already exempt, but nothing could call it), and
 *   2. a guest saw raw JSON instead of the branded maintenance screen the
 *      frontend already ships.
 *
 * The shell is inert HTML: it boots, calls /api/public/settings (exempt) and
 * renders MaintenanceMode itself, so letting it through costs nothing.
 *
 * The dividing line is taken from frontend/nginx.conf rather than invented:
 * paths nginx answers from the frontend container are exempt, paths it
 * proxy_passes to the backend stay gated. That makes the all-in-one image
 * behave exactly like compose in both directions. The gated half is where the
 * risk lives — a negative "everything that is not an API is a shell" rule
 * looks right and quietly un-gates /og/ (event names, cover images) and the
 * public CMS at the site root — so most of the cases below assert it.
 */

const { maintenanceMiddleware } = require('../../src/middleware/maintenance');

jest.mock('../../src/database/db', () => {
  const settings = { setting_key: 'general_maintenance_mode', setting_value: 'true' };
  const db = jest.fn(() => ({
    where: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(settings),
  }));
  return { db };
});
jest.mock('../../src/utils/logger', () => ({
  error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(),
}));

// Maintenance state is cached for a minute; each case starts from a clean read.
const { clearMaintenanceCache } = require('../../src/middleware/maintenance');

async function run(path, { method = 'GET', authorization } = {}) {
  clearMaintenanceCache();
  const req = { path, method, headers: authorization ? { authorization } : {} };
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  const next = jest.fn();
  await maintenanceMiddleware(req, res, next);
  return { passed: next.mock.calls.length === 1, status: res.statusCode, body: res.body };
}

describe('maintenanceMiddleware — SPA shell vs API split', () => {
  describe('passes the frontend shell through so the branded screen can render', () => {
    it.each([
      ['/admin', 'admin shell entry'],
      ['/admin/login', 'the page that calls the exempt login API'],
      ['/assets/index-abc123.js', 'hashed bundle the shell loads'],
      ['/gallery/some-event', 'guest gallery route'],
      ['/customer/portal', 'customer portal route'],
    ])('%s (%s)', async (path) => {
      const { passed } = await run(path);
      expect(passed).toBe(true);
    });
  });

  describe('still gates everything that is not a shell', () => {
    it.each([
      ['/api/gallery/some-event/verify', 'public gallery API'],
      ['/api/photos/1', 'photo API'],
      ['/photos/anything.jpg', 'backend-owned photo mount'],
      ['/thumbnails/anything.jpg', 'backend-owned thumbnail mount'],
      ['/fonts/anything.woff2', 'backend-owned font mount'],
      // nginx proxy_passes these to the backend, so compose gates them today
      // and the all-in-one image must not be the one deployment that does not.
      ['/', 'site root — nginx `location = /` hands this to the public CMS'],
      ['/og/gallery/some-event', 'OG renderer: leaks the event name'],
      ['/og/gallery/some-event/cover', 'OG cover: leaks the hero thumbnail'],
      ['/s/abc123', 'short-link renderer'],
      ['/robots.txt', 'proxied one-to-one by nginx'],
      ['/favicon.ico', 'proxied one-to-one by nginx'],
    ])('%s (%s) returns 503', async (path) => {
      const { passed, status, body } = await run(path);
      expect(passed).toBe(false);
      expect(status).toBe(503);
      expect(body).toMatchObject({ maintenance: true });
    });

    it('does not let a non-GET request masquerade as a shell load', async () => {
      const { passed, status } = await run('/api/gallery/some-event/verify', { method: 'POST' });
      expect(passed).toBe(false);
      expect(status).toBe(503);
    });
  });

  describe('keeps the pre-existing admin exemptions', () => {
    it('admin login API stays reachable', async () => {
      expect((await run('/api/auth/admin/login', { method: 'POST' })).passed).toBe(true);
    });

    it('/api/public/settings stays reachable so the shell can read the flag', async () => {
      expect((await run('/api/public/settings')).passed).toBe(true);
    });

    it('an authenticated admin still reaches /api/admin', async () => {
      const { passed } = await run('/api/admin/events', { authorization: 'Bearer token' });
      expect(passed).toBe(true);
    });

    it('an unauthenticated /api/admin request is not served by this middleware', async () => {
      // isAdminRoute suppresses the 503 so the auth layer can answer 401.
      const { passed, status } = await run('/api/admin/events');
      expect(passed).toBe(true);
      expect(status).toBeNull();
    });
  });
});
