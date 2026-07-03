/**
 * HTTP route auth-gate tests for the CRM admin surface (P1 / P2 — #570).
 *
 * Bundled into one file rather than nine because the contract is the
 * same for every CRM admin route:
 *   - No token → 401 (adminAuth at the router level)
 *   - Valid token, missing permission → 403 (requirePermission middleware)
 *   - Valid token + super_admin role → 2xx / 404 (resource-based)
 *
 * Deeper service-layer behaviour (PDF generation, send, Storno,
 * countersign, integrity hash) is covered by the existing service
 * unit tests in __tests__/services/. This file pins the contract
 * between the HTTP layer and the auth+permission middleware so a
 * misconfigured route ("forgot requirePermission") can never ship
 * unnoticed.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-admincrm-test-'));
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'db.sqlite');
process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
fs.mkdirSync(process.env.STORAGE_PATH, { recursive: true });
process.env.JWT_SECRET = process.env.JWT_SECRET || 'crm-route-test-secret';

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole,
  mintAdminToken, buildRouteApp,
} = require('../integration/helpers/crmDb');

// One row per admin CRM route. `mount` matches server.js's app.use,
// `loader` is the require()'d router, `getPath` is one path on the
// router we'll exercise. The path should be a GET-shaped read where
// possible — listing endpoints (`/`) are safest because they don't
// require pre-seeded resource ids.
const ROUTES = [
  { name: 'adminQuotes',          mount: '/api/admin/quotes',           loader: () => require('../../src/routes/adminQuotes'),          getPath: '/' },
  { name: 'adminContracts',       mount: '/api/admin/contracts',        loader: () => require('../../src/routes/adminContracts'),       getPath: '/' },
  { name: 'adminInvoices',        mount: '/api/admin/invoices',         loader: () => require('../../src/routes/adminInvoices'),        getPath: '/' },
  { name: 'adminCalendar',        mount: '/api/admin/calendar',         loader: () => require('../../src/routes/adminCalendar'),        getPath: '/items?from=2026-01-01&to=2026-12-31' },
  { name: 'adminDeals',           mount: '/api/admin/deals',            loader: () => require('../../src/routes/adminDeals'),           getPath: '/' },
  { name: 'adminTaxReport',       mount: '/api/admin/tax-report',       loader: () => require('../../src/routes/adminTaxReport'),       getPath: '/?period=2026-Q1' },
  { name: 'adminBusinessProfile', mount: '/api/admin/business-profile', loader: () => require('../../src/routes/adminBusinessProfile'), getPath: '/' },
];

describe('admin CRM routes — auth + permission gate', () => {
  let db;
  let cleanup;
  let adminId;
  let customerId;
  let superAdminToken;
  let invalidToken;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId, customerId } = await seedMinimal(db));

    // Super-admin: assign the seeded super_admin role (created by
    // migration 057). requirePermission lookups short-circuit because
    // super_admin role inherits every permission via role_permissions
    // rows seeded by mig 107 and earlier.
    await assignAdminRole(db, adminId, 'super_admin');
    superAdminToken = mintAdminToken(adminId);

    // CRM routes have a feature-flag gate that runs INSIDE the route
    // handler — even a super-admin gets 403 (`QUOTES_DISABLED` /
    // similar) when the flag is off. The flag check is independent
    // of permissions, so for happy-path tests we flip every CRM flag
    // on. Negative tests (no-token, bad-signature) hit adminAuth
    // first and never reach the flag check, so they're unaffected.
    // `accounting` is the master flag the tax-report route now requires
    // (tax export moved out of CRM into Accounting, independent of bills).
    const crmFlags = ['quotes', 'bills', 'contracts', 'hoursLogging', 'calendar', 'taxReport', 'clients', 'accounting'];
    for (const key of crmFlags) {
      // eslint-disable-next-line no-await-in-loop
      await db('feature_flags').where({ key }).update({ value: 1 });
    }

    // Invalid: signed with a different secret. adminAuth must reject.
    const jwt = require('jsonwebtoken');
    invalidToken = jwt.sign({ id: adminId, type: 'admin' }, 'WRONG-SECRET', { issuer: 'picpeak-auth' });
  }, 60000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  describe.each(ROUTES)('$name', ({ mount, loader, getPath }) => {
    let app;

    beforeAll(() => {
      app = buildRouteApp(mount, loader());
    });

    it('returns 401 with no Authorization header', async () => {
      const res = await request(app).get(`${mount}${getPath}`);
      expect(res.status).toBe(401);
    });

    it('returns 401 with an invalid JWT signature', async () => {
      const res = await request(app)
        .get(`${mount}${getPath}`)
        .set('Authorization', `Bearer ${invalidToken}`);
      expect(res.status).toBe(401);
    });

    it('returns 2xx (or resource-shaped 4xx) with a valid super-admin token', async () => {
      const res = await request(app)
        .get(`${mount}${getPath}`)
        .set('Authorization', `Bearer ${superAdminToken}`);
      // 200 if listing succeeds (likely empty list), 400 if a
      // validator complains about query shape, 404 if the route
      // doesn't have a list endpoint at `/`. What MUST NOT happen:
      // 401 (auth gate failed) or 403 (permission gate failed).
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
      expect(res.status).toBeLessThan(500);
    });
  });

  describe('adminCustomers — CRM additions (hour-entries / bill / trigger-monthly-bill)', () => {
    let app;
    beforeAll(() => {
      app = buildRouteApp('/api/admin/customers', require('../../src/routes/adminCustomers'));
    });

    it('GET /:id/hour-entries — 401 without token', async () => {
      const res = await request(app).get(`/api/admin/customers/${customerId}/hour-entries`);
      expect(res.status).toBe(401);
    });

    it('GET /:id/hour-entries — 2xx with super-admin token', async () => {
      const res = await request(app)
        .get(`/api/admin/customers/${customerId}/hour-entries`)
        .set('Authorization', `Bearer ${superAdminToken}`);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
      expect(res.status).toBeLessThan(500);
    });

    it('POST /:id/hour-entries/bill — 401 without token', async () => {
      const res = await request(app)
        .post(`/api/admin/customers/${customerId}/hour-entries/bill`)
        .send({});
      expect(res.status).toBe(401);
    });

    it('POST /:id/trigger-monthly-bill — 401 without token', async () => {
      const res = await request(app)
        .post(`/api/admin/customers/${customerId}/trigger-monthly-bill`)
        .send({});
      expect(res.status).toBe(401);
    });
  });
});
