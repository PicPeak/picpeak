/**
 * The admin countersignature records only the trusted client address.
 *
 * The route stored `req.ip || req.headers['x-forwarded-for']`: whenever
 * Express could not resolve an address, the evidence took whatever the
 * caller put in X-Forwarded-For. Every other signing path already used
 * clientIpForAudit(req), which trusts req.ip as resolved through
 * `trust proxy` and nothing else.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-countersign-ip-test-'));
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'db.sqlite');
process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
fs.mkdirSync(process.env.STORAGE_PATH, { recursive: true });
process.env.JWT_SECRET = process.env.JWT_SECRET || 'crm-route-test-secret';

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken } = require('../integration/helpers/crmDb');

const SPOOFED = '203.0.113.99';

describe('admin countersignature IP', () => {
  let db;
  let cleanup;
  let token;

  const sentContract = async (number) => {
    const inserted = await db('contracts').insert({
      contract_number: number, customer_account_id: (await db('customer_accounts').first()).id,
      status: 'sent', language: 'de', issue_date: new Date().toISOString().slice(0, 10),
      created_at: new Date().toISOString(),
    }).returning('id');
    return inserted[0]?.id ?? inserted[0];
  };

  // Same trust-proxy default as server.js.
  const buildApp = (beforeRoutes) => {
    const app = express();
    app.set('trust proxy', 'loopback, linklocal, uniquelocal');
    app.use(express.json());
    app.use(cookieParser());
    if (beforeRoutes) app.use(beforeRoutes);
    app.use('/api/admin/contracts', require('../../src/routes/adminContracts'));
    app.use(require('../../src/middleware/errorHandler').errorHandler);
    return app;
  };

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId);
    token = mintAdminToken(adminId);
    const flag = await db('feature_flags').where({ key: 'contracts' }).first();
    if (flag) await db('feature_flags').where({ key: 'contracts' }).update({ value: true });
    else await db('feature_flags').insert({ key: 'contracts', value: true });
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  const countersign = (app, id) => request(app)
    .post(`/api/admin/contracts/${id}/countersign`)
    .set('Authorization', `Bearer ${token}`)
    .set('X-Forwarded-For', SPOOFED)
    .send({ name: 'Studio Admin' });

  it('stores nothing rather than a forged header when Express resolved no address', async () => {
    const id = await sentContract('K-IP-1');
    // A socket without a remote address (e.g. some proxy or unix-socket
    // setups) leaves req.ip undefined — the case the header fallback hit.
    const app = buildApp((req, res, next) => {
      Object.defineProperty(req, 'ip', { value: undefined, configurable: true });
      next();
    });

    const res = await countersign(app, id);

    expect(res.status).toBe(200);
    const row = await db('contracts').where({ id }).first();
    expect(row.signed_admin_ip).not.toBe(SPOOFED);
    expect(row.signed_admin_ip).toBeNull();
  });

  it('stores the address Express resolved, not the header', async () => {
    const id = await sentContract('K-IP-2');
    const resolved = '192.0.2.10';
    const app = buildApp((req, res, next) => {
      Object.defineProperty(req, 'ip', { value: resolved, configurable: true });
      next();
    });

    const res = await countersign(app, id);

    expect(res.status).toBe(200);
    expect((await db('contracts').where({ id }).first()).signed_admin_ip).toBe(resolved);
  });
});
