/**
 * Inbound PDFs — the accounting mailbox's attachments and the admin's
 * incoming-invoice upload — are parsed in the PDF worker, not in this process.
 *
 * expenseService.inspectFile used to call pdf-lib's PDFDocument.load on the
 * whole attachment in the server process; anyone who can mail the mailbox
 * reaches that unauthenticated, and a compressed-object bomb inflating there
 * takes the backend down — after which the retained message is ingested
 * again. The check now runs under utils/pdfValidation's heap, time and
 * inflate budgets, and a refused mail attachment is recorded as a failed,
 * declined document so the message is finished with rather than retried.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');
const { minimalPdf, javascriptPdf, duplicateObjectPdf } = require('./helpers/pdfFixture');

jest.setTimeout(120000);

let db; let cleanup; let tmpDir; let adminId; let expenseService;
let seq = 0;

// One page whose single stream inflates to `mb` MB of zeros: the shape a
// decompression bomb has (same fixture as the pdfValidation suite).
function bomb(mb) {
  const payload = zlib.deflateSync(Buffer.alloc(mb * 1024 * 1024), { level: 9 });
  const head = Buffer.from([
    '%PDF-1.4',
    '1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj',
    '2 0 obj <</Type/Pages/Kids[3 0 R]/Count 1>> endobj',
    '3 0 obj <</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]/Contents 4 0 R>> endobj',
    `4 0 obj <</Length ${payload.length}/Filter/FlateDecode>>`,
    'stream\n',
  ].join('\n'), 'latin1');
  const tail = Buffer.from('\nendstream endobj\ntrailer <</Size 5/Root 1 0 R>>\n%%EOF', 'latin1');
  return Buffer.concat([head, payload, tail]);
}

async function fileWith(bytes) {
  seq += 1;
  const filePath = path.join(tmpDir, `inbound-${seq}.pdf`);
  await fs.promises.writeFile(filePath, bytes);
  return filePath;
}

const record = (filePath, source, admin) => expenseService.recordInboundDocument(
  { source, filePath, originalFilename: path.basename(filePath), mimeType: 'application/pdf' }, admin,
);

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  const dbModule = require('../../src/database/db');
  dbModule.logActivity = async () => {};
  ({ adminId } = await seedMinimal(db));
  expenseService = require('../../src/services/expenseService');
});

afterAll(async () => { if (cleanup) await cleanup(); });

test('a plain PDF from the mailbox is captured with its page count', async () => {
  const doc = await record(await fileWith(await minimalPdf({ label: 'supplier' })), 'email', null);
  expect(doc.status).toBe('unsorted');
  expect(doc.parseStatus).toBe('pending');
  expect(doc.pageCount).toBe(1);
});

test('a plain PDF is stored byte for byte, hashed as received', async () => {
  // A supplier invoice may be digitally signed; re-serialising it would
  // break the signature and replace the accounting evidence.
  const crypto = require('crypto');
  const original = await minimalPdf({ label: 'signed-supplier-invoice' });
  const filePath = await fileWith(original);
  const doc = await record(filePath, 'email', null);
  expect(doc.status).toBe('unsorted');
  expect((await fs.promises.readFile(filePath)).equals(original)).toBe(true);
  const row = await db('inbound_documents').where({ id: doc.id }).first();
  expect(row.file_sha256).toBe(crypto.createHash('sha256').update(original).digest('hex'));
});

test('a mailed PDF whose xref resolves what the scan did not keep is declined, not stored as usable', async () => {
  // The xref points at a catalog with JavaScript; the scan kept the harmless
  // last one. The original is kept, so the disagreement itself is refused.
  const doc = await record(await fileWith(duplicateObjectPdf()), 'email', null);
  expect(doc.status).toBe('declined');
  expect(doc.parseStatus).toBe('failed');
  const row = await db('inbound_documents').where({ id: doc.id }).first();
  expect(row.parse_error).toContain('PDF_AMBIGUOUS_OBJECTS');
});

test('the same file uploaded by an admin is answered 400 and does not stay on disk', async () => {
  const filePath = await fileWith(duplicateObjectPdf());
  await expect(record(filePath, 'upload', adminId)).rejects.toMatchObject({ statusCode: 400, code: 'PDF_AMBIGUOUS_OBJECTS' });
  expect(fs.existsSync(filePath)).toBe(false);
});

test('a mail attachment the PDF check refuses is recorded as failed and declined, once', async () => {
  // The check never saw the page count, and the row says why. Declined keeps
  // it out of the unsorted inbox and the parsers; nothing is left pending
  // for the next poll to try again.
  const doc = await record(await fileWith(await javascriptPdf()), 'email', null);
  expect(doc.status).toBe('declined');
  expect(doc.parseStatus).toBe('failed');
  expect(doc.pageCount).toBeNull();
  expect((await db('inbound_documents').where({ id: doc.id }).first()).parse_error).toMatch(/^PDF_ACTIVE_CONTENT:/);
});

test('a decompression bomb from the mailbox is refused inside the budget, not inflated here', async () => {
  // ~64 KB of upload that wants to become 512 MB; the check stops at the
  // inflate budget in the worker. The process must not grow by anything near
  // the file's expansion.
  const file = await fileWith(bomb(512));
  const before = process.memoryUsage().rss;

  const doc = await record(file, 'email', null);

  expect(doc.status).toBe('declined');
  expect(doc.parseStatus).toBe('failed');
  expect((await db('inbound_documents').where({ id: doc.id }).first()).parse_error).toMatch(/^PDF_TOO_COMPLEX:/);
  expect(process.memoryUsage().rss - before).toBeLessThan(256 * 1024 * 1024);
});

test('a refused PDF uploaded by an admin is answered as a refusal and does not stay on disk', async () => {
  const file = await fileWith(await javascriptPdf());
  const before = await db('inbound_documents').count('* as n').first();

  await expect(record(file, 'upload', adminId)).rejects.toMatchObject({ statusCode: 400, code: 'PDF_ACTIVE_CONTENT' });

  expect(fs.existsSync(file)).toBe(false);
  expect(await db('inbound_documents').count('* as n').first()).toEqual(before);
});

test('a file that is not a PDF at all is still a document the admin can type in by hand', async () => {
  // Non-PDF attachments (images) were never parsed here; they are unchanged.
  seq += 1;
  const filePath = path.join(tmpDir, `scan-${seq}.jpg`);
  await fs.promises.writeFile(filePath, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0]));
  const doc = await expenseService.recordInboundDocument(
    { source: 'email', filePath, originalFilename: 'scan.jpg', mimeType: 'image/jpeg' }, null,
  );
  expect(doc.status).toBe('unsorted');
  expect(doc.parseStatus).toBe('pending');
});
