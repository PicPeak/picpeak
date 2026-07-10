const { db } = require('../../src/database/db');
const logger = require('../../src/utils/logger');

async function up() {
  console.log('Adding backup manifest columns...');
  
  // Add manifest columns to backup_runs table
  const hasManifestPath = await db.schema.hasColumn('backup_runs', 'manifest_path');
  if (!hasManifestPath) {
    await db.schema.alterTable('backup_runs', (table) => {
      table.string('manifest_path'); // Path to the manifest file
      table.string('manifest_id'); // Unique manifest ID
      table.string('manifest_format').defaultTo('json'); // json or yaml
    });
  }

  // Add backup manifest-related settings to app_settings
  const manifestSettings = [
    {
      setting_key: 'backup_manifest_enabled',
      setting_value: JSON.stringify(true),
      setting_type: 'backup'
    },
    {
      setting_key: 'backup_manifest_format',
      setting_value: JSON.stringify('json'), // json or yaml
      setting_type: 'backup'
    },
    {
      setting_key: 'backup_manifest_path',
      setting_value: JSON.stringify('/backup/manifests'),
      setting_type: 'backup'
    },
    {
      setting_key: 'backup_manifest_validate',
      setting_value: JSON.stringify(true),
      setting_type: 'backup'
    },
    {
      setting_key: 'backup_manifest_include_checksums',
      setting_value: JSON.stringify(true),
      setting_type: 'backup'
    }
  ];

  // Insert manifest settings if they don't exist
  for (const setting of manifestSettings) {
    const exists = await db('app_settings')
      .where('setting_key', setting.setting_key)
      .first();
    
    if (!exists) {
      await db('app_settings').insert(setting);
    }
  }

  console.log('✓ Backup manifest columns and settings added');
}

async function down() {
  // Remove manifest columns from backup_runs table
  const hasManifestPath = await db.schema.hasColumn('backup_runs', 'manifest_path');
  if (hasManifestPath) {
    await db.schema.alterTable('backup_runs', (table) => {
      table.dropColumn('manifest_path');
      table.dropColumn('manifest_id');
      table.dropColumn('manifest_format');
    });
  }

  // Remove manifest settings
  await db('app_settings')
    .where('setting_type', 'backup')
    .whereIn('setting_key', [
      'backup_manifest_enabled',
      'backup_manifest_format',
      'backup_manifest_path',
      'backup_manifest_validate',
      'backup_manifest_include_checksums'
    ])
    .delete();

  console.log('✓ Backup manifest columns and settings removed');
}

module.exports = { up, down };