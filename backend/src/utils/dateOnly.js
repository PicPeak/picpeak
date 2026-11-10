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

// Every `date` column of the public schema, as a Map of table name to column
// names, in one query. Only PostgreSQL has a real `date` type that node-pg
// reads as a local-midnight Date; callers decide whether the engine they run
// on needs this. The schema is named, as listDataTables (picpeakExportService)
// and jsonColumnsFor (picpeakImportService) name it.
async function pgDateColumnsByTable(executor) {
  const res = await executor.raw(
    'SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = \'public\' AND data_type = \'date\' ORDER BY table_name, ordinal_position'
  );
  const byTable = new Map();
  for (const { table_name: table, column_name: column } of res.rows) {
    if (!byTable.has(table)) byTable.set(table, []);
    byTable.get(table).push(column);
  }
  return byTable;
}

module.exports = { toDateOnly, pgDateColumnsByTable };
