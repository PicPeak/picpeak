const fs = require('fs').promises;
const path = require('path');
const { db } = require('../src/database/db');

/**
 * Production-safe migration runner that handles existing schema
 */

// Create or verify migrations tracking table
async function ensureMigrationsTable() {
  const tableExists = await db.schema.hasTable('migrations');
  if (!tableExists) {
    await db.schema.createTable('migrations', (table) => {
      table.increments('id').primary();
      table.string('filename').unique().notNullable();
      table.timestamp('applied_at').defaultTo(db.fn.now());
    });
    console.log('Created migrations tracking table');
  }
}

// Check if a migration has been applied
async function isMigrationApplied(filename) {
  const result = await db('migrations').where('filename', filename).first();
  return !!result;
}

// Mark migration as applied without running it (for existing schema)
async function markMigrationAsApplied(filename) {
  // Check if already marked to avoid duplicate key error
  const isApplied = await isMigrationApplied(filename);
  if (!isApplied) {
    await db('migrations').insert({ filename });
    console.log(`Marked migration ${filename} as applied`);
  }
}

// Detect existing schema and mark migrations as applied
async function detectExistingSchema() {
  console.log('Detecting existing schema...');

  // Modern-bootstrap fingerprint check (#530).
  //
  // A DB with the post-initializeDatabase state (photo_categories +
  // cms_pages present, which db.js:initializeDatabase() creates as
  // part of the consolidated modern bootstrap) but an empty migrations
  // table is a recovery scenario — either restored from a backup that
  // lost the migrations table, or someone invoked initializeDatabase()
  // outside the migration runner.
  //
  // Treating this as a regular "existing deployment" runs the legacy
  // chain first, which renames email_templates.subject → subject_en
  // (legacy/008). Then core/029 fails when it tries to insert email
  // templates referencing the pre-rename `subject` column. Fresh
  // installs avoid this by running ONLY core migrations (core/059
  // handles the rename later, after core/029 has inserted templates).
  // Real legacy upgrades avoid it because their migrations table
  // already records that legacy/008–028 ran historically.
  //
  // The fix: when the modern bootstrap fingerprint is detected, mark
  // every legacy migration as applied. This matches what fresh
  // installs do (skip legacy entirely) and keeps the legacy chain
  // from operating on a schema state it doesn't expect. Real legacy
  // upgrades hit no-op markings here because they already have their
  // migrations recorded.
  const hasPhotoCategoriesTable = await db.schema.hasTable('photo_categories');
  const hasCmsPagesTable = await db.schema.hasTable('cms_pages');
  if (hasPhotoCategoriesTable && hasCmsPagesTable) {
    const legacyDir = path.join(__dirname, 'legacy');
    try {
      const legacyFiles = await fs.readdir(legacyDir);
      const legacyMigrations = legacyFiles.filter((f) => /^\d{3}_.*\.js$/.test(f));
      for (const filename of legacyMigrations) {
        await markMigrationAsApplied(filename);
      }
    } catch (err) {
      // Non-fatal — only legacy dir absence (very-old test setups)
      // would land here. Original table-based markers below still run.
      console.log(`Could not enumerate legacy migrations: ${err.message}`);
    }
  }

  const tableChecks = [
    { table: 'events', migration: '001_init.js' },
    { table: 'photos', migration: '001_init.js' },
    { table: 'photo_categories', migration: '004_add_categories_and_cms.js' },
    { table: 'cms_pages', migration: '004_add_categories_and_cms.js' },
    { table: 'login_attempts', migration: '015_add_login_attempts_table.js' },
    { table: 'token_blacklist', migration: '017_add_token_revocation_tables.js' },
    { table: 'backup_runs', migration: '029_add_backup_service_tables.js' },
    { table: 'gallery_feedback', migration: '033_add_gallery_feedback.js' },
  ];

  for (const check of tableChecks) {
    const exists = await db.schema.hasTable(check.table);
    if (exists) {
      const isApplied = await isMigrationApplied(check.migration);
      if (!isApplied) {
        await markMigrationAsApplied(check.migration);
      }
    }
  }
}

