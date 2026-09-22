/**
 * Placeholder escaping, PDF context (#1445): what the contract renderer
 * draws. A value is drawn in the body font as typed; only the template's own
 * `**…**` switches to bold. Asserted on the text runs and font switches the
 * renderer emits, not on pixels.
 */
const PDFDocument = require('pdfkit');
const pdfService = require('../../src/services/pdfService');
const { renderTemplatedBody } = require('../../src/services/contract/renderContext');
const payloads = require('../helpers/placeholderPayloads');

const values = (value) => ({ customer_name: value, event_name: 'Hochzeit' });

const context = (body) => ({
  locale: 'de',
  issuer: { companyName: 'Studio Test' },
  recipient: { companyName: 'Kunde AG' },
  doc: { contractNumber: 'C-2026-0001', issueDate: '2026-09-14' },
  sections: [{ section: 'scope', blocks: [{ name: 'Leistung', body }] }],
});

/** Every text run with the font it was drawn in. */
async function runs(body) {
  const drawn = [];
  const text = PDFDocument.prototype.text;
  jest.spyOn(PDFDocument.prototype, 'text').mockImplementation(function (str, ...rest) {
    drawn.push({ text: str, font: this._font && this._font.name });
    return text.call(this, str, ...rest);
  });
  await pdfService.renderContractToBuffer(context(body));
  jest.restoreAllMocks();
  return drawn;
}

test('a bold-looking value is drawn as typed, in the body font', async () => {
  const drawn = await runs(renderTemplatedBody('Kunde: {{customer_name}}', values(payloads.bold)));
  const run = drawn.find((d) => d.text === 'Kunde: **bold**');
  expect(run).toBeDefined();
  expect(run.font).toBe('Helvetica');
  expect(drawn.some((d) => d.text === 'bold' && d.font === 'Helvetica-Bold')).toBe(false);
});

test('the template\'s own bold still switches the font', async () => {
  const drawn = await runs(renderTemplatedBody('**Kunde:** {{customer_name}}', values(payloads.bold)));
  expect(drawn).toEqual(expect.arrayContaining([
    { text: 'Kunde:', font: 'Helvetica-Bold' },
    { text: ' **bold**', font: 'Helvetica' },
  ]));
});

test.each(Object.entries(payloads))('%s is drawn without being interpreted', async (_, value) => {
  const drawn = await runs(renderTemplatedBody('{{customer_name}}', values(value)));
  expect(drawn.map((d) => d.text)).toContain(value);
});
