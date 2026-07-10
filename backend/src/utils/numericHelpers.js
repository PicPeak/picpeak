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

/**
 * Parse a value as an integer clamped to [min, max]; `undefined` on
 * anything that doesn't parse (null, undefined, '', booleans, garbage).
 *
 * Exists because the inline guard `Number.isFinite(+v) ? parseInt(v)`
 * disagrees with itself for null/''/true (`+null` is 0 but
 * `parseInt(null)` is NaN), which let NaN through Math.min/Math.max
 * and into an INSERT — PostgreSQL rejects NaN for integer columns
 * while SQLite silently stores NULL, so it only failed on PG.
 */
function clampIntOrUndefined(value, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}

module.exports = { ensureInt, ensureNumber, clampIntOrUndefined };
