// Steps run-migrations.js and run-migrations-safe.js share. Not a migration:
// both runners (and utils/schemaLevel.js) only read core/ and legacy/, and the
// updater's image_migrations() drops every `/run-migrations*` path, so the name
// keeps this file out of its "new migrations" count.
const fs = require('fs').promises;
const path = require('path');
const { db } = require('../src/database/db');

const MIGRATION_FILE = /^\d{3}_.*\.js$/;

// Create the migrations tracking table if it doesn't exist. Each runner keeps
// its own log line.
async function createMigrationsTable(createdMessage) {
  const tableExists = await db.schema.hasTable('migrations');
  if (!tableExists) {
    await db.schema.createTable('migrations', (table) => {
      table.increments('id').primary();
      table.string('filename').unique().notNullable();
      table.timestamp('applied_at').defaultTo(db.fn.now());
    });
    console.log(createdMessage);
  }
}

// Run one migration (`core/NNN_x.js` or `legacy/NNN_x.js`) and record it.
// On PostgreSQL the migration and its tracking row share one transaction, so a
// failure leaves neither behind. `completedMessage` is the word(s) each runner
// logs after the file name.
async function runMigrationFile(filepath, completedMessage) {
  const migrationPath = path.join(__dirname, filepath);
  const migration = require(migrationPath);
  const filename = path.basename(filepath);

  if (migration.up) {
    console.log(`Running migration: ${filepath}`);

    if (db.client.config.client === 'pg') {
      await db.transaction(async (trx) => {
        await migration.up(trx);
        await trx('migrations').insert({ filename });
      });
    } else {
      await migration.up(db);
      await db('migrations').insert({ filename });
    }

    console.log(`Migration ${filepath} ${completedMessage}`);
  }
}

async function listDir(dir) {
  const files = await fs.readdir(path.join(__dirname, dir));
  return files
    .filter(f => f.match(MIGRATION_FILE))
    .map(f => path.join(dir, f));
}

function byNumber(a, b) {
  const numA = parseInt(path.basename(a).split('_')[0]);
  const numB = parseInt(path.basename(b).split('_')[0]);
  return numA - numB;
}

// The files to consider, sorted by number: a new deployment runs core/ only,
// an existing one legacy/ and core/ together.
async function listMigrationFiles(isNewDeployment) {
  if (isNewDeployment) {
    console.log('New deployment detected - running core migrations only');
    return (await listDir('core')).sort(byNumber);
  }
  console.log('Existing deployment detected - checking all migrations');
  const legacyMigrations = await listDir('legacy');
  const coreMigrations = await listDir('core');
  return [...legacyMigrations, ...coreMigrations].sort(byNumber);
}

// Engine consistency check (#1038). The entrypoint resolves the engine before
// migrations run and exports DATABASE_CLIENT, so this normally agrees and does
// nothing. It bites on a MANUAL migration run: without that env, an install
// that is really on SQLite would resolve to Postgres here and build a schema in
// the empty database, which then hides the SQLite data from the boot-time
// check. Stop instead, and say which env to set.
async function assertEngine() {
  const knexConfig = require('../knexfile');
  const logger = require('../src/utils/logger');
  const { resolveBootEngine } = require('../src/utils/databaseEngine');
  const decision = await resolveBootEngine({ knexConfig, logger });
  if (decision.reason === 'marker-target-mismatch') {
    console.error(
      'Refusing to migrate: this install was migrated to a different PostgreSQL than the\n'
      + 'one currently configured. The resolver printed both targets above.'
    );
    process.exit(1);
  }
  if (decision.reason === 'ambiguous-both-populated') {
    // Both databases hold data and nothing records which is current; the
    // resolver has already printed the comparison. There is no client to
    // recommend here — the operator has to pick one.
    console.error(
      'Refusing to migrate: SQLite and PostgreSQL both hold data and neither is marked\n'
      + 'as current. Set DATABASE_CLIENT=pg or DATABASE_CLIENT=sqlite3 to say which one\n'
      + 'this command should touch.'
    );
    process.exit(1);
  }
  if (decision.client !== knexConfig.client) {
    console.error(
      `Refusing to migrate ${knexConfig.client} — this install's data is in ${decision.client}.\n`
      + `Run migrations through the container entrypoint, or set DATABASE_CLIENT=${decision.client} explicitly.\n`
      + 'To move the data across instead: node scripts/migrate-sqlite-to-postgres.js'
    );
    process.exit(1);
  }
}

module.exports = {
  createMigrationsTable,
  runMigrationFile,
  listMigrationFiles,
  assertEngine,
};
