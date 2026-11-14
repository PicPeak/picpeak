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
// A trigger character after leading whitespace counts too: spreadsheet
// importers trim leading spaces (Unicode ones such as U+3000 included), so
// "\u3000=cmd" opens as a formula. \s covers the ASCII and Unicode spaces
// and the BOM; the zero-width characters are added by hand. Tab and CR are
// themselves triggers, so they are tested before the whitespace skip. The
// full-width forms (U+FF1D = U+FF0B + U+FF0D - U+FF20 @) are triggers in
// spreadsheets that fold them to ASCII, as East Asian locales do.
const FORMULA_START = /^(?:[\t\r]|[\s\u200B-\u200D\u2060]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20])/;

function neutralizeSpreadsheetFormula(value) {
  const s = value === null || value === undefined ? '' : String(value);
  // A plain number is not a formula, and a leading minus is how every
  // negative amount is written: cost rows in the tax report and storno
  // invoices in the ledger. Prefixing those turned them into text cells, so
  // a SUM over the imported column silently dropped every one of them
  // (security review 2026-09-29). Only strict numerics are exempt — an
  // optional sign, digits, one decimal separator (dot or comma), digits.
  if (/^-?\d+(?:[.,]\d+)?$/.test(s)) return s;
  return FORMULA_START.test(s) ? `'${s}` : s;
}

// Characters that end a cell in SOME reader of a .csv file: the comma, the
// semicolon (Excel's list separator in de/fr/it/nl and other locales, used
// when the file is opened by double-click), the tab, and the line breaks —
// plus the double quote, which must itself be escaped.
const CSV_QUOTE_NEEDED = /[,;\t"\n\r]/;

/**
 * One CSV cell: formula-neutralised, then RFC-4180 quoted when it holds a
 * separator (comma, semicolon or tab), a quote or a line break. Only the
 * start of the value is checked for a formula trigger, so a value that a
 * reader could split mid-way must be quoted: `a;=1+2` would otherwise open
 * as two cells, the second one a formula. Callers that render some values
 * differently (booleans as yes/no, say) map them first and hand the rest here.
 */
function csvCell(value) {
  const s = neutralizeSpreadsheetFormula(value);
  return CSV_QUOTE_NEEDED.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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
