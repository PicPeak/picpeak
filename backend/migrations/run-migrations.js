const fs = require('fs').promises;
const path = require('path');
const { db } = require('../src/database/db');

// Create migrations table if it doesn't exist
async function createMigrationsTable() {
  const tableExists = await db.schema.hasTable('migrations');
  if (!tableExists) {
    await db.schema.createTable('migrations', (table) => {
      table.increments('id').primary();
      table.string('filename').unique().notNullable();
      table.timestamp('applied_at').defaultTo(db.fn.now());
    });
    console.log('Created migrations table');
  }
}

// Get list of applied migrations
async function getAppliedMigrations() {
  const migrations = await db('migrations').select('filename');
  return migrations.map(m => m.filename);
}

// Run a single migration
async function runMigration(filepath) {
  const migrationPath = path.join(__dirname, filepath);
  const migration = require(migrationPath);
  const filename = path.basename(filepath);

  if (migration.up) {
    console.log(`Running migration: ${filepath}`);

    // Run migration in a transaction if PostgreSQL to ensure atomicity
    // between schema changes and migration tracking
    if (db.client.config.client === 'pg') {
      await db.transaction(async (trx) => {
        await migration.up(trx);
        await trx('migrations').insert({ filename });
      });
    } else {
      await migration.up(db);
      await db('migrations').insert({ filename });
    }

    console.log(`Migration ${filepath} completed`);
  }
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

// Main migration runner
async function runMigrations() {
  try {
    console.log('Starting database migrations...');
    await assertEngine();
    
    // First run the init.js if it exists but only if migrations table doesn't exist
    const tableExists = await db.schema.hasTable('migrations');
    if (!tableExists) {
      const { initializeDatabase } = require('../src/database/db');
      console.log('Running initial database setup...');
      await initializeDatabase();
    }
    
    // Create migrations table
    await createMigrationsTable();
    
    // Get applied migrations
    const appliedMigrations = await getAppliedMigrations();
    
    // Check if this is a new deployment (no migrations have been applied)
    const isNewDeployment = appliedMigrations.length === 0;
    
    // Get migration files from appropriate directories
    let migrationFiles = [];
    
    if (isNewDeployment) {
      // For new deployments, only run core migrations
      console.log('New deployment detected - running core migrations only');
      const coreDir = path.join(__dirname, 'core');
      const coreFiles = await fs.readdir(coreDir);
      migrationFiles = coreFiles
        .filter(f => f.match(/^\d{3}_.*\.js$/))
        .map(f => path.join('core', f))
        .sort((a, b) => {
          const baseA = path.basename(a);
          const baseB = path.basename(b);
          const numA = parseInt(baseA.split('_')[0]);
          const numB = parseInt(baseB.split('_')[0]);
          return numA - numB;
        });
    } else {
      // For existing deployments, run all migrations (legacy + core)
      console.log('Existing deployment detected - checking all migrations');
      
      // Get legacy migrations
      const legacyDir = path.join(__dirname, 'legacy');
      const legacyFiles = await fs.readdir(legacyDir);
      const legacyMigrations = legacyFiles
        .filter(f => f.match(/^\d{3}_.*\.js$/))
        .map(f => path.join('legacy', f));
      
      // Get core migrations
      const coreDir = path.join(__dirname, 'core');
      const coreFiles = await fs.readdir(coreDir);
      const coreMigrations = coreFiles
        .filter(f => f.match(/^\d{3}_.*\.js$/))
        .map(f => path.join('core', f));
      
      // Combine and sort by number
      migrationFiles = [...legacyMigrations, ...coreMigrations]
        .sort((a, b) => {
          const numA = parseInt(path.basename(a).split('_')[0]);
          const numB = parseInt(path.basename(b).split('_')[0]);
          return numA - numB;
        });
    }
    
    // Run pending migrations
    let pendingCount = 0;
    for (const file of migrationFiles) {
      const filename = path.basename(file);
      if (!appliedMigrations.includes(filename)) {
        await runMigration(file);
        pendingCount++;
      }
    }
    
    if (pendingCount === 0) {
      console.log('No pending migrations');
    } else {
      console.log(`Applied ${pendingCount} migration(s)`);
    }
    
    console.log('All migrations completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

// Only run if called directly
if (require.main === module) {
  runMigrations();
}

module.exports = { runMigrations };