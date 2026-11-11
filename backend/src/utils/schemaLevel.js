'use strict';

// The schema level of a database: the applied migration with the highest
// numeric filename prefix. The runner (migrations/run-migrations-safe.js)
// records applied migrations in `migrations.filename`; knex's own ledger is
// read only for an install that has nothing in `migrations` (issue 2458).

// Compare migrations by their numeric filename prefix (001_, 107_, 129_ …).
function migrationOrder(name) {
  const m = String(name || '').match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : -1;
}

// The filename of the newest applied migration, or null when neither ledger
// records one. A shared prefix (core has two 061_ files) resolves by name.
async function latestMigration(knex) {
  for (const [table, column] of [['migrations', 'filename'], ['knex_migrations', 'name']]) {
    if (!(await knex.schema.hasTable(table))) continue;
    let latest = null;
    for (const row of await knex(table).select(column)) {
      const name = row[column];
      const order = migrationOrder(name);
      if (order < 0) continue;
      if (latest === null || order > migrationOrder(latest) || (order === migrationOrder(latest) && name > latest)) {
        latest = name;
      }
    }
    if (latest !== null) return latest;
  }
  return null;
}

module.exports = { migrationOrder, latestMigration };
