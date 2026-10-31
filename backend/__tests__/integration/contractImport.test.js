/**
 * Historical contract import (POST /api/admin/contracts/import).
 *
 * A studio moving from another tool has contracts that were signed or
 * cancelled long ago. The only path used to be create → send → upload the
 * signed PDF, which emails the customer a signing link and then
 * `contract_fully_signed`, and seeds the contract with every system clause.
 * The import writes the finished row instead: the original PDF, its hash,
 * the historical dates — no clauses, no action tokens, no email.
 *
 * Real route → service → full core-migration SQLite, as in the other
 * contract suites.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const { PDFDocument } = require('pdf-lib');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');
const { resolveStoredPath } = require('../../src/utils/storedPath');

jest.setTimeout(120000);

let db;
let cleanup;
let app;
let token;
let adminId;
let customerId;
let queueEmail;
let pdfBytes;

const auth = (req) => req.set('Authorization', `Bearer ${token}`);
const count = async (table, where = {}) => Number((await db(table).where(where).count({ n: '*' }).first()).n);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
// SQLite hands timestamps back as epoch milliseconds, Postgres as dates.
const day = (value) => new Date(require('../../src/utils/queueTimestamps').toMillis(value)).toISOString().slice(0, 10);

function importsDir() {
  return path.join(process.env.STORAGE_PATH, 'business-docs', 'contract', 'imports');
}
function filesOnDisk() {
  const dir = importsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.pdf'));
}

function postImport(fields, { file = pdfBytes, filename = 'original.pdf', contentType = 'application/pdf' } = {}) {
  let req = auth(request(app).post('/api/admin/contracts/import'));
  for (const [key, value] of Object.entries(fields)) req = req.field(key, String(value));
  if (file) req = req.attach('pdf', file, { filename, contentType });
  return req;
}

const signedFields = (extra = {}) => ({
  customerAccountId: customerId,
  status: 'fully_signed',
  title: 'Wedding photography 2023',
  issueDate: '2023-03-01',
  signedByCustomerAt: '2023-03-04',
  signedByAdminAt: '2023-03-05',
  ...extra,
});

beforeAll(async () => {
  ({ db, cleanup } = await bootCrmDb());
  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId);
  token = mintAdminToken(adminId);
  const flag = await db('feature_flags').where({ key: 'contracts' }).first();
  if (flag) await db('feature_flags').where({ key: 'contracts' }).update({ value: true });
  else await db('feature_flags').insert({ key: 'contracts', value: true });
  app = buildRouteApp('/api/admin/contracts', require('../../src/routes/adminContracts'));

  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]).drawText('Signed in 2023');
  pdfBytes = Buffer.from(await pdf.save());

  const emailProcessor = require('../../src/services/emailProcessor');
  queueEmail = jest.spyOn(emailProcessor, 'queueEmail');
  jest.spyOn(emailProcessor, 'sendTemplateEmail');
});

afterAll(async () => {
  jest.restoreAllMocks();
  if (cleanup) await cleanup();
});

beforeEach(() => {
  require('../../src/services/emailProcessor').queueEmail.mockClear();
  require('../../src/services/emailProcessor').sendTemplateEmail.mockClear();
});

describe('POST /api/admin/contracts/import', () => {
  it('imports a fully signed contract as the original PDF, with its historical dates', async () => {
    const emailsBefore = await count('email_queue');

    const res = await postImport(signedFields());

    expect(res.status).toBe(201);
    const { contract } = res.body;
    expect(contract.status).toBe('fully_signed');
    expect(contract.isImported).toBe(true);
    expect(contract.title).toBe('Wedding photography 2023');
    expect(contract.issueDate).toContain('2023-03-01');

    const row = await db('contracts').where({ id: contract.id }).first();
    expect(row.imported_at).toBeTruthy();
    expect(row.pdf_path).toBe(row.signed_pdf_path);
    expect(Boolean(row.signed_pdf_is_wet_upload)).toBe(true);
    expect(row.signed_pdf_sha256).toBe(sha256(pdfBytes));
    expect(row.pdf_sha256).toBe(sha256(pdfBytes));
    expect(day(row.sent_at)).toBe('2023-03-01');
    expect(day(row.signed_by_customer_at)).toBe('2023-03-04');
    expect(day(row.signed_by_admin_at)).toBe('2023-03-05');
    // A date without a time is kept at midday UTC, the same calendar day in
    // every zone from UTC-12 to UTC+12.
    const instant = (v) => new Date(require('../../src/utils/queueTimestamps').toMillis(v)).toISOString();
    expect(instant(row.signed_by_customer_at)).toBe('2023-03-04T12:00:00.000Z');

    // No clauses, no free text: the PDF is the contract.
    expect(await count('contract_block_inclusions', { contract_id: contract.id })).toBe(0);
    expect(await count('contract_text_sections', { contract_id: contract.id })).toBe(0);
    // Nothing that reaches the customer.
    expect(await count('contract_action_tokens', { contract_id: contract.id })).toBe(0);
    expect(await count('email_queue')).toBe(emailsBefore);
    expect(queueEmail).not.toHaveBeenCalled();

    // Both PDF endpoints serve the original bytes untouched.
    for (const endpoint of ['pdf', 'signed-pdf']) {
      const pdf = await auth(request(app).get(`/api/admin/contracts/${contract.id}/${endpoint}`))
        .buffer(true).parse((r, cb) => { const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
      expect(pdf.status).toBe(200);
      expect(sha256(pdf.body)).toBe(sha256(pdfBytes));
    }
  });

  it('defaults the signed-at dates to the issue date, never the moment of import', async () => {
    const res = await postImport(signedFields({ signedByCustomerAt: '', signedByAdminAt: '' }));

    expect(res.status).toBe(201);
    const row = await db('contracts').where({ id: res.body.contract.id }).first();
    expect(day(row.signed_by_customer_at)).toBe('2023-03-01');
    expect(day(row.signed_by_admin_at)).toBe('2023-03-01');
  });

  it('imports a cancelled contract as an unsigned PDF', async () => {
    const res = await postImport(signedFields({ status: 'cancelled' }));

    expect(res.status).toBe(201);
    const row = await db('contracts').where({ id: res.body.contract.id }).first();
    expect(row.status).toBe('cancelled');
    expect(row.pdf_path).toBeTruthy();
    expect(row.signed_pdf_path).toBeNull();
    expect(row.signed_by_customer_at).toBeNull();
    expect(row.signed_by_admin_at).toBeNull();
    expect(row.sent_at).toBeNull();
    expect(Boolean(row.signed_pdf_is_wet_upload)).toBe(false);
  });

  it('stores the PDF inside the contract roots under a name of its own', async () => {
    const res = await postImport(signedFields(), { filename: '../../../escape.pdf' });

    expect(res.status).toBe(201);
    const row = await db('contracts').where({ id: res.body.contract.id }).first();
    expect(path.isAbsolute(row.pdf_path)).toBe(false);
    expect(row.pdf_path).toMatch(/^business-docs\/contract\/imports\/\d{4}\/imported-\d+-[0-9a-f]{8}\.pdf$/);
    const { assertContractPdfPath } = require('../../src/utils/safePath');
    expect(() => assertContractPdfPath(row.pdf_path)).not.toThrow();
    expect(fs.readFileSync(resolveStoredPath(row.pdf_path))).toEqual(pdfBytes);
  });

  it.each([
    ['a status that would need signing', { status: 'sent' }, 400],
    ['a draft', { status: 'draft' }, 400],
    // Every way on from it re-renders the PDF or is refused (see imports.js).
    ['a contract signed only by the customer', { status: 'signed_by_customer' }, 400],
    ['a missing issue date', { issueDate: '' }, 400],
    // ISO 8601, but not a date Date can read: these used to reach the
    // service and throw a RangeError (500).
    ['a week date', { issueDate: '2023-W05' }, 400],
    ['an ordinal date', { issueDate: '2023-123' }, 400],
    ['a day the month does not have', { signedByCustomerAt: '2023-02-30' }, 400],
    ['a date before 2000', { issueDate: '1999-12-31' }, 400],
    ['a signature in the future', { signedByAdminAt: '2999-01-01' }, 400],
    ['a customer signature before the issue date', { signedByCustomerAt: '2023-02-28' }, 400],
    ['a counter-signature before the customer signed', { signedByAdminAt: '2023-03-03' }, 400],
    ['an unknown customer', { customerAccountId: 999999 }, 404],
  ])('refuses %s, leaving no row and no file behind', async (_label, extra, status) => {
    const contractsBefore = await count('contracts');
    const filesBefore = filesOnDisk().length;

    const res = await postImport(signedFields(extra));

    expect(res.status).toBe(status);
    expect(await count('contracts')).toBe(contractsBefore);
    expect(filesOnDisk()).toHaveLength(filesBefore);
  });

  it('refuses a file that is not a PDF, whatever its declared type', async () => {
    const filesBefore = filesOnDisk().length;

    const res = await postImport(signedFields(), { file: Buffer.from('<html>not a pdf</html>') });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PDF');
    expect(filesOnDisk()).toHaveLength(filesBefore);
  });

  it('refuses a request without a PDF', async () => {
    const res = await postImport(signedFields(), { file: null });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NO_FILE');
  });

  it('accepts an event date ahead of the import', async () => {
    const res = await postImport(signedFields({ eventDate: '2999-06-01', validUntil: '2999-06-01' }));

    expect(res.status).toBe(201);
  });

  it('creates one contract per Idempotency-Key, and drops the retried upload', async () => {
    const contractsBefore = await count('contracts');
    const filesBefore = filesOnDisk().length;
    const key = 'import-retry-0001';

    const first = await postImport(signedFields()).set('Idempotency-Key', key);
    const retry = await postImport(signedFields()).set('Idempotency-Key', key);

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBe(true);
    expect(retry.body.contract.id).toBe(first.body.contract.id);
    expect(await count('contracts')).toBe(contractsBefore + 1);
    expect(filesOnDisk()).toHaveLength(filesBefore + 1);
  });

  it('does not answer an import with a draft that used the same Idempotency-Key', async () => {
    const key = 'draft-then-import-01';
    const draft = await auth(request(app).post('/api/admin/contracts'))
      .set('Idempotency-Key', key).send({ customerAccountId: customerId, title: 'Draft' });
    expect(draft.status).toBe(201);
    const contractsBefore = await count('contracts');
    const filesBefore = filesOnDisk().length;

    const res = await postImport(signedFields()).set('Idempotency-Key', key);

    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('IDEMPOTENCY_KEY_CONFLICT');
    expect(await count('contracts')).toBe(contractsBefore);
    expect(filesOnDisk()).toHaveLength(filesBefore);
  });

  it('orders dates by the calendar day written, not by the instant', async () => {
    // 00:30 on the issue day at UTC+14 is the previous day in UTC. A time
    // without a zone lands the same way on a UTC+ server (it parses as
    // server-local), so comparing instants refused same-day signatures.
    const res = await postImport(signedFields({
      signedByCustomerAt: '2023-03-01T00:30:00+14:00',
      signedByAdminAt: '2023-03-01T00:45:00+14:00',
    }));

    expect(res.status).toBe(201);
    // Stored as the day written, so it does not show as Feb 28 west of
    // UTC+14 next to an issue date of Mar 1.
    const row = await db('contracts').where({ id: res.body.contract.id }).first();
    const instant = (v) => new Date(require('../../src/utils/queueTimestamps').toMillis(v)).toISOString();
    expect(instant(row.signed_by_customer_at)).toBe('2023-03-01T12:00:00.000Z');
    expect(instant(row.signed_by_admin_at)).toBe('2023-03-01T12:00:00.000Z');
  });

  it('requires contracts.manage', async () => {
    const insert = await db('admin_users').insert({
      username: 'no-role', email: 'no-role@example.com', password_hash: 'x',
      must_change_password: false, created_at: new Date(),
    }).returning('id');
    const noRoleToken = mintAdminToken(insert[0]?.id ?? insert[0]);
    const contractsBefore = await count('contracts');

    const res = await request(app).post('/api/admin/contracts/import')
      .set('Authorization', `Bearer ${noRoleToken}`)
      .field('customerAccountId', String(customerId)).field('status', 'fully_signed').field('issueDate', '2023-03-01')
      .attach('pdf', pdfBytes, { filename: 'original.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(403);
    expect(await count('contracts')).toBe(contractsBefore);
  });
});

describe('an imported contract keeps its PDF', () => {
  let signedId;
  let customerOnlyId;
  let original;

  beforeAll(async () => {
    signedId = (await postImport(signedFields())).body.contract.id;
    original = await db('contracts').where({ id: signedId }).first();
    // The import no longer creates `signed_by_customer`, but the guard must
    // hold for any imported row that reaches it: put one there by hand.
    customerOnlyId = (await postImport(signedFields())).body.contract.id;
    await db('contracts').where({ id: customerOnlyId })
      .update({ status: 'signed_by_customer', signed_by_admin_at: null });
  });

  it('refuses a counter-signature, which would re-render the PDF from clauses it never had', async () => {
    const res = await auth(request(app).post(`/api/admin/contracts/${customerOnlyId}/countersign`))
      .send({ name: 'Studio Owner' });

    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('CONTRACT_IMPORTED');
    const row = await db('contracts').where({ id: customerOnlyId }).first();
    expect(row.status).toBe('signed_by_customer');
    expect(queueEmail).not.toHaveBeenCalled();
  });

  it('refuses replacing the PDF with an upload, and removes the upload', async () => {
    const signedDir = path.join(process.env.STORAGE_PATH, 'uploads', 'contracts', 'signed');
    const before = fs.existsSync(signedDir) ? fs.readdirSync(signedDir).length : 0;

    const res = await auth(request(app).post(`/api/admin/contracts/${signedId}/upload-signed-pdf`))
      .attach('file', pdfBytes, { filename: 'other.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(409);
    expect(fs.existsSync(signedDir) ? fs.readdirSync(signedDir).length : 0).toBe(before);
    const row = await db('contracts').where({ id: signedId }).first();
    expect(row.signed_pdf_path).toBe(original.signed_pdf_path);
    expect(queueEmail).not.toHaveBeenCalled();
  });

  it.each([
    ['resend-signed', {}],
    ['restamp-signatures', { customerSignatureDataUrl: 'data:image/png;base64,iVBORw0KGgo=' }],
  ])('refuses POST /:id/%s', async (endpoint, payload) => {
    const res = await auth(request(app).post(`/api/admin/contracts/${signedId}/${endpoint}`)).send(payload);

    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('CONTRACT_IMPORTED');
    expect(queueEmail).not.toHaveBeenCalled();
    const row = await db('contracts').where({ id: signedId }).first();
    expect(row.signed_pdf_sha256).toBe(original.signed_pdf_sha256);
  });

  it('refuses re-render-and-resend and re-stamping', async () => {
    const contractService = require('../../src/services/contractService');

    await expect(contractService.rerenderAndResend(signedId, adminId))
      .rejects.toMatchObject({ code: 'CONTRACT_IMPORTED' });
    await expect(contractService.restampSignatures(signedId, {}, adminId))
      .rejects.toMatchObject({ code: 'CONTRACT_IMPORTED' });
    expect(queueEmail).not.toHaveBeenCalled();
    const row = await db('contracts').where({ id: signedId }).first();
    expect(row.signed_pdf_sha256).toBe(original.signed_pdf_sha256);
  });

  it('cannot be sent', async () => {
    const res = await auth(request(app).post(`/api/admin/contracts/${signedId}/send`)).send({});

    expect(res.status).toBe(409);
    expect(queueEmail).not.toHaveBeenCalled();
    expect(await count('contract_action_tokens', { contract_id: signedId })).toBe(0);
  });
});
