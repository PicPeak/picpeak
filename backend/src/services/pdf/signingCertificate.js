'use strict';

/**
 * The signing certificate (#1446): a separate PDF in the contract's theme.
 * It lists what was signed (the content and PDF hashes), who signed and how
 * each signer was verified, every event of the signing log in order, and
 * the log's final hash. The signed PDF carries an identifier band that
 * points here; a copy of this certificate pins the log as it was at
 * completion.
 *
 * Resolves `{ buffer, sha256 }`.
 */

const crypto = require('crypto');
const PDFKit = require('pdfkit');

function iso(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().replace('.000Z', 'Z');
}

function renderSigningCertificate({
  contract, signers = [], events = [], hashes = {}, attachments = [], chainHead = null,
  locale = 'de', theme = null, issuer = {}, generatedAt = null,
}) {
  const pdfService = require('../pdfService');
  const { PAGE } = pdfService;
  const { t, registerThemeFonts } = pdfService._internal;
  const colors = { text: '#000000', muted: '#666666', rule: '#888888', accent: '#000000', ...((theme && theme.colors) || {}) };

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFKit({
        size: 'A4',
        bufferPages: true,
        margins: { top: PAGE.marginTop, bottom: PAGE.marginBottom, left: PAGE.marginLeft, right: PAGE.marginRight },
        info: {
          Title: `${contract.contract_number || 'Contract'}_signing_certificate`,
          Author: issuer.companyName || 'picpeak',
          Subject: t(locale, 'cert_title'),
          ...(generatedAt ? { CreationDate: new Date(generatedAt) } : {}),
        },
      });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({ buffer, sha256: crypto.createHash('sha256').update(buffer).digest('hex') });
      });
      doc.on('error', reject);

      const fonts = registerThemeFonts(doc, issuer, theme);
      const left = PAGE.marginLeft;
      const width = PAGE.contentWidth;
      const labelW = 170;
      const bottom = PAGE.height - PAGE.marginBottom;

      const ensure = (needed) => {
        if (doc.y + needed > bottom) doc.addPage();
      };
      const heading = (text) => {
        ensure(40);
        doc.moveDown(0.8);
        doc.font(fonts.bold).fontSize(11).fillColor(colors.text).text(text, left, doc.y, { width });
        doc.moveDown(0.3);
      };
      const row = (label, value, { mono = false } = {}) => {
        if (value === null || value === undefined || value === '') return;
        ensure(14);
        const y = doc.y;
        doc.font(fonts.bold).fontSize(9).fillColor(colors.muted).text(label, left, y, { width: labelW - 8 });
        const labelBottom = doc.y;
        doc.font(mono ? 'Courier' : fonts.body).fontSize(mono ? 8 : 9).fillColor(colors.text)
          .text(String(value), left + labelW, y, { width: width - labelW });
        doc.y = Math.max(doc.y, labelBottom) + 2;
      };

      doc.font(fonts.bold).fontSize(18).fillColor(colors.accent).text(t(locale, 'cert_title'), left, PAGE.marginTop, { width });
      const ruleY = doc.y + 4;
      doc.strokeColor(colors.rule).lineWidth(0.5).moveTo(left, ruleY).lineTo(left + width, ruleY).stroke();
      doc.y = ruleY + 10;
      doc.font(fonts.body).fontSize(9.5).fillColor(colors.text).text(t(locale, 'cert_intro'), left, doc.y, { width });

      heading(t(locale, 'cert_contract_section'));
      row(t(locale, 'audit_contract_number'), contract.contract_number);
      row(t(locale, 'cert_title_label'), contract.title);
      row(t(locale, 'audit_issued_at'), iso(contract.sent_at));
      row(t(locale, 'cert_content_sha'), hashes.content, { mono: true });
      // The attachments the signature is bound to, each with its own hash,
      // and the manifest hash over all of them (#1446).
      attachments.forEach((a, index) => {
        row(`${t(locale, 'cert_attachment')} ${index + 1}`,
          `${a.name} · ${t(locale, `cert_delivery_${a.delivery === 'separate' ? 'separate' : 'merged'}`)} · ${Number(a.pages) || 0} ${t(locale, 'cert_pages')}`);
        row(t(locale, 'cert_attachment_sha'), a.sha256, { mono: true });
      });
      row(t(locale, 'cert_manifest_sha'), hashes.manifest, { mono: true });
      row(t(locale, 'cert_unsigned_sha'), hashes.unsigned, { mono: true });
      row(t(locale, 'cert_signed_sha'), hashes.signed, { mono: true });

      heading(t(locale, 'cert_signers_section'));
      signers.forEach((signer, index) => {
        ensure(70);
        doc.font(fonts.bold).fontSize(9.5).fillColor(colors.text)
          .text(`${index + 1}. ${t(locale, signer.role === 'issuer' ? 'cert_role_issuer' : 'cert_role_customer')}`, left, doc.y, { width });
        doc.moveDown(0.2);
        row(t(locale, 'cert_name'), signer.name);
        row(t(locale, 'cert_email'), signer.email);
        row(t(locale, 'cert_verified'), signer.verifiedVia ? t(locale, `signature_verified_${signer.verifiedVia}`) : '');
        row(t(locale, 'cert_method'), signer.signatureMode ? t(locale, `signature_method_${signer.signatureMode}`) : '');
        row(t(locale, 'cert_signed_at'), iso(signer.signedAt));
        row(t(locale, 'cert_document_sha'), signer.documentSha256, { mono: true });
        // One row per declaration (#1446): key and version, the answer, and
        // the start of the wording's hash.
        for (const consent of signer.consents || []) {
          row(`${t(locale, 'cert_consent')} ${consent.key} · v${consent.version}`,
            `${t(locale, consent.accepted ? 'cert_consent_accepted' : 'cert_consent_declined')} · ${String(consent.textSha256 || '').slice(0, 16)}`);
        }
        doc.moveDown(0.4);
      });

      heading(t(locale, 'cert_events_section'));
      for (const event of events) {
        ensure(22);
        const label = t(locale, `cert_event_${event.type}`);
        const actor = event.actorLabel ? ` · ${event.actorLabel}` : '';
        doc.font(fonts.body).fontSize(8.5).fillColor(colors.text)
          .text(`${event.seq}. ${iso(event.occurredAt)} · ${label === `cert_event_${event.type}` ? event.type : label}${actor}`, left, doc.y, { width });
        doc.font('Courier').fontSize(7).fillColor(colors.muted)
          .text(`${event.eventHash}${event.artifactSha256 ? `  ·  ${event.artifactSha256}` : ''}`, left + 12, doc.y, { width: width - 12 });
        doc.moveDown(0.25);
      }
      heading(t(locale, 'cert_chain_head'));
      doc.font('Courier').fontSize(8).fillColor(colors.text).text(chainHead || '', left, doc.y, { width });

      doc.moveDown(1.2);
      ensure(30);
      doc.font(fonts.body).fontSize(8).fillColor(colors.muted).text(t(locale, 'cert_footer'), left, doc.y, { width });
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { renderSigningCertificate };
