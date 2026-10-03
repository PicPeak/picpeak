/**
 * A calendar date for the API, whatever the engine handed back for a `date`
 * column.
 *
 * SQLite stores and returns the 'YYYY-MM-DD' text the writer sent. The pg
 * driver turns a `date` column into a JS Date at local midnight of the server
 * process, and `res.json` then serialises that as UTC — so with TZ=UTC a
 * viewer west of Greenwich reads "2026-10-03T00:00:00.000Z", and
 * `parseISO` in the browser puts it at 2026-10-02 (issue 1733). The date has
 * no time, so it must leave the server as a bare date: read the local
 * components, which are exactly what the driver filled in.
 *
 * @param {Date|string|null|undefined} value
 * @returns {string|null} 'YYYY-MM-DD', or null when there is no date
 */
function toDateOnly(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${value.getFullYear()}-${month}-${day}`;
  }
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : text;
}

module.exports = { toDateOnly };
