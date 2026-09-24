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

/**
 * One CSV cell: formula-neutralised, then RFC-4180 quoted when it holds a
 * comma, quote or line break. Callers that render some values differently
 * (booleans as yes/no, say) map them first and hand the rest here.
 */
function csvCell(value) {
  const s = neutralizeSpreadsheetFormula(value);
  return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Rows of plain objects to CSV: the first row's keys are the header, every
 * row is rendered through `cell`. Empty input gives an empty string.
 */
function objectsToCsv(rows, cell = csvCell) {
  if (!rows || rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  return [headers.join(','), ...rows.map((row) => headers.map((h) => cell(row[h])).join(','))].join('\n');
}

module.exports = { neutralizeSpreadsheetFormula, csvCell, objectsToCsv };
