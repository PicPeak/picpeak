/**
 * Coerce any of the shapes a TIMESTAMP column produces across our
 * supported drivers into a single ISO 8601 string the frontend (and
 * any external API consumer) can safely pass to date-fns / new Date.
 *
 * Postgres → Date object (becomes ISO via JSON.stringify anyway, but
 *   pinning the format defends against driver-side surprises).
 * SQLite → integer milliseconds since epoch when a raw `new Date()` was
 *   written through knex (the surface that crashed the admin Users page
 *   in #485 — `parseISO(123456789)` blows up with "e.split is not a
 *   function"). Native installs default to SQLite, so this path matters
 *   every release.
 * Already a string → assume it's a parseable ISO/RFC3339 (Postgres
 *   driver may stringify under JSON serialization mid-pipeline).
 *
 * Returns null/undefined unchanged so an unset value surfaces as
 * "Never" in the UI rather than 1970-01-01T00:00:00Z.
 *
 * Extracted from routes/adminUsers.js (#485) so every route that
 * serializes timestamps can share one contract.
 */
function toIso(value) {
  if (value === null || value === undefined || value === '') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  if (typeof value === 'string') {
    // Numeric-as-string ("1778752458666") happens when the SQLite
    // driver stringifies large integers — re-coerce so the frontend
    // doesn't try to parseISO('1778752458666').
    if (/^\d{10,}$/.test(value)) return new Date(Number(value)).toISOString();
    return value;
  }
  return value;
}

module.exports = { toIso };
