/**
 * Database Backup Service Usage Examples
 * 
 * This service provides comprehensive database backup functionality
 * with support for both SQLite and PostgreSQL databases.
 */

const { databaseBackupService } = require('./databaseBackup');

// Example 1: Manual backup with default settings
async function manualBackup() {
  try {
    const result = await databaseBackupService.backup();
    console.log('Backup completed:', result);
    // Result includes: path, size, duration, checksum, compressionRatio
  } catch (error) {
    console.error('Backup failed:', error);
  }
}

// Example 2: Backup with custom options
async function customBackup() {
  try {
    const result = await databaseBackupService.backup({
      destinationPath: '/custom/backup/path',
      compress: true,              // Enable gzip compression
      validateIntegrity: true,     // Validate backup after creation
      includeChecksums: true,      // Calculate table checksums
      noTransaction: false         // Use transaction for consistency (PostgreSQL)
    });
    console.log('Custom backup completed:', result);
  } catch (error) {
    console.error('Backup failed:', error);
  }
}

// Example 3: Check backup progress (useful for long-running backups)
async function backupWithProgress() {
  // Start backup asynchronously
  const backupPromise = databaseBackupService.backup();
  
  // Poll for progress
  const progressInterval = setInterval(() => {
    const progress = databaseBackupService.getProgress();
    if (progress) {
      console.log(`Progress: ${progress.message}`, progress.details);
    }
  }, 1000);
  
  try {
    const result = await backupPromise;
    clearInterval(progressInterval);
    console.log('Backup completed:', result);
  } catch (error) {
    clearInterval(progressInterval);
    console.error('Backup failed:', error);
  }
}

// Example 4: Get backup history
async function getBackupHistory() {
  const history = await databaseBackupService.getBackupHistory(10);
  
  history.forEach(backup => {
    console.log(`Backup ${backup.id}:`);
    console.log(`  Started: ${backup.started_at}`);
    console.log(`  Status: ${backup.status}`);
    console.log(`  Size: ${(backup.file_size_bytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  Duration: ${backup.duration_seconds}s`);
  });
}

// Example 5: Clean up old backups
async function cleanupBackups() {
  // Delete backups older than 30 days
  await databaseBackupService.cleanupOldBackups(30);
  console.log('Old backups cleaned up');
}

// Example 6: Get table checksums (useful for monitoring changes)
async function getTableChecksums() {
  const checksums = await databaseBackupService.getTableChecksums();
  
  console.log('Table Checksums:');
  Object.entries(checksums).forEach(([table, info]) => {
    console.log(`  ${table}: ${info.rowCount} rows, checksum: ${info.checksum}`);
  });
}

// Example 7: Using the scheduled backup service
const { startScheduledBackups, stopScheduledBackups } = require('./databaseBackup');

async function setupScheduledBackups() {
  // Start scheduled backups (reads schedule from database config)
  await startScheduledBackups();
  console.log('Scheduled backups started');
  
  // Later, if needed, stop scheduled backups
  // stopScheduledBackups();
}

// Example 8: Admin API endpoints available
/*
  GET  /api/admin/database-backup/status      - Get backup status and config
  PUT  /api/admin/database-backup/config      - Update backup configuration
  POST /api/admin/database-backup/backup      - Trigger manual backup
  GET  /api/admin/database-backup/progress    - Get current backup progress
  GET  /api/admin/database-backup/history     - Get backup history with pagination
  DELETE /api/admin/database-backup/cleanup   - Delete old backup files
  POST /api/admin/database-backup/test        - Test backup configuration
  GET  /api/admin/database-backup/checksums   - Get current table checksums
*/

// Example 9: Configuration options stored in database
/*
  database_backup_enabled: boolean          - Enable/disable scheduled backups
  database_backup_schedule: string          - Cron schedule (default: '0 3 * * *')
  database_backup_destination_path: string  - Where to store backups
  database_backup_compress: boolean         - Enable gzip compression
  database_backup_validate_integrity: boolean - Validate after backup
  database_backup_include_checksums: boolean  - Calculate table checksums
  database_backup_retention_days: number    - Days to keep old backups
  database_backup_email_on_failure: boolean - Send email on failure
  database_backup_email_on_success: boolean - Send email on success
*/

// Example 10: Production considerations
/*
  1. Ensure destination path has sufficient space
  2. For large databases, backups may take significant time
  3. PostgreSQL backups use single-transaction mode by default
  4. Compression typically reduces size by 70-90%
  5. Schedule backups during low-traffic periods
  6. Monitor backup history for failures
  7. Test restore procedures regularly
  8. Consider replication for real-time redundancy
*/

module.exports = {
  manualBackup,
  customBackup,
  backupWithProgress,
  getBackupHistory,
  cleanupBackups,
  getTableChecksums,
  setupScheduledBackups
};