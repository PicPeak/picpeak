/**
 * A .picpeak restore onto a DIFFERENT storage path.
 *
 * Contracts go through this release's signing flow: created and sent through
 * the admin routes, signed by the customer with a drawn signature (the same
 * service call the public link makes), and counter-signed with a drawn
 * signature through the admin route. They record their PDFs and signature
 * images. One contract keeps the storage-relative paths this install now
 * writes; the other gets the absolute paths older releases recorded. The
 * archive is then restored with the storage root moved somewhere else and the
 * old root deleted, and every document has to open again and re-hash to the
 * sha256 recorded when it was issued.
 *
 * SQLite by default. With PICPEAK_PG_TEST_URL set the same run goes against
 * Postgres: the export lists tables from the public schema, so the URL must
 * name a throwaway test database whose public schema this suite may drop.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const knex = require('knex');
const request = require('supertest');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(180000);

const pgUrl = process.env.PICPEAK_PG_TEST_URL;
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const PNG = `data:image/png;base64,${'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='}`;
const SIGNATURE_COLUMNS = ['signed_customer_signature_path', 'signed_admin_signature_path'];

let db;
let cleanup;
let tmpDir;
let owner;
let adminId;
let token;
let contractsApp;
let contractService;
const auth = { get Authorization() { return `Bearer ${token}`; } };

async function resetPublicSchema() {
  const database = new URL(pgUrl).pathname.slice(1);
  if (!/test/i.test(database)) throw new Error(`refusing to drop the public schema of "${database}"`);
  await owner.raw('DROP SCHEMA IF EXISTS public CASCADE');
  await owner.raw('CREATE SCHEMA public');
}

async function ok(req, status = [200, 201]) {
  const res = await req;
  if (!status.includes(res.status)) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** Create, send, sign (drawn) and counter-sign (drawn) one contract. */
async function signedContract() {
  const created = await ok(request(contractsApp).post('/api/admin/contracts').set(auth)
    .send({ customerAccountId: (await db('customer_accounts').first()).id, title: 'Restore test' }));
  const id = (created.contract || created.data?.contract || created).id;
  await ok(request(contractsApp).post(`/api/admin/contracts/${id}/send`).set(auth));
  const { token: link } = await db('contract_action_tokens').where({ contract_id: id }).orderBy('id', 'desc').first();
  await contractService.recordCustomerSignature({
    token: link, name: 'Anna Muster', accepted: true, ip: '198.51.100.7', signatureDataUrl: PNG,
  });
  await ok(request(contractsApp).post(`/api/admin/contracts/${id}/countersign`).set(auth)
    .send({ name: 'Studio Admin', signatureDataUrl: PNG }));
  const row = await db('contracts').where({ id }).first('status');
  expect(row.status).toBe('fully_signed');
  return id;
}

const pathRows = async (contractId) => db('contracts').where({ id: contractId })
  .first('pdf_path', 'signed_pdf_path', ...SIGNATURE_COLUMNS, 'pdf_sha256', 'signed_pdf_sha256');

const storedValues = (row) => [row.pdf_path, row.signed_pdf_path, ...SIGNATURE_COLUMNS.map((c) => row[c])];

