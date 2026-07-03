/**
 * Shared numeric coercion helpers used across the CRM services.
 *
 * Previously: 4 copies of `ensureInt` + 2 copies of `ensureNumber` lived
 * across quoteService, invoiceService, contractService, and
 * taxReportService. Each copy was identical apart from `Number.isFinite`
 * vs `!Number.isNaN` — converging on the same answer in practice
 * because `parseInt`/`Number` never produce `Infinity` from string input.
 *
 * One canonical pair lives here so future numeric coercion concerns
 * (e.g. BigInt safety, locale-aware decimals) are addressed in one place.
 */

/**
 * Coerce a value to a non-NaN integer, defaulting to 0 on garbage.
 * Matches the legacy `ensureInt` semantics across all four services.
 */
function ensureInt(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Coerce a value to a finite Number, defaulting to `fallback` (0) on
 * null/undefined/empty string/NaN. Matches the legacy `ensureNumber`
 * shape used by quote + invoice line-item math.
 */
function ensureNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = { ensureInt, ensureNumber };
