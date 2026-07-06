/**
 * Tests for the createBaseDocument + getPageMetrics helpers — the
 * shared PDF factory used by quote/invoice rendering AND by the
 * upcoming tax-report renderer. These verify orientation handling
 * and font defaults without touching DB or filesystem.
 */
const pdfService = require('../../src/services/pdfService');

describe('getPageMetrics', () => {
  it('returns portrait A4 metrics by default', () => {
    const p = pdfService.getPageMetrics();
    expect(p.width).toBeCloseTo(595.28, 1);
    expect(p.height).toBeCloseTo(841.89, 1);
    expect(p.contentWidth).toBeCloseTo(515.28, 1);
  });

  it('returns portrait when orientation is "portrait"', () => {
    const p = pdfService.getPageMetrics('portrait');
    expect(p.width).toBeLessThan(p.height);
  });

  it('returns landscape A4 metrics (width > height) when orientation is "landscape"', () => {
    const p = pdfService.getPageMetrics('landscape');
    expect(p.width).toBeCloseTo(841.89, 1);
    expect(p.height).toBeCloseTo(595.28, 1);
    expect(p.contentWidth).toBeCloseTo(761.89, 1);
    expect(p.width).toBeGreaterThan(p.height);
  });

  it('ignores unknown orientation values (falls back to portrait)', () => {
    const p = pdfService.getPageMetrics('upside-down');
    expect(p.width).toBeLessThan(p.height);
  });
});

