/**
 * A business in the United Kingdom (issue 2439): its documents carry the
 * trading disclosures in the footer, its English invoices use HMRC's wording
 * ("VAT Reg. No.", "Tax point"), show the VAT rate on every line, state the
 * VAT total in sterling when the invoice is in another currency, and can carry
 * the B2B late-payment notice. A business anywhere else renders as before.
 */

const PDFDocument = require('pdfkit');
const pdfService = require('../../src/services/pdfService');
const { builtInTheme } = require('../../src/services/pdf/theme');

const ukIssuer = (extra = {}) => ({
  companyName: 'Northern Lights Media', addressLine1: '1 High Street', postalCode: 'M1 1AA',
  city: 'Manchester', countryCode: 'GB', vatId: 'GB999999973',
  legalForm: 'ltd', registeredName: 'Northern Lights Media Ltd', companyNumber: '12345678',
  jurisdiction: 'england_wales', registeredOffice: '2 Office Row\nLondon EC1A 1AA', ...extra,
});

const recipient = { companyName: 'Band Ltd', addressLine1: '5 Stage Rd', city: 'Leeds', postalCode: 'LS1 1AA', countryCodeIso: 'GB' };
const line = { quantity: 1, description: 'Music video shoot', unitPriceMinor: 123400, discountPercent: 0, lineTotalMinor: 123400 };
const totals = { netAmountMinor: 123400, vatRate: 20, vatAmountMinor: 24680, shippingAmountMinor: 0, totalAmountMinor: 148080 };

const invoiceContext = (extra = {}) => ({
  locale: 'en', currency: 'GBP', qrFormat: 'none', issuer: ukIssuer(), recipient,
  theme: builtInTheme('invoice'), lineItems: [line], totals, vatRegistered: true,
  doc: {
    kind: 'invoice', invoiceNumber: 'INV-2026-0001', issueDate: '2026-11-09', dueDate: '2026-12-09',
    totalAmountMinor: 148080, servicePeriod: { from: '2026-11-01', to: null },
  },
  ...extra,
});

afterEach(() => jest.restoreAllMocks());

function drawnText() {
  const spy = jest.spyOn(PDFDocument.prototype, 'text');
  return () => spy.mock.calls.map((call) => String(call[0]));
}

const mentions = (texts, needle) => texts.some((s) => s.includes(needle));

describe('trading disclosures', () => {
  test('a company prints its registered name, part of the UK, number and office', async () => {
    const drawn = drawnText();
    await pdfService.renderInvoiceToBuffer(invoiceContext());
    const texts = drawn();
    expect(texts).toContain('Northern Lights Media Ltd · Registered in England and Wales · Company no. 12345678');
    expect(texts).toContain('Registered office: 2 Office Row, London EC1A 1AA');
  });

  test('they print even when the theme hides the footer', async () => {
    const theme = { ...builtInTheme('invoice'), footer: { mode: 'none', text: '' } };
    const drawn = drawnText();
    await pdfService.renderInvoiceToBuffer(invoiceContext({ theme }));
    expect(drawn()).toContain('Registered office: 2 Office Row, London EC1A 1AA');
  });

  test('a sole trader under a business name prints the proprietor', async () => {
    const drawn = drawnText();
    await pdfService.renderQuoteToBuffer({
      ...invoiceContext(),
      issuer: ukIssuer({ legalForm: 'sole_trader', proprietorName: 'Alex Morgan', companyNumber: null }),
      doc: { quoteNumber: 'Q-2026-0001', issueDate: '2026-11-09', totalAmountMinor: 148080 },
    });
    const texts = drawn();
    expect(texts).toContain('Proprietor: Alex Morgan');
    expect(mentions(texts, 'Company no.')).toBe(false);
  });

  test('a business outside the UK prints none', async () => {
    const drawn = drawnText();
    await pdfService.renderInvoiceToBuffer(invoiceContext({ issuer: ukIssuer({ countryCode: 'LI' }) }));
    const texts = drawn();
    expect(mentions(texts, 'Registered office')).toBe(false);
    expect(mentions(texts, 'Company no.')).toBe(false);
  });
});

