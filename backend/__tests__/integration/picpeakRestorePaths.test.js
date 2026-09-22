/**
 * A .picpeak restore onto a DIFFERENT storage path.
 *
 * Contracts signed through the real v2 flow (routes → services → DB) record
 * their PDFs, signature images and certificate. One contract keeps the
 * storage-relative paths this install now writes; the other gets the absolute
 * paths older releases recorded. The archive is then restored with the storage
 * root moved somewhere else and the old root deleted, and every document has
 * to open again and re-hash to the sha256 recorded when it was issued.
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

let db;
let cleanup;
let tmpDir;
let owner;
let adminId;
let customerEmail;
let token;
let contractsApp;
let signingApp;
const sentCodes = [];
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

let ipCounter = 0;
const asSigner = (req) => req.set('X-Forwarded-For', `198.51.100.${(ipCounter += 1) % 250}`);

async function lastQueued(type, to) {
  const row = await db('email_queue').where({ email_type: type, recipient_email: to }).orderBy('id', 'desc').first();
  if (!row) return null;
  return typeof row.email_data === 'string' ? JSON.parse(row.email_data) : row.email_data;
}

/** Create, send, sign (drawn) and counter-sign (drawn) one contract. */
async function signedContract() {
  const { contract } = await ok(request(contractsApp).post('/api/admin/contracts').set(auth)
    .send({ customerAccountId: (await db('customer_accounts').first()).id }));
  await ok(request(contractsApp).post(`/api/admin/contracts/${contract.id}/send`).set(auth));
  const link = (await lastQueued('contract_sent', customerEmail)).response_url.split('/').pop();
  // The one-minute gap between codes, moved back rather than waited out.
  await db('contract_signing_otps').update({ created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString() });
  await ok(asSigner(request(signingApp).post(`/api/public/contract-signing/invite/${link}/code`)));
  const { code } = sentCodes[sentCodes.length - 1];
  const { sessionToken } = await ok(asSigner(request(signingApp).post(`/api/public/contract-signing/invite/${link}/verify`)).send({ code }));
  await ok(asSigner(request(signingApp).post('/api/public/contract-signing/session/sign'))
    .set('X-Signing-Session', sessionToken)
    .send({ accepted: true, name: 'Anna Muster', mode: 'drawn', signatureDataUrl: PNG }));
  const done = await ok(request(contractsApp).post(`/api/admin/contracts/${contract.id}/countersign`).set(auth)
    .send({ name: 'Studio Admin', mode: 'drawn', signatureDataUrl: PNG }));
  expect(done.status).toBe('fully_signed');
  return contract.id;
}