// Run a single migration safely
async function runMigrationSafely(filepath) {
  try {
    const migrationPath = path.join(__dirname, filepath);
    const migration = require(migrationPath);
    const filename = path.basename(filepath);

    if (migration.up) {
      console.log(`Running migration: ${filepath}`);

      // Run migration in a transaction if possible
      // IMPORTANT: Include the migrations table insert INSIDE the transaction
      // to ensure atomicity between schema changes and tracking
      if (db.client.config.client === 'pg') {
        await db.transaction(async (trx) => {
          await migration.up(trx);
          // Insert migration record inside transaction for atomicity
          await trx('migrations').insert({ filename });
        });
      } else {
        await migration.up(db);
        await db('migrations').insert({ filename });
      }

      console.log(`Migration ${filepath} completed successfully`);
    }
  } catch (error) {
    // Check if error is because schema already exists
    // PostgreSQL error codes:
    // - 42P07: duplicate_table (relation already exists)
    // - 42701: duplicate_column (column already exists)
    // - 42710: duplicate_object (constraint, index, etc. already exists)
    // - 23505: unique_violation (migration record already exists)
    const schemaExistsErrors = ['42P07', '42701', '42710', '23505'];
    const isSQLiteAlreadyExists = error.code === 'SQLITE_ERROR' && error.message.includes('already exists');

    if (schemaExistsErrors.includes(error.code) || isSQLiteAlreadyExists) {
      console.log(`Migration ${filepath} - schema already exists, marking as applied`);
      await markMigrationAsApplied(path.basename(filepath));
    } else {
      throw error;
    }
  }
}

// Main migration runner
async function runMigrations() {
  let connection;
  try {
    console.log('Starting production-safe database migrations...');
    
    // Ensure database connection is ready
    await db.raw('SELECT 1');
    console.log('Database connection verified');
    
    // Create migrations tracking table
    await ensureMigrationsTable();
    
    // Check if essential tables exist to determine if this is truly a new deployment
    const hasEventsTable = await db.schema.hasTable('events');
    const hasPhotosTable = await db.schema.hasTable('photos');
    const hasAdminTable = await db.schema.hasTable('admin_users');
    const hasActivityLogsTable = await db.schema.hasTable('activity_logs');
    
    // Get applied migrations
    let appliedMigrations = await db('migrations').select('filename');
    let appliedFilenames = appliedMigrations.map(m => m.filename);

    // Check if this is a new deployment
    // It's new if no essential tables exist OR no migrations have been applied
    const hasEssentialTables = hasEventsTable && hasPhotosTable && hasAdminTable && hasActivityLogsTable;
    const isDatabaseEmpty = !hasEventsTable && !hasPhotosTable && !hasAdminTable && !hasActivityLogsTable;
    const isNewDeployment = isDatabaseEmpty || (appliedFilenames.length === 0 && !hasEssentialTables);

    // Only detect existing schema for truly existing deployments
    if (!isNewDeployment) {
      await detectExistingSchema();
      // detectExistingSchema may have inserted rows into the migrations
      // table (e.g. for 004_add_categories_and_cms.js when photo_categories
      // already exists). Re-query so the iteration below sees the up-to-date
      // applied set — otherwise the loop attempts those migrations again,
      // their tx-internal `insert into migrations` conflicts, and postgres
      // logs a "duplicate key" ERROR on every fresh-after-partial install.
      appliedMigrations = await db('migrations').select('filename');
      appliedFilenames = appliedMigrations.map(m => m.filename);
    }
    
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
          const baseA = path.basename(a);
          const baseB = path.basename(b);
          const numA = parseInt(baseA.split('_')[0]);
          const numB = parseInt(baseB.split('_')[0]);
          return numA - numB;
        });
    }
    
    // Run pending migrations
    let pendingCount = 0;
    let skippedCount = 0;
    
    for (const file of migrationFiles) {
      const filename = path.basename(file);
      const isApplied = appliedFilenames.includes(filename);
      if (!isApplied) {
        await runMigrationSafely(file);
        pendingCount++;
      } else {
        skippedCount++;
      }
    }
    
    console.log(`\nMigration Summary:`);
    console.log(`- Applied: ${pendingCount} migration(s)`);
    console.log(`- Skipped: ${skippedCount} migration(s) (already applied)`);
    console.log(`- Total: ${migrationFiles.length} migration(s)`);
    console.log('\nAll migrations completed successfully');
    
    // Close database connection
    await db.destroy();
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    console.error('Error details:', error);
    
    // Close database connection on error
    try {
      await db.destroy();
    } catch (e) {
      // Ignore
    }
    
    process.exit(1);
  }
}

// Add delay for database readiness in production
async function waitAndRun() {
  if (process.env.NODE_ENV === 'production') {
    console.log('Waiting 2 seconds for database readiness...');
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  await runMigrations();
}

// Only run if called directly
if (require.main === module) {
  waitAndRun();
}

module.exports = { runMigrations };
