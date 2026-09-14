/**
 * HTTP route tests for backend/src/routes/publicContracts (P0 — #570).
 *
 * Four endpoints on the customer-facing surface:
 *   GET  /:token             — load contract for signing
 *   POST /:token/sign        — in-browser canvas signature submission
 *   POST /:token/upload-signed-pdf  — wet-signed PDF upload
 *   GET  /:token/pdf         — download the contract PDF
 *
 * Tests pin the publicTokenGuards.loadActionToken contract per
 * endpoint and a few endpoint-specific shape assertions. Deeper
 * service-layer behaviour (PDF generation, signature attachment,
 * integrity-hash compute) is covered by the contractService unit
 * tests; here we only assert the HTTP contract.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-pubcontracts-test-'));
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'db.sqlite');
process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
fs.mkdirSync(process.env.STORAGE_PATH, { recursive: true });
process.env.JWT_SECRET = process.env.JWT_SECRET || 'crm-route-test-secret';

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const { bootCrmDb, seedMinimal, createPublicToken, buildRouteApp } = require('../integration/helpers/crmDb');
const tokenGuards = require('../../src/utils/publicTokenGuards');
const { errorHandler } = require('../../src/middleware/errorHandler');

describe('publicContracts routes', () => {
  let db;
  let cleanup;
  let app;
  let appWithErrorHandler;
  let customerId;
  let contractId;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    ({ customerId } = await seedMinimal(db));
    const inserted = await db('contracts').insert({
      contract_number: 'K-TEST-0001',
      customer_account_id: customerId,
      title: 'Test Booking Confirmation',
      issue_date: new Date().toISOString().slice(0, 10),
      status: 'sent',
      language: 'de',
      created_at: new Date().toISOString(),
    }).returning('id');
    contractId = inserted[0]?.id ?? inserted[0];

    app = buildRouteApp('/api/public/contracts', require('../../src/routes/publicContracts'));

    // A second app instance wired to the REAL production error handler
    // (buildRouteApp's is a simplified stand-in that only reads
    // err.statusCode/err.status, which a bare MulterError doesn't set).
    // Used below to verify the actual 4xx contract end-to-end, not just
    // that multer aborted the request.
    appWithErrorHandler = express();
    appWithErrorHandler.use(express.json());
    appWithErrorHandler.use(cookieParser());
    appWithErrorHandler.use('/api/public/contracts', require('../../src/routes/publicContracts'));
    appWithErrorHandler.use(errorHandler);
  }, 120000);

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  beforeEach(() => {
    if (tokenGuards._internal?.badAttempts) tokenGuards._internal.badAttempts.clear();
  });

  describe('GET /:token', () => {
    it('returns 404 for an unknown well-formed token', async () => {
      const fakeToken = 'a'.repeat(64);
      const res = await request(app).get(`/api/public/contracts/${fakeToken}`);
      expect(res.status).toBe(404);
    });

    it('rejects malformed tokens with 400 before reaching the guard', async () => {
      const res = await request(app).get('/api/public/contracts/short');
      expect(res.status).toBe(400);
    });

    it('returns 410 for an expired token', async () => {
      const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const token = await createPublicToken(db, 'contract_action_tokens', {
        contract_id: contractId, expires_at: past,
      });
      const res = await request(app).get(`/api/public/contracts/${token}`);
      expect(res.status).toBe(410);
      expect(res.body.code).toBe('TOKEN_EXPIRED');
    });

    it('returns 200 with the contract payload for a valid token', async () => {
      const token = await createPublicToken(db, 'contract_action_tokens', {
        contract_id: contractId,
      });
      const res = await request(app).get(`/api/public/contracts/${token}`);
      expect(res.status).toBe(200);
      expect(res.body.contract).toBeDefined();
    });
  });

  describe('POST /:token/sign', () => {
    it('rejects missing required fields (name, accepted) with 400', async () => {
      const token = await createPublicToken(db, 'contract_action_tokens', {
        contract_id: contractId,
      });
      const res = await request(app)
        .post(`/api/public/contracts/${token}/sign`)
        .send({}); // missing name + accepted
      expect(res.status).toBe(400);
    });

    it('returns 404 for an unknown token on sign', async () => {
      const fakeToken = 'b'.repeat(64);
      const res = await request(app)
        .post(`/api/public/contracts/${fakeToken}/sign`)
        .send({ name: 'Jane Doe', accepted: true });
      // Either 404 (token not found) or service-level error mapped to
      // 4xx — what matters is the request didn't slip past validation.
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });
  });

  describe('POST /:token/upload-signed-pdf', () => {
    it('rejects malformed tokens with 400 before multer runs', async () => {
      const res = await request(app)
        .post('/api/public/contracts/bad-token/upload-signed-pdf')
        .attach('file', Buffer.from('%PDF-1.4 fake'), 'signed.pdf');
      expect(res.status).toBe(400);
    });

    it('returns 404 for an unknown but well-formed token', async () => {
      const fakeToken = 'c'.repeat(64);
      const res = await request(app)
        .post(`/api/public/contracts/${fakeToken}/upload-signed-pdf`)
        .attach('file', Buffer.from('%PDF-1.4 fake'), 'signed.pdf');
      expect(res.status).toBe(404);
    });

    // CVE-2026-82333 regression (#1374 follow-up): multer 2.3.0 added an
    // opt-in `fieldArrayIndexLimit` that must be set to actually close the
    // field-parser DoS — the version bump alone does nothing. This route is
    // unauthenticated (token-in-URL only), so it's the sharpest place to
    // prove a crafted request with an oversized array-index field name
    // (`evil[999999999]`) is rejected rather than accepted or left to hang.
    it('rejects a multipart request with an oversized array-index field name', async () => {
      const token = await createPublicToken(db, 'contract_action_tokens', {
        contract_id: contractId,
      });
      // With a grant, so the request actually reaches multer (the grant
      // check runs before it and would otherwise answer 401).
      const verification = require('../../src/services/publicDocumentVerificationService');
      const tokenRow = await db('contract_action_tokens').where({ token }).first();
      const res = await request(app)
        .post(`/api/public/contracts/${token}/upload-signed-pdf`)
        .set('X-Document-Access', verification.issueGrant('contract', tokenRow, token))
        .field('evil[999999999]', 'x')
        .attach('file', Buffer.from('%PDF-1.4 fake'), 'signed.pdf');
      // multer aborts the request before the handler runs; buildRouteApp's
      // generic error handler falls back to 500 for a bare MulterError
      // (see appWithErrorHandler test below for the real 4xx contract), so
      // here we only assert the upload was NOT accepted/processed.
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.error).not.toBe(undefined);
    });

    it('maps the oversized array-index rejection to a 400 through the real error handler', async () => {
      const token = await createPublicToken(db, 'contract_action_tokens', {
        contract_id: contractId,
      });
      const verification = require('../../src/services/publicDocumentVerificationService');
      const tokenRow = await db('contract_action_tokens').where({ token }).first();
      const res = await request(appWithErrorHandler)
        .post(`/api/public/contracts/${token}/upload-signed-pdf`)
        .set('X-Document-Access', verification.issueGrant('contract', tokenRow, token))
        .field('evil[999999999]', 'x')
        .attach('file', Buffer.from('%PDF-1.4 fake'), 'signed.pdf');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /:token/pdf', () => {
    it('returns 404 for an unknown token on PDF download', async () => {
      const fakeToken = 'd'.repeat(64);
      const res = await request(app).get(`/api/public/contracts/${fakeToken}/pdf`);
      expect(res.status).toBe(404);
    });

    it('returns 410 for an expired token on PDF download', async () => {
      const past = new Date(Date.now() - 1000);
      const token = await createPublicToken(db, 'contract_action_tokens', {
        contract_id: contractId, expires_at: past,
      });
      const res = await request(app).get(`/api/public/contracts/${token}/pdf`);
      expect(res.status).toBe(410);
      expect(res.body.code).toBe('TOKEN_EXPIRED');
    });
  });
});
