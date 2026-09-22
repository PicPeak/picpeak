/**
 * An imported invoice streams its stored original to the customer, so the
 * row's imported_pdf_path must name a file the import route wrote: inside
 * business-docs/invoice-imports, with symlinks followed. A restored or
 * hand-edited row naming anything else — the evidence key above all — is
 * refused rather than served.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let mockRow = null;
jest.mock('../../src/services/invoice/queries', () => ({
  getInvoiceById: async () => ({ invoice: mockRow, lineItems: [] }),
}));

const prevStorage = process.env.STORAGE_PATH;
let tmp; let root;
let renderInvoicePdfBuffer;

function put(rel, content) {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imported-invoice-'));
  root = path.join(tmp, 'storage');
  process.env.STORAGE_PATH = root;
  put('business-docs/invoice-imports/2026/imported-1.pdf', '%PDF-IMPORTED');
  put('business-docs/keys/evidence.key', 'EVIDENCE-KEY');
  put('business-docs/invoice/2026/I-1.pdf', '%PDF-OTHER');
  fs.writeFileSync(path.join(tmp, 'outside.pdf'), 'OUTSIDE');
  fs.symlinkSync(path.join(root, 'business-docs', 'keys', 'evidence.key'),
    path.join(root, 'business-docs', 'invoice-imports', '2026', 'link.pdf'));
  ({ renderInvoicePdfBuffer } = require('../../src/services/invoice/render'));
});

afterAll(() => {
  if (prevStorage === undefined) delete process.env.STORAGE_PATH;
  else process.env.STORAGE_PATH = prevStorage;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const render = (importedPath) => {
  mockRow = { id: 1, status: 'paid', imported_pdf_path: importedPath };
  return renderInvoicePdfBuffer(1);
};

test('serves the imported original, stored relative or absolute', async () => {
  expect((await render('business-docs/invoice-imports/2026/imported-1.pdf')).toString()).toBe('%PDF-IMPORTED');
  expect((await render(path.join(root, 'business-docs/invoice-imports/2026/imported-1.pdf'))).toString()).toBe('%PDF-IMPORTED');
});

test('refuses the evidence key and anything else outside invoice-imports with 403', async () => {
  for (const bad of [
    'business-docs/keys/evidence.key',
    'business-docs/invoice-imports/../keys/evidence.key',
    'business-docs/invoice-imports/2026/link.pdf',
    'business-docs/invoice/2026/I-1.pdf',
    path.join(tmp, 'outside.pdf'),
    '/etc/passwd',
  ]) {
    await expect(render(bad)).rejects.toMatchObject({ statusCode: 403 });
  }
});

test('a missing original is still 410', async () => {
  await expect(render('business-docs/invoice-imports/2026/gone.pdf')).rejects.toMatchObject({ statusCode: 410 });
});
