/**
 * Expense and incoming-invoice timestamps as ISO text on SQLite.
 *
 * expenseService once wrote `created_at` / `updated_at` of expenses and of
 * uploaded incoming invoices as a Date, which SQLite stores as epoch
 * milliseconds. The tax report and the bookkeeping journal compare created_at
 * with ISO text bounds, and SQLite sorts every number before every text, so
 * such rows fall in no period. This rewrites the numbers as
 * 'YYYY-MM-DDTHH:MM:SS.sssZ' text.
 *
 * Run once by migration 337, and again by the portable import, whose archived
 * rows may predate that migration while the target's ledger says it has run.
 * PostgreSQL columns are typed timestamps and never affected. Only numeric
 * values are touched (typeof integer or real), so a second run changes nothing.
 */

const COLUMNS = {
  expenses: ['created_at', 'updated_at'],
  inbound_documents: ['created_at', 'updated_at'],
};

/**
 * @param {import('knex').Knex} knex connection or transaction
 * @param {string[]} [tables] limit the rewrite to these tables
 */
async function isoSqliteCostTimestamps(knex, tables = Object.keys(COLUMNS)) {
  if (knex.client.config.client === 'pg') return;
  for (const table of tables) {
    const columns = COLUMNS[table];
    if (!columns || !(await knex.schema.hasTable(table))) continue;
    for (const column of columns) {
      if (!(await knex.schema.hasColumn(table, column))) continue;
      await knex.raw(
        'UPDATE ?? SET ?? = strftime(\'%Y-%m-%dT%H:%M:%fZ\', ?? / 1000.0, \'unixepoch\') '
          + 'WHERE typeof(??) IN (\'integer\', \'real\')',
        [table, column, column, column]
      );
    }
  }
}

module.exports = { isoSqliteCostTimestamps, COST_TIMESTAMP_TABLES: Object.keys(COLUMNS) };
