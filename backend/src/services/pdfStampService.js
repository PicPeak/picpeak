/**
 * Contract-PDF stamp service.
 *
 * Replaces the previous re-render-on-every-signature approach with
 * the industry-standard pattern: the unsigned contract PDF is
 * rendered once at send time and stays byte-immutable from then on.
 * Each signature event opens that PDF with pdf-lib, overlays the
 * signature PNG at the fixed coordinates defined in
 * pdfService.CONTRACT_SIGNATURE_LAYOUT, then writes the result to a
 * new timestamped file. Same model DocuSign / Adobe Sign / HelloSign
 * use.
 *
 * Why this matters for audit defence:
 *   - The customer's signed PDF = the original PDF + their signature
 *     stamp + nothing else. Bytes the customer saw at signing time
 *     pass through unchanged into the signed file.
 *   - No render-code drift between sign events; later layout
 *     tweaks to renderContractToBuffer don't retroactively change
 *     what already-signed PDFs look like.
 *   - The audit certificate (timestamps, IPs, hashes) is a
 *     separate sibling document — not embedded in the signed
 *     contract PDF — so the operator can verify each independently.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PDFKit = require('pdfkit');
const { PDFDocument } = require('pdf-lib');
const pdfService = require('./pdfService');
// Resolve these at function-call time, not at module-load time, so the
// module remains loadable even when pdfService is mocked in unit tests
// (the mock stubs only renderContractToBuffer). Each function reads
// the live values from pdfService at the top of its body.
function pdfConsts() {
  return {
    L: pdfService.CONTRACT_SIGNATURE_LAYOUT,
    PAGE: pdfService.PAGE,
    FONT_BODY: pdfService.FONT_BODY,
    FONT_BOLD: pdfService.FONT_BOLD,
    t: pdfService._internal && pdfService._internal.t,
    // formatDate respects the `general_date_format` app setting when
    // a dateFormat arg is passed; with no arg it defaults to the
    // European DD.MM.YYYY shape (the operator's locale). Used for the
    // "Datum: ..." line under each signature stamp.
    formatDate: pdfService._internal && pdfService._internal.formatDate,
  };
}
const logger = require('../utils/logger');

function sha256OfBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Convert PDFKit-style coordinates (top-left origin, y increases
 * downward) to pdf-lib coordinates (bottom-left origin, y increases
 * upward). Both libraries use PDF's native point unit.
 */
function pdfkitToPdfLib(pageHeight, x, y, w, h) {
  return {
    x,
    y: pageHeight - y - h,
    width: w,
    height: h,
  };
}

/**
 * Stamp a signature image onto an existing contract PDF.
 *
 * - `pdfBuffer` is the Buffer of the PDF we're stamping into. Either
 *   the originally-rendered unsigned PDF (first stamp) or a
 *   previously-stamped version (second stamp adds the admin's
 *   signature on top of the customer-stamped PDF).
 * - `signaturePngPath` is the on-disk path of the canvas PNG to
 *   embed. The file must exist; caller already validated this.
 * - `role` is 'customer' or 'admin' — selects the left/right box.
 * - `caption` is the typed name + ISO date string drawn under the
 *   image so the visual artifact matches what the unsigned PDF
 *   showed as empty caption rows.
 *
 * Returns a Buffer of the new PDF. Does NOT touch the input buffer
 * or the input file.
 */
