/**
 * Historical contract import — the contract counterpart of
 * POST /api/admin/invoices/import.
 *
 * A studio moving off another tool (Pixieset, HoneyBook, Dubsado, paper)
 * has contracts that were signed, or cancelled, years ago. The only path
 * to them used to be create → send → upload signed PDF: sending emails the
 * customer a signing link, the upload emails them `contract_fully_signed`,
 * and the draft is seeded with every active system clause that the
 * original never contained.
 *
 * importContract writes the finished row in one insert instead: the
 * uploaded PDF as pdf_path (and signed_pdf_path when signed), its SHA-256,
 * the historical dates, no clauses, no action tokens, no email, no
 * webhook. `imported_at` marks the row so the signing services leave the
 * PDF alone (assertNotImported in ./helpers).
 */

const { AppError } = require('../../utils/errors');
const { hasColumnCached } = require('../../utils/schemaCache');
const { toStoredPath } = require('../../utils/storedPath');
const { sha256OfFile } = require('./signatureAssets');
const { createContract } = require('./crud');

const IMPORT_STATUSES = ['fully_signed', 'signed_by_customer', 'cancelled'];

// ISO strings rather than Date objects, as the expiry and erasure services
// bind them: node-sqlite3 can store a Date as "[object Object]".
const iso = (value) => new Date(value).toISOString();

/**
 * @param {object} payload  customerAccountId, status, issueDate (required);
 *   title, language, eventName, eventDate, validUntil, signedByCustomerAt,
 *   signedByAdminAt, signedCustomerName, signedAdminName (optional)
 * @param {string} filePath the uploaded PDF, already under the contract
 *   storage roots (assertContractPdfPath)
 * @param {number} adminId
 * @returns {Promise<number>} the new contract id
 */
async function importContract(payload, filePath, adminId) {
  if (!filePath) throw new AppError('PDF file is required', 400, 'NO_FILE');
  const status = payload.status;
  if (!IMPORT_STATUSES.includes(status)) {
    throw new AppError(`Cannot import a contract in status '${status}'`, 400, 'INVALID_STATUS');
  }

  const issueDate = payload.issueDate;
  const storedPath = toStoredPath(filePath);
  const sha256 = sha256OfFile(filePath);
  // Historical dates, never the moment of import (same reasoning as the
  // invoice import's paid_at): a contract signed in 2023 must not show up
  // as signed today.
  const customerSignedAt = payload.signedByCustomerAt || issueDate;
  const adminSignedAt = payload.signedByAdminAt || customerSignedAt;
  const signed = status !== 'cancelled';

  const columns = {
    status,
    sent_at: iso(issueDate),
    pdf_path: storedPath,
    signed_by_customer_at: signed ? iso(customerSignedAt) : null,
    signed_by_admin_at: status === 'fully_signed' ? iso(adminSignedAt) : null,
    signed_customer_name: signed ? (payload.signedCustomerName || null) : null,
    signed_admin_name: status === 'fully_signed' ? (payload.signedAdminName || null) : null,
    // A signed import is the authoritative signed copy: the same columns a
    // wet-signed upload sets, so every reader treats it the same way.
    signed_pdf_path: signed ? storedPath : null,
  };
  const optional = {
    imported_at: iso(Date.now()),
    pdf_sha256: sha256,
    signed_pdf_sha256: signed ? sha256 : null,
    signed_pdf_is_wet_upload: signed,
  };
  for (const [column, value] of Object.entries(optional)) {
    if (await hasColumnCached('contracts', column)) columns[column] = value;
  }

  return createContract({
    customerAccountId: payload.customerAccountId,
    language: payload.language,
    title: payload.title,
    eventName: payload.eventName,
    eventDate: payload.eventDate,
    issueDate,
    validUntil: payload.validUntil || issueDate,
  }, adminId, { imported: columns });
}

module.exports = { importContract, IMPORT_STATUSES };