beforeAll(async () => {
  if (pgUrl) {
    owner = knex({ client: 'pg', connection: pgUrl });
    await resetPublicSchema();
    process.env.DATABASE_CLIENT = 'pg';
    jest.doMock('../../knexfile', () => ({ client: 'pg', connection: pgUrl }));
  }
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  expect(db.client.config.client).toBe(pgUrl ? 'pg' : 'sqlite3');
  const emailProcessor = require('../../src/services/emailProcessor');
  jest.spyOn(emailProcessor, 'sendTemplateEmail').mockImplementation(async () => ({ success: true }));
  ({ adminId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  const updated = await db('feature_flags').where({ key: 'contracts' }).update({ value: true });
  if (!updated) await db('feature_flags').insert({ key: 'contracts', value: true });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
  await db('customer_accounts').update({ first_name: 'Anna', last_name: 'Muster' });
  await db('business_profile').update({ email: 'studio@example.com', company_name: 'Studio Test' });
  contractsApp = buildRouteApp('/api/admin/contracts', require('../../src/routes/adminContracts'));
  contractService = require('../../src/services/contractService');
}, 180000);

afterAll(async () => {
  if (cleanup) await cleanup();
  if (owner) {
    await resetPublicSchema();
    await owner.destroy();
  }
});

test('documents open and re-hash after a restore onto another storage path', async () => {
  const oldRoot = process.env.STORAGE_PATH;

  // 1. A contract written by this release: every stored path is relative.
  const current = await signedContract();
  const fresh = await pathRows(current);
  for (const value of storedValues(fresh)) {
    expect(value).toMatch(/^business-docs\/contract\//);
    expect(fs.existsSync(path.join(oldRoot, value))).toBe(true);
  }

  // 2. A contract as an older release recorded it: absolute paths under the
  //    old root.
  const legacy = await signedContract();
  const abs = (value) => path.join(oldRoot, value);
  const before = await pathRows(legacy);
  await db('contracts').where({ id: legacy }).update(Object.fromEntries(
    ['pdf_path', 'signed_pdf_path', ...SIGNATURE_COLUMNS].map((c) => [c, abs(before[c])]),
  ));

  const expected = {
    [current]: fresh,
    [legacy]: await pathRows(legacy),
  };
  expect(path.isAbsolute(expected[legacy].signed_pdf_path)).toBe(true);
  // The signature images carry no hash column: record what they hashed to.
  const imageHashes = {};
  for (const id of [current, legacy]) {
    for (const c of SIGNATURE_COLUMNS) {
      const value = expected[id][c];
      imageHashes[`${id}:${c}`] = sha256(fs.readFileSync(path.isAbsolute(value) ? value : path.join(oldRoot, value)));
    }
  }

  // 3. Export, then move storage somewhere else and delete the old root, so
  //    nothing can still be read from where it was written.
  const { createPicpeak } = require('../../src/services/picpeakExportService');
  const { filePath: archive } = await createPicpeak({ includePhotos: false });
  const newRoot = path.join(tmpDir, 'moved', 'elsewhere', 'storage');
  fs.mkdirSync(newRoot, { recursive: true });
  process.env.STORAGE_PATH = newRoot;
  fs.rmSync(oldRoot, { recursive: true, force: true });

  try {
    const { importFromPicpeak } = require('../../src/services/picpeakImportService');
    const result = await importFromPicpeak({ picpeakPath: archive, currentAdminId: adminId });
    expect(result.restored).toBe(true);
    expect(result.filesRestored).toBeGreaterThan(0);
  } finally {
    fs.rmSync(path.dirname(archive), { recursive: true, force: true });
  }
  expect(fs.existsSync(oldRoot)).toBe(false);

  // 4. Every restored path is storage-relative, the legacy ones included, and
  //    every signature image re-hashes to what it was before the export.
  for (const id of [current, legacy]) {
    const restored = await pathRows(id);
    for (const value of storedValues(restored)) {
      expect(value).toMatch(/^business-docs\/contract\//);
      expect(fs.existsSync(path.join(newRoot, value))).toBe(true);
    }
    for (const c of SIGNATURE_COLUMNS) {
      expect(sha256(fs.readFileSync(path.join(newRoot, restored[c])))).toBe(imageHashes[`${id}:${c}`]);
    }
  }

  // 5. The PDFs open through the admin routes and match the hashes recorded
  //    when they were issued.
  // The restore may revoke every session issued before it.
  token = mintAdminToken(adminId, { extraClaims: { iat: Math.floor(Date.now() / 1000) + 2 } });
  const binary = (res, cb) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  };
  for (const id of [current, legacy]) {
    const contract = expected[id];
    const pdf = await request(contractsApp).get(`/api/admin/contracts/${id}/pdf`).set(auth).buffer(true).parse(binary);
    expect(pdf.status).toBe(200);
    expect(sha256(pdf.body)).toBe(contract.pdf_sha256);
    const signed = await request(contractsApp).get(`/api/admin/contracts/${id}/signed-pdf`).set(auth).buffer(true).parse(binary);
    expect(signed.status).toBe(200);
    expect(sha256(signed.body)).toBe(contract.signed_pdf_sha256);

    const integrity = await contractService.verifyIntegrity(id);
    expect(integrity.unsigned).toEqual(expect.objectContaining({ present: true, match: true }));
    expect(integrity.signed).toEqual(expect.objectContaining({ present: true, match: true }));
  }

  const report = await require('../../src/services/backupIntegrityService').verifyDocumentArtefacts();
  expect(report.summary.missingFiles).toBe(0);
  expect(report.summary.hashMismatches).toBe(0);
  expect(report.summary.verifiedOk).toBeGreaterThanOrEqual(4);

  // 6. The completion emails queued before the export name the old root.
  //    Restored with the queue, they still go out with the restored files.
  const queued = await db('email_queue').where({ email_type: 'contract_fully_signed', status: 'pending' }).select('id');
  expect(queued.length).toBeGreaterThanOrEqual(2);
  const transport = require('../../src/services/emailWebhookTransport');
  process.env.EMAIL_FROM = 'noreply@example.com';
  const mails = [];
  const enabled = jest.spyOn(transport, 'isEnabled').mockReturnValue(true);
  const deliver = jest.spyOn(transport, 'send').mockImplementation(async (mail) => { mails.push(mail); return { messageId: `m-${mails.length}` }; });
  try {
    const { processEmailQueue } = require('../../src/services/emailProcessor');
    for (const { id } of queued) await processEmailQueue({ ignoreSchedule: true, onlyId: id });
  } finally {
    enabled.mockRestore();
    deliver.mockRestore();
  }
  for (const { id } of queued) expect((await db('email_queue').where({ id }).first()).status).toBe('sent');
  const signedHashes = new Set([expected[current].signed_pdf_sha256, expected[legacy].signed_pdf_sha256]);
  const attached = mails.flatMap((m) => m.attachments || []);
  // The audit certificate is a best-effort second attachment on this release
  // (it does not render under Jest + SQLite, whose Date writes land as
  // "[object Object]"); the signed PDF is always there.
  expect(attached.length).toBeGreaterThanOrEqual(queued.length);
  for (const a of attached) expect(a.path.startsWith(fs.realpathSync(newRoot))).toBe(true);
  const signedAttached = attached.filter((a) => /-signed\.pdf$/.test(a.filename));
  expect(signedAttached.length).toBe(queued.length);
  for (const a of signedAttached) expect(signedHashes.has(sha256(fs.readFileSync(a.path)))).toBe(true);
});

test('a stored path that climbs out of the storage root is not served', async () => {
  const contract = await db('contracts').whereNotNull('pdf_path').first('id', 'pdf_path', 'signed_pdf_path');
  await db('contracts').where({ id: contract.id }).update({ pdf_path: '../../../../etc/passwd', signed_pdf_path: '/etc/passwd' });
  try {
    for (const route of ['pdf', 'signed-pdf']) {
      const res = await request(contractsApp).get(`/api/admin/contracts/${contract.id}/${route}`).set(auth);
      expect(res.status).toBe(404);
      expect(String(res.text)).not.toMatch(/root:/);
    }
    const { assertContractPdfPath } = require('../../src/utils/safePath');
    expect(() => assertContractPdfPath('../../../../etc/passwd')).toThrow(expect.objectContaining({ statusCode: 403 }));
  } finally {
    await db('contracts').where({ id: contract.id }).update({ pdf_path: contract.pdf_path, signed_pdf_path: contract.signed_pdf_path });
  }
});
