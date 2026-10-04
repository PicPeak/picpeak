/**
 * PDF bytes for upload tests. The signer upload routes parse what they are
 * given (utils/pdfValidation), so a `%PDF-` prefix alone is refused there:
 * a fixture has to be a document pdf-lib can open.
 */
const { PDFDocument, PDFName, PDFString } = require('pdf-lib');

/** A plain one-page PDF; `label` makes two fixtures differ byte-wise. */
async function minimalPdf({ label = '', mutate } = {}) {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  if (label) doc.setTitle(String(label));
  if (mutate) await mutate(doc);
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/** A one-page PDF whose OpenAction runs JavaScript — active content. */
function javascriptPdf() {
  return minimalPdf({
    mutate: (doc) => {
      doc.catalog.set(PDFName.of('OpenAction'), doc.context.obj({
        Type: 'Action', S: 'JavaScript', JS: PDFString.of('app.alert(1)'),
      }));
    },
  });
}

/**
 * A PDF that defines object 1 (the catalog) twice. The xref table points at
 * the FIRST definition, which carries a JavaScript OpenAction; pdf-lib's
 * sequential scan keeps the LAST, harmless one. A viewer resolves through
 * the xref, so the two disagree about whether the file has active content.
 */
function duplicateObjectPdf() {
  const parts = [];
  const offsets = {};
  let pos = 0;
  const push = (text) => { parts.push(text); pos += Buffer.byteLength(text, 'latin1'); };
  push('%PDF-1.4\n');
  offsets[1] = pos;
  push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R /OpenAction << /Type /Action /S /JavaScript /JS (app.alert\\(1\\)) >> >>\nendobj\n');
  offsets[2] = pos;
  push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  offsets[3] = pos;
  push('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n');
  // The second, harmless catalog: last in the file, so the scan keeps it.
  push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  const xrefPos = pos;
  const pad = (n) => String(n).padStart(10, '0');
  push(`xref\n0 4\n0000000000 65535 f \n${pad(offsets[1])} 00000 n \n${pad(offsets[2])} 00000 n \n${pad(offsets[3])} 00000 n \n`);
  push(`trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);
  return Buffer.from(parts.join(''), 'latin1');
}

module.exports = { minimalPdf, javascriptPdf, duplicateObjectPdf };
