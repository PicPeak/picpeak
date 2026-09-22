/**
 * The PDF theme in the renderer (#1445): colours, the footer, page numbers
 * that skip the payment slip, Jost italic on line comments, the contract's
 * date format, and deterministic output for the same inputs.
 */

const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const pdfService = require('../../src/services/pdfService');
const { resolveTheme, builtInTheme } = require('../../src/services/pdf/theme');

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

const issuer = {
  companyName: 'Studio Test', addressLine1: 'Weg 1', postalCode: '9490', city: 'Vaduz', countryCode: 'LI',
};

const quoteContext = (theme, extra = {}) => ({
  locale: 'de',
  currency: 'CHF',
  issuer,
  recipient: { companyName: 'Kunde AG' },
  theme,
  lineItems: [{
    quantity: 1, description: 'Fotografie', unitPriceMinor: 10000, discountPercent: 0,
    lineTotalMinor: 10000, detailsText: 'Eine Notiz zur Zeile',
  }],
  totals: { netAmountMinor: 10000, vatRate: 0, vatAmountMinor: 0, shippingAmountMinor: 0, totalAmountMinor: 10000 },
  doc: { quoteNumber: 'Q-2026-0001', issueDate: '2026-09-14', totalAmountMinor: 10000 },
  ...extra,
});

const contractContext = (extra = {}) => ({
  locale: 'de',
  issuer,
  recipient: { companyName: 'Kunde AG' },
  doc: { contractNumber: 'C-2026-0001', issueDate: '2026-09-14' },
  sections: [{ section: 'scope', blocks: [{ name: 'Leistung', body: 'Text' }] }],
  ...extra,
});

afterEach(() => jest.restoreAllMocks());

function spyOn(method) {
  const spy = jest.spyOn(PDFDocument.prototype, method);
  return () => spy.mock.calls.map((call) => call[0]);
}

test('the same inputs render to the same bytes', async () => {
  const at = '2026-09-14T10:00:00Z';
  const a = await pdfService.renderQuoteToBuffer(quoteContext(builtInTheme('quote'), { generatedAt: at }));
  const b = await pdfService.renderQuoteToBuffer(quoteContext(builtInTheme('quote'), { generatedAt: at }));
  expect(sha256(a)).toBe(sha256(b));

  const c = await pdfService.renderContractToBuffer(contractContext({ generatedAt: at }));
  const d = await pdfService.renderContractToBuffer(contractContext({ generatedAt: at }));
  expect(sha256(c)).toBe(sha256(d));
});

test('a custom footer replaces the address line; "none" drops it', async () => {
  const address = 'Studio Test, Weg 1, LI-9490 Vaduz, Liechtenstein';

  let texts = spyOn('text');
  await pdfService.renderQuoteToBuffer(quoteContext(builtInTheme('quote')));
  expect(texts()).toContain(address);
  jest.restoreAllMocks();

  texts = spyOn('text');
  const custom = resolveTheme('quote', { quote: { footer: { mode: 'custom', text: 'Studio Test · Fotografie' } } });
  await pdfService.renderQuoteToBuffer(quoteContext(custom));
  expect(texts()).toContain('Studio Test · Fotografie');
  expect(texts()).not.toContain(address);
  jest.restoreAllMocks();

  texts = spyOn('text');
  await pdfService.renderQuoteToBuffer(quoteContext(resolveTheme('quote', { quote: { footer: { mode: 'none' } } })));
  expect(texts()).not.toContain(address);
});

test('the title uses the accent colour and size', async () => {
  const colors = spyOn('fillColor');
  const sizes = spyOn('fontSize');
  await pdfService.renderQuoteToBuffer(quoteContext(resolveTheme('quote', {
    default: { colors: { accent: '#123456' }, titleSize: 26 },
  })));
  expect(colors()).toContain('#123456');
  expect(sizes()).toContain(26);
});

test('line comments use Jost italic when the theme uses Jost', async () => {
  const fonts = spyOn('font');
  await pdfService.renderQuoteToBuffer(quoteContext(resolveTheme('quote', { default: { fontFamily: 'Jost' } })));
  expect(fonts()).toContain('crm-italic');
});

test('contracts use the configured date format', async () => {
  const texts = spyOn('text');
  await pdfService.renderContractToBuffer(contractContext({ dateFormat: { format: 'YYYY-MM-DD' } }));
  expect(texts()).toContain('2026-09-14');
});

test('page numbers skip the payment slip and do not count it', () => {
  const doc = new PDFDocument({ size: 'A4', bufferPages: true });
  doc._fonts = { body: 'Helvetica', bold: 'Helvetica-Bold', italic: 'Helvetica-Oblique' };
  doc.addPage(); // page 2: the payment slip
  doc._paymentSlipPages = new Set([1]);
  doc.addPage(); // page 3

  const switched = jest.spyOn(doc, 'switchToPage');
  const texts = jest.spyOn(doc, 'text');
  pdfService._internal.stampPageNumbers(doc, 'en');

  const { t } = pdfService._internal;
  expect(switched.mock.calls.map((c) => c[0])).toEqual([0, 2]);
  expect(texts.mock.calls.map((c) => c[0])).toEqual([
    t('en', 'page_of', { current: 1, total: 2 }),
    t('en', 'page_of', { current: 2, total: 2 }),
  ]);
  doc.end();
});

test('page numbers can be centred or left off', () => {
  const doc = new PDFDocument({ size: 'A4', bufferPages: true });
  doc._fonts = { body: 'Helvetica' };
  doc._theme = resolveTheme('quote', { quote: { pageNumbers: 'none' } });
  const texts = jest.spyOn(doc, 'text');
  pdfService._internal.stampPageNumbers(doc, 'en');
  expect(texts).not.toHaveBeenCalled();
  doc.end();
});

// ---------------------------------------------------------------------
// Render coverage (#1445 plan slice 2): long contracts, both languages.
// ---------------------------------------------------------------------

const { PDFDocument: PdfLib } = require('pdf-lib');

/** Every text drawn, with the 0-based page it was drawn on. */
function recordTexts() {
  const drawn = [];
  const text = PDFDocument.prototype.text;
  jest.spyOn(PDFDocument.prototype, 'text').mockImplementation(function (str, ...rest) {
    drawn.push({ text: String(str), page: this._pageBuffer ? this._pageBuffer.indexOf(this.page) : -1 });
    return text.call(this, str, ...rest);
  });
  return drawn;
}

const longClauses = (count, body) => [{
  section: 'scope',
  blocks: Array.from({ length: count }, (_, i) => ({ name: `Klausel ${i + 1}`, body })),
}];

test('a contract of three or more pages numbers each page of the total and ends on the signature page', async () => {
  const drawn = recordTexts();
  const buffer = await pdfService.renderContractToBuffer(contractContext({
    sections: longClauses(12, 'Der Auftragnehmer erbringt die vereinbarten Leistungen sorgfältig. '.repeat(12)),
  }));
  const pages = (await PdfLib.load(buffer)).getPageCount();
  expect(pages).toBeGreaterThanOrEqual(3);

  const { t } = pdfService._internal;
  for (let n = 1; n <= pages; n += 1) {
    const label = t('de', 'page_of', { current: n, total: pages });
    expect(drawn.find((d) => d.text === label)).toEqual({ text: label, page: n - 1 });
  }
  const signature = drawn.find((d) => d.text === t('de', 'signature_page_title'));
  expect(signature.page).toBe(pages - 1);
  // No clause text lands on the signature page.
  expect(drawn.filter((d) => d.text.startsWith('Klausel ')).every((d) => d.page < pages - 1)).toBe(true);
});

test('with merged attachments the signature page counts them in its number', async () => {
  const drawn = recordTexts();
  const buffer = await pdfService.renderContractToBuffer(contractContext({ mergedAttachmentPages: 4 }));
  const own = (await PdfLib.load(buffer)).getPageCount();
  const { t } = pdfService._internal;
  expect(drawn.map((d) => d.text)).toContain(t('de', 'page_of', { current: own + 4, total: own + 4 }));
});

test('the same contract renders in English and in German with that language\'s strings', async () => {
  const { t } = pdfService._internal;
  for (const locale of ['en', 'de']) {
    const drawn = recordTexts();
    await pdfService.renderContractToBuffer(contractContext({ locale, doc: { contractNumber: 'C-1', issueDate: '2026-09-14' } }));
    const texts = drawn.map((d) => d.text);
    for (const key of ['contract_title', 'contract_number_label', 'section_scope', 'signature_page_title', 'signature_page_prompt']) {
      expect(texts).toContain(t(locale, key));
    }
    expect(texts).toContain(t(locale, 'page_of', { current: 1, total: 2 }));
    jest.restoreAllMocks();
  }
  expect(t('en', 'signature_page_title')).not.toBe(t('de', 'signature_page_title'));
});

test('a clause that is one 20 000-character paragraph flows over pages and keeps the signature page last', async () => {
  const word = 'Nutzungsrecht ';
  const paragraph = word.repeat(Math.ceil(20000 / word.length)).slice(0, 20000);
  const drawn = recordTexts();
  const buffer = await pdfService.renderContractToBuffer(contractContext({
    sections: [{ section: 'scope', blocks: [{ name: 'Lizenz', body: paragraph }] }],
  }));
  const pages = (await PdfLib.load(buffer)).getPageCount();
  expect(pages).toBeGreaterThanOrEqual(3);
  const { t } = pdfService._internal;
  expect(drawn.find((d) => d.text === t('de', 'signature_page_title')).page).toBe(pages - 1);
  expect(drawn.find((d) => d.text === paragraph)).toBeDefined();
});

// ---------------------------------------------------------------------
// Layout in the theme (#1445 plan slice 8)
// ---------------------------------------------------------------------

const MM = 2.834645669;
const withLayout = (settings) => resolveTheme('contract', { contract: settings });

test('the margins move the letter text; the signature slots stay put for every margin combination', async () => {
  const L = pdfService.CONTRACT_SIGNATURE_LAYOUT;
  const reference = (await pdfService.renderContractWithSlots(contractContext())).slots;
  expect(reference[0]).toEqual(expect.objectContaining({ x: L.customerX, y: L.boxY }));
  for (const left of [20, 25, 30]) {
    for (const right of [10, 25]) {
      for (const bottom of [15, 30]) {
        const { slots } = await pdfService.renderContractWithSlots(contractContext({
          theme: withLayout({ layout: { margins: { left, right, bottom } } }),
        }));
        expect(slots.map(({ x, y, width, height, captionY }) => ({ x, y, width, height, captionY })))
          .toEqual(reference.map(({ x, y, width, height, captionY }) => ({ x, y, width, height, captionY })));
      }
    }
  }
  // The clause heading starts at the theme's left margin.
  const calls = [];
  const text = PDFDocument.prototype.text;
  jest.spyOn(PDFDocument.prototype, 'text').mockImplementation(function (str, x, ...rest) {
    calls.push({ text: String(str), x });
    return text.call(this, str, x, ...rest);
  });
  await pdfService.renderContractToBuffer(contractContext({ theme: withLayout({ layout: { margins: { left: 30 } } }) }));
  expect(calls.find((c) => c.text === 'Leistung').x).toBeCloseTo(30 * MM, 3);
  // The signature page title stays at the fixed margin.
  const { t } = pdfService._internal;
  expect(calls.find((c) => c.text === t('de', 'signature_page_title')).x).toBe(pdfService.PAGE.marginLeft);
});

