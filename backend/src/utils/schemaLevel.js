'use strict';

const fs = require('fs');
const path = require('path');

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

// The newest migration file this code ships (migrations/core, what the runner
// applies on every start), or null when the folder can't be read. A portable
// restore replaces the ledger with the archive's, so until the next start the
// ledger can sit below the schema the code has already built (issue 2458).
function shippedMigration(dir = path.join(__dirname, '../../migrations/core')) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((name) => /\.js$/.test(name) && migrationOrder(name) >= 0);
  } catch (_) {
    return null;
  }
  return files.reduce((latest, name) => (
    latest === null || migrationOrder(name) > migrationOrder(latest)
      || (migrationOrder(name) === migrationOrder(latest) && name > latest) ? name : latest
  ), null);
}

// Every migration filename this code ships, as the runner stores it in
// `migrations.filename`: the bare basename with `.js`, for core and legacy
// alike (run-migrations-safe.js records path.basename of each file).
function shippedMigrationNames(dirs = [
  path.join(__dirname, '../../migrations/core'),
  path.join(__dirname, '../../migrations/legacy'),
]) {
  const names = new Set();
  for (const dir of dirs) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch (_) { /* An absent folder ships nothing. */ }
    for (const name of files) if (/\.js$/.test(name)) names.add(name);
  }
  return names;
}

// Ledger names this line once shipped and no longer does, other than renames
// that kept the part after the number. `init.js` became 001_init.js in 2025;
// an install that old still records it. Left in place: the runner ignores it.
const RETIRED_MIGRATIONS = new Set(['init.js']);

// The part of a migration filename after its leading number, or null when it
// has none. stable backports main's migrations under its own numbers with the
// same rest (main 366_fix_translated_email_template_placeholders.js is this
// line's 254_fix_translated_email_template_placeholders.js).
function migrationStem(name) {
  const m = String(name || '').match(/^\d+_(.+)$/);
  return m ? m[1] : null;
}

// Sort the ledger of a restored archive against this code (issue 2480):
// - keep: names this code ships (or once shipped, RETIRED_MIGRATIONS);
// - twins: names of the other release line whose stem a shipped file has.
//   Their rows are dropped so this code's own counterpart runs on the next
//   start, as on a promote upgrade;
// - unknown: anything else. This code cannot know what such a migration did
//   to the schema, and the runner would never apply this line's migrations a
//   foreign name stands in for, so the restore is refused.
function classifyLedger(names, shipped = shippedMigrationNames()) {
  const stems = new Set();
  for (const name of shipped) {
    const stem = migrationStem(name);
    if (stem) stems.add(stem);
  }
  const keep = [];
  const twins = [];
  const unknown = [];
  for (const name of names) {
    if (shipped.has(name) || RETIRED_MIGRATIONS.has(name)) keep.push(name);
    else if (stems.has(migrationStem(name))) twins.push(name);
    else unknown.push(name);
  }
  const byOrder = (a, b) => migrationOrder(a) - migrationOrder(b) || (a < b ? -1 : a > b ? 1 : 0);
  return { keep, twins, unknown: unknown.sort(byOrder) };
}

module.exports = {
  migrationOrder, latestMigration, shippedMigration, shippedMigrationNames, migrationStem, classifyLedger,
};
