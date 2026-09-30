/**
 * Formula-injection defence for spreadsheet / accounting exports (CSV + Banana).
 *
 * A cell whose first character is one of `= + - @ TAB CR` is evaluated as a
 * formula when the file is opened in Excel / Numbers / Banana. RFC-4180
 * quote-wrapping does NOT stop that evaluation — only prefixing a single quote
 * does. Vectors in picpeak are real: supplier_name, invoice_number,
 * payment_reference and description are admin-editable (and sender-controlled
 * once incoming-mail ingestion is live).
 *
 * Apply to BOTH the quoted CSV and the unquoted tab-separated Banana export —
 * the tab export has no surrounding quotes, so it's the more exposed of the two.
 */
function neutralizeSpreadsheetFormula(value) {
  const s = value === null || value === undefined ? '' : String(value);
  // A plain number is not a formula, and a leading minus is how every
  // negative amount is written: cost rows in the tax report and storno
  // invoices in the ledger. Prefixing those turned them into text cells, so
  // a SUM over the imported column silently dropped every one of them
  // (security review 2026-09-29). Only strict numerics are exempt — an
  // optional sign, digits, one decimal separator (dot or comma), digits.
  if (/^-?\d+(?:[.,]\d+)?$/.test(s)) return s;
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

module.exports = { neutralizeSpreadsheetFormula };
