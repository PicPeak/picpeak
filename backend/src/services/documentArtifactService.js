'use strict';

/**
 * Generated documents (#1445): every PDF the app writes for a quote, invoice
 * or contract goes through persist(). The file lands under
 * business-docs/<folder>/<year>/ exactly where it did before, and a
 * generated_documents row records its sha256, size, page count, the theme
 * it was rendered with (including the font and logo files' sha256) and, for
 * contracts, the attachment and signature manifest. The document's own row
 * keeps storing the path (pdf_path, signed_pdf_path…) as before.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const { db } = require('../database/db');
const { getStoragePath } = require('../config/storage');
const { resolveFontFiles } = require('./pdf/fonts');

// Bumped when the renderer's output for the same inputs changes on purpose.
const RENDERER_VERSION = '2';
const DOC_TYPES = ['quote', 'invoice', 'contract'];

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

function fileSha256(file) {
  if (!file) return null;
  try { return sha256(fs.readFileSync(file)); } catch (_) { return null; }
}

async function countPages(buffer) {
  try {
    const pdf = await PDFDocument.load(buffer, { updateMetadata: false });
    return pdf.getPageCount();
  } catch (_) {
    return null;
  }
}

/** The resolved theme plus the sha256 of the font and logo files it drew with. */
function themeSnapshot(theme, issuer) {
  if (!theme) return null;
  const fonts = resolveFontFiles({ pdfFontTtfPath: issuer && issuer.pdfFontTtfPath, fontFamily: theme.fontFamily });
  return JSON.stringify({
    ...theme,
    fontSha256: fonts
      ? { body: fileSha256(fonts.body), bold: fileSha256(fonts.bold), italic: fileSha256(fonts.italic) }
      : null,
    logoSha256: fileSha256(issuer && issuer.showLogo !== false ? issuer.logoPath : null),
  });
}

/**
 * Write a generated PDF and record it.
 *
 * @param {object} opts
 * @param {'quote'|'invoice'|'contract'} opts.docType
 * @param {number} opts.docId
 * @param {string} opts.kind              sent | accepted | reminder | storno | unsigned | signed | audit | wet_upload
 * @param {Buffer} opts.buffer
 * @param {string} opts.fileName          file name inside the year folder
 * @param {string} [opts.folder]          business-docs sub-folder (default: docType)
 * @param {number} [opts.year]            year folder (default: this year)
 * @param {object} [opts.theme]           resolved theme the PDF was rendered with
 * @param {object} [opts.issuer]          issuer block (logo path, legacy font)
 * @param {object} [opts.manifest]        attachments / signature slots (contracts)
 * @param {number} [opts.templateVersionId]
 * @param {number} [opts.parentId]        the generated_documents row this derives from
 * @param {object} [opts.conn]            knex transaction to record inside
 * @returns {Promise<{ path: string, sha256: string, bytes: number, id: number }>}
 */
async function persist(opts) {
  const { docType, docId, kind, buffer, fileName } = opts;
  if (!DOC_TYPES.includes(docType)) throw new Error(`Unknown document type: ${docType}`);
  if (!Buffer.isBuffer(buffer)) throw new Error('persist() needs the PDF bytes');
  if (!fileName || path.basename(fileName) !== fileName) throw new Error('persist() needs a plain file name');

  const folder = opts.folder || docType;
  const year = opts.year || new Date().getFullYear();
  const root = path.join(getStoragePath(), 'business-docs', folder, String(year));
  fs.mkdirSync(root, { recursive: true });
  const filePath = path.join(root, fileName);
  fs.writeFileSync(filePath, buffer);

  const digest = sha256(buffer);
  const conn = opts.conn || db;
  const inserted = await conn('generated_documents').insert({
    doc_type: docType,
    doc_id: docId,
    kind,
    path: filePath,
    sha256: digest,
    bytes: buffer.length,
    pages: await countPages(buffer),
    theme_snapshot: themeSnapshot(opts.theme, opts.issuer),
    manifest: opts.manifest ? JSON.stringify(opts.manifest) : null,
    template_version_id: opts.templateVersionId || null,
    renderer_version: RENDERER_VERSION,
    parent_id: opts.parentId || null,
    generated_at: new Date(),
  }).returning('id');
  const id = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
  return { path: filePath, sha256: digest, bytes: buffer.length, id };
}

/** A document's generated PDFs, newest first (no file paths). */
async function listForDocument(docType, docId) {
  const rows = await db('generated_documents')
    .where({ doc_type: docType, doc_id: docId })
    .orderBy('generated_at', 'desc')
    .orderBy('id', 'desc')
    .select('id', 'kind', 'sha256', 'bytes', 'pages', 'template_version_id', 'renderer_version', 'parent_id', 'generated_at');
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    sha256: r.sha256,
    bytes: Number(r.bytes),
    pages: r.pages == null ? null : Number(r.pages),
    templateVersionId: r.template_version_id || null,
    rendererVersion: r.renderer_version,
    parentId: r.parent_id || null,
    generatedAt: r.generated_at,
  }));
}

module.exports = {
  RENDERER_VERSION,
  persist,
  listForDocument,
  _internal: { sha256, themeSnapshot, countPages },
};
