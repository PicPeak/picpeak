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

module.exports = { minimalPdf, javascriptPdf };
