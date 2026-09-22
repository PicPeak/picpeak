/**
 * Signed-PDF uploads were stored as `contract-<id>-<Date.now()>.pdf`, both on
 * the admin route and in the customer upload shared by the public link and
 * the portal. Two uploads in the same millisecond shared one file, and since
 * attachSignedPdfUpload is compare-and-set, the request that lost removed that
 * file with its cleanup, leaving the winning contract pointing at a PDF that
 * no longer exists.
 *
 * The clock is frozen here so both uploads fall in the same millisecond.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// The route's real fileFilter refuses every PDF (see
// adminContractsSignedPdfPathTraversal.test.js); stub it so the upload runs.
jest.mock('../../src/utils/fileSecurityUtils', () => {
  const actual = jest.requireActual('../../src/utils/fileSecurityUtils');
  return {
    ...actual,
    validateFileType: (filename, mimetype, allowedTypes) => allowedTypes.includes(mimetype),
  };
});

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, createPublicToken, buildRouteApp,
} = require('../integration/helpers/crmDb');

// Stored paths are relative to the storage root (storedPath.js).
const { resolveStoredPath: onDisk } = require('../../src/utils/storedPath');

describe('signed-PDF upload file names', () => {
  let db; let cleanup; let customerId; let token;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    let adminId;
    ({ adminId, customerId } = await seedMinimal(db));
    await assignAdminRole(db, adminId, 'super_admin');
    token = mintAdminToken(adminId);
    await db('feature_flags').where({ key: 'contracts' }).update({ value: true });
  }, 120000);

  afterAll(async () => { await cleanup(); });

  afterEach(() => { jest.restoreAllMocks(); });

  const signedDir = () => path.join(process.env.STORAGE_PATH, 'uploads/contracts/signed');
  const filesStartingWith = (prefix) => (fs.existsSync(signedDir())
    ? fs.readdirSync(signedDir()).filter((name) => name.startsWith(prefix))
    : []);

  async function insertContract() {
    const inserted = await db('contracts').insert({
      contract_number: `K-TEST-${crypto.randomBytes(3).toString('hex')}`,
      customer_account_id: customerId,
      title: 'Upload names',
      issue_date: new Date().toISOString().slice(0, 10),
      status: 'sent',
      language: 'de',
      created_at: new Date().toISOString(),
    }).returning('id');
    return inserted[0]?.id ?? inserted[0];
  }

  it('gives two admin uploads in the same millisecond their own files', async () => {
    const app = buildRouteApp('/api/admin/contracts', require('../../src/routes/adminContracts'));
    const id = await insertContract();
    jest.spyOn(Date, 'now').mockReturnValue(Date.now());

    for (const body of ['%PDF-1.4 first', '%PDF-1.4 second']) {
      const res = await request(app)
        .post(`/api/admin/contracts/${id}/upload-signed-pdf`)
        .set('Authorization', `Bearer ${token}`)
        .attach('file', Buffer.from(body), 'signed.pdf');
      expect(res.status).toBe(200);
    }

    expect(filesStartingWith(`contract-${id}-`)).toHaveLength(2);
  });

  it('gives two customer uploads for one contract in the same millisecond their own files', async () => {
    const app = buildRouteApp('/api/public/contracts', require('../../src/routes/publicContracts'));
    const verification = require('../../src/services/publicDocumentVerificationService');
    const id = await insertContract();
    // Two links to the same contract: the shared upload names files by
    // contract id, so both land on the same name without the random part.
    const links = [];
    for (let i = 0; i < 2; i += 1) {
      links.push(await createPublicToken(db, 'contract_action_tokens', { contract_id: id }));
    }
    jest.spyOn(Date, 'now').mockReturnValue(Date.now());

    const statuses = [];
    for (const link of links) {
      const tokenRow = await db('contract_action_tokens').where({ token: link }).first();
      const res = await request(app)
        .post(`/api/public/contracts/${link}/upload-signed-pdf`)
        .set('X-Document-Access', verification.issueGrant('contract', tokenRow, link))
        .attach('file', Buffer.from(`%PDF-1.4 ${link.slice(-4)}`), 'signed.pdf');
      statuses.push(res.status);
    }

    // Every accepted upload keeps its own file, and a refused one must not
    // have removed the file the contract now points at.
    expect(statuses[0]).toBe(200);
    expect(filesStartingWith(`contract-${id}-`)).toHaveLength(statuses.filter((s) => s === 200).length);
    const row = await db('contracts').where({ id }).first();
    expect(fs.existsSync(onDisk(row.signed_pdf_path))).toBe(true);
  });
});