describe('a UK VAT invoice', () => {
  test('uses HMRC wording for the VAT number and the time of supply', async () => {
    const drawn = drawnText();
    await pdfService.renderInvoiceToBuffer(invoiceContext());
    const texts = drawn();
    expect(mentions(texts, 'VAT Reg. No.')).toBe(true);
    expect(mentions(texts, 'Tax point')).toBe(true);
    expect(mentions(texts, 'Service date')).toBe(false);
  });

  // The totals block is drawn twice (once to measure it), so the rate column
  // is compared against the same invoice from a business elsewhere.
  async function rateCells(issuer, extra = {}) {
    const drawn = drawnText();
    await pdfService.renderInvoiceToBuffer(invoiceContext({ issuer, lineItems: [line, { ...line, description: 'Edit' }], ...extra }));
    const texts = drawn();
    jest.restoreAllMocks();
    return { rates: texts.filter((s) => s === '20%').length, texts };
  }

  test('shows the VAT rate on every line', async () => {
    const uk = await rateCells(ukIssuer());
    const elsewhere = await rateCells(ukIssuer({ countryCode: 'CH' }));
    expect(uk.rates).toBe(elsewhere.rates + 2);
    expect(uk.texts).toContain('VAT');
  });

  test('a business that is not VAT-registered gets no rate column', async () => {
    const drawn = drawnText();
    await pdfService.renderInvoiceToBuffer(invoiceContext({
      vatRegistered: false,
      totals: { ...totals, vatRate: 0, vatAmountMinor: 0, totalAmountMinor: 123400 },
    }));
    expect(drawn().filter((s) => s === '0%')).toHaveLength(0);
  });


  test('an invoice in another currency states its VAT in sterling with the rate', async () => {
    const drawn = drawnText();
    await pdfService.renderInvoiceToBuffer(invoiceContext({
      currency: 'EUR', vatGbp: { amountMinor: 21471, rate: 0.87 },
    }));
    const texts = drawn();
    expect(texts).toContain('VAT in GBP');
    expect(texts).toContain('214.71');
    expect(texts).toContain('Converted at 0.87 GBP per EUR');
  });

  test('a quote never carries the sterling row', async () => {
    const drawn = drawnText();
    await pdfService.renderQuoteToBuffer({
      ...invoiceContext({ currency: 'EUR', vatGbp: { amountMinor: 21471, rate: 0.87 } }),
      doc: { quoteNumber: 'Q-2026-0001', issueDate: '2026-11-09', totalAmountMinor: 148080 },
    });
    expect(drawn()).not.toContain('VAT in GBP');
  });

  test('carries the late-payment notice with the fixed sum for this debt', async () => {
    const drawn = drawnText();
    await pdfService.renderInvoiceToBuffer(invoiceContext({ latePayment: { compensationPounds: 70 } }));
    const texts = drawn();
    expect(texts).toContain('Late payment:');
    expect(mentions(texts, 'fixed-sum compensation of £70')).toBe(true);
  });

  test('names the scale when the invoice is not in sterling', async () => {
    const drawn = drawnText();
    await pdfService.renderInvoiceToBuffer(invoiceContext({ currency: 'EUR', latePayment: { compensationPounds: null } }));
    expect(mentions(drawn(), '£40, £70 or £100, depending on the amount')).toBe(true);
  });
});

// Luap round 1 on PR 2447.
describe('the registered office and long disclosures', () => {
  const { legalDisclosureLines, smallTextSize, pageMetricsFor, t } = pdfService._internal;

  test('a company that leaves the field blank shows its letterhead address as the registered office', () => {
    const lines = legalDisclosureLines(ukIssuer({ registeredOffice: '', addressLine2: 'Unit 4' }), 'en');
    expect(lines).toContain('Registered office: 1 High Street, Unit 4, GB-M1 1AA Manchester');
  });

  test('a long disclosure wraps inside the content width, at the narrowest margins and largest text', () => {
    const theme = { ...builtInTheme('invoice'), bodySize: 12, layout: { margins: { left: 30, right: 25, bottom: 20 }, addressWindow: true } };
    const office = 'Suite 1200, The Very Long Business Centre Building, 100 Extraordinarily Long Road Name, Little Snoring, Fakenham, Norfolk NR21 0AA';
    const issuer = ukIssuer({ registeredOffice: office, registeredName: 'An Unusually Long Registered Company Name For Testing Purposes Limited' });
    const lines = legalDisclosureLines(issuer, 'en', theme);
    expect(lines.length).toBeGreaterThan(2);
    const doc = new PDFDocument({ size: 'A4' });
    doc.font('Helvetica').fontSize(smallTextSize(theme));
    const width = pageMetricsFor(theme).contentWidth;
    for (const text of lines) expect(doc.widthOfString(text)).toBeLessThanOrEqual(width);
    expect(lines.join(' ')).toContain('Norfolk NR21 0AA');
  });

  test('the footer reserves a row for every wrapped line', async () => {
    const issuer = ukIssuer({ registeredOffice: 'x '.repeat(150).trim() });
    const drawn = drawnText();
    await pdfService.renderInvoiceToBuffer(invoiceContext({ issuer }));
    const lines = legalDisclosureLines(issuer, 'en', builtInTheme('invoice'));
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) expect(drawn()).toContain(line);
  });

  test('a "$&" in a registered name is printed as typed', () => {
    expect(t('en', 'disclosure_proprietor', { name: 'A $& B $\' C' })).toBe('Proprietor: A $& B $\' C');
  });
});
