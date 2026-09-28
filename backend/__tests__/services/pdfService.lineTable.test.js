/**
 * The shared PDF line table (#1451, PDF pass 1). Quotes, invoices and
 * contracts all draw their line items through drawLineItems; these tests
 * capture the rows it hands to swissqrbill's Table and pin:
 *   - units in the quantity cell ("8 Std.", "pauschal") and the widened column;
 *   - discount lines as numbered minus rows without qty/unit price;
 *   - comment rows in the theme's italic face (Helvetica-Oblique fallback);
 *   - data rows naming the body font;
 *   - a contract following the quote's discount-column rule.
 */

const mockTables = [];
jest.mock('swissqrbill/pdf', () => ({
  SwissQRBill: jest.fn(),
  Table: jest.fn().mockImplementation((options) => {
    mockTables.push(options);
    return { attachTo: jest.fn() };
  }),
}));

const path = require('path');
const PDFDocument = require('pdfkit');
const { drawLineItems } = require('../../src/services/pdfService')._internal;

/**
 * A real document: drawLineItems plans its own page breaks now (#1546) and has
 * to measure every row to do it, so a `{ y }` stub no longer stands in. The
 * Table is still mocked, so nothing is actually drawn — these tests read the
 * rows it was handed.
 */
function draw(lineItems, extra = {}) {
  mockTables.length = 0;
  const doc = new PDFDocument({ size: 'A4' });
  // The renderer registers its logical font names on the document before it
  // draws; measuring the rows resolves them, so the test has to register them
  // too. Any real face will do — these tests read row data, not glyphs.
  const face = (weight) => path.join(__dirname, '../../assets/fonts/Jost', weight);
  doc.registerFont('crm-body', face('400.ttf'));
  doc.registerFont('crm-bold', face('600.ttf'));
  doc.registerFont('crm-italic', face('400i.ttf'));
  doc.y = 100;
  drawLineItems(doc, {
    type: 'quote', locale: 'de', currency: 'CHF', intlLocale: 'de-CH', lineItems, ...extra,
  });
  const [{ rows }] = mockTables;
  const [header, ...data] = rows;
  const cellTexts = (row) => row.columns.map((c) => c.text);
  return { header, data, cellTexts };
}

const item = (extra) => ({
  quantity: 1, description: 'Item', unitPriceMinor: 10000, discountPercent: 0, lineTotalMinor: 10000, ...extra,
});

describe('units', () => {
  it('puts the unit into the quantity cell and widens that column', () => {
    const { data, cellTexts } = draw([
      item({ description: 'Coverage', quantity: 8, unit: 'hour', lineTotalMinor: 120000 }),
      item({ description: 'Album', unit: 'flat' }),
      item({ description: 'Prints', quantity: 3 }),
    ]);
    expect(cellTexts(data[0])[2]).toBe('8 Std.');
    expect(cellTexts(data[1])[2]).toBe('pauschal');
    expect(cellTexts(data[2])[2]).toBe('3');
    const widths = data[0].columns.map((c) => c.width);
    expect(widths[2]).toBe(75);
    expect(widths.reduce((a, b) => a + b, 0)).toBe(515);
  });

  it('keeps the original widths when no line has a unit', () => {
    const { data } = draw([item()]);
    expect(data[0].columns.map((c) => c.width)).toEqual([30, 275, 55, 70, 85]);
  });

  it('translates the unit with the document language', () => {
    const { data, cellTexts } = draw([item({ quantity: 2, unit: 'day' })], { locale: 'en' });
    expect(cellTexts(data[0])[2]).toBe('2 d');
  });
});

describe('discount lines', () => {
  it('render as a numbered minus row without quantity or unit price', () => {
    const { data, cellTexts } = draw([
      item({ description: 'Coverage', lineTotalMinor: 100000, unitPriceMinor: 100000 }),
      item({
        description: 'Early booking', lineKind: 'discount', unitPriceMinor: -10000, lineTotalMinor: -10000,
        promotion: { type: 'percent', percent: 10 },
      }),
      item({ description: 'Album' }),
    ]);
    const [pos, desc, qty, unit, total] = cellTexts(data[1]);
    expect(pos).toBe('2');
    expect(desc).toBe('Early booking (10 %)');
    expect(qty).toBe('');
    expect(unit).toBe('');
    expect(total).toMatch(/-.*100\.00/);
    // The next line counts on from the discount.
    expect(cellTexts(data[2])[0]).toBe('3');
  });

  it('never opens the discount column on their own', () => {
    const { header } = draw([
      item(),
      item({ lineKind: 'discount', discountPercent: 50, unitPriceMinor: -500, lineTotalMinor: -500 }),
    ]);
    expect(header.columns).toHaveLength(5);
  });
});

describe('packages', () => {
  it('leave the unit price empty when the package line is the sum of its items', () => {
    const { data, cellTexts } = draw([
      item({ position: 1, description: 'Wedding Basic', unitPriceMinor: 0, lineTotalMinor: 340200 }),
      item({ position: 2, parentPosition: 1, description: 'Photography', quantity: 8, unitPriceMinor: 12000, lineTotalMinor: 96000 }),
      item({ position: 3, description: 'Album', unitPriceMinor: 39000, lineTotalMinor: 39000 }),
    ]);
    const [, desc, qty, unit, total] = cellTexts(data[0]);
    expect(desc).toBe('Wedding Basic');
    expect(qty).toBe('1');
    expect(unit).toBe('');
    expect(total).toMatch(/3.402\.00/);
    // An item inside the package, and a plain line, keep their prices.
    expect(cellTexts(data[1])[3]).toMatch(/120\.00/);
    expect(cellTexts(data[2])[3]).toMatch(/390\.00/);
  });

  it('keep a package line price that was set on the line itself', () => {
    const { data, cellTexts } = draw([
      item({ position: 1, description: 'Portrait package', unitPriceMinor: 50000, lineTotalMinor: 50000 }),
      item({ position: 2, parentPosition: 1, description: 'Editing', unitPriceMinor: 0, lineTotalMinor: 0 }),
    ]);
    expect(cellTexts(data[0])[3]).toMatch(/500\.00/);
  });
});

describe('fonts', () => {
  it('draws comment rows in the theme italic and data rows in the body font', () => {
    const { data } = draw([item({ detailsText: 'On location' })], {
      fonts: { body: 'crm-body', bold: 'crm-bold', italic: 'crm-italic' },
    });
    expect(data[0].fontName).toBe('crm-body');
    expect(data[1].columns[1]).toEqual(expect.objectContaining({ text: 'On location', fontName: 'crm-italic' }));
  });

  it('falls back to Helvetica-Oblique for comments without an italic face', () => {
    const { data } = draw([item({ detailsText: 'On location' })], { fonts: { body: 'crm-body', bold: 'crm-bold' } });
    expect(data[1].columns[1].fontName).toBe('Helvetica-Oblique');
  });
});

describe('contracts', () => {
  it('show the discount column like the quote they came from', () => {
    const { header } = draw([item({ discountPercent: 10, lineTotalMinor: 9000 })], { type: 'contract' });
    expect(header.columns).toHaveLength(6);
  });
});
