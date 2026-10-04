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
const { minimalPdf, javascriptPdf } = require('../integration/helpers/pdfFixture');

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

  describe('content checks on the signer uploads', () => {
    it('refuses a PDF with JavaScript on the public link, keeping the link and writing no file', async () => {
      const id = await insertContract();
      const link = await createPublicToken(db, 'contract_action_tokens', { contract_id: id });
      const before = signedFiles();

      const res = await publicUpload(link, await grantFor(link)).attach('file', ...asPdf(await javascriptPdf()));

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PDF_ACTIVE_CONTENT');
      expect((await contractRow(id)).status).toBe('sent');
      expect((await tokenRow(link)).used_at).toBeNull();
      expect(signedFiles()).toEqual(before);
    });

    it('refuses a PDF with JavaScript in the customer portal', async () => {
      const id = await insertContract();
      const link = await createPublicToken(db, 'contract_action_tokens', { contract_id: id });
      const before = signedFiles();

      const res = await portalUpload(id).attach('file', ...asPdf(await javascriptPdf()));

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PDF_ACTIVE_CONTENT');
      expect((await contractRow(id)).status).toBe('sent');
      expect((await tokenRow(link)).used_at).toBeNull();
      expect(signedFiles()).toEqual(before);
    });

    it('refuses a PDF whose xref resolves an object the scan did not keep', async () => {
      // The last definition of the catalog is harmless and is what pdf-lib
      // scans; the xref points at the first, which carries JavaScript. The
      // original bytes are kept for signer uploads, so the file is refused.
      const { duplicateObjectPdf } = require('../integration/helpers/pdfFixture');
      const id = await insertContract();
      const link = await createPublicToken(db, 'contract_action_tokens', { contract_id: id });
      const before = signedFiles();

      const res = await publicUpload(link, await grantFor(link)).attach('file', ...asPdf(duplicateObjectPdf()));

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PDF_AMBIGUOUS_OBJECTS');
      expect((await contractRow(id)).status).toBe('sent');
      expect((await tokenRow(link)).used_at).toBeNull();
      expect(signedFiles()).toEqual(before);
    });

    it('refuses a file that is only a PDF signature, not a document', async () => {
      const id = await insertContract();
      const link = await createPublicToken(db, 'contract_action_tokens', { contract_id: id });

      const res = await publicUpload(link, await grantFor(link)).attach('file', ...asPdf(Buffer.from('%PDF-1.4 signed')));

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PDF_MALFORMED');
      expect((await contractRow(id)).status).toBe('sent');
    });

    it('keeps the original bytes of an accepted PDF', async () => {
      const id = await insertContract();
      const link = await createPublicToken(db, 'contract_action_tokens', { contract_id: id });
      const bytes = await minimalPdf({ label: 'original bytes' });

      const res = await publicUpload(link, await grantFor(link)).attach('file', ...asPdf(bytes));

      expect(res.status).toBe(200);
      const row = await contractRow(id);
      const onDisk = fs.readFileSync(path.join(process.env.STORAGE_PATH, row.signed_pdf_path));
      expect(onDisk.equals(bytes)).toBe(true);
    });
  });

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

  describe('a finalized contract is immutable for a signer', () => {
    it('refuses a second link once the first upload finalized the contract, keeping the file on record', async () => {
      const id = await insertContract();
      const first = await createPublicToken(db, 'contract_action_tokens', { contract_id: id });
      const second = await createPublicToken(db, 'contract_action_tokens', { contract_id: id });

      expect((await publicUpload(first, await grantFor(first)).attach('file', ...asPdf(REAL_PDF))).status).toBe(200);
      const after = await contractRow(id);
      const before = signedFiles();

      const res = await publicUpload(second, await grantFor(second)).attach('file', ...asPdf(await minimalPdf({ label: 'second' })));

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONTRACT_ALREADY_SIGNED');
      const row = await contractRow(id);
      expect(row.signed_pdf_path).toBe(after.signed_pdf_path);
      expect(row.signed_pdf_sha256).toBe(after.signed_pdf_sha256);
      expect(signedFiles()).toEqual(before);
      expect((await tokenRow(second)).used_at).toBeNull();
    });

    it('refuses a customer upload after an admin finalized the contract with a paper copy', async () => {
      const id = await insertContract();
      const link = await createPublicToken(db, 'contract_action_tokens', { contract_id: id });

      expect((await adminUpload(id).attach('file', ...asPdf(REAL_PDF))).status).toBe(200);
      const after = await contractRow(id);
      expect(after.status).toBe('fully_signed');
      // The admin's finalization withdrew the customer's link.
      expect((await tokenRow(link)).used_at).not.toBeNull();

      // Through the portal: no live link, so not signable.
      const portal = await portalUpload(id).attach('file', ...asPdf(REAL_PDF));
      expect(portal.status).toBe(409);
      expect((await contractRow(id)).signed_pdf_path).toBe(after.signed_pdf_path);
    });

    it('an admin countersignature that completes the contract withdraws the unused links', async () => {
      const id = await insertContract('signed_by_customer');
      const link = await createPublicToken(db, 'contract_action_tokens', { contract_id: id });

      const res = await request(adminApp)
        .post(`/api/admin/contracts/${id}/countersign`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Studio Owner' });

      expect(res.status).toBe(200);
      expect((await contractRow(id)).status).toBe('fully_signed');
      expect((await tokenRow(link)).used_at).not.toBeNull();
    });

    it('the link is spent in the transaction that moves the contract: a spent link rolls the contract back', async () => {
      // A request admitted by the pre-multer guard, whose link another
      // request spent while its body was still being read.
      const id = await insertContract();
      const link = await createPublicToken(db, 'contract_action_tokens', { contract_id: id });
      const row = await tokenRow(link);
      await db('contract_action_tokens').where({ id: row.id }).update({ used_at: nowIso(), used_action: 'uploaded_signed_pdf' });
      fs.mkdirSync(signedDir(), { recursive: true });
      const file = path.join(signedDir(), `contract-${id}-race.pdf`);
      fs.writeFileSync(file, REAL_PDF);

      const contractService = require('../../src/services/contractService');
      await expect(contractService.attachSignedPdfUpload(id, file, 'customer', null, { actionToken: { id: row.id, ip: null } }))
        .rejects.toMatchObject({ code: 'TOKEN_ALREADY_USED' });

      const contract = await contractRow(id);
      expect(contract.status).toBe('sent');
      expect(contract.signed_pdf_path).toBeNull();
      expect(fs.existsSync(file)).toBe(false);
    });
  });

  describe('admin uploads the service refuses leave no file behind', () => {
    it('a contract that does not exist', async () => {
      const before = signedFiles();
      const res = await adminUpload(999999).attach('file', ...asPdf(REAL_PDF));
      expect(res.status).toBe(404);
      expect(signedFiles()).toEqual(before);
    });

    it.each(['draft', 'cancelled', 'expired', 'awaiting_data'])('a contract in status %s', async (status) => {
      const id = await insertContract(status);
      const before = signedFiles();
      const res = await adminUpload(id).attach('file', ...asPdf(REAL_PDF));
      expect(res.status).toBe(409);
      expect((await contractRow(id)).status).toBe(status);
      expect(signedFiles()).toEqual(before);
    });

    it('a committed upload is kept', async () => {
      const id = await insertContract();
      const res = await adminUpload(id).attach('file', ...asPdf(REAL_PDF));
      expect(res.status).toBe(200);
      const row = await contractRow(id);
      expect(fs.existsSync(path.join(process.env.STORAGE_PATH, row.signed_pdf_path))).toBe(true);
    });

    it('a committed upload is kept when the failure also takes the lookup down', async () => {
      // The service commits, something after it fails, and the catch block's
      // "did it commit?" lookup fails too: indeterminate, so the file stays.
      const id = await insertContract();
      const contractService = require('../../src/services/contractService');
      const real = contractService.attachSignedPdfUpload;
      jest.spyOn(contractService, 'attachSignedPdfUpload').mockImplementation(async (...args) => {
        await real(...args);
        await db.schema.renameTable('contracts', 'contracts_offline');
        throw new Error('post-commit failure');
      });
      let res;
      try {
        res = await adminUpload(id).attach('file', ...asPdf(REAL_PDF));
      } finally {
        jest.restoreAllMocks();
        await db.schema.renameTable('contracts_offline', 'contracts');
      }
      expect(res.status).toBe(500);
      const row = await contractRow(id);
      expect(row.status).toBe('fully_signed');
      expect(fs.existsSync(path.join(process.env.STORAGE_PATH, row.signed_pdf_path))).toBe(true);
    });
  });

  describe('the signer learns the status, not the storage path', () => {
    const noPathIn = (body) => {
      expect(body).toEqual({ status: 'fully_signed' });
      expect(JSON.stringify(body)).not.toContain(process.env.STORAGE_PATH);
      expect(JSON.stringify(body)).not.toMatch(/uploads\/contracts/);
    };

    it('on the public link', async () => {
      const id = await insertContract();
      const link = await createPublicToken(db, 'contract_action_tokens', { contract_id: id });
      const res = await publicUpload(link, await grantFor(link)).attach('file', ...asPdf(REAL_PDF));
      expect(res.status).toBe(200);
      noPathIn(res.body);
      // The row keeps a path relative to the storage root.
      expect((await contractRow(id)).signed_pdf_path).toMatch(/^uploads\/contracts\/signed\/contract-\d+-/);
    });

    it('in the customer portal', async () => {
      const id = await insertContract();
      await createPublicToken(db, 'contract_action_tokens', { contract_id: id });
      const res = await portalUpload(id).attach('file', ...asPdf(REAL_PDF));
      expect(res.status).toBe(200);
      noPathIn(res.body);
    });
  });
});
