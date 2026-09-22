'use strict';

/**
 * The PDF a quote or invoice was actually sent as.
 *
 * Once a document has gone out, showing it again must not re-render it from
 * today's data: a later change to a template, the branding or the settings
 * would silently alter what the customer received. Sent documents therefore
 * open the file stored at send time; drafts keep rendering live.
 *
 * Returns the stored bytes, or null when there is no usable stored file
 * (never sent, file gone after a restore onto another host, path outside
 * storage) so the caller falls back to rendering. The path goes through the
 * same containment check as every other document read.
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { assertStoredPathInside, resolveStoredPathStrict } = require('./safePath');
const { getStoragePath } = require('../config/storage');

/**
 * @param {string|null} pdfPath the document's stored `pdf_path`
 * @param {'quote'|'invoice'} type the business-docs sub-directory it lives in
 * @returns {Buffer|null}
 */
const documentRoots = (type) => [
  path.join(getStoragePath(), 'business-docs', type),
  // Documents written before the writers moved to the shared resolver
  // still live under <cwd>/storage (same directory on a stock install).
  path.join(process.cwd(), 'storage', 'business-docs', type),
];

function readStoredDocumentPdf(pdfPath, type) {
  if (!pdfPath) return null;
  try {
    const resolved = assertStoredPathInside(pdfPath, documentRoots(type));
    return fs.readFileSync(resolved);
  } catch (err) {
    logger.warn('Stored document PDF unavailable, rendering it live instead', { type, pdfPath, code: err.code || err.name });
    return null;
  }
}

/**
 * The stored invoice PDF to attach to a reminder or workflow email: the file,
 * symlinks followed, or null when it is missing or lies outside the invoice
 * folder (the email then goes without it, as it always did when missing).
 */
function invoicePdfFile(pdfPath) {
  try {
    return resolveStoredPathStrict(pdfPath, documentRoots('invoice'));
  } catch (err) {
    logger.warn('Stored invoice PDF refused as an attachment', { pdfPath, code: err.code || err.name });
    return null;
  }
}

module.exports = { readStoredDocumentPdf, invoicePdfFile };
