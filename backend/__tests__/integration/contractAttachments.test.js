/**
 * Contract attachments (#1445).
 *
 * Real admin + public routes → services → SQLite with the full
 * core-migration run (helpers/crmDb). Pins:
 *   - uploads are checked by content and stored once per file;
 *   - a template version carries its attachments into new contracts, with
 *     each file's sha256 recorded;
 *   - sending merges "in the PDF" attachments before the signature page,
 *     records them in the generated document's manifest, and attaches the
 *     separate ones to the email;
 *   - the signing page lists them and downloads only this contract's files,
 *     and only while the stored bytes still match;
 *   - an archived attachment blocks publishing; everything sits behind the
 *     contracts flag.
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { PDFDocument } = require('pdf-lib');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

jest.setTimeout(120000);

let db;
let cleanup;
let tmpDir;
let adminId;
let customerId;
let token;
let attachmentsApp;
let templatesApp;
let contractsApp;
let publicApp;
let signingApp;
const ids = {};
const files = {};

const prevCwd = process.cwd();
const auth = { get Authorization() { return `Bearer ${token}`; } };

async function setFlag(key, value) {
  const updated = await db('feature_flags').where({ key }).update({ value });
  if (!updated) await db('feature_flags').insert({ key, value });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
}

async function ok(req, status = [200, 201]) {
  const res = await req;
  if (!status.includes(res.status)) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

const binary = (r, cb) => {
  const chunks = [];
  r.on('data', (c) => chunks.push(c));
  r.on('end', () => cb(null, Buffer.concat(chunks)));
};

async function makePdf(pages, [width, height]) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage([width, height]);
  return Buffer.from(await doc.save());
}

function upload(buffer, fields = {}, filename = 'file.pdf') {
  let req = request(attachmentsApp).post('/api/admin/document-attachments').set(auth);
  for (const [key, value] of Object.entries(fields)) req = req.field(key, value);
  return req.attach('file', buffer, { filename, contentType: 'application/pdf' });
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  process.chdir(tmpDir);
  db.client.pool.acquireTimeoutMillis = 2000;
  ({ adminId, customerId } = await seedMinimal(db));
  await assignAdminRole(db, adminId, 'super_admin');
  token = mintAdminToken(adminId);
  await setFlag('contracts', true);

  attachmentsApp = buildRouteApp('/api/admin/document-attachments', require('../../src/routes/adminDocumentAttachments'));
  templatesApp = buildRouteApp('/api/admin/contract-templates', require('../../src/routes/adminContractTemplates'));
  contractsApp = buildRouteApp('/api/admin/contracts', require('../../src/routes/adminContracts'));
  publicApp = buildRouteApp('/api/public/contracts', require('../../src/routes/publicContracts'));
  signingApp = buildRouteApp('/api/public/contract-signing', require('../../src/routes/publicContractSigning'));

  files.terms = await makePdf(2, [300, 400]);
  files.privacy = await makePdf(1, [200, 200]);
  files.other = await makePdf(1, [250, 250]);
}, 120000);

afterAll(async () => {
  process.chdir(prevCwd);
  if (cleanup) await cleanup();
});

test('uploads are checked by content and stored once per file', async () => {
  const first = await upload(files.terms, { name: 'AGB' });
  expect(first.status).toBe(201);
  expect(first.body.attachment).toEqual(expect.objectContaining({ name: 'AGB', pages: 2, isActive: true }));
  ids.terms = first.body.attachment.id;

  const again = await upload(files.terms, { name: 'AGB again' });
  expect(again.status).toBe(200);
  expect(again.body).toEqual(expect.objectContaining({ existing: true }));
  expect(again.body.attachment.id).toBe(ids.terms);

  ids.privacy = (await ok(upload(files.privacy, { name: 'Datenschutz' }))).attachment.id;
  ids.other = (await ok(upload(files.other, {}, 'Preisliste.pdf'))).attachment.id;
  const { attachments } = await ok(request(attachmentsApp).get('/api/admin/document-attachments').set(auth));
  expect(attachments.find((a) => a.id === ids.other).name).toBe('Preisliste');

  const bogus = await upload(Buffer.from('not a pdf at all'), { name: 'Bogus' });
  expect(bogus.status).toBe(400);
  expect(['PDF_NOT_A_PDF', 'PDF_MALFORMED']).toContain(bogus.body.code);

  const row = await db('document_attachments').where({ id: ids.terms }).first();
  expect(row.storage_key).toBe(path.join('business-docs', 'attachments', `${row.sha256}.pdf`));
  expect(fs.readFileSync(path.join(process.env.STORAGE_PATH, row.storage_key)).equals(files.terms)).toBe(true);
});

test('a template version carries its attachments into new contracts', async () => {
  const [block] = await db('contract_blocks').where({ is_system: true, is_active: true }).orderBy('id');
  const created = await ok(request(templatesApp).post('/api/admin/contract-templates').set(auth).send({ name: 'Mit Anhängen' }));
  ids.template = created.template.id;
  const saved = await ok(request(templatesApp).put(`/api/admin/contract-templates/${ids.template}/draft`).set(auth).send({
    lockVersion: created.template.lockVersion,
    items: [{ kind: 'block', blockId: block.id }],
    attachments: [{ attachmentId: ids.terms, delivery: 'merged' }],
  }));
  expect(saved.draft.attachments).toEqual([expect.objectContaining({ attachmentId: ids.terms, delivery: 'merged', position: 1 })]);
  const published = await ok(request(templatesApp).post(`/api/admin/contract-templates/${ids.template}/publish`).set(auth)
    .send({ lockVersion: saved.template.lockVersion }));
  expect(published.published.attachments).toHaveLength(1);

  const { contract } = await ok(request(contractsApp).post('/api/admin/contracts').set(auth)
    .send({ customerAccountId: customerId, templateVersionId: published.published.id }));
  const termsSha = (await db('document_attachments').where({ id: ids.terms }).first()).sha256;
  expect(contract.attachments).toEqual([
    expect.objectContaining({ attachmentId: ids.terms, delivery: 'merged', sha256: termsSha }),
  ]);
  ids.contract = contract;
});

test('a draft contract\'s attachments can be changed', async () => {
  const { contract } = await ok(request(contractsApp).put(`/api/admin/contracts/${ids.contract.id}`).set(auth).send({
    lockVersion: ids.contract.lockVersion,
    attachments: [
      { attachmentId: ids.terms, delivery: 'merged' },
      { attachmentId: ids.privacy, delivery: 'separate' },
    ],
  }));
  expect(contract.attachments.map((a) => [a.attachmentId, a.delivery])).toEqual([
    [ids.terms, 'merged'], [ids.privacy, 'separate'],
  ]);

  const duplicate = await request(contractsApp).put(`/api/admin/contracts/${ids.contract.id}`).set(auth).send({
    lockVersion: contract.lockVersion,
    attachments: [{ attachmentId: ids.terms }, { attachmentId: ids.terms }],
  });
  expect(duplicate.status).toBe(400);
  expect(duplicate.body.code).toBe('ATTACHMENT_INVALID');

  // An archived attachment can't be added, but one the contract has stays.
  await ok(request(attachmentsApp).post(`/api/admin/document-attachments/${ids.other}/archive`).set(auth));
  await ok(request(attachmentsApp).post(`/api/admin/document-attachments/${ids.privacy}/archive`).set(auth));
  const archived = await request(contractsApp).put(`/api/admin/contracts/${ids.contract.id}`).set(auth).send({
    lockVersion: contract.lockVersion,
    attachments: [...contract.attachments, { attachmentId: ids.other, delivery: 'separate' }],
  });
  expect(archived.status).toBe(400);
  expect(archived.body.code).toBe('ATTACHMENT_INVALID');
  const kept = await ok(request(contractsApp).put(`/api/admin/contracts/${ids.contract.id}`).set(auth).send({
    lockVersion: contract.lockVersion,
    attachments: contract.attachments.map((a) => ({ attachmentId: a.attachmentId, delivery: a.delivery })),
  }));
  ids.contract = kept.contract;
  await ok(request(attachmentsApp).post(`/api/admin/document-attachments/${ids.other}/restore`).set(auth));
  await ok(request(attachmentsApp).post(`/api/admin/document-attachments/${ids.privacy}/restore`).set(auth));
});

test('sending merges attachments before the signature page and mails the separate ones', async () => {
  const contractService = require('../../src/services/contractService');
  await contractService.sendContract(ids.contract.id, adminId);

  const document = await db('generated_documents')
    .where({ doc_type: 'contract', doc_id: ids.contract.id, kind: 'unsigned' }).orderBy('id', 'desc').first();
  const manifest = JSON.parse(document.manifest);
  const stored = await PDFDocument.load(fs.readFileSync(document.path.startsWith('/')
    ? document.path : path.join(process.env.STORAGE_PATH, document.path)));
  expect(stored.getPageCount()).toBe(Number(document.pages));
  expect(manifest.signaturePage).toBe(stored.getPageCount());

  const terms = manifest.attachments.find((a) => a.attachmentId === ids.terms);
  expect(terms).toEqual(expect.objectContaining({ delivery: 'merged', pages: 2 }));
  // The attachment's own pages, in order, right before the signature page.
  const sizes = [0, 1].map((i) => stored.getPage(terms.firstPage - 1 + i).getSize());
  expect(sizes).toEqual([{ width: 300, height: 400 }, { width: 300, height: 400 }]);
  expect(terms.firstPage + 2).toBe(manifest.signaturePage);
  expect(manifest.attachments.find((a) => a.attachmentId === ids.privacy)).toEqual(
    expect.objectContaining({ delivery: 'separate' }),
  );

  const mail = await db('email_queue').where({ email_type: 'contract_sent' }).orderBy('id', 'desc').first();
  const names = JSON.parse(mail.email_data).attachments.map((a) => a.filename);
  expect(names).toContain('Datenschutz.pdf');
  expect(names).not.toContain('AGB.pdf');
});

test('the signing page lists the attachments and downloads only this contract\'s files', async () => {
  // A verified signer's session (#1446).
  const signerRow = await db('contract_signers').where({ contract_id: ids.contract.id, role: 'customer' }).first();
  const { token: session } = await require('../../src/services/contract/signers').createSession(signerRow.id, 'otp');
  const signing = (url) => request(signingApp).get(`/api/public/contract-signing/session${url}`).set('X-Signing-Session', session);
  const view = await ok(signing(''));
  expect(view.contract.attachments.map((a) => [a.id, a.delivery])).toEqual([
    [ids.terms, 'merged'], [ids.privacy, 'separate'],
  ]);

  const download = await signing(`/attachments/${ids.privacy}`).buffer(true).parse(binary);
  expect(download.status).toBe(200);
  expect(download.headers['content-type']).toMatch(/application\/pdf/);
  expect(download.body.equals(files.privacy)).toBe(true);

  const notOnContract = await signing(`/attachments/${ids.other}`);
  expect(notOnContract.status).toBe(404);

  // A contract sent before signatures v2 serves them from its link as well.
  const legacyToken = await require('./helpers/crmDb').createPublicToken(db, 'contract_action_tokens', { contract_id: ids.contract.id });
  const legacy = await request(publicApp).get(`/api/public/contracts/${legacyToken}/attachments/${ids.privacy}`).buffer(true).parse(binary);
  expect(legacy.status).toBe(200);

  // A stored file that no longer matches its recorded sha256 isn't served.
  const row = await db('document_attachments').where({ id: ids.privacy }).first();
  const absolute = path.join(process.env.STORAGE_PATH, row.storage_key);
  fs.writeFileSync(absolute, files.other);
  const changed = await signing(`/attachments/${ids.privacy}`);
  expect(changed.status).toBe(409);
  expect(changed.body.code).toBe('ATTACHMENT_CHANGED');
  fs.writeFileSync(absolute, files.privacy);
});

test('an archived attachment blocks publishing', async () => {
  const detail = await ok(request(templatesApp).get(`/api/admin/contract-templates/${ids.template}`).set(auth));
  const saved = await ok(request(templatesApp).put(`/api/admin/contract-templates/${ids.template}/draft`).set(auth)
    .send({ lockVersion: detail.template.lockVersion, title: 'Neu' }));
  await ok(request(attachmentsApp).post(`/api/admin/document-attachments/${ids.terms}/archive`).set(auth));
  const res = await request(templatesApp).post(`/api/admin/contract-templates/${ids.template}/publish`).set(auth)
    .send({ lockVersion: saved.template.lockVersion });
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(res.body.error).toMatch(/archived in the attachment library/);
  await ok(request(attachmentsApp).post(`/api/admin/document-attachments/${ids.terms}/restore`).set(auth));
});

test('attachments sit behind the contracts flag', async () => {
  await setFlag('contracts', false);
  const res = await request(attachmentsApp).get('/api/admin/document-attachments').set(auth);
  expect(res.status).toBe(403);
  expect(res.body.code).toBe('CONTRACTS_DISABLED');
  await setFlag('contracts', true);
});
