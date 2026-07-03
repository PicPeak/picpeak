const { db } = require('../../src/database/db');

async function up() {
  console.log('Enhancing backup system...');
  
  // Add new settings to app_settings table if they don't exist
  const backupSettings = [
    {
      setting_key: 'backup_s3_force_path_style',
      setting_value: JSON.stringify(false),
      setting_type: 'backup'
    },
    {
      setting_key: 'backup_s3_ssl_enabled',
      setting_value: JSON.stringify(true),
      setting_type: 'backup'
    },
    {
      setting_key: 'backup_s3_prefix',
      setting_value: JSON.stringify(''),
      setting_type: 'backup'
    },
    {
      setting_key: 'backup_incremental',
      setting_value: JSON.stringify(false),
      setting_type: 'backup'
    },
    {
      setting_key: 'backup_include_database',
      setting_value: JSON.stringify(true),
      setting_type: 'backup'
    },
    {
      setting_key: 'backup_encryption_enabled',
      setting_value: JSON.stringify(false),
      setting_type: 'backup'
    },
    {
      setting_key: 'backup_database_schedule',
      setting_value: JSON.stringify(''),
      setting_type: 'backup'
    }
  ];

  // Insert settings if they don't exist
  for (const setting of backupSettings) {
    const exists = await db('app_settings')
      .where('setting_key', setting.setting_key)
      .first();
    
    if (!exists) {
      await db('app_settings').insert(setting);
    }
  }

  // Check and add columns to backup_runs table
  const hasBackupRunsTable = await db.schema.hasTable('backup_runs');
  if (hasBackupRunsTable) {
    // Check for existing columns before adding
    const hasManifestPath = await db.schema.hasColumn('backup_runs', 'manifest_path');
    const hasManifestId = await db.schema.hasColumn('backup_runs', 'manifest_id');
    const hasManifestFormat = await db.schema.hasColumn('backup_runs', 'manifest_format');
    const hasParentBackupId = await db.schema.hasColumn('backup_runs', 'parent_backup_id');
    const hasBackupMode = await db.schema.hasColumn('backup_runs', 'backup_mode');
    
    if (!hasManifestPath || !hasManifestId || !hasManifestFormat || !hasParentBackupId || !hasBackupMode) {
      await db.schema.alterTable('backup_runs', (table) => {
        if (!hasManifestPath) {
          table.string('manifest_path', 500).comment('Path to backup manifest file');
        }
        if (!hasManifestId) {
          table.uuid('manifest_id').comment('Unique identifier for the manifest');
        }
        if (!hasManifestFormat) {
          table.enum('manifest_format', ['json', 'yaml']).comment('Format of the manifest file');
        }
        if (!hasParentBackupId) {
          table.integer('parent_backup_id').unsigned().references('id').inTable('backup_runs').onDelete('SET NULL').comment('Parent backup for incremental backups');
        }
        if (!hasBackupMode) {
          table.enum('backup_mode', ['full', 'incremental', 'database']).defaultTo('full').comment('Type of backup performed');
        }
      });
    }
    
    // Add indexes if they don't exist. backup_runs (created in 029) tracks
    // chronology via `started_at` — the original `created_at` reference
    // here was a bug that emitted a "column does not exist" ERROR in the
    // postgres log on every fresh install (silently caught below). See
    // migration 105 for the matching back-fix on already-applied installs.
    try {
      await db.raw('CREATE INDEX IF NOT EXISTS idx_backup_runs_mode_status ON backup_runs(backup_mode, status)');
      await db.raw('CREATE INDEX IF NOT EXISTS idx_backup_runs_parent ON backup_runs(parent_backup_id)');
      await db.raw('CREATE INDEX IF NOT EXISTS idx_backup_runs_started_mode ON backup_runs(started_at, backup_mode)');
    } catch (error) {
      console.log('Note: Some indexes may already exist, continuing...');
    }
  }

  // Create backup_manifest table if it doesn't exist
  const hasManifestTable = await db.schema.hasTable('backup_manifest');
  if (!hasManifestTable) {
    await db.schema.createTable('backup_manifest', (table) => {
      table.increments('id').primary();
      table.integer('backup_run_id').unsigned().notNullable().references('id').inTable('backup_runs').onDelete('CASCADE');
      table.uuid('manifest_id').notNullable().unique().comment('Unique identifier matching backup_runs.manifest_id');
      table.string('version', 20).notNullable().defaultTo('1.0.0').comment('Manifest schema version');
      table.enum('format', ['json', 'yaml']).notNullable().defaultTo('json');
      
      // Backup metadata
      table.timestamp('backup_start').notNullable();
      table.timestamp('backup_end').notNullable();
      table.bigInteger('total_size').unsigned().comment('Total size of backup in bytes');
      table.integer('file_count').unsigned().comment('Number of files in backup');
      table.integer('photo_count').unsigned().comment('Number of photos backed up');
      table.integer('event_count').unsigned().comment('Number of events backed up');
      
      // Incremental backup metadata
      table.boolean('is_incremental').defaultTo(false);
      table.uuid('parent_manifest_id').comment('Parent manifest ID for incremental backups');
      table.timestamp('incremental_since').comment('Timestamp for incremental backup baseline');
      
      // Content checksums
      table.string('checksum_algorithm', 50).defaultTo('sha256').comment('Algorithm used for checksums');
      table.text('manifest_checksum').comment('Checksum of the manifest file itself');
      
      // Storage information
      table.string('storage_location', 500).comment('Primary storage location (local path or S3 URI)');
      table.string('storage_provider', 50).comment('Storage provider (local, s3, etc.)');
      
      // Encryption metadata
      table.boolean('is_encrypted').defaultTo(false);
      table.string('encryption_algorithm', 100).comment('Encryption algorithm used');
      table.string('encryption_key_id', 255).comment('ID of encryption key used');
      
      // Additional metadata as JSON
      table.json('metadata').comment('Additional metadata as JSON');
      
      // Timestamps
      table.timestamps(true, true);
      
      // Indexes
      table.index(['backup_run_id'], 'idx_manifest_backup_run');
      table.index(['manifest_id'], 'idx_manifest_uuid');
      table.index(['parent_manifest_id'], 'idx_manifest_parent');
      table.index(['backup_start', 'backup_end'], 'idx_manifest_time_range');
      table.index(['is_incremental', 'created_at'], 'idx_manifest_incremental_created');
    });
  }

  // Add composite indexes for common query patterns. Same `started_at`
  // correction as above — `created_at` doesn't exist on backup_runs.
  try {
    await db.raw(`
      CREATE INDEX IF NOT EXISTS idx_backup_runs_recent_successful
      ON backup_runs(started_at DESC)
      WHERE status = 'completed' AND backup_mode = 'full';
    `);
    await db.raw(`
      CREATE INDEX IF NOT EXISTS idx_backup_runs_incremental_chain
      ON backup_runs(parent_backup_id, started_at)
      WHERE backup_mode = 'incremental';
    `);
  } catch (error) {
    console.log('Note: Some composite indexes may already exist, continuing...');
  }

  console.log('Backup system enhancements completed');
}

async function down() {
  // Drop indexes first
  try {
    await db.raw('DROP INDEX IF EXISTS idx_backup_runs_incremental_chain;');
    await db.raw('DROP INDEX IF EXISTS idx_backup_runs_recent_successful;');
  } catch (error) {
    // Ignore errors if indexes don't exist
  }

  // Drop backup_manifest table
  await db.schema.dropTableIfExists('backup_manifest');

  // Remove columns from backup_runs if they exist
  const hasBackupRunsTable = await db.schema.hasTable('backup_runs');
  if (hasBackupRunsTable) {
    const hasBackupMode = await db.schema.hasColumn('backup_runs', 'backup_mode');
    const hasParentBackupId = await db.schema.hasColumn('backup_runs', 'parent_backup_id');
    const hasManifestFormat = await db.schema.hasColumn('backup_runs', 'manifest_format');
    const hasManifestId = await db.schema.hasColumn('backup_runs', 'manifest_id');
    const hasManifestPath = await db.schema.hasColumn('backup_runs', 'manifest_path');
    
    if (hasBackupMode || hasParentBackupId || hasManifestFormat || hasManifestId || hasManifestPath) {
      await db.schema.alterTable('backup_runs', (table) => {
        if (hasBackupMode) table.dropColumn('backup_mode');
        if (hasParentBackupId) table.dropColumn('parent_backup_id');
        if (hasManifestFormat) table.dropColumn('manifest_format');
        if (hasManifestId) table.dropColumn('manifest_id');
        if (hasManifestPath) table.dropColumn('manifest_path');
      });
    }
    
    // Drop indexes. `idx_backup_runs_created_mode` is the legacy name
    // shipped by an earlier revision of this migration; kept in the drop
    // list so a down() against any historic state cleans up either name.
    try {
      await db.raw('DROP INDEX IF EXISTS idx_backup_runs_mode_status');
      await db.raw('DROP INDEX IF EXISTS idx_backup_runs_parent');
      await db.raw('DROP INDEX IF EXISTS idx_backup_runs_started_mode');
      await db.raw('DROP INDEX IF EXISTS idx_backup_runs_created_mode');
    } catch (error) {
      // Ignore errors if indexes don't exist
    }
  }

  // Remove settings
  await db('app_settings')
    .whereIn('setting_key', [
      'backup_s3_force_path_style',
      'backup_s3_ssl_enabled',
      'backup_s3_prefix',
      'backup_incremental',
      'backup_include_database',
      'backup_encryption_enabled',
      'backup_database_schedule'
    ])
    .delete();
}

module.exports = { up, down };