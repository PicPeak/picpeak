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
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

module.exports = { neutralizeSpreadsheetFormula };
