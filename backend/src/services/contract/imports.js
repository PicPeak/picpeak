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
const { createContractIdempotent } = require('./crud');

// Only finished states. `signed_by_customer` is left out: every way on from
// it (countersign, signed-PDF upload, cancel) would either re-render the
// original or is refused, so an import in that state could never be closed.
const IMPORT_STATUSES = ['fully_signed', 'cancelled'];

// ISO strings rather than Date objects, as the expiry and erasure services
// bind them: node-sqlite3 can store a Date as "[object Object]". A
// historical date is kept as the calendar day written, at 12:00 UTC, which
// is that same day from UTC-12 to UTC+12: midnight UTC showed as the
// evening before west of Greenwich, and a zoned time such as
// 2023-03-01T00:30+14:00 is Feb 28 in UTC. assertDateOrder compares the
// same written day, so what is checked is what is stored.
const isoDay = (value) => `${String(value).slice(0, 10)}T12:00:00.000Z`;

/**
 * @param {object} payload  customerAccountId, status, issueDate (required);
 *   title, language, eventName, eventDate, validUntil, signedByCustomerAt,
 *   signedByAdminAt, signedCustomerName, signedAdminName (optional)
 * @param {string} filePath the uploaded PDF, already under the contract
 *   storage roots (assertContractPdfPath)
 * @param {number} adminId
 * @param {{ idempotencyKey?: string|null }} [options] the same key on a
 *   retried submit returns the contract the first one created
 * @returns {Promise<{ id: number, replayed: boolean }>}
 */
async function importContract(payload, filePath, adminId, { idempotencyKey = null } = {}) {
  if (!filePath) throw new AppError('PDF file is required', 400, 'NO_FILE');
  const status = payload.status;
  if (!IMPORT_STATUSES.includes(status)) {
    throw new AppError(`Cannot import a contract in status '${status}'`, 400, 'INVALID_STATUS');
  }

  const issueDate = payload.issueDate;
  const signed = status === 'fully_signed';
  // Historical dates, never the moment of import (same reasoning as the
  // invoice import's paid_at): a contract signed in 2023 must not show up
  // as signed today.
  const customerSignedAt = payload.signedByCustomerAt || issueDate;
  const adminSignedAt = payload.signedByAdminAt || customerSignedAt;
  if (signed) assertDateOrder(issueDate, customerSignedAt, adminSignedAt);

  const storedPath = toStoredPath(filePath);
  const sha256 = sha256OfFile(filePath);
  const columns = {
    status,
    // A cancelled import records no send: the original tool may never have
    // sent it, and nothing here did.
    sent_at: signed ? isoDay(issueDate) : null,
    pdf_path: storedPath,
    signed_by_customer_at: signed ? isoDay(customerSignedAt) : null,
    signed_by_admin_at: signed ? isoDay(adminSignedAt) : null,
    signed_customer_name: signed ? (payload.signedCustomerName || null) : null,
    signed_admin_name: signed ? (payload.signedAdminName || null) : null,
    // A signed import is the authoritative signed copy: the same columns a
    // wet-signed upload sets, so every reader treats it the same way.
    signed_pdf_path: signed ? storedPath : null,
  };
  const optional = {
    imported_at: new Date().toISOString(),
    pdf_sha256: sha256,
    signed_pdf_sha256: signed ? sha256 : null,
    signed_pdf_is_wet_upload: signed,
  };
  for (const [column, value] of Object.entries(optional)) {
    if (await hasColumnCached('contracts', column)) columns[column] = value;
  }

  return createContractIdempotent({
    customerAccountId: payload.customerAccountId,
    language: payload.language,
    title: payload.title,
    eventName: payload.eventName,
    eventDate: payload.eventDate,
    issueDate,
    validUntil: payload.validUntil || issueDate,
  }, adminId, idempotencyKey, { imported: columns });
}

// Issued, then signed by the customer, then counter-signed — the order the
// signing flow produces. Compared as calendar days, as written: a date-only
// value parses as UTC but a time without a zone as server-local, so
// comparing instants could refuse a same-day signature on a UTC+ server.
function assertDateOrder(issueDate, customerSignedAt, adminSignedAt) {
  const day = (value) => String(value).slice(0, 10);
  if (day(customerSignedAt) < day(issueDate)) {
    throw new AppError('signedByCustomerAt cannot be before issueDate', 400, 'INVALID_DATE_ORDER');
  }
  if (day(adminSignedAt) < day(customerSignedAt)) {
    throw new AppError('signedByAdminAt cannot be before signedByCustomerAt', 400, 'INVALID_DATE_ORDER');
  }
}

module.exports = { importContract, IMPORT_STATUSES };
