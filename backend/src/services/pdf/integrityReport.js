'use strict';

/**
 * The integrity report as a one-page PDF (#1446), in the contract's theme:
 * every check with its result, the recorded value and the value found.
 * Resolves the PDF buffer.
 */

const PDFKit = require('pdfkit');

function renderIntegrityReport({ report, locale = 'de', theme = null, issuer = {} }) {
  const pdfService = require('../pdfService');
  const { PAGE } = pdfService;
  const { t, registerThemeFonts } = pdfService._internal;
  const colors = { text: '#000000', muted: '#666666', rule: '#888888', accent: '#000000', ...((theme && theme.colors) || {}) };

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFKit({
        size: 'A4',
        margins: { top: PAGE.marginTop, bottom: PAGE.marginBottom, left: PAGE.marginLeft, right: PAGE.marginRight },
        info: {
          Title: `${report.contractNumber || 'Contract'}_integrity_report`,
          Author: issuer.companyName || 'picpeak',
          Subject: t(locale, 'integrity_title'),
        },
      });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const fonts = registerThemeFonts(doc, issuer, theme);
      const left = PAGE.marginLeft;
      const width = PAGE.contentWidth;

      doc.font(fonts.bold).fontSize(16).fillColor(colors.accent).text(t(locale, 'integrity_title'), left, PAGE.marginTop, { width });
      const ruleY = doc.y + 4;
      doc.strokeColor(colors.rule).lineWidth(0.5).moveTo(left, ruleY).lineTo(left + width, ruleY).stroke();
      doc.y = ruleY + 8;
      doc.font(fonts.body).fontSize(9).fillColor(colors.text)
        .text(`${t(locale, 'audit_contract_number')}: ${report.contractNumber}`, left, doc.y, { width })
        .text(`${t(locale, 'integrity_generated')}: ${report.generatedAt}`, { width })
        .text(`${t(locale, 'integrity_result')}: ${t(locale, report.ok ? 'integrity_all_ok' : 'integrity_failed')}`, { width });
      doc.moveDown(0.6);

      for (const check of report.checks) {
        const verdict = check.ok === true ? 'integrity_ok' : check.ok === false ? 'integrity_mismatch' : 'integrity_not_checkable';
        const label = t(locale, `integrity_check_${check.check}`);
        doc.font(fonts.bold).fontSize(8.5).fillColor(check.ok === false ? '#b00020' : colors.text)
          .text(`${label}${check.subject ? ` · ${check.subject}` : ''} — ${t(locale, verdict)}${check.note ? ` (${check.note})` : ''}`, left, doc.y, { width });
        doc.font('Courier').fontSize(6.5).fillColor(colors.muted)
          .text(`${t(locale, 'integrity_expected')}: ${check.expected || '—'}`, left + 10, doc.y, { width: width - 10 })
          .text(`${t(locale, 'integrity_actual')}: ${check.actual || '—'}`, { width: width - 10 });
        doc.moveDown(0.3);
      }

      doc.moveDown(0.6);
      doc.font(fonts.body).fontSize(7.5).fillColor(colors.muted).text(t(locale, 'integrity_footer'), left, doc.y, { width });
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { renderIntegrityReport };
