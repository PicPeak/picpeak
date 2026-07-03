/**
 * Build a consistent filesystem-safe filename for quote / invoice
 * PDFs. Format:
 *
 *     <docNumber>_<customerLabel>.pdf
 *
 * - docNumber:     the invoice/quote number as printed
 * - customerLabel: customer.company_name || full person name ||
 *                  display_name || email-local-part || 'customer'
 *
 * Both segments are sanitised: spaces → '-', non-ASCII letters
 * preserved, slashes/colons/quotes stripped, length capped so the
 * combined filename stays under the typical 255-byte filesystem
 * limit (we cap each side at 80 chars, which is generous for both
 * pieces).
 *
 * Used by:
 *   - Content-Disposition headers on every admin + customer PDF
 *     endpoint
 *   - The PDF's internal `Title` metadata (Chrome's PDF viewer
 *     uses this as the default name when saving from a blob URL,
 *     where Content-Disposition can't reach)
 */

function sanitiseSegment(input, maxLen = 80) {
  if (!input) return '';
  let s = String(input).trim();
  // Replace OS-hostile characters with '-'.
  s = s.replace(/[/\\:*?"<>|]+/g, '-');
  // Collapse whitespace runs into a single '-'.
  s = s.replace(/\s+/g, '-');
  // Collapse repeat dashes.
  s = s.replace(/-+/g, '-');
  // Trim leading/trailing dashes + dots.
  s = s.replace(/^[-.]+|[-.]+$/g, '');
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

/**
 * Resolve a label representing the customer for the filename. Tries
 * company name first (most useful for filing), then full person
 * name, then display name, then the email's local part, finally
 * 'customer' as a generic fallback.
 *
 * @param {object} customer  customer_accounts row (snake_case)
 * @returns {string}         sanitised label segment
 */
function customerLabel(customer) {
  if (!customer) return 'customer';
  const company = (customer.company_name || '').trim();
  if (company) return sanitiseSegment(company);
  const fullName = [customer.first_name, customer.last_name]
    .map((v) => (v || '').trim()).filter(Boolean).join(' ');
  if (fullName) return sanitiseSegment(fullName);
  const display = (customer.display_name || '').trim();
  if (display) return sanitiseSegment(display);
  const email = (customer.email || '').trim();
  if (email) return sanitiseSegment(email.split('@')[0]);
  return 'customer';
}

/**
 * Build the final filename. Always ends with `.pdf`. When the
 * document number is missing (e.g. preview of an unsaved row),
 * substitutes a sensible fallback.
 *
 * @param {object} args
 *   - docNumber: 'R-2026-0001' / 'Q-2026-0042' / null for previews
 *   - customer:  customer_accounts row
 *   - fallback:  prefix when docNumber is null ('invoice-preview' etc.)
 */
function buildPdfFilename({ docNumber, customer, fallback = 'document' }) {
  const numberSeg = sanitiseSegment(docNumber) || sanitiseSegment(fallback) || 'document';
  const custSeg = customerLabel(customer);
  return `${numberSeg}_${custSeg}.pdf`;
}

module.exports = { buildPdfFilename, sanitiseSegment, customerLabel };
