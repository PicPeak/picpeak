/**
 * Web addresses in a line's description or notes are clickable on the PDF
 * (quotes, invoices and contracts share drawLineItems). Drawn for real, not
 * through a mocked Table, so the test reads the link annotation in the file.
 */
const path = require('path');
const PDFDocument = require('pdfkit');
const { drawLineItems } = require('../../src/services/pdfService')._internal;

async function render(lineItems) {
  const doc = new PDFDocument({ size: 'A4', compress: false });
  const face = (weight) => path.join(__dirname, '../../assets/fonts/Jost', weight);
  doc.registerFont('crm-body', face('400.ttf'));
  doc.registerFont('crm-bold', face('600.ttf'));
  doc.registerFont('crm-italic', face('400i.ttf'));
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', resolve));
  doc.y = 100;
  drawLineItems(doc, { type: 'invoice', locale: 'de', currency: 'CHF', intlLocale: 'de-CH', lineItems });
  doc.end();
  await done;
  return Buffer.concat(chunks).toString('latin1');
}

const item = (extra) => ({
  quantity: 1, description: 'Item', unitPriceMinor: 18000, discountPercent: 0, lineTotalMinor: 18000, ...extra,
});

const linkTargets = (pdf) => [...pdf.matchAll(/\/URI \(([^)]*)\)/g)].map((m) => m[1]);

describe('links in line items', () => {
  it('makes the address in a sub-line\'s notes a link', async () => {
    const pdf = await render([
      item({ position: 1, description: '28.09.2024: 10. Next-Step B', lineTotalMinor: 21000 }),
      item({
        position: 2, parentPosition: 1, description: 'Online Galerie', unitPriceMinor: 3000, lineTotalMinor: 3000,
        detailsText: 'https://photos.example.com/gallery/next-step-b/abc123',
      }),
    ]);
    expect(linkTargets(pdf)).toEqual(['https://photos.example.com/gallery/next-step-b/abc123']);
  });

  it('links an address inside a sentence, without the full stop after it', async () => {
    const pdf = await render([item({ description: 'Galerie: https://photos.example.com/g/x.' })]);
    expect(linkTargets(pdf)).toEqual(['https://photos.example.com/g/x']);
  });

  it('makes nothing a link without an http(s) address', async () => {
    const pdf = await render([item({ description: 'Shoot', detailsText: 'javascript:alert(1) or ftp://host/x' })]);
    expect(linkTargets(pdf)).toEqual([]);
  });

  it('draws a bare link in a link colour, not the text colour', async () => {
    const pdf = await render([item({ detailsText: 'https://photos.example.com/g/x' })]);
    // #0b57d0 as PDF fill colour components (11/255 87/255 208/255).
    expect(pdf).toMatch(/0\.04313\d* 0\.34117\d* 0\.81568\d* (rg|scn)/);
  });
});