const pathRows = async (contractId) => ({
  contract: await db('contracts').where({ id: contractId })
    .first('pdf_path', 'signed_pdf_path', 'signed_admin_signature_path', 'pdf_sha256', 'signed_pdf_sha256'),
  signers: await db('contract_signers').where({ contract_id: contractId }).whereNotNull('signature_path').select('id', 'signature_path', 'signature_sha256'),
  documents: await db('generated_documents').where({ doc_type: 'contract', doc_id: contractId }).select('id', 'kind', 'path', 'sha256'),
});

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
  jest.spyOn(emailProcessor, 'sendTemplateEmail').mockImplementation(async (to, templateKey, variables) => {
    sentCodes.push({ to, templateKey, code: variables.code });
    return { success: true };
  });
  ({ adminId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  const updated = await db('feature_flags').where({ key: 'contracts' }).update({ value: true });
  if (!updated) await db('feature_flags').insert({ key: 'contracts', value: true });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
  customerEmail = (await db('customer_accounts').first()).email.toLowerCase();
  await db('customer_accounts').update({ first_name: 'Anna', last_name: 'Muster' });
  await db('business_profile').update({ email: 'studio@example.com', company_name: 'Studio Test' });
  contractsApp = buildRouteApp('/api/admin/contracts', require('../../src/routes/adminContracts'));
  signingApp = buildRouteApp('/api/public/contract-signing', require('../../src/routes/publicContractSigning'));
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
  const written = [
    fresh.contract.pdf_path, fresh.contract.signed_pdf_path, fresh.contract.signed_admin_signature_path,
    ...fresh.signers.map((s) => s.signature_path), ...fresh.documents.map((d) => d.path),
  ];
  expect(fresh.documents.map((d) => d.kind).sort()).toEqual(expect.arrayContaining(['audit', 'signed', 'unsigned']));
  expect(fresh.signers).toHaveLength(2); // the customer and the issuer, both drawn
  for (const value of written) {
    expect(value).toMatch(/^business-docs\/contract\//);
    expect(fs.existsSync(path.join(oldRoot, value))).toBe(true);
  }

  // 2. A contract as an older release recorded it: absolute paths under the
  //    old root.
  const legacy = await signedContract();
  const abs = (value) => path.join(oldRoot, value);
  const before = await pathRows(legacy);
  await db('contracts').where({ id: legacy }).update({
    pdf_path: abs(before.contract.pdf_path),
    signed_pdf_path: abs(before.contract.signed_pdf_path),
    signed_admin_signature_path: abs(before.contract.signed_admin_signature_path),
  });
  for (const s of before.signers) await db('contract_signers').where({ id: s.id }).update({ signature_path: abs(s.signature_path) });
  for (const d of before.documents) await db('generated_documents').where({ id: d.id }).update({ path: abs(d.path) });

  const expected = {
    [current]: fresh,
    [legacy]: await pathRows(legacy),
  };
  expect(path.isAbsolute(expected[legacy].contract.signed_pdf_path)).toBe(true);

  // 3. Export, then move storage somewhere else and delete the old root, so
  //    nothing can still be read from where it was written.
  const { createPicpeak } = require('../../src/services/picpeakExportService');
  const { filePath: archive } = await createPicpeak({ includePhotos: false });
  const newRoot = path.join(tmpDir, 'moved', 'elsewhere', 'storage');
  fs.mkdirSync(newRoot, { recursive: true });
  process.env.STORAGE_PATH = newRoot;
  fs.rmSync(oldRoot, { recursive: true, force: true });
  // The restore replaces every table: start from an emptied one.
  await db('generated_documents').del();
  await db('contract_signers').del();

  try {
    const { importFromPicpeak } = require('../../src/services/picpeakImportService');
    const result = await importFromPicpeak({ picpeakPath: archive, currentAdminId: adminId });
    expect(result.restored).toBe(true);
    expect(result.filesRestored).toBeGreaterThan(0);
  } finally {
    fs.rmSync(path.dirname(archive), { recursive: true, force: true });
  }
  expect(fs.existsSync(oldRoot)).toBe(false);

  // 4. Every restored path is storage-relative, the legacy ones included.
  for (const id of [current, legacy]) {
    const restored = await pathRows(id);
    for (const value of [
      restored.contract.pdf_path, restored.contract.signed_pdf_path, restored.contract.signed_admin_signature_path,
      ...restored.signers.map((s) => s.signature_path), ...restored.documents.map((d) => d.path),
    ]) {
      expect(value).toMatch(/^business-docs\/contract\//);
      expect(fs.existsSync(path.join(newRoot, value))).toBe(true);
    }
    for (const s of restored.signers) {
      expect(sha256(fs.readFileSync(path.join(newRoot, s.signature_path)))).toBe(s.signature_sha256);
    }
    for (const d of restored.documents) {
      expect(sha256(fs.readFileSync(path.join(newRoot, d.path)))).toBe(d.sha256);
    }
  }

  // 5. The PDFs and the certificate open through the admin routes and match
  //    the hashes recorded when they were issued.
  // The restore revokes every session issued before it.
  token = mintAdminToken(adminId, { extraClaims: { iat: Math.floor(Date.now() / 1000) + 2 } });
  const binary = (res, cb) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  };
  const contractService = require('../../src/services/contractService');
  for (const id of [current, legacy]) {
    const { contract, documents } = expected[id];
    const pdf = await request(contractsApp).get(`/api/admin/contracts/${id}/pdf`).set(auth).buffer(true).parse(binary);
    expect(pdf.status).toBe(200);
    expect(sha256(pdf.body)).toBe(contract.pdf_sha256);
    const signed = await request(contractsApp).get(`/api/admin/contracts/${id}/signed-pdf`).set(auth).buffer(true).parse(binary);
    expect(signed.status).toBe(200);
    expect(sha256(signed.body)).toBe(contract.signed_pdf_sha256);
    const certificate = await request(contractsApp).get(`/api/admin/contracts/${id}/certificate`).set(auth).buffer(true).parse(binary);
    expect(certificate.status).toBe(200);
    const audit = documents.filter((d) => d.kind === 'audit').sort((a, b) => b.id - a.id)[0];
    expect(sha256(certificate.body)).toBe(audit.sha256);

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
  const signedHashes = new Set([expected[current].contract.signed_pdf_sha256, expected[legacy].contract.signed_pdf_sha256]);
  const attached = mails.flatMap((m) => m.attachments || []);
  expect(attached.length).toBeGreaterThanOrEqual(queued.length * 2);
  for (const a of attached) expect(a.path.startsWith(fs.realpathSync(newRoot))).toBe(true);
  const signedAttached = attached.filter((a) => /-signed\.pdf$/.test(a.filename));
  expect(signedAttached.length).toBe(queued.length);
  for (const a of signedAttached) expect(signedHashes.has(sha256(fs.readFileSync(a.path)))).toBe(true);
});

test('a stored path that climbs out of the storage root is not served', async () => {
  const contract = await db('contracts').whereNotNull('pdf_path').first('id', 'pdf_path');
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
    await db('contracts').where({ id: contract.id }).update({ pdf_path: contract.pdf_path });
  }
});
