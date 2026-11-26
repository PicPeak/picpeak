const path = require('path');
const { db } = require('../src/database/db');
const {
  createMigrationsTable,
  runMigrationFile,
  listMigrationFiles,
  assertEngine,
} = require('./run-migrations-shared');

// Get list of applied migrations
async function getAppliedMigrations() {
  const migrations = await db('migrations').select('filename');
  return migrations.map(m => m.filename);
}

// Main migration runner
function runMigrations() {
  return require('../src/database/crmAccess').withTrustedCrmAccess('schema migration', runMigrationsInternal);
}

async function runMigrationsInternal() {
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
    await createMigrationsTable('Created migrations table');
    
    // Get applied migrations
    const appliedMigrations = await getAppliedMigrations();
    
    // Check if this is a new deployment (no migrations have been applied)
    const isNewDeployment = appliedMigrations.length === 0;
    
    // Get migration files from appropriate directories
    const migrationFiles = await listMigrationFiles(isNewDeployment);
    
    // Run pending migrations
    let pendingCount = 0;
    for (const file of migrationFiles) {
      const filename = path.basename(file);
      if (!appliedMigrations.includes(filename)) {
        await runMigrationFile(file, 'completed');
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