test('a custom layout renders the same bytes twice', async () => {
  const at = '2026-09-14T10:00:00Z';
  const custom = withLayout({
    layout: { margins: { left: 25, right: 15, bottom: 20 }, addressWindow: false },
    logo: { position: 'center' }, bodySize: 11, lineHeight: 1.4,
  });
  const a = await pdfService.renderContractToBuffer(contractContext({ theme: custom, generatedAt: at }));
  const b = await pdfService.renderContractToBuffer(contractContext({ theme: custom, generatedAt: at }));
  expect(sha256(a)).toBe(sha256(b));
  const q1 = await pdfService.renderQuoteToBuffer(quoteContext(resolveTheme('quote', { quote: { layout: { margins: { left: 25 } } } }), { generatedAt: at }));
  const q2 = await pdfService.renderQuoteToBuffer(quoteContext(resolveTheme('quote', { quote: { layout: { margins: { left: 25 } } } }), { generatedAt: at }));
  expect(sha256(q1)).toBe(sha256(q2));
  // …and differs from the built-in layout.
  expect(sha256(q1)).not.toBe(sha256(await pdfService.renderQuoteToBuffer(quoteContext(builtInTheme('quote'), { generatedAt: at }))));
});

test('with the address window off the recipient moves into the flow and loses the return-address line', async () => {
  const calls = [];
  const text = PDFDocument.prototype.text;
  jest.spyOn(PDFDocument.prototype, 'text').mockImplementation(function (str, x, y, ...rest) {
    calls.push({ text: String(str), x, y });
    return text.call(this, str, x, y, ...rest);
  });
  const recipient = { companyName: 'Kunde AG', issuerLine: 'Studio Test · Weg 1 · 9490 Vaduz' };
  await pdfService.renderContractToBuffer(contractContext({ recipient }));
  const inWindow = calls.find((c) => c.text === 'Kunde AG');
  expect(inWindow.y).toBeCloseTo(52 * MM, 1);
  expect(calls.some((c) => c.text === recipient.issuerLine)).toBe(true);
  calls.length = 0;
  await pdfService.renderContractToBuffer(contractContext({ recipient, theme: withLayout({ layout: { addressWindow: false } }) }));
  const inFlow = calls.find((c) => c.text === 'Kunde AG');
  expect(inFlow.x).toBe(pdfService.PAGE.marginLeft);
  expect(inFlow.y).toBeLessThan(inWindow.y);
  expect(calls.some((c) => c.text === recipient.issuerLine)).toBe(false);
});

test('body size and line height reach the running text', async () => {
  const sizes = spyOn('fontSize');
  const drawn = [];
  const text = PDFDocument.prototype.text;
  jest.spyOn(PDFDocument.prototype, 'text').mockImplementation(function (str, ...rest) {
    const options = rest.find((r) => r && typeof r === 'object');
    drawn.push({ text: String(str), lineGap: options && options.lineGap });
    return text.call(this, str, ...rest);
  });
  await pdfService.renderContractToBuffer(contractContext({ theme: withLayout({ bodySize: 11.5, lineHeight: 1.5 }) }));
  expect(sizes()).toContain(11.5);
  expect(drawn.find((d) => d.text === 'Text').lineGap).toBeCloseTo((1.5 - 1.15) * 11.5, 5);
});

test('the logo can sit left or centred above the letter, or beside the name', async () => {
  const logoPath = require('path').resolve(__dirname, '../../../frontend/public/favicon-32x32.png');
  const place = async (logo) => {
    jest.restoreAllMocks();
    const calls = [];
    const image = PDFDocument.prototype.image;
    jest.spyOn(PDFDocument.prototype, 'image').mockImplementation(function (src, x, y, options) {
      calls.push({ x, y, options });
      return image.call(this, src, x, y, options);
    });
    await pdfService.renderContractToBuffer(contractContext({
      issuer: { ...issuer, logoPath }, theme: withLayout({ logo }),
    }));
    return calls[0];
  };
  const right = await place({});
  expect(right.x).toBeGreaterThan(300);
  const left = await place({ position: 'left' });
  expect(left.x).toBe(pdfService.PAGE.marginLeft);
  expect(left.options.align).toBe('left');
  const centre = await place({ position: 'center' });
  expect(centre.options.align).toBe('center');
  // Above the address window, however tall the logo is set.
  expect(centre.y + centre.options.fit[1]).toBeLessThanOrEqual(45 * MM);
  const beside = await place({ stack: 'inline' });
  expect(beside.options.fit[0]).toBeLessThan(180);
});
