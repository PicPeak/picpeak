/**
 * Same bug class as GHSA-9q5j-vqfw-32hr (fixed in adminEvents/logo.js) —
 * the signed-PDF upload's multer `filename` callback built the stored
 * path directly from `req.params.id` with no integer validation:
 *
 *   filename: (req, file, cb) => {
 *     cb(null, `contract-${req.params.id}-${Date.now()}${ext}`);
 *   }
 *
 * `POST /:id/upload-signed-pdf` declares `param('id').isInt({ min: 1 })`,
 * but express-validator's check only runs inside the route handler via
 * validateRequest(req) — AFTER multer has already parsed the multipart
 * body and invoked the filename callback. A traversal payload in the raw
 * `:id` URL segment reaches multer completely unvalidated.
 *
 * Fixed by rejecting any non-positive-integer id before it is used to
 * build the filename, independent of the declared-but-too-late
 * express-validator check.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-contracts-signed-pdf-')), 'db.sqlite'
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'admin-contracts-signed-pdf-test-secret';

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('../integration/helpers/crmDb');

describe('POST /api/admin/contracts/:id/upload-signed-pdf — path traversal guard', () => {
  let db; let cleanup; let app; let adminId; let customerId; let token;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ adminId, customerId } = await seedMinimal(db));
    await assignAdminRole(db, adminId, 'super_admin');
    token = mintAdminToken(adminId);

    // Feature flag defaults OFF on a fresh install — the contracts
    // router 403s every route until it's on.
    await db('feature_flags').where({ key: 'contracts' }).update({ value: true });

    app = buildRouteApp('/api/admin/contracts', require('../../src/routes/adminContracts'));
  }, 120000);

  afterAll(async () => { await cleanup(); });

  const auth = (req) => req.set('Authorization', `Bearer ${token}`);
  const signedDir = () => path.join(process.env.STORAGE_PATH, 'uploads/contracts/signed');

  async function insertContract(over = {}) {
    const base = {
      contract_number: `K-TEST-${Math.random().toString(16).slice(2, 8)}`,
      customer_account_id: customerId,
      title: 'Test Contract',
      issue_date: new Date().toISOString().slice(0, 10),
      status: 'sent',
      language: 'de',
      created_at: new Date().toISOString(),
      ...over,
    };
    const inserted = await db('contracts').insert(base).returning('id');
    return inserted[0]?.id ?? inserted[0];
  }

  it('rejects a traversal payload in the id param instead of writing outside uploads/contracts/signed', async () => {
    // '../../../../tmp/pwned' URL-encoded so the raw request path still
    // has a single segment (matches Express's `:id`), but Express
    // decodes the param back into literal '../' sequences before the
    // route sees it.
    const traversalId = encodeURIComponent('../../../../tmp/pwned');

    const res = await auth(
      request(app).post(`/api/admin/contracts/${traversalId}/upload-signed-pdf`)
    ).attach('file', Buffer.from('%PDF-1.4 fake'), 'signed.pdf');

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error).toMatch(/invalid contract id/i);

    // No file should have been written anywhere — the filename callback
    // must error out before multer opens a write stream.
    const escapedFile = path.join(os.tmpdir(), 'pwned');
    expect(fs.existsSync(escapedFile)).toBe(false);
    if (fs.existsSync(signedDir())) {
      expect(fs.readdirSync(signedDir())).toHaveLength(0);
    }
  });

  it('still accepts a normal numeric contract id', async () => {
    const id = await insertContract();

    const res = await auth(
      request(app).post(`/api/admin/contracts/${id}/upload-signed-pdf`)
    ).attach('file', Buffer.from('%PDF-1.4 fake'), 'signed.pdf');

    expect(res.status).toBe(200);

    const files = fs.readdirSync(signedDir());
    expect(files.some((f) => f.startsWith(`contract-${id}-`))).toBe(true);

    const row = await db('contracts').where({ id }).first();
    expect(row.status).toBe('fully_signed');
    expect(row.signed_pdf_path).toMatch(new RegExp(`contract-${id}-`));
  });
});
