const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { spawnAsync, spawnToFile } = require('../utils/safeExec');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { createReadStream, createWriteStream } = require('fs');
const { db } = require('../database/db');
const knexConfig = require('../../knexfile');
const logger = require('../utils/logger');
const { queueEmail } = require('./emailProcessor');
const { formatBoolean } = require('../utils/dbCompat');
const packageJson = require('../../package.json');

// Constants
const CHUNK_SIZE = 1024 * 1024; // 1MB chunks for streaming
const PROGRESS_INTERVAL = 100; // Report progress every 100 rows

/**
 * Database Backup Service
 * Supports both SQLite and PostgreSQL with proper escaping,
 * compression, checksums, and validation
 */
class DatabaseBackupService {
  constructor() {
    this.isRunning = false;
    this.currentProgress = null;
    this.dbType = knexConfig.client === 'pg' ? 'postgresql' : 'sqlite';
  }

  /**
   * Calculate checksum for a file
   */
  async calculateChecksum(filePath) {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    
    return new Promise((resolve, reject) => {
      stream.on('data', data => hash.update(data));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  /**
   * Compress a file using gzip
   */
  async compressFile(inputPath, outputPath) {
    const gzip = zlib.createGzip({ level: 6 }); // Balanced compression
    const source = createReadStream(inputPath);
    const destination = createWriteStream(outputPath);
    
    await pipeline(source, gzip, destination);
    
    // Get compression ratio
    const inputStats = await fs.stat(inputPath);
    const outputStats = await fs.stat(outputPath);
    const ratio = (1 - outputStats.size / inputStats.size) * 100;
    
    return {
      originalSize: inputStats.size,
      compressedSize: outputStats.size,
      compressionRatio: ratio.toFixed(2)
    };
  }

  /**
   * Get database size
   */
  async getDatabaseSize() {
    if (this.dbType === 'sqlite') {
      const dbPath = knexConfig.connection.filename;
      const stats = await fs.stat(dbPath);
      return stats.size;
    } else {
      // PostgreSQL
      const result = await db.raw(`
        SELECT pg_database_size(current_database()) as size
      `);
      return parseInt(result.rows[0].size);
    }
  }

  /**
   * Get table checksums for change detection
   */
  async getTableChecksums() {
    const checksums = {};
    const tables = await this.getTables();
    
    for (const table of tables) {
      if (this.dbType === 'sqlite') {
        // SQLite: Use aggregate of all row data
        const result = await db.raw(`
          SELECT 
            COUNT(*) as row_count,
            COALESCE(SUM(LENGTH(CAST(t.* AS TEXT))), 0) as data_sum
          FROM "${table}" t
        `);
        
        checksums[table] = {
          rowCount: result[0].row_count,
          checksum: crypto
            .createHash('md5')
            .update(`${result[0].row_count}-${result[0].data_sum}`)
            .digest('hex')
        };
      } else {
        // PostgreSQL: Use built-in functions
        const result = await db.raw(`
          SELECT 
            COUNT(*) as row_count,
            MD5(COALESCE(STRING_AGG(MD5(t::text), ''), '')) as checksum
          FROM "${table}" t
        `);
        
        checksums[table] = {
          rowCount: parseInt(result.rows[0].row_count),
          checksum: result.rows[0].checksum || 'empty'
        };
      }
    }
    
    return checksums;
  }

  /**
   * Get list of tables
   */
  async getTables() {
    if (this.dbType === 'sqlite') {
      const result = await db.raw(`
        SELECT name FROM sqlite_master 
        WHERE type='table' 
        AND name NOT LIKE 'sqlite_%'
        AND name != 'knex_migrations'
        AND name != 'knex_migrations_lock'
        ORDER BY name
      `);
      return result.map(row => row.name);
    } else {
      // PostgreSQL
      const result = await db.raw(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_type = 'BASE TABLE'
        AND table_name NOT IN ('knex_migrations', 'knex_migrations_lock')
        ORDER BY table_name
      `);
      return result.rows.map(row => row.table_name);
    }
  }

  /**
   * Create SQLite backup
   */
  async createSQLiteBackup(outputPath, options = {}) {
    const dbPath = knexConfig.connection.filename;
    const tempPath = `${outputPath}.tmp`;
    
    try {
      // Use SQLite's backup API for consistency
      await spawnAsync('sqlite3', [dbPath, `.backup '${tempPath}'`]);

      // Verify the backup
      const verifyResult = await spawnAsync('sqlite3', [tempPath, 'PRAGMA integrity_check']);
      if (!verifyResult.stdout.includes('ok')) {
        throw new Error('Backup integrity check failed');
      }
      
      // Move temp file to final location
      await fs.rename(tempPath, outputPath);
      
      return { success: true };
    } catch (error) {
      // Cleanup temp file if exists
      try {
        await fs.unlink(tempPath);
      } catch (e) {
        // Ignore
      }
      throw error;
    }
  }

  /**
   * Create PostgreSQL backup with proper escaping
   */
  async createPostgreSQLBackup(outputPath, options = {}) {
    const { host, port, user, password, database } = knexConfig.connection;
    
    // Set PGPASSWORD environment variable for security
    const env = { ...process.env };
    if (password) {
      env.PGPASSWORD = password;
    }
    
    // Build pg_dump command with options
    const pgDumpOptions = [
      '--verbose',
      '--no-owner',
      '--no-privileges',
      '--clean',
      '--if-exists',
      '--format=plain',
      '--encoding=UTF8'
    ];

    // NOTE: do NOT add `--single-transaction` here. It looks like
    // the right flag for "consistent snapshot" but it isn't a pg_dump
    // option — it belongs to pg_restore / psql and pg_dump rejects it
    // with `unrecognized option: single-transaction` (exit code 1).
    // pg_dump already wraps the entire export in a single REPEATABLE
    // READ snapshot automatically (since Postgres 9.x), so consistency
    // is built in. If we ever need stricter cross-pg-cluster snapshot
    // sharing, use `--snapshot=<id>` — but the typical inline-dump
    // path doesn't need it. Bug went undetected until Stage A wired
    // this code into the user-facing "Run Backup Now" path; prior
    // callers (scheduled cron, dedicated admin DB-backup page) hit
    // the same failure but on installs that had never exercised them.

    // Add compression if not doing it separately
    if (options.compress && !options.separateCompression) {
      pgDumpOptions.push('--compress=6');
    }
    
    const pgDumpArgs = [
      ...pgDumpOptions,
      '-h', host,
      '-p', String(port),
      '-U', user,
      '-d', database
    ];

    try {
      const { stderr } = await spawnToFile('pg_dump', pgDumpArgs, outputPath, { env });

      // pg_dump writes progress to stderr, not an error
      if (stderr && !stderr.includes('dump complete')) {
        logger.warn('pg_dump warnings:', stderr);
      }
      
      // Verify the dump file is not empty
      const stats = await fs.stat(outputPath);
      if (stats.size === 0) {
        throw new Error('Backup file is empty');
      }
      
      return { success: true, warnings: stderr };
    } catch (error) {
      throw new Error(`PostgreSQL backup failed: ${error.message}`);
    }
  }

  /**
   * Validate backup integrity
   */
  async validateBackup(backupPath, originalChecksums) {
    const tempDbPath = `${backupPath}.validate`;
    
    try {
      if (this.dbType === 'sqlite') {
        // For SQLite, we can directly check integrity
        const result = await spawnAsync('sqlite3', [backupPath, 'PRAGMA integrity_check']);
        if (!result.stdout.includes('ok')) {
          throw new Error('Backup integrity check failed');
        }
      } else {
        // For PostgreSQL, we'd need to restore to a temp database
        // This is more complex and might not be feasible in production
        logger.info('PostgreSQL backup validation would require restore test');
      }
      
      return { valid: true };
    } finally {
      // Cleanup
      try {
        await fs.unlink(tempDbPath);
      } catch (e) {
        // Ignore
      }
    }
  }

  /**
   * Main backup method
   */
  async backup(options = {}) {
    if (this.isRunning) {
      throw new Error('Backup already in progress');
    }
    
    this.isRunning = true;
    const startTime = new Date();
    let backupRun = null;
    
    try {
      // Get configuration
      const config = await this.getBackupConfig();
      const {
        destinationPath = '/backup/database',
        compress = true,
        validateIntegrity = true,
        includeChecksums = true
      } = { ...config, ...options };
      
      // Create backup directory
      await fs.mkdir(destinationPath, { recursive: true });
      
      // Generate backup filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const baseName = `picpeak-db-${this.dbType}-${timestamp}`;
      const sqlFile = path.join(destinationPath, `${baseName}.sql`);
      const finalFile = compress ? path.join(destinationPath, `${baseName}.sql.gz`) : sqlFile;
      
      // Get current schema version
      const schemaVersion = await this.getCurrentSchemaVersion();
      
      // Create backup run record with version info.
      //
      // Insert shape divergence between SQLite + Postgres made the old
      // `const [runId] = await db(...).insert({...})` form throw
      // "(intermediate value) is not iterable" on Postgres installs:
      //
      //   - SQLite-via-knex: insert() returns `[lastInsertId]` (array)
      //   - Postgres-via-knex: insert() without .returning() returns an
      //     empty object / row count — not iterable
      //
      // Bug went undetected until Stage A wired this method into the
      // "Run Backup Now" inline-dump path — before that, only the
      // scheduled-cron + dedicated-admin-page callers exercised it,
      // and Ralf's install had never triggered either. Cure: same
      // explicit `.returning('id')` + dual-shape coalesce pattern that
      // `backupService.js:949` uses for its own `backup_runs` insert.
      const insertResult = await db('database_backup_runs').insert({
        started_at: startTime,
        status: 'running',
        backup_type: this.dbType,
        destination_path: finalFile,
        app_version: packageJson.version,
        node_version: process.version,
        db_schema_version: schemaVersion,
        environment_info: JSON.stringify({
          platform: process.platform,
          arch: process.arch,
          node_env: process.env.NODE_ENV || 'production',
          db_type: this.dbType
        })
      }).returning('id');
      const runId = insertResult[0]?.id || insertResult[0];

      backupRun = { id: runId };
      
      // Get initial checksums
      let tableChecksums = null;
      if (includeChecksums) {
        this.updateProgress('Calculating table checksums...');
        tableChecksums = await this.getTableChecksums();
      }
      
      // Get database size
      const dbSize = await this.getDatabaseSize();
      
      // Create the backup
      this.updateProgress('Creating database backup...');
      if (this.dbType === 'sqlite') {
        await this.createSQLiteBackup(sqlFile, options);
      } else {
        await this.createPostgreSQLBackup(sqlFile, options);
      }
      
      // Compress if requested
      let compressionStats = null;
      if (compress) {
        this.updateProgress('Compressing backup...');
        compressionStats = await this.compressFile(sqlFile, finalFile);
        await fs.unlink(sqlFile); // Remove uncompressed file
      }
      
      // Calculate checksum
      this.updateProgress('Calculating backup checksum...');
      const backupChecksum = await this.calculateChecksum(finalFile);
      
      // Validate if requested
      if (validateIntegrity && !compress) {
        this.updateProgress('Validating backup integrity...');
        await this.validateBackup(finalFile, tableChecksums);
      }
      
      // Get final file size
      const finalStats = await fs.stat(finalFile);
      
      // Calculate duration
      const endTime = new Date();
      const durationSeconds = Math.round((endTime - startTime) / 1000);
      
      // Update backup run record
      await db('database_backup_runs')
        .where('id', runId)
        .update({
          completed_at: endTime,
          status: 'completed',
          file_path: finalFile,
          file_size_bytes: finalStats.size,
          original_size_bytes: dbSize,
          duration_seconds: durationSeconds,
          checksum: backupChecksum,
          compression_ratio: compressionStats?.compressionRatio || null,
          table_checksums: tableChecksums ? JSON.stringify(tableChecksums) : null,
          statistics: JSON.stringify({
            dbType: this.dbType,
            compressed: compress,
            validated: validateIntegrity,
            compressionStats,
            tableCount: tableChecksums ? Object.keys(tableChecksums).length : null,
            app_version: packageJson.version,
            node_version: process.version,
            db_schema_version: await this.getCurrentSchemaVersion()
          })
        });
      
      logger.info(`Database backup completed: ${finalFile} (${(finalStats.size / 1024 / 1024).toFixed(2)} MB) in ${durationSeconds}s`);
      
      // Send success notification if configured
      if (config.emailOnSuccess) {
        await this.sendBackupNotification('success', {
          duration: durationSeconds,
          size: finalStats.size,
          compressionRatio: compressionStats?.compressionRatio,
          path: finalFile
        });
      }
      
      return {
        success: true,
        path: finalFile,
        size: finalStats.size,
        duration: durationSeconds,
        checksum: backupChecksum,
        compressionRatio: compressionStats?.compressionRatio
      };
      
    } catch (error) {
      logger.error('Database backup failed:', error);
      
      // Update backup run record
      if (backupRun) {
        await db('database_backup_runs')
          .where('id', backupRun.id)
          .update({
            completed_at: new Date(),
            status: 'failed',
            error_message: error.message
          });
      }
      
      // Send failure notification
      const config = await this.getBackupConfig();
      if (config.emailOnFailure) {
        await this.sendBackupNotification('failure', {
          error: error.message
        });
      }
      
      throw error;
    } finally {
      this.isRunning = false;
      this.currentProgress = null;
    }
  }

  /**
   * Update progress
   */
  updateProgress(message, details = {}) {
    this.currentProgress = {
      message,
      details,
      timestamp: new Date()
    };
    logger.info(`Backup progress: ${message}`, details);
  }

  /**
   * Get current progress
   */
  getProgress() {
    return this.currentProgress;
  }

  /**
   * Get backup configuration
   */
  async getBackupConfig() {
    const settings = await db('app_settings')
      .where('setting_type', 'database_backup')
      .select('setting_key', 'setting_value');
    
    const config = {};
    settings.forEach(setting => {
      try {
        config[setting.setting_key] = JSON.parse(setting.setting_value);
      } catch (e) {
        config[setting.setting_key] = setting.setting_value;
      }
    });
    
    return config;
  }

  /**
   * Send backup notification email
   */
  async sendBackupNotification(type, details) {
    const admins = await db('admin_users').where('is_active', formatBoolean(true));
    
    for (const admin of admins) {
      if (type === 'success') {
        await queueEmail(null, admin.email, 'database_backup_completed', {
          backup_type: this.dbType,
          duration: `${details.duration} seconds`,
          file_size: `${(details.size / 1024 / 1024).toFixed(2)} MB`,
          compression_ratio: details.compressionRatio ? `${details.compressionRatio}%` : 'N/A',
          file_path: details.path
        });
      } else {
        await queueEmail(null, admin.email, 'database_backup_failed', {
          backup_type: this.dbType,
          error_message: details.error,
          timestamp: new Date().toISOString()
        });
      }
    }
  }

  /**
   * Clean up old backups
   */
  async cleanupOldBackups(retentionDays = 30) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
      
      // Get old backup records
      const oldBackups = await db('database_backup_runs')
        .where('completed_at', '<', cutoffDate)
        .where('status', 'completed')
        .select('id', 'file_path');
      
      let deletedCount = 0;
      
      for (const backup of oldBackups) {
        try {
          // Delete the file
          if (backup.file_path) {
            await fs.unlink(backup.file_path);
          }
          
          // Delete the record
          await db('database_backup_runs')
            .where('id', backup.id)
            .delete();
          
          deletedCount++;
        } catch (error) {
          logger.error(`Failed to delete old backup ${backup.file_path}:`, error);
        }
      }
      
      if (deletedCount > 0) {
        logger.info(`Cleaned up ${deletedCount} old database backups`);
      }
      
      // Also clean up old failed runs
      await db('database_backup_runs')
        .where('started_at', '<', cutoffDate)
        .where('status', 'failed')
        .delete();
      
    } catch (error) {
      logger.error('Failed to cleanup old database backups:', error);
    }
  }

  /**
   * Get backup history
   */
  async getBackupHistory(limit = 10) {
    return await db('database_backup_runs')
      .orderBy('started_at', 'desc')
      .limit(limit);
  }

  /**
   * Get current database schema version
   */
  async getCurrentSchemaVersion() {
    try {
      const result = await db('knex_migrations')
        .orderBy('id', 'desc')
        .first();
      return result ? result.name : 'unknown';
    } catch (error) {
      logger.error('Failed to get schema version:', error);
      return 'unknown';
    }
  }

  /**
   * Check version compatibility for restore
   */
  async checkVersionCompatibility(backupInfo) {
    const currentAppVersion = packageJson.version;
    const currentNodeVersion = process.version;
    const currentSchemaVersion = await this.getCurrentSchemaVersion();
    
    const compatibility = {
      compatible: true,
      warnings: [],
      errors: []
    };

    // Check app version
    if (backupInfo.app_version !== currentAppVersion) {
      const backupMajor = backupInfo.app_version?.split('.')[0];
      const currentMajor = currentAppVersion.split('.')[0];
      
      if (backupMajor !== currentMajor) {
        compatibility.errors.push(
          `Major version mismatch: backup v${backupInfo.app_version}, current v${currentAppVersion}`
        );
        compatibility.compatible = false;
      } else {
        compatibility.warnings.push(
          `Minor version difference: backup v${backupInfo.app_version}, current v${currentAppVersion}`
        );
      }
    }

    // Check Node.js version
    if (backupInfo.node_version !== currentNodeVersion) {
      const backupNodeMajor = backupInfo.node_version?.split('.')[0];
      const currentNodeMajor = currentNodeVersion.split('.')[0];
      
      if (backupNodeMajor !== currentNodeMajor) {
        compatibility.warnings.push(
          `Node.js major version difference: backup ${backupInfo.node_version}, current ${currentNodeVersion}`
        );
      }
    }

    // Check schema version
    if (backupInfo.db_schema_version && backupInfo.db_schema_version !== currentSchemaVersion) {
      compatibility.warnings.push(
        `Database schema difference: backup migration '${backupInfo.db_schema_version}', current '${currentSchemaVersion}'`
      );
      compatibility.warnings.push(
        'You may need to run migrations after restore'
      );
    }

    return compatibility;
  }

  /**
   * Restore from backup (with version checking)
   */
  async restore(backupPath, options = {}) {
    // This is a dangerous operation and should be used with extreme caution
    throw new Error('Restore functionality not implemented for safety. Please use restore service or restore manually.');
  }
}

// Create singleton instance
const databaseBackupService = new DatabaseBackupService();

// Scheduled backup runner
let backupSchedule = null;

/**
 * Start scheduled database backups
 */
async function startScheduledBackups() {
  const cron = require('node-cron');
  
  try {
    const config = await databaseBackupService.getBackupConfig();
    
    if (!config.enabled) {
      logger.info('Database backup service is disabled');
      return;
    }
    
    // Stop existing schedule
    if (backupSchedule) {
      backupSchedule.stop();
    }
    
    // Default schedule: 3 AM daily (offset from file backups at 2 AM)
    const schedule = config.schedule || '0 3 * * *';
    
    backupSchedule = cron.schedule(schedule, async () => {
      logger.info('Starting scheduled database backup');
      try {
        await databaseBackupService.backup();
        await databaseBackupService.cleanupOldBackups(config.retentionDays || 30);
      } catch (error) {
        logger.error('Scheduled database backup failed:', error);
      }
    });
    
    logger.info(`Database backup service started with schedule: ${schedule}`);
  } catch (error) {
    logger.error('Failed to start database backup service:', error);
  }
}

/**
 * Stop scheduled database backups
 */
function stopScheduledBackups() {
  if (backupSchedule) {
    backupSchedule.stop();
    backupSchedule = null;
    logger.info('Database backup service stopped');
  }
}

module.exports = {
  databaseBackupService,
  startScheduledBackups,
  stopScheduledBackups,
  DatabaseBackupService // Export class for testing
};