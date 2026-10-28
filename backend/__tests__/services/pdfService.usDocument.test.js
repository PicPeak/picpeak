/**
 * A business in the United States gets US conventions on its quotes and
 * invoices: addresses read "Denver, CO 80202" with no country line on
 * domestic mail, the totals say Subtotal and Sales tax, a reversal is a credit
 * memo, and the stored German default for the VAT label never reaches an
 * English document. A business anywhere else renders exactly as before.
 */

const PDFDocument = require('pdfkit');
const pdfService = require('../../src/services/pdfService');
const { builtInTheme } = require('../../src/services/pdf/theme');

const usIssuer = (extra = {}) => ({
  companyName: 'Example Photo Co.', addressLine1: '123 Main St', postalCode: '80202',
  city: 'Denver', state: 'CO', countryCode: 'US', phone: '(303) 555-0100', ...extra,
});

const usRecipient = (extra = {}) => ({
  companyName: 'Jordan Rivera', addressLine1: '1200 Lincoln St', city: 'Denver', state: 'CO',
  postalCode: '80203', countryCodeIso: 'US', ...extra,
});

const line = { quantity: 1, description: 'Full session', unitPriceMinor: 17500, discountPercent: 0, lineTotalMinor: 17500 };
const totals = { netAmountMinor: 17500, vatRate: 0, vatAmountMinor: 0, shippingAmountMinor: 0, totalAmountMinor: 17500 };

const quoteContext = (extra = {}) => ({
  locale: 'en', currency: 'USD', issuer: usIssuer(), recipient: usRecipient(),
  theme: builtInTheme('quote'), lineItems: [line], totals,
  doc: { quoteNumber: 'Q-2026-0001', issueDate: '2026-10-28', totalAmountMinor: 17500 },
  ...extra,
});

const invoiceContext = (doc = {}, extra = {}) => ({
  locale: 'en', currency: 'USD', qrFormat: 'none', issuer: usIssuer(), recipient: usRecipient(),
  theme: builtInTheme('invoice'), lineItems: [line], totals,
  doc: {
    kind: 'invoice', invoiceNumber: 'INV-2026-0001', issueDate: '2026-10-28', dueDate: '2026-11-27',
    totalAmountMinor: 17500, ...doc,
  },
  ...extra,
});

afterEach(() => jest.restoreAllMocks());

function drawnText() {
  const spy = jest.spyOn(PDFDocument.prototype, 'text');
  return () => spy.mock.calls.map((call) => String(call[0]));
}

const mentions = (texts, needle) => texts.some((s) => s.includes(needle));

describe('addresses', () => {
  test('the letterhead and footer write the business address the US way, without a country', async () => {
    const drawn = drawnText();
    await pdfService.renderQuoteToBuffer(quoteContext());
    const texts = drawn();
    expect(texts).toContain('Denver, CO 80202');
    expect(mentions(texts, 'US-80202')).toBe(false);
    expect(mentions(texts, 'United States')).toBe(false);
    expect(mentions(texts, 'Example Photo Co., 123 Main St, Denver, CO 80202')).toBe(true);
  });

  test('a customer in the US gets city, state and ZIP and no country line', async () => {
    const drawn = drawnText();
    await pdfService.renderInvoiceToBuffer(invoiceContext());
    const texts = drawn();
    expect(texts).toContain('Denver, CO 80203');
    expect(mentions(texts, 'United States')).toBe(false);
  });

  test('a customer abroad still gets the country line', async () => {
    const drawn = drawnText();
    await pdfService.renderInvoiceToBuffer(invoiceContext({}, {
      recipient: usRecipient({ city: 'London', state: null, postalCode: 'SW1A 1AA', countryCodeIso: 'GB' }),
    }));
    expect(drawn()).toContain('United Kingdom');
  });

  test('a business outside the US keeps the European address form', async () => {
    const drawn = drawnText();
    await pdfService.renderQuoteToBuffer(quoteContext({
      issuer: usIssuer({ city: 'Vaduz', state: null, postalCode: '9490', countryCode: 'LI' }),
      recipient: usRecipient({ city: 'Schaan', state: null, postalCode: '9494', countryCodeIso: 'LI' }),
    }));
    const texts = drawn();
    expect(texts).toContain('LI-9490 Vaduz / Liechtenstein');
    expect(texts).toContain('Liechtenstein');
  });
});

describe('wording', () => {
  test('the totals read Subtotal and Sales tax', async () => {
    const drawn = drawnText();
    await pdfService.renderInvoiceToBuffer(invoiceContext());
    const texts = drawn();
    expect(texts).toEqual(expect.arrayContaining(['Subtotal', 'Sales tax']));
    expect(texts).not.toContain('Net amount');
    expect(texts).not.toContain('VAT');
  });

  test('the stored default VAT label (MwSt.) never reaches an English document', async () => {
    const drawn = drawnText();
    await pdfService.renderInvoiceToBuffer(invoiceContext({}, { issuer: usIssuer({ vatLabel: 'MwSt.' }) }));
    expect(drawn()).not.toContain('MwSt.');
    expect(drawn()).toContain('Sales tax');
  });

  test('a VAT label the business chose itself is still printed', async () => {
    const drawn = drawnText();
    await pdfService.renderInvoiceToBuffer(invoiceContext({}, { issuer: usIssuer({ vatLabel: 'Colorado sales tax' }) }));
    expect(drawn()).toContain('Colorado sales tax');
  });

  test('the business tax number is labeled as an EIN', async () => {
    const drawn = drawnText();
    await pdfService.renderQuoteToBuffer(quoteContext({ issuer: usIssuer({ vatId: '12-3456789' }) }));
    expect(drawn()).toContain('EIN:');
    expect(drawn()).not.toContain('VAT no.:');
  });

  test('a cancelled invoice is titled a credit memo', async () => {
    const drawn = drawnText();
    await pdfService.renderInvoiceToBuffer(invoiceContext({
      kind: 'storno', cancelsInvoice: { number: 'INV-2026-0000', issueDate: '2026-10-01' },
    }));
    expect(drawn()).toContain('Credit memo');
    expect(drawn()).not.toContain('Cancellation invoice');
  });

  test('without a named contact the letter opens with Hello', async () => {
    const drawn = drawnText();
    await pdfService.renderQuoteToBuffer(quoteContext());
    expect(drawn()).toContain('Hello,');
    expect(drawn()).not.toContain('Dear Sir or Madam,');
  });

  test('a business outside the US keeps the existing English wording', async () => {
    const drawn = drawnText();
    await pdfService.renderInvoiceToBuffer(invoiceContext({}, {
      issuer: usIssuer({ city: 'Vaduz', state: null, postalCode: '9490', countryCode: 'LI' }),
    }));
    expect(drawn()).toEqual(expect.arrayContaining(['Net amount', 'VAT']));
    expect(drawn()).not.toContain('Sales tax');
  });
});
