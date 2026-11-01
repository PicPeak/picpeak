'use strict';
const PDFDocument = require('pdfkit');
async function sheet(row, snapshot, contact, entries) {
  // Use the existing document-font configuration for studios needing scripts
  // outside the bundled Latin/Greek/Cyrillic family.
  const fonts = require('../pdf/fonts');
  const theme = await require('../pdfThemeService').resolveTheme('invoice');
  const options = theme.fontFiles ? theme : { fontFamily: 'IBM-Plex-Sans-Full' };
  const pdf = new PDFDocument({ size: 'A4', margin: 40 }), chunks = [];
  const done = new Promise((resolve, reject) => { pdf.on('data', b => chunks.push(b)); pdf.on('end', () => resolve(Buffer.concat(chunks))); pdf.on('error', reject); });
  const registered = fonts.registerFonts(pdf, options) || fonts.registerFonts(pdf, { fontFamily: 'IBM-Plex-Sans-Full' });
  if (!registered) throw new Error('The bundled print-sheet font is unavailable');
  pdf.font(registered.body);
  pdf.fontSize(18).text('Studio print order sheet');
  pdf.fontSize(10).text(`Order ${row.id}\nSelection ${row.snapshot_hash}\n${row.invoice_id ? `Invoice ${row.invoice_id}` : 'Invoice reference: see this order in PicPeak'}`);
  pdf.moveDown().text('PRIVATE STUDIO CHECKLIST — verify settlement and exact files before manual lab submission.');
  pdf.moveDown().text(`Deliver to: ${Object.values(contact.delivery).filter(Boolean).join(', ')}\nBuyer: ${contact.buyerEmail}`);
  if (snapshot.shipping?.zoneName) pdf.text(`Delivery zone: ${snapshot.shipping.zoneName}`);
  pdf.text(`Retail total: ${snapshot.totalMinor} minor units (${snapshot.currency}); VAT ${snapshot.vatMinor}`);
  for (let n = 0; n < snapshot.items.length; n++) {
    const i = snapshot.items[n], p = i.profile, e = entries[n];
    pdf.addPage();
    pdf.fontSize(14).text(`${n + 1}. ${p.selection.product.name} — ${i.quantity} copies`);
    pdf.fontSize(10).text(`File: ${e.name}\nSource: ${i.source.filename}\nSource SHA-256: ${i.source.sha256}\nArtwork SHA-256: ${e.asset.sha256}`);
    pdf.text(`Trim: ${p.manufacturing.trimMm.width} × ${p.manufacturing.trimMm.height} mm\nArtwork: ${p.artwork.widthMm} × ${p.artwork.heightMm} mm\nBleed (top/right/bottom/left): ${Object.values(p.manufacturing.bleedMm).join('/')} mm\nProfile: ${p.id} revision ${p.revision}\nLab reference: ${p.labReference || '(not provided)'}`);
    pdf.text(p.selection.attributes.map(a => `${a.name}: ${a.options.map(o => o.name).join(', ')}`).join('\n'));
    pdf.text(`Supplier: ${p.supplierName || '(studio configured)'}\nOutput: ${require('./colourProfiles').profile(p.manufacturing.output.colourSpace).label} ${p.manufacturing.output.format.toUpperCase()}. Single rectangular face; no wrapping, folds or imposition.`);
    if (p.manufacturing.output.profileSha256) pdf.text(`Output ICC SHA-256: ${p.manufacturing.output.profileSha256}`);
    if (p.instructions) pdf.moveDown().text(`Supplier instructions:\n${p.instructions}`);
    if (pdf.y + 270 > pdf.page.height - pdf.page.margins.bottom) pdf.addPage();
    pdf.image(e.thumbnail, { fit: [250, 250] });
    pdf.moveDown().text('[ ] Correct file, crop, product, finish and quantities\n[ ] Delivery and actual lab destination checked\nLab reference / operator notes: ______________________________');
  }
  pdf.end(); return done;
}
module.exports = sheet;
