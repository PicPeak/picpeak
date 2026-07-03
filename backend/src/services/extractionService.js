/**
 * Inbound-document field extraction — the assist ladder.
 *
 * Lightest-first: Swiss QR-bill decode → digital-PDF text layer → OCR for
 * true scans. Returns BEST-EFFORT fields only; the admin always confirms
 * them in the inbox. The QR amount is returned SEPARATELY as `qrAmountMinor`
 * and must NEVER be treated as the authoritative total (it is the
 * attacker-controllable "pay this" field) — the authoritative total comes
 * from the text/line items and the admin's confirmation.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * STATUS: interface + plumbing only. The heavy extractors require infra that
 * is intentionally deferred to a follow-up:
 *   - Swiss QR decode  → a 2D-barcode decoder (zxing/jsQR class) + rasterise.
 *   - PDF text layer   → a text extractor (NOT a 3rd PDF lib — see memory
 *                        `feedback_pdf_libraries`; revisit the approach).
 *   - OCR              → Tesseract installed as an OS package in the Docker
 *                        image and shelled out, run inside a NETWORK-ISOLATED
 *                        worker (no egress) per the locked design.
 * Until those land, extract() returns { parsed: false, method: 'none' } and
 * the document stays in `parse_status='pending'` for manual entry.
 * ─────────────────────────────────────────────────────────────────────────
 */
const logger = require('../utils/logger');

/**
 * @returns {Promise<{
 *   parsed: boolean,
 *   method: 'qr'|'pdf_text'|'ocr'|'none',
 *   fields: {
 *     supplierName?, invoiceNumber?, invoiceDate?, dueDate?, currency?,
 *     netAmountMinor?, vatAmountMinor?, totalAmountMinor?,
 *     qrAmountMinor?, iban?, paymentReference?
 *   },
 *   raw?: object,
 *   error?: string
 * }>}
 */
async function extract(filePath, mimeType) {
  try {
    // 1) Swiss QR-bill (structured) — DEFERRED.
    // 2) Digital-PDF text layer    — DEFERRED.
    // 3) OCR for scans/photos      — DEFERRED.
    // Plumbing is in place so the upload route can call this best-effort
    // today and richer extractors can slot in without touching callers.
    logger.debug?.(`extractionService: no extractor wired yet for ${mimeType || 'unknown'} (${filePath})`);
    return { parsed: false, method: 'none', fields: {} };
  } catch (err) {
    logger.error?.(`extractionService.extract failed: ${err.message}`);
    return { parsed: false, method: 'none', fields: {}, error: err.message };
  }
}

module.exports = { extract };
