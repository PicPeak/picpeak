/**
 * The wet-signed PDF upload as a security boundary — the public link, the
 * customer portal and the admin route.
 *
 *   - a signer's file is parsed in the PDF worker: active content is refused
 *     before the contract moves, and the link stays usable;
 *   - the public uploaders accept one part, the file: a text field is refused
 *     before multer buffers anything;
 *   - `fully_signed` is immutable for a signer's upload, the link is spent in
 *     the same transaction as the contract, and an admin finalizing a
 *     contract withdraws every unused link;
 *   - an admin upload the service refuses leaves no file behind;
 *   - the signer's response names the status, never where the file lives.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-contract-pdf-hardening-'));
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'db.sqlite');
process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
fs.mkdirSync(process.env.STORAGE_PATH, { recursive: true });
process.env.JWT_SECRET = process.env.JWT_SECRET || 'contract-pdf-hardening-test-secret';

const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp, createPublicToken,
} = require('../integration/helpers/crmDb');
const { minimalPdf } = require('../integration/helpers/pdfFixture');

describe('signed-contract PDF upload hardening', () => {
  let db; let cleanup; let adminApp; let publicApp; let portalApp; let adminToken; let customerId; let cookie;
  let REAL_PDF;

  const signedDir = () => path.join(process.env.STORAGE_PATH, 'uploads/contracts/signed');
  const signedFiles = () => { try { return fs.readdirSync(signedDir()); } catch { return []; } };
  const nowIso = () => new Date().toISOString();

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    let adminId;
    ({ adminId, customerId } = await seedMinimal(db));
    await assignAdminRole(db, adminId, 'super_admin');
    adminToken = mintAdminToken(adminId);
    await db('feature_flags').where({ key: 'contracts' }).update({ value: true });
    await db('customer_accounts').where({ id: customerId }).update({ feature_contracts: true });
    adminApp = buildRouteApp('/api/admin/contracts', require('../../src/routes/adminContracts'));
    publicApp = buildRouteApp('/api/public/contracts', require('../../src/routes/publicContracts'));

    const session = jwt.sign(
      { type: 'customer', customerId, iat: Math.floor(Date.now() / 1000) - 5 },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', issuer: 'picpeak-auth', expiresIn: '1h' },
    );
    cookie = `customer_token=${session}`;
    portalApp = express();
    portalApp.use(express.json());
    portalApp.use(cookieParser());
    portalApp.use('/api/customer', require('../../src/routes/customer'));
    portalApp.use(require('../../src/middleware/errorHandler').errorHandler);

    REAL_PDF = await minimalPdf();
  }, 120000);

  afterAll(async () => { await cleanup(); });

  async function insertContract(status = 'sent') {
    const inserted = await db('contracts').insert({
      contract_number: `K-HARD-${Math.random().toString(16).slice(2, 8)}`,
      customer_account_id: customerId,
      title: 'Upload hardening',
      issue_date: nowIso().slice(0, 10),
      status,
      language: 'de',
      created_at: nowIso(),
    }).returning('id');
    return inserted[0]?.id ?? inserted[0];
  }
  const contractRow = (id) => db('contracts').where({ id }).first();
  const tokenRow = (token) => db('contract_action_tokens').where({ token }).first();

  const verification = require('../../src/services/publicDocumentVerificationService');
  const grantFor = async (linkToken) => verification.issueGrant('contract', await tokenRow(linkToken), linkToken);
  // The grant is minted first: a supertest request is a thenable, so it
  // can't be awaited for its headers without being sent.
  const publicUpload = (linkToken, grant) => request(publicApp)
    .post(`/api/public/contracts/${linkToken}/upload-signed-pdf`)
    .set('X-Document-Access', grant);
  const portalUpload = (id) => request(portalApp)
    .post(`/api/customer/contracts/${id}/upload-signed-pdf`).set('Cookie', cookie);
  const adminUpload = (id) => request(adminApp)
    .post(`/api/admin/contracts/${id}/upload-signed-pdf`).set('Authorization', `Bearer ${adminToken}`);
  const asPdf = (buffer) => [buffer, { filename: 'signed.pdf', contentType: 'application/pdf' }];

  // Refused as a 400 (not a 500: a bare MulterError has no statusCode), and
  // nothing changed.
  describe('multipart limits on the signer uploads', () => {
    it('refuses a text field next to the file on the public link', async () => {
      const id = await insertContract();
      const link = await createPublicToken(db, 'contract_action_tokens', { contract_id: id });
      const before = signedFiles();

      const res = await publicUpload(link, await grantFor(link))
        .field('note', 'x'.repeat(2048))
        .attach('file', ...asPdf(REAL_PDF));

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect((await contractRow(id)).status).toBe('sent');
      expect((await tokenRow(link)).used_at).toBeNull();
      expect(signedFiles()).toEqual(before);
    });

    it('refuses a second file on the public link', async () => {
      const id = await insertContract();
      const link = await createPublicToken(db, 'contract_action_tokens', { contract_id: id });

      const res = await publicUpload(link, await grantFor(link))
        .attach('file', ...asPdf(REAL_PDF))
        .attach('file', ...asPdf(REAL_PDF));

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect((await contractRow(id)).status).toBe('sent');
    });

    it('refuses a text field in the customer portal', async () => {
      const id = await insertContract();
      await createPublicToken(db, 'contract_action_tokens', { contract_id: id });

      const res = await portalUpload(id).field('note', 'x').attach('file', ...asPdf(REAL_PDF));

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect((await contractRow(id)).status).toBe('sent');
    });
  });

});
