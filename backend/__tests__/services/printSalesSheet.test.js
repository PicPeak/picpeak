'use strict';
const { PDFDocument, PDFRawStream, decodePDFRawStream } = require('pdf-lib');
jest.mock('../../src/services/pdfThemeService', () => ({ resolveTheme: jest.fn(async () => ({})) }));
const sheet = require('../../src/services/printSales/sheet');
const theme = require('../../src/services/pdfThemeService');
const row = { id: 'synthetic-order', snapshot_hash: 'synthetic-hash', invoice_id: 1 };
const snapshot = { totalMinor: 1000, vatMinor: 187, currency: 'EUR', items: [] };
const contact = { delivery: { name: 'Müller Łódź Αθήνα Київ', country: 'IE' }, buyerEmail: 'buyer@example.test' };
async function cmap(bytes) {
  const doc = await PDFDocument.load(bytes);
  return doc.context.enumerateIndirectObjects().filter(([, value]) => value instanceof PDFRawStream)
    .map(([, value]) => Buffer.from(decodePDFRawStream(value).decode()).toString()).filter(text => text.includes('begincmap')).join('\n');
}
test('the actual PDF embeds accented Latin, Greek and Cyrillic glyph mappings', async () => {
  const bytes = await sheet(row, snapshot, contact, []), mappings = await cmap(bytes);
  for (const character of ['ü', 'Ł', 'θ', 'К', 'ї']) expect(mappings.toLowerCase()).toContain(character.codePointAt(0).toString(16).padStart(4, '0'));
  expect(theme.resolveTheme).toHaveBeenCalledWith('invoice');
});
test('uses the existing configured document font files for other scripts', async () => {
  const path = require('path');
  theme.resolveTheme.mockResolvedValueOnce({ fontFamily: 'upload-1', fontFiles: {
    body: path.resolve(__dirname, '../../assets/fonts/IBM-Plex-Sans-Full/400.ttf'),
  } });
  const mappings = await cmap(await sheet(row, snapshot, contact, []));
  expect(mappings).toContain('041a');
});
