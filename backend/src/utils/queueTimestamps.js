/**
 * Reading email_queue timestamps back, whatever shape the engine stored them in.
 *
 * The columns are written three different ways and read back three different
 * ways, and a comparison that assumes one of them is wrong for the other two:
 *
 *   - Postgres hands back a Date.
 *   - SQLite stores what queueEmail writes -- a JS Date, which the native
 *     binding turns into epoch ms -- and hands back that number.
 *   - Both columns also default to CURRENT_TIMESTAMP, which on SQLite is a
 *     zone-less 'YYYY-MM-DD HH:MM:SS' string in UTC, and older rows plus test
 *     fixtures carry ISO strings.
 *
 * Extracted from adminSystemHealth so the parsing can be tested under a forced
 * TZ in a child process, which is the only way to pin the naive-timestamp case
 * from a test suite that itself runs in UTC (#1262).
 */

/** 'YYYY-MM-DD HH:MM:SS[.sss]' with no zone — SQLite's CURRENT_TIMESTAMP shape. */
const SQLITE_NAIVE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/;

/**
 * @param {Date|number|string|null|undefined} value
 * @returns {number|null} epoch ms, or null when the value cannot be read
 */
function toMillis(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const text = String(value).trim();
  if (text === '') return null;
  // A numeric string is epoch ms; anything else goes through Date.parse.
  const numeric = Number(text);
  if (Number.isFinite(numeric)) return numeric;
  // Date.parse reads the zone-less shape as LOCAL time. On a
  // TZ=America/New_York deployment that puts a row due now four hours in the
  // future, so it never reaches the waiting list -- the false all-clear again,
  // arrived at via the clock. Stamp the zone the value actually carries.
  const stamped = SQLITE_NAIVE_TIMESTAMP.test(text) ? `${text.replace(' ', 'T')}Z` : text;
  const parsed = Date.parse(stamped);
  return Number.isNaN(parsed) ? null : parsed;
}

module.exports = { toMillis, SQLITE_NAIVE_TIMESTAMP };
