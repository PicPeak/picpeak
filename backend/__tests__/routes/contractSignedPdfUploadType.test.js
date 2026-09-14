/**
 * The wet-signed PDF uploads (admin and customer link) filter files with
 * validateFileType(..., ['application/pdf']). That helper looked the type up
 * in ALLOWED_MEDIA_TYPES, which only holds images and videos, so it refused
 * every PDF: both uploads answered "Only PDF files are allowed" to a PDF.
 *
 * These run the real filter. A PDF must pass on both routes, anything else
 * must still be refused, and the photo side must still refuse a PDF.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

// Before anything loads the database module: it binds to this path.
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-contract-pdf-type-')), 'db.sqlite'
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'contract-pdf-upload-type-test-secret';

const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp, createPublicToken,
} = require('../integration/helpers/crmDb');
const { validateFileType, ALLOWED_MEDIA_TYPES } = require('../../src/utils/fileSecurityUtils');
const { EXTENSION_TO_MIME } = require('../../src/services/uploadSettings');

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);

describe('signed-contract PDF uploads accept PDF files', () => {
  let db; let cleanup; let adminApp; let publicApp; let token; let customerId;

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    let adminId;
    ({ adminId, customerId } = await seedMinimal(db));
    await assignAdminRole(db, adminId, 'super_admin');
    token = mintAdminToken(adminId);
    await db('feature_flags').where({ key: 'contracts' }).update({ value: true });
    adminApp = buildRouteApp('/api/admin/contracts', require('../../src/routes/adminContracts'));
    publicApp = buildRouteApp('/api/public/contracts', require('../../src/routes/publicContracts'));
  }, 120000);

  afterAll(async () => { await cleanup(); });

  async function insertContract() {
    const inserted = await db('contracts').insert({
      contract_number: `K-PDF-${Math.random().toString(16).slice(2, 8)}`,
      customer_account_id: customerId,
      title: 'Upload type test',
      issue_date: new Date().toISOString().slice(0, 10),
      status: 'sent',
      language: 'de',
      created_at: new Date().toISOString(),
    }).returning('id');
    return inserted[0]?.id ?? inserted[0];
  }

  const adminUpload = (id) => request(adminApp)
    .post(`/api/admin/contracts/${id}/upload-signed-pdf`)
    .set('Authorization', `Bearer ${token}`);

  it('accepts a PDF on the admin upload', async () => {
    const id = await insertContract();

    const res = await adminUpload(id).attach('file', PDF, { filename: 'signed.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(200);
    const row = await db('contracts').where({ id }).first();
    expect(row.status).toBe('fully_signed');
    expect(row.signed_pdf_path).toMatch(/\.pdf$/);
  });

  it('accepts a PDF on the customer link upload', async () => {
    const id = await insertContract();
    const linkToken = await createPublicToken(db, 'contract_action_tokens', { contract_id: id });

    const res = await request(publicApp)
      .post(`/api/public/contracts/${linkToken}/upload-signed-pdf`)
      .attach('file', PDF, { filename: 'signed.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(200);
    const row = await db('contracts').where({ id }).first();
    expect(row.status).toBe('fully_signed');
  });

  it('still refuses an image sent under a .pdf name', async () => {
    const id = await insertContract();

    const res = await adminUpload(id).attach('file', PNG, { filename: 'signed.pdf', contentType: 'image/png' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error).toMatch(/only pdf files are allowed/i);
    expect((await db('contracts').where({ id }).first()).status).toBe('sent');
  });

  it('still refuses a PDF type with a non-PDF extension', async () => {
    const id = await insertContract();
    const linkToken = await createPublicToken(db, 'contract_action_tokens', { contract_id: id });

    const res = await request(publicApp)
      .post(`/api/public/contracts/${linkToken}/upload-signed-pdf`)
      .attach('file', PDF, { filename: 'signed.exe', contentType: 'application/pdf' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error).toMatch(/only pdf files are allowed/i);
    expect((await db('contracts').where({ id }).first()).status).toBe('sent');
  });

  it('keeps PDFs out of the photo and media uploads', () => {
    // Photo uploads build their list from the upload settings; the archive
    // restore reads ALLOWED_MEDIA_TYPES. Neither may start to include PDFs.
    const photoTypes = Array.from(new Set(Object.values(EXTENSION_TO_MIME)));
    expect(photoTypes).not.toContain('application/pdf');
    expect(validateFileType('scan.pdf', 'application/pdf', photoTypes)).toBe(false);
    expect(ALLOWED_MEDIA_TYPES['application/pdf']).toBeUndefined();
  });
});