async function stampSignature({ pdfBuffer, signaturePngPath, role, caption }) {
  const { L, FONT_BODY, FONT_BOLD, formatDate } = pdfConsts();
  if (!Buffer.isBuffer(pdfBuffer)) {
    throw new Error('stampSignature: pdfBuffer must be a Buffer');
  }
  if (!signaturePngPath || !fs.existsSync(signaturePngPath)) {
    throw new Error(`stampSignature: signature PNG not found at ${signaturePngPath}`);
  }
  if (!['customer', 'admin'].includes(role)) {
    throw new Error(`stampSignature: role must be 'customer' or 'admin', got '${role}'`);
  }

  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const pngBytes = fs.readFileSync(signaturePngPath);
  let pngImage;
  try {
    pngImage = await pdfDoc.embedPng(pngBytes);
  } catch (err) {
    // pdf-lib throws InvalidPNGError for files that aren't valid PNG.
    // Try JPEG as a fallback (the canvas could be saved as JPEG too).
    try {
      pngImage = await pdfDoc.embedJpg(pngBytes);
    } catch (_) {
      throw new Error(`stampSignature: signature file at ${signaturePngPath} is neither valid PNG nor JPEG`);
    }
  }

  // pdf-lib pages are 0-indexed. The signature page is the last page
  // of the unsigned PDF (added by renderContractToBuffer just before
  // the page-number stamp).
  const pages = pdfDoc.getPages();
  const sigPage = pages[pages.length - 1];
  const { height: pageH } = sigPage.getSize();

  // Origin coordinates for the box in PDFKit space. Pick by role.
  const boxX = role === 'customer' ? L.customerX : L.adminX;
  const boxY = L.boxY;
  const boxW = L.boxWidth;
  const boxH = L.boxHeight;

  // The signature image fits inside the box with 4pt padding on each
  // side. We preserve the aspect ratio by scaling the image to fit,
  // then centring it.
  const padding = 4;
  const innerW = boxW - 2 * padding;
  const innerH = boxH - 2 * padding;
  const imgW = pngImage.width;
  const imgH = pngImage.height;
  const scale = Math.min(innerW / imgW, innerH / imgH);
  const drawW = imgW * scale;
  const drawH = imgH * scale;
  // Centre inside the inner rect.
  const drawXPdfkit = boxX + padding + (innerW - drawW) / 2;
  const drawYPdfkit = boxY + padding + (innerH - drawH) / 2;
  const conv = pdfkitToPdfLib(pageH, drawXPdfkit, drawYPdfkit, drawW, drawH);

  sigPage.drawImage(pngImage, conv);

  // Caption — fill in the "Name: ___" and "Date: ___" rows under
  // the box. The unsigned PDF left these empty; we overwrite by
  // drawing white rectangles over the empty rows then printing the
  // filled-in values on top. Same coords as the unsigned render's
  // captionY = boxY + boxHeight + 6.
  if (caption && (caption.name || caption.signedAt)) {
    const captionYPdfkit = boxY + boxH + 6;
    // Use the shared formatDate helper so the "Datum: ..." line
    // matches the locale-aware DD.MM.YYYY format the rest of the
    // contract PDF uses (e.g. issue-date headline). Caller may pass
    // a custom dateFormat via caption.dateFormat for per-document
    // overrides; without it formatDate defaults to DD.MM.YYYY.
    const lines = [
      `${caption.nameLabel || 'Name'}: ${caption.name || ''}`,
      `${caption.dateLabel || 'Date'}: ${caption.signedAt && formatDate
        ? formatDate(caption.signedAt, caption.dateFormat)
        : ''}`,
    ];
    // Overdraw a white rectangle so we replace the unsigned-page's
    // empty captions cleanly. PDFKit + pdf-lib both lay glyphs over
    // existing content rather than replacing, so without this the
    // old "Name: " would still show through.
    const captionRect = pdfkitToPdfLib(pageH, boxX, captionYPdfkit - 2, boxW, 28);
    sigPage.drawRectangle({ ...captionRect, color: pdfLibRgb(1, 1, 1) });

    // Embed Helvetica (pdf-lib's built-in font). 9pt to match the
    // unsigned render's caption size.
    const StandardFonts = require('pdf-lib').StandardFonts;
    const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontSize = 9;
    for (let i = 0; i < lines.length; i++) {
      const lineY = captionYPdfkit + i * 12;
      const conv2 = pdfkitToPdfLib(pageH, boxX, lineY, boxW, fontSize);
      sigPage.drawText(lines[i], {
        x: conv2.x,
        y: conv2.y,
        size: fontSize,
        font: helv,
        color: pdfLibRgb(0, 0, 0),
      });
    }
  }

  const outBytes = await pdfDoc.save();
  return Buffer.from(outBytes);
}

// pdf-lib expects rgb() instances. Importing the helper lazily so
// the function works whether pdf-lib resolves it as a named export or
// a method on the default object across versions.
let _rgbFn = null;
function pdfLibRgb(r, g, b) {
  if (!_rgbFn) {
    const m = require('pdf-lib');
    _rgbFn = m.rgb || ((rr, gg, bb) => ({ type: 'RGB', red: rr, green: gg, blue: bb }));
  }
  return _rgbFn(r, g, b);
}

/**
 * Render the audit certificate — a standalone single-page (or 2-page
 * if it grows) PDF that records timestamps, IPs, SHA-256 hashes, and
 * the actor names for every signature event on the contract.
 *
 * Used as a sibling document to the signed contract PDF. Both are
 * attached to the contract_fully_signed email and stored on the
 * contract row so either party can fetch each independently.
 *
 * The certificate references the signed contract PDF by hash —
 * verifying the certificate authentic + re-hashing the contract PDF
 * is the integrity check.
 *
 * Returns { buffer, sha256 }.
 */
