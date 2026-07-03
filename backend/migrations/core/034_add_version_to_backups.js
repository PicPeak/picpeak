const { db } = require('../../src/database/db');

async function up() {
  console.log('Adding version tracking to backup tables...');
  
  // Add version columns to database_backup_runs table
  const hasDatabaseBackupRunsTable = await db.schema.hasTable('database_backup_runs');
  if (hasDatabaseBackupRunsTable) {
    const hasAppVersion = await db.schema.hasColumn('database_backup_runs', 'app_version');
    if (!hasAppVersion) {
      await db.schema.alterTable('database_backup_runs', (table) => {
        table.string('app_version'); // Application version
        table.string('node_version'); // Node.js version
        table.string('db_schema_version'); // Database schema version (migration name)
        table.json('environment_info'); // Additional environment information
      });
      console.log('Added version columns to database_backup_runs table');
    }
  }

  // Add version columns to backup_runs table (file backups)
  const hasBackupRunsTable = await db.schema.hasTable('backup_runs');
  if (hasBackupRunsTable) {
    const hasAppVersion = await db.schema.hasColumn('backup_runs', 'app_version');
    if (!hasAppVersion) {
      await db.schema.alterTable('backup_runs', (table) => {
        table.string('app_version'); // Application version
        table.string('node_version'); // Node.js version
        table.string('db_schema_version'); // Database schema version
        table.json('manifest_info'); // Manifest summary information
      });
      console.log('Added version columns to backup_runs table');
    }
  }

  // Add restore tracking table
  const hasRestoreHistoryTable = await db.schema.hasTable('restore_history');
  if (!hasRestoreHistoryTable) {
    await db.schema.createTable('restore_history', (table) => {
      table.increments('id').primary();
      table.datetime('started_at').notNullable();
      table.datetime('completed_at');
      table.string('status').defaultTo('running'); // running, completed, failed, partial
      table.string('restore_type'); // database, files, full
      table.string('backup_id'); // Reference to the backup that was restored
      table.string('backup_app_version'); // Version of app that created the backup
      table.string('restore_app_version'); // Version of app performing the restore
      table.string('backup_node_version'); // Node version that created the backup
      table.string('restore_node_version'); // Node version performing the restore
      table.string('backup_schema_version'); // Schema version in the backup
      table.string('restore_schema_version'); // Current schema version
      table.json('version_compatibility'); // Compatibility check results
      table.json('restore_options'); // Options used during restore
      table.json('statistics'); // Restore statistics
      table.text('warnings'); // Any warnings during restore
      table.text('error_message'); // Error details if failed
      table.string('restored_by'); // User who initiated the restore
      table.index(['started_at'], 'idx_restore_started');
      table.index(['backup_id'], 'idx_restore_backup_id');
    });
    console.log('Created restore_history table');
  }

  // Add version compatibility settings
  const versionSettings = [
    {
      setting_key: 'backup_require_version_match',
      setting_value: JSON.stringify(false), // If true, exact version match required for restore
      setting_type: 'backup'
    },
    {
      setting_key: 'backup_allow_minor_version_mismatch',
      setting_value: JSON.stringify(true), // Allow restoring from same major version
      setting_type: 'backup'
    },
    {
      setting_key: 'backup_warn_on_version_mismatch',
      setting_value: JSON.stringify(true), // Show warning when versions don't match
      setting_type: 'backup'
    },
    {
      setting_key: 'backup_check_schema_compatibility',
      setting_value: JSON.stringify(true), // Check if migrations are compatible
      setting_type: 'backup'
    }
  ];

  // Insert version settings if they don't exist
  for (const setting of versionSettings) {
    const exists = await db('app_settings')
      .where('setting_key', setting.setting_key)
      .first();
    
    if (!exists) {
      await db('app_settings').insert(setting);
    }
  }

  console.log('Version tracking for backups added successfully');
}

async function down() {
  // Remove version columns from database_backup_runs
  const hasDatabaseBackupRunsTable = await db.schema.hasTable('database_backup_runs');
  if (hasDatabaseBackupRunsTable) {
    await db.schema.alterTable('database_backup_runs', (table) => {
      table.dropColumn('app_version');
      table.dropColumn('node_version');
      table.dropColumn('db_schema_version');
      table.dropColumn('environment_info');
    });
  }

  // Remove version columns from backup_runs
  const hasBackupRunsTable = await db.schema.hasTable('backup_runs');
  if (hasBackupRunsTable) {
    await db.schema.alterTable('backup_runs', (table) => {
      table.dropColumn('app_version');
      table.dropColumn('node_version');
      table.dropColumn('db_schema_version');
      table.dropColumn('manifest_info');
    });
  }

  // Drop restore_history table
  await db.schema.dropTableIfExists('restore_history');

  // Remove version settings
  await db('app_settings')
    .whereIn('setting_key', [
      'backup_require_version_match',
      'backup_allow_minor_version_mismatch',
      'backup_warn_on_version_mismatch',
      'backup_check_schema_compatibility'
    ])
    .delete();
}

module.exports = { up, down };