/**
 * Migration 337: expense and incoming-invoice timestamps as ISO text on SQLite.
 *
 * expenseService wrote `created_at` (and `updated_at`) of expenses and of
 * uploaded incoming invoices as a Date, which SQLite stores as epoch
 * milliseconds. The tax report and the bookkeeping journal select costs by
 * comparing created_at with ISO text bounds, and SQLite sorts every number
 * before every text, so those rows never fell in any period: every expense,
 * and every incoming invoice without an invoice date, was missing from both.
 * The writers now store ISO text; this turns the numbers already stored into
 * the same 'YYYY-MM-DDTHH:MM:SS.sssZ' text.
 *
 * SQLite only: PostgreSQL columns are typed timestamps and were never
 * affected. Only numeric values are touched (typeof integer or real), so a
 * second run changes nothing. No down(): the old shape was the bug.
 */

const COLUMNS = {
  expenses: ['created_at', 'updated_at'],
  inbound_documents: ['created_at', 'updated_at'],
};

exports.up = async function up(knex) {
  if (knex.client.config.client === 'pg') return;
  for (const [table, columns] of Object.entries(COLUMNS)) {
    if (!(await knex.schema.hasTable(table))) continue;
    for (const column of columns) {
      if (!(await knex.schema.hasColumn(table, column))) continue;
      await knex.raw(
        'UPDATE ?? SET ?? = strftime(\'%Y-%m-%dT%H:%M:%fZ\', ?? / 1000.0, \'unixepoch\') '
          + 'WHERE typeof(??) IN (\'integer\', \'real\')',
        [table, column, column, column]
      );
    }
  }
};

exports.down = async function down() {
  // Irreversible by design: the epoch-ms shape was the bug.
};