async function renderAuditCertificate({ contract, customer, admin, locale = 'de' }) {
  const { PAGE, FONT_BODY, FONT_BOLD, t } = pdfConsts();
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFKit({
        size: 'A4',
        bufferPages: true,
        margins: {
          top: PAGE.marginTop, bottom: PAGE.marginBottom,
          left: PAGE.marginLeft, right: PAGE.marginRight,
        },
        info: {
          Title: `${contract.contract_number || 'Contract'}_audit_certificate`,
          Author: 'picpeak',
          Subject: t(locale, 'audit_certificate_subject'),
        },
      });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({ buffer, sha256: sha256OfBuffer(buffer) });
      });
      doc.on('error', reject);

      doc._fonts = { body: FONT_BODY, bold: FONT_BOLD };

      let y = PAGE.marginTop;

      doc.font(doc._fonts.bold).fontSize(18).fillColor('#000');
      doc.text(t(locale, 'audit_title'), PAGE.marginLeft, y, {
        width: PAGE.contentWidth,
      });
      y = doc.y + 6;
      doc.strokeColor('#888').lineWidth(0.5)
        .moveTo(PAGE.marginLeft, y).lineTo(PAGE.marginLeft + PAGE.contentWidth, y).stroke();
      y += 14;

      doc.font(doc._fonts.body).fontSize(10).fillColor('#000');
      doc.text(t(locale, 'audit_intro'), PAGE.marginLeft, y, {
        width: PAGE.contentWidth, align: 'left',
      });
      y = doc.y + 14;

      const labelW = 200;
      const valueW = PAGE.contentWidth - labelW;
      function row(labelKey, value) {
        if (!value) return;
        doc.font(doc._fonts.bold).fontSize(9).fillColor('#444');
        doc.text(t(locale, labelKey), PAGE.marginLeft, y, {
          width: labelW, lineBreak: false,
        });
        doc.font(doc._fonts.body).fontSize(9).fillColor('#000');
        doc.text(String(value), PAGE.marginLeft + labelW, y, {
          width: valueW, align: 'left',
        });
        y = Math.max(y + 12, doc.y + 4);
      }

      row('audit_contract_number', contract.contract_number);
      row('audit_issued_at', contract.sent_at
        ? new Date(contract.sent_at).toISOString()
        : null);

      if (customer && (customer.name || customer.signedAt)) {
        y += 6;
        doc.font(doc._fonts.bold).fontSize(11).fillColor('#000');
        doc.text(t(locale, 'audit_customer_section'), PAGE.marginLeft, y);
        y = doc.y + 4;
        row('audit_signed_by', customer.name);
        row('audit_signed_at', customer.signedAt ? new Date(customer.signedAt).toISOString() : null);
        row('audit_ip', customer.ip);
      }
      if (admin && (admin.name || admin.signedAt)) {
        y += 6;
        doc.font(doc._fonts.bold).fontSize(11).fillColor('#000');
        doc.text(t(locale, 'audit_admin_section'), PAGE.marginLeft, y);
        y = doc.y + 4;
        row('audit_signed_by', admin.name);
        row('audit_signed_at', admin.signedAt ? new Date(admin.signedAt).toISOString() : null);
        row('audit_ip', admin.ip);
      }

      if (contract.pdf_sha256 || contract.signed_pdf_sha256) {
        y += 8;
        doc.font(doc._fonts.bold).fontSize(11).fillColor('#000');
        doc.text(t(locale, 'audit_integrity_section'), PAGE.marginLeft, y);
        y = doc.y + 4;
        row('audit_unsigned_sha', contract.pdf_sha256);
        row('audit_signed_sha', contract.signed_pdf_sha256);
      }

      y += 14;
      doc.font(doc._fonts.body).fontSize(8).fillColor('#666');
      doc.text(t(locale, 'audit_footer'), PAGE.marginLeft, y, {
        width: PAGE.contentWidth, align: 'left',
      });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Apply a sequence of signature stamps to a contract PDF buffer.
 * Each stamp is `{ signaturePngPath, role, caption }`. Returns the
 * final buffer + its SHA-256 hash.
 *
 * Single-pass so file IO happens once per stamp pair. Caller orders
 * the array (customer first, admin second) per the desired
 * provenance chain.
 */
async function stampSignatures(originalPdfBuffer, stamps) {
  let buffer = originalPdfBuffer;
  for (const stamp of stamps) {
    if (!stamp.signaturePngPath) continue;
    try {
      buffer = await stampSignature({
        pdfBuffer: buffer,
        signaturePngPath: stamp.signaturePngPath,
        role: stamp.role,
        caption: stamp.caption,
      });
    } catch (err) {
      logger.error('stampSignatures: failed to apply stamp', {
        role: stamp.role,
        signaturePngPath: stamp.signaturePngPath,
        message: err.message,
      });
      // Skip the failed stamp but keep going — better to produce a
      // PDF missing one signature than to lose the whole document.
    }
  }
  return { buffer, sha256: sha256OfBuffer(buffer) };
}

module.exports = {
  stampSignature,
  stampSignatures,
  renderAuditCertificate,
  _internal: { pdfkitToPdfLib, sha256OfBuffer },
};
