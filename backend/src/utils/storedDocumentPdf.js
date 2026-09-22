'use strict';

/**
 * Stored invoice PDFs, opened for an email attachment.
 *
 * Backported from main's storedDocumentPdf.js: only the attachment helper.
 * This release does not serve sent quote/invoice PDFs from disk
 * (readStoredDocumentPdf), so that part is not here.
 */

const path = require('path');
const logger = require('./logger');
const { resolveStoredPathStrict } = require('./safePath');
const { getStoragePath } = require('../config/storage');

const documentRoots = (type) => [
  path.join(getStoragePath(), 'business-docs', type),
  // Documents written before the writers moved to the shared resolver
  // still live under <cwd>/storage (same directory on a stock install).
  path.join(process.cwd(), 'storage', 'business-docs', type),
];

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

module.exports = { invoicePdfFile };
