const { db } = require('../../src/database/db');

async function up() {
  console.log('Adding database backup tables and settings...');
  
  // Create database_backup_runs table to track database backup history
  const hasDatabaseBackupRunsTable = await db.schema.hasTable('database_backup_runs');
  if (!hasDatabaseBackupRunsTable) {
    await db.schema.createTable('database_backup_runs', (table) => {
      table.increments('id').primary();
      table.datetime('started_at').notNullable();
      table.datetime('completed_at');
      table.string('status').defaultTo('running'); // running, completed, failed
      table.string('backup_type'); // sqlite, postgresql
      table.string('destination_path');
      table.string('file_path');
      table.bigInteger('file_size_bytes').defaultTo(0);
      table.bigInteger('original_size_bytes').defaultTo(0);
      table.integer('duration_seconds');
      table.string('checksum'); // SHA256 checksum of backup file
      table.float('compression_ratio'); // Compression percentage
      table.json('table_checksums'); // Individual table checksums
      table.text('error_message');
      table.json('statistics'); // Detailed stats about the backup
      table.index(['started_at'], 'idx_db_backup_started');
      table.index(['status'], 'idx_db_backup_status');
    });
  }

  // Add database backup-related settings to app_settings
  const databaseBackupSettings = [
    {
      setting_key: 'database_backup_enabled',
      setting_value: JSON.stringify(false),
      setting_type: 'database_backup'
    },
    {
      setting_key: 'database_backup_schedule',
      setting_value: JSON.stringify('0 3 * * *'), // Default: 3 AM daily
      setting_type: 'database_backup'
    },
    {
      setting_key: 'database_backup_destination_path',
      setting_value: JSON.stringify('/backup/database'),
      setting_type: 'database_backup'
    },
    {
      setting_key: 'database_backup_compress',
      setting_value: JSON.stringify(true),
      setting_type: 'database_backup'
    },
    {
      setting_key: 'database_backup_validate_integrity',
      setting_value: JSON.stringify(true),
      setting_type: 'database_backup'
    },
    {
      setting_key: 'database_backup_include_checksums',
      setting_value: JSON.stringify(true),
      setting_type: 'database_backup'
    },
    {
      setting_key: 'database_backup_retention_days',
      setting_value: JSON.stringify(30),
      setting_type: 'database_backup'
    },
    {
      setting_key: 'database_backup_email_on_failure',
      setting_value: JSON.stringify(true),
      setting_type: 'database_backup'
    },
    {
      setting_key: 'database_backup_email_on_success',
      setting_value: JSON.stringify(false),
      setting_type: 'database_backup'
    },
    {
      setting_key: 'database_backup_max_retries',
      setting_value: JSON.stringify(3),
      setting_type: 'database_backup'
    }
  ];

  // Insert database backup settings if they don't exist
  for (const setting of databaseBackupSettings) {
    const exists = await db('app_settings')
      .where('setting_key', setting.setting_key)
      .first();
    
    if (!exists) {
      await db('app_settings').insert(setting);
    }
  }

  // Add database backup-related email templates
  const databaseBackupEmailTemplates = [
    {
      template_key: 'database_backup_failed',
      subject: 'Database Backup Failed - Critical Alert',
      body_html: `<h2>Database Backup Failed</h2>
<p>The scheduled database backup has failed and requires immediate attention.</p>
<p><strong>Error Details:</strong></p>
<ul>
  <li>Backup Type: {{backup_type}}</li>
  <li>Timestamp: {{timestamp}}</li>
  <li>Error: {{error_message}}</li>
</ul>
<p>This is a critical issue that could affect disaster recovery. Please investigate immediately.</p>`,
      body_text: 'Database Backup Failed\n\nThe scheduled database backup has failed.\n\nBackup Type: {{backup_type}}\nTimestamp: {{timestamp}}\nError: {{error_message}}\n\nThis is critical - please investigate immediately.',
      variables: JSON.stringify(['backup_type', 'timestamp', 'error_message'])
    },
    {
      template_key: 'database_backup_completed',
      subject: 'Database Backup Completed Successfully',
      body_html: `<h2>Database Backup Completed</h2>
<p>The scheduled database backup has been completed successfully.</p>
<p><strong>Backup Summary:</strong></p>
<ul>
  <li>Backup Type: {{backup_type}}</li>
  <li>Duration: {{duration}}</li>
  <li>File Size: {{file_size}}</li>
  <li>Compression Ratio: {{compression_ratio}}</li>
  <li>File Path: {{file_path}}</li>
</ul>`,
      body_text: 'Database Backup Completed\n\nThe scheduled database backup has been completed successfully.\n\nBackup Type: {{backup_type}}\nDuration: {{duration}}\nFile Size: {{file_size}}\nCompression Ratio: {{compression_ratio}}\nFile Path: {{file_path}}',
      variables: JSON.stringify(['backup_type', 'duration', 'file_size', 'compression_ratio', 'file_path'])
    }
  ];

  // Insert database backup email templates if they don't exist
  for (const template of databaseBackupEmailTemplates) {
    const exists = await db('email_templates')
      .where('template_key', template.template_key)
      .first();
    
    if (!exists) {
      await db('email_templates').insert(template);
    }
  }

  console.log('Database backup tables and settings added successfully');
}

async function down() {
  // Remove database backup tables
  await db.schema.dropTableIfExists('database_backup_runs');
  
  // Remove database backup settings
  await db('app_settings')
    .where('setting_type', 'database_backup')
    .delete();
  
  // Remove database backup email templates
  await db('email_templates')
    .whereIn('template_key', ['database_backup_failed', 'database_backup_completed'])
    .delete();
}

module.exports = { up, down };