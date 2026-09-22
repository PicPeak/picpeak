/**
 * PDF rendering in a worker (#1445): the worker renders the same bytes as
 * this process, a render past its time or heap comes back as
 * 422 PDF_RENDER_FAILED instead of stalling the server, and the renderer's
 * log entries still reach the server's logger.
 */

const crypto = require('crypto');
const { PDFDocument } = require('pdf-lib');
const pdfService = require('../../src/services/pdfService');
const { mergePdfs, insertBeforeLastPage, _raw: rawMerge } = require('../../src/services/pdf/merge');
const { renderInWorker, runRender } = require('../../src/services/pdf/renderIsolation');
const logger = require('../../src/utils/logger');

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const at = '2026-09-14T10:00:00Z';

const issuer = {
  companyName: 'Studio Test', addressLine1: 'Weg 1', postalCode: '9490', city: 'Vaduz', countryCode: 'LI',
};

const quoteContext = (extra = {}) => ({
  locale: 'de',
  currency: 'CHF',
  issuer,
  recipient: { companyName: 'Kunde AG' },
  lineItems: [{ quantity: 1, description: 'Fotografie', unitPriceMinor: 10000, discountPercent: 0, lineTotalMinor: 10000 }],
  totals: { netAmountMinor: 10000, vatRate: 0, vatAmountMinor: 0, shippingAmountMinor: 0, totalAmountMinor: 10000 },
  doc: { quoteNumber: 'Q-2026-0001', issueDate: '2026-09-14', totalAmountMinor: 10000 },
  generatedAt: at,
  ...extra,
});

const contractContext = (extra = {}) => ({
  locale: 'de',
  issuer,
  recipient: { companyName: 'Kunde AG' },
  doc: { contractNumber: 'C-2026-0001', issueDate: '2026-09-14' },
  sections: [{ section: 'scope', blocks: [{ name: 'Leistung', body: 'Text' }] }],
  generatedAt: at,
  ...extra,
});

let previous;
beforeAll(() => {
  previous = process.env.PDF_RENDER_ISOLATION;
  process.env.PDF_RENDER_ISOLATION = 'on';
});
afterAll(() => {
  process.env.PDF_RENDER_ISOLATION = previous;
});
afterEach(() => jest.restoreAllMocks());

test('a quote, an invoice and a contract render the same bytes in the worker as in this process', async () => {
  const quote = await pdfService.renderQuoteToBuffer(quoteContext());
  expect(sha256(quote)).toBe(sha256((await runRender('quote', quoteContext())).buffer));

  const invoiceCtx = quoteContext({ doc: { invoiceNumber: 'R-2026-0001', issueDate: '2026-09-14', totalAmountMinor: 10000 } });
  const invoice = await pdfService.renderInvoiceToBuffer(invoiceCtx);
  expect(sha256(invoice)).toBe(sha256((await runRender('invoice', invoiceCtx)).buffer));

  const worker = await pdfService.renderContractWithSlots(contractContext());
  const local = await runRender('contract', contractContext());
  expect(sha256(worker.buffer)).toBe(sha256(local.buffer));
  expect(worker.slots).toEqual(local.slots);
});

test('merging runs in the worker and matches the in-process merge', async () => {
  const contract = await pdfService.renderContractToBuffer(contractContext());
  const appendix = await pdfService.renderContractToBuffer(contractContext({ doc: { contractNumber: 'A-1' } }));
  const info = { title: 'C-2026-0001', createdAt: at };

  const inWorker = await insertBeforeLastPage(contract, [appendix], info);
  const inProcess = await rawMerge.insertBeforeLastPage(contract, [appendix], info);
  expect(sha256(inWorker.buffer)).toBe(sha256(inProcess.buffer));
  expect(inWorker.ranges).toEqual(inProcess.ranges);
  expect(inWorker.lastPageIndex).toBe((await PDFDocument.load(inWorker.buffer)).getPageCount() - 1);

  const merged = await mergePdfs([contract, appendix], info);
  expect(sha256(merged.buffer)).toBe(sha256((await rawMerge.mergePdfs([contract, appendix], info)).buffer));
});

test('a render that runs past its time is refused with PDF_RENDER_FAILED', async () => {
  await expect(renderInWorker('contract', contractContext(), { timeoutMs: 1 }))
    .rejects.toMatchObject({ statusCode: 422, code: 'PDF_RENDER_FAILED' });
});

test('a render that outgrows its heap is refused with PDF_RENDER_FAILED', async () => {
  // The same heap renders an ordinary contract: it is the document that is
  // refused, not the worker that failed to start.
  await expect(renderInWorker('contract', contractContext(), { heapMb: 16 })).resolves.toHaveProperty('buffer');
  const huge = 'Lorem ipsum dolor sit amet. '.repeat(20000);
  const sections = [{ section: 'scope', blocks: Array.from({ length: 20 }, (_, i) => ({ name: `§${i}`, body: huge })) }];
  await expect(renderInWorker('contract', contractContext({ sections }), { heapMb: 16 }))
    .rejects.toMatchObject({ statusCode: 422, code: 'PDF_RENDER_FAILED' });
});

test('the renderer\'s warnings reach the server\'s logger', async () => {
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  await pdfService.renderContractToBuffer(contractContext({
    issuer: { ...issuer, logoPath: '/nonexistent/logo.png', pdfShowLogo: true },
  }));
  expect(warn).toHaveBeenCalledWith('PDFKit failed to embed logo image', expect.anything());
});