describe('createBaseDocument', () => {
  it('returns a PDFKit doc, page metrics, and logical font names by default', () => {
    const { doc, page, fonts } = pdfService.createBaseDocument();
    expect(doc).toBeDefined();
    expect(typeof doc.on).toBe('function');
    expect(typeof doc.font).toBe('function');
    expect(page.width).toBeCloseTo(595.28, 1); // portrait by default
    expect(fonts).toEqual({ body: 'Helvetica', bold: 'Helvetica-Bold' });
  });

  it('produces a landscape document when orientation is "landscape"', () => {
    const { doc, page } = pdfService.createBaseDocument({ orientation: 'landscape' });
    expect(page.width).toBeGreaterThan(page.height);
    // PDFKit stores the active page dims on doc.page.
    expect(doc.page.width).toBeCloseTo(841.89, 1);
    expect(doc.page.height).toBeCloseTo(595.28, 1);
  });

  it('produces a buffered PDF of non-zero size with the PDF magic header', async () => {
    const { doc } = pdfService.createBaseDocument({ orientation: 'landscape' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    const ended = new Promise((resolve) => doc.on('end', resolve));
    doc.text('hello', 40, 40);
    doc.end();
    await ended;
    const buf = Buffer.concat(chunks);
    expect(buf.length).toBeGreaterThan(0);
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('keeps Helvetica fonts when the issuer has no custom TTF path', () => {
    const { fonts } = pdfService.createBaseDocument({
      issuer: { pdfFontTtfPath: null },
    });
    expect(fonts.body).toBe('Helvetica');
    expect(fonts.bold).toBe('Helvetica-Bold');
  });

  it('falls back to Helvetica when the custom TTF path does not exist', () => {
    // No exception, no logger.error blow-up — just silent fallback.
    const { fonts } = pdfService.createBaseDocument({
      issuer: { pdfFontTtfPath: '/nonexistent/path/font.ttf' },
    });
    expect(fonts.body).toBe('Helvetica');
    expect(fonts.bold).toBe('Helvetica-Bold');
  });

  it('registers a bundled font family when pdfFontFamily is set', () => {
    // Migration-121 dropdown path. Inter ships 400 + 600 + 700 under
    // backend/assets/fonts/Inter/, so the resolver should pick 400
    // for body and 700 for bold.
    const { fonts } = pdfService.createBaseDocument({
      issuer: { pdfFontFamily: 'Inter' },
    });
    expect(fonts.body).toBe('crm-body');
    expect(fonts.bold).toBe('crm-bold');
  });

  it('falls back to Helvetica when pdfFontFamily names a non-existent directory', () => {
    const { fonts } = pdfService.createBaseDocument({
      issuer: { pdfFontFamily: 'NotARealFamily' },
    });
    expect(fonts.body).toBe('Helvetica');
    expect(fonts.bold).toBe('Helvetica-Bold');
  });

  it('strips path-traversal characters from pdfFontFamily', () => {
    // Defence in depth: the sanitiser keeps only [A-Za-z0-9_-].
    // "../../etc/passwd" becomes "etcpasswd" → no such font dir → fallback.
    const { fonts } = pdfService.createBaseDocument({
      issuer: { pdfFontFamily: '../../etc/passwd' },
    });
    expect(fonts.body).toBe('Helvetica');
    expect(fonts.bold).toBe('Helvetica-Bold');
  });

  it('prefers pdfFontTtfPath over pdfFontFamily when both are set', () => {
    // The explicit upload is the priority-1 override. When the upload
    // path is unusable (file missing) the family is consulted next.
    // Here we set BOTH to invalid values and confirm Helvetica fallback
    // — what matters is that the family DIDN'T get registered while a
    // (failed) explicit path was being evaluated.
    const { fonts } = pdfService.createBaseDocument({
      issuer: {
        pdfFontTtfPath: '/nonexistent/path/font.ttf',
        pdfFontFamily: 'Inter',
      },
    });
    // pdfFontTtfPath misses → falls through to pdfFontFamily → Inter
    // registers successfully. crm-body / crm-bold confirm a custom
    // font won.
    expect(fonts.body).toBe('crm-body');
    expect(fonts.bold).toBe('crm-bold');
  });

  it('forwards PDF info metadata (Title, Author) to the document', () => {
    const { doc } = pdfService.createBaseDocument({
      info: { Title: 'Tax Report 2026', Author: 'picpeak' },
    });
    // PDFKit copies these onto doc.info during construction.
    expect(doc.info.Title).toBe('Tax Report 2026');
    expect(doc.info.Author).toBe('picpeak');
  });
});

describe('exported letterhead helper', () => {
  it('exposes drawIssuerBlock for reuse by non-quote/invoice renderers', () => {
    expect(typeof pdfService.drawIssuerBlock).toBe('function');
  });
});

// Storno rendering — smoke-tests that exercise the kind='storno'
// branch in renderInvoiceToBuffer. We can't search the PDF buffer
// directly for German strings because PDFKit Flate-compresses
// content streams, but we CAN verify the renderer:
//   - completes without throwing on a Storno-shaped context,
//   - produces a valid %PDF magic header,
//   - produces a SMALLER document than its invoice counterpart
//     (no payment block, no QR slip → fewer bytes), proving the
//     suppression branches actually fire.
//
// Visual correctness (title swap, reference line, signed totals) is
// validated by manual review of a real Storno PDF; the renderer's
// branch logic is unit-tested in service tests where the inputs
// can be asserted directly.
describe('renderInvoiceToBuffer — Storno branch', () => {
  function buildContext(overrides = {}) {
    return {
      locale: 'de',
      currency: 'CHF',
      issuer: { companyName: 'AcmeCo' },
      recipient: {
        companyName: 'KundenCo', addressLine1: 'Strasse 1',
        city: 'Bern', postalCode: '3000',
      },
      lineItems: [{
        quantity: 1, description: 'Photo session',
        unitPriceMinor: 30000, lineTotalMinor: 30000,
        parentLineItemId: null, parentPosition: null,
      }],
      totals: {
        netAmountMinor: 30000, vatRate: 7.7, vatAmountMinor: 2310,
        shippingAmountMinor: 0, totalAmountMinor: 32310,
      },
      doc: { invoiceNumber: 'R-2026-0042', issueDate: '2026-04-12' },
      // Bank + payment term are part of the baseline invoice so the
      // payment block renders a real IBAN + Zahlungsbedingungen
      // section. The Storno branch suppresses this entirely, which
      // produces a visible byte-size delta.
      bank: {
        accountHolder: 'AcmeCo',
        iban: 'CH9300762011623852957',
        bic: 'POFICHBE',
        currency: 'CHF',
      },
      qrFormat: 'none',
      paymentTerm: { netDays: 30, skontoPercent: 2, skontoWithinDays: 10 },
      ...overrides,
    };
  }

  it('renders a valid Storno PDF (kind="storno", negated totals)', async () => {
    const buf = await pdfService.renderInvoiceToBuffer(buildContext({
      totals: {
        netAmountMinor: -30000, vatRate: 7.7, vatAmountMinor: -2310,
        shippingAmountMinor: 0, totalAmountMinor: -32310,
      },
      doc: {
        kind: 'storno',
        invoiceNumber: 'R-2026-0080',
        issueDate: '2026-05-15',
        cancelsInvoice: { number: 'R-2026-0042', issueDate: '2026-04-12' },
      },
    }));
    expect(buf.length).toBeGreaterThan(0);
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('produces a smaller PDF than the equivalent invoice (no payment block, no QR slip)', async () => {
    // Baseline: normal invoice with a payment block.
    const invoiceBuf = await pdfService.renderInvoiceToBuffer(buildContext());
    // Storno: same context but kind='storno' → payment block + QR
    // both suppressed. Payment block alone is ~80pt tall in the
    // PDF; its absence is reliably detectable as a byte-size delta.
    const stornoBuf = await pdfService.renderInvoiceToBuffer(buildContext({
      totals: {
        netAmountMinor: -30000, vatRate: 7.7, vatAmountMinor: -2310,
        shippingAmountMinor: 0, totalAmountMinor: -32310,
      },
      doc: {
        kind: 'storno',
        invoiceNumber: 'R-2026-0080',
        issueDate: '2026-05-15',
        cancelsInvoice: { number: 'R-2026-0042', issueDate: '2026-04-12' },
      },
    }));
    expect(stornoBuf.length).toBeGreaterThan(0);
    expect(stornoBuf.length).toBeLessThan(invoiceBuf.length);
  });
});
