'use strict';

/**
 * Historical contracts survive a backup and restore (#1445, plan slice 11).
 *
 * A template with an attachment, a contract made from it and sent: export a
 * .picpeak, restore it into an emptied storage directory over a wiped
 * database, and the contract's stored PDF re-hashes to the sha256 recorded
 * for it, every attachment in its manifest re-hashes to the sha256 recorded
 * there, and the template version it was made from is still there with its
 * content hash. "Historical contracts remain reproducible", pinned.
 *
 * The storage directory is emptied in place, not swapped for one at another
 * path: generated documents record absolute paths, so a restore expects the
 * same STORAGE_PATH (the case for the Docker images, /app/storage).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const { PDFDocument } = require('pdf-lib');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(180000);

let db;
let cleanup;
let tmpDir;
let adminId;
let customerId;
let token;

const prevCwd = process.cwd();
const auth = { get Authorization() { return `Bearer ${token}`; } };
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const parsed = (value) => (typeof value === 'string' ? JSON.parse(value) : value);

async function ok(req, status = [200, 201]) {
  const res = await req;
  if (!status.includes(res.status)) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** A stored file's bytes, wherever the row says it is (relative to storage, or absolute). */
function readStored(file) {
  return fs.readFileSync(path.isAbsolute(file) ? file : path.join(process.env.STORAGE_PATH, file));
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  db.client.pool.acquireTimeoutMillis = 2000;
  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  for (const key of ['contracts', 'quotes']) {
    const updated = await db('feature_flags').where({ key }).update({ value: true });
    if (!updated) await db('feature_flags').insert({ key, value: true });
  }
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
  const profile = await db('business_profile').where({ id: 1 }).first();
  const columns = { email: 'studio@example.com', company_name: 'Studio Test' };
  if (profile) await db('business_profile').where({ id: 1 }).update(columns);
  else await db('business_profile').insert({ id: 1, ...columns });
}, 180000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

test('a sent contract, its attachments and its template version come back byte for byte from a .picpeak', async () => {
  const attachmentsApp = buildRouteApp('/api/admin/document-attachments', require('../../src/routes/adminDocumentAttachments'));
  const templatesApp = buildRouteApp('/api/admin/contract-templates', require('../../src/routes/adminContractTemplates'));
  const contractsApp = buildRouteApp('/api/admin/contracts', require('../../src/routes/adminContracts'));

  // An attachment merged into the PDF and one delivered separately.
  const pdf = async (pages, size) => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < pages; i += 1) doc.addPage(size);
    return Buffer.from(await doc.save());
  };
  const upload = async (buffer, name) => (await ok(request(attachmentsApp).post('/api/admin/document-attachments').set(auth)
    .field('name', name).attach('file', buffer, { filename: `${name}.pdf`, contentType: 'application/pdf' }))).attachment;
  const terms = await upload(await pdf(2, [300, 400]), 'AGB');
  const privacy = await upload(await pdf(1, [200, 200]), 'Datenschutz');

  // A template with both, published, made the default.
  const created = await ok(request(templatesApp).post('/api/admin/contract-templates').set(auth).send({ name: 'Mit Anhängen' }));
  const saved = await ok(request(templatesApp).put(`/api/admin/contract-templates/${created.template.id}/draft`).set(auth).send({
    lockVersion: created.template.lockVersion,
    items: [{ kind: 'text', section: 'scope', heading: 'Leistung', body: { de: 'Für {{customer_name}}.', en: 'For {{customer_name}}.' } }],
    attachments: [{ attachmentId: terms.id, delivery: 'merged' }, { attachmentId: privacy.id, delivery: 'separate' }],
  }));
  await ok(request(templatesApp).post(`/api/admin/contract-templates/${created.template.id}/publish`).set(auth)
    .send({ lockVersion: saved.template.lockVersion }));
  await ok(request(templatesApp).post(`/api/admin/contract-templates/${created.template.id}/default`).set(auth));

  // A contract from it, sent.
  const { contract } = await ok(request(contractsApp).post('/api/admin/contracts').set(auth).send({ customerAccountId: customerId }));
  await ok(request(contractsApp).post(`/api/admin/contracts/${contract.id}/send`).set(auth));

  const before = {
    contract: await db('contracts').where({ id: contract.id }).first(),
    document: await db('generated_documents').where({ doc_type: 'contract', doc_id: contract.id, kind: 'unsigned' }).first(),
    version: await db('contract_template_versions').where({ template_id: created.template.id, status: 'published' }).first(),
  };
  const manifest = parsed(before.document.manifest);
  expect(manifest.attachments.map((a) => a.delivery).sort()).toEqual(['merged', 'separate']);
  expect(sha256(readStored(before.document.path))).toBe(before.document.sha256);

  // Export, then restore into an empty storage directory over a wiped database.
  const { createPicpeak } = require('../../src/services/picpeakExportService');
  const { importFromPicpeak } = require('../../src/services/picpeakImportService');
  const { filePath } = await createPicpeak({ includePhotos: false });
  const storage = process.env.STORAGE_PATH;
  const moved = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-before-restore-'));
  try {
    // Nothing of the old storage stays: every file must come from the archive.
    fs.renameSync(path.join(storage, 'business-docs'), path.join(moved, 'business-docs'));
    for (const table of ['contract_attachment_inclusions', 'generated_documents', 'contract_block_inclusions',
      'contract_text_sections', 'contracts', 'contract_template_version_attachments', 'contract_template_version_items',
      'contract_template_versions', 'contract_templates', 'document_attachments']) {
      await db(table).del().catch(() => {});
    }
    const result = await importFromPicpeak({ picpeakPath: filePath, currentAdminId: adminId });
    expect(result.restored).toBe(true);

    const restored = {
      contract: await db('contracts').where({ id: contract.id }).first(),
      document: await db('generated_documents').where({ id: before.document.id }).first(),
      version: await db('contract_template_versions').where({ id: before.version.id }).first(),
    };
    // The records are the same records…
    expect(restored.contract.rendered_content_sha256).toBe(before.contract.rendered_content_sha256);
    expect(restored.contract.pdf_sha256).toBe(before.contract.pdf_sha256);
    expect(restored.document.sha256).toBe(before.document.sha256);
    expect(restored.version.content_sha256).toBe(before.version.content_sha256);
    // …and the files behind them are the same bytes, read from the new storage.
    expect(path.isAbsolute(restored.document.path) ? restored.document.path.startsWith(storage) : true).toBe(true);
    expect(sha256(readStored(restored.document.path))).toBe(restored.document.sha256);
    for (const entry of parsed(restored.document.manifest).attachments) {
      const row = await db('document_attachments').where({ id: entry.attachmentId }).first();
      expect(sha256(readStored(row.storage_key))).toBe(entry.sha256);
    }
    // The frozen content still hashes to what the signature is bound to.
    const { canonicalSha256 } = require('../../src/utils/canonicalJson');
    expect(canonicalSha256(parsed(restored.contract.rendered_content))).toBe(restored.contract.rendered_content_sha256);
  } finally {
    fs.rmSync(moved, { recursive: true, force: true });
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  }
});
