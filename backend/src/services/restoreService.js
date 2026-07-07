const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { createReadStream, createWriteStream } = require('fs');
const { spawnAsync, spawnToFile, spawnFromFile } = require('../utils/safeExec');
const { db } = require('../database/db');
const knexConfig = require('../../knexfile');
const logger = require('../utils/logger');
const backupManifest = require('./backupManifest');
const S3StorageAdapter = require('./storage/s3Storage');
const { queueEmail } = require('./emailProcessor');
const { formatBoolean } = require('../utils/dbCompat');
const { formatBytes } = require('../utils/formatBytes');
const os = require('os');

/**
 * Restore Service with Extreme Safety Measures
 * 
 * This service handles restoration of backups with multiple safety checks,
 * validation, and rollback capabilities. It prioritizes data safety over speed.
 * 
 * Features:
 * - Pre-restore validation and integrity checks
 * - Automatic pre-restore backup creation
 * - Atomic operations where possible
 * - Comprehensive rollback capability
 * - Detailed logging of every action
 * - Dry-run mode for testing
 * - Multiple restore options (full, database-only, files-only, selective)
 * - S3 support with resume capability
 * - Post-restore verification
 * 
 * @class RestoreService
 */
class RestoreService {
  constructor() {
    this.isRunning = false;
    this.currentProgress = null;
    this.restoreLog = [];
    this.preRestoreBackupPath = null;
    // Snapshot of operator-meta settings (e.g. `restore_allow_force`)
    // captured by performDatabaseRestore BEFORE the DROP DATABASE.
    // Drained by restore() AFTER post-restore verification passes so
    // the replay doesn't inflate the row-count check. Reset per run
    // via beforeRestore() to keep state from leaking across calls.
    this.preservedMetaSnapshot = [];
    this.dbType = knexConfig.client === 'pg' ? 'postgresql' : 'sqlite';
    this.tempDir = path.join(os.tmpdir(), 'picpeak-restore');
  }

  /**
   * Main restore method with comprehensive safety checks
   * 
   * @param {Object} options - Restore options
   * @param {string} options.source - Backup source (file path or S3 URL)
   * @param {string} options.manifestPath - Path to backup manifest
   * @param {string} options.restoreType - 'full', 'database', 'files', or 'selective'
   * @param {Array} options.selectedItems - For selective restore, array of items to restore
   * @param {boolean} options.dryRun - If true, performs validation only
   * @param {boolean} options.skipPreBackup - Skip automatic pre-restore backup (dangerous!)
   * @param {boolean} options.force - Force restore even with warnings (dangerous!)
   * @param {Object} options.s3Config - S3 configuration for S3-based backups
   * @returns {Promise<Object>} - Restore result
   */
  async restore(options) {
    if (this.isRunning) {
      throw new Error('Restore operation already in progress');
    }

    this.isRunning = true;
    this.restoreLog = [];
    this.preservedMetaSnapshot = [];  // reset per run
    const startTime = new Date();
    let restoreRun = null;

    try {
      // Validate options
      this.validateRestoreOptions(options);
      this.log('info', 'Starting restore operation', { options: this.sanitizeOptions(options) });

      // Create restore run record
      const result = await db('restore_runs').insert({
        started_at: startTime,
        status: 'running',
        restore_type: options.restoreType,
        source: options.source,
        manifest_path: options.manifestPath,
        is_dry_run: options.dryRun || false
      }).returning('id');
      const runId = Array.isArray(result) ? (result[0]?.id || result[0]) : result;

      restoreRun = { id: runId };

      // Step 1: Load and validate manifest
      this.updateProgress('Loading and validating manifest...');
      const manifest = await this.loadAndValidateManifest(options.manifestPath, options.s3Config);
      this.log('info', 'Manifest loaded and validated', {
        backupId: manifest.backup.id,
        backupType: manifest.backup.type,
        backupTime: manifest.backup.timestamp
      });

      // Step 2: Pre-restore validation
      this.updateProgress('Performing pre-restore validation...');
      const validation = await this.performPreRestoreValidation(manifest, options);
      
      if (!validation.isValid && !options.force) {
        throw new Error(`Pre-restore validation failed: ${validation.errors.join(', ')}`);
      }

      if (validation.warnings.length > 0) {
        this.log('warn', 'Pre-restore validation warnings', { warnings: validation.warnings });
        // Only block actual restores (not dry runs/validations) on warnings
        if (!options.force && !options.dryRun) {
          throw new Error(`Restore blocked due to warnings (use force to override): ${validation.warnings.join(', ')}`);
        }
      }

      // Step 3: Check disk space
      this.updateProgress('Checking available disk space...');
      const spaceCheck = await this.checkDiskSpace(manifest, options);
      if (!spaceCheck.hasEnoughSpace) {
        throw new Error(`Insufficient disk space. Required: ${spaceCheck.requiredFormatted}, Available: ${spaceCheck.availableFormatted}`);
      }

      // Dry run mode - stop here after validation
      if (options.dryRun) {
        this.log('info', 'Dry run completed successfully');
        
        await db('restore_runs').where('id', runId).update({
          completed_at: new Date(),
          status: 'completed',
          statistics: JSON.stringify({
            dryRun: true,
            validation,
            spaceCheck,
            manifest: {
              backupId: manifest.backup.id,
              fileCount: manifest.files.count,
              totalSize: manifest.files.total_size
            }
          })
        });

        return {
          success: true,
          dryRun: true,
          validation,
          spaceCheck,
          logs: this.restoreLog
        };
      }

      // Step 4: Create pre-restore backup (unless explicitly skipped)
      if (!options.skipPreBackup) {
        this.updateProgress('Creating pre-restore safety backup...');
        this.preRestoreBackupPath = await this.createPreRestoreBackup(options);
        this.log('info', 'Pre-restore backup created', { path: this.preRestoreBackupPath });
      } else {
        this.log('warn', 'Pre-restore backup skipped at user request');
      }

      // Step 5: Download backup if from S3, or resolve the local root.
      //
      // The wizard passes `options.source = 'local'` (the SOURCE TYPE
      // string) — not a path. The old code assigned that string to
      // `localBackupPath` verbatim and every downstream `path.join(...)`
      // ended up with junk like `local/database/<file>.sql.gz`. Caused
      // the disaster-recovery restore flow to fail with
      // `Database backup file not found: local/database/...` even when
      // the manifest recorded the correct absolute path AND the file
      // existed at exactly that path on disk.
      //
      // Resolve `'local'` to the configured backup destination root by
      // reading `backup_destination_path` from app_settings. That's the
      // same root the file-backup walker writes to, so every relative
      // `file.path` in the manifest resolves correctly via
      // `path.join(localBackupPath, file.path)` further down.
      let localBackupPath = options.source;
      if (options.source === 'local') {
        try {
          const row = await db('app_settings')
            .where('setting_key', 'backup_destination_path')
            .first();
          if (row?.setting_value) {
            let parsed;
            try { parsed = JSON.parse(row.setting_value); } catch (_) { parsed = row.setting_value; }
            if (parsed) localBackupPath = parsed;
          }
        } catch (err) {
          this.log('warn', `Could not resolve backup_destination_path: ${err.message}`);
        }
      } else if (options.source.startsWith('s3://')) {
        this.updateProgress('Downloading backup from S3...');
        localBackupPath = await this.downloadFromS3(options.source, manifest, options);
      }

      // Step 6: Perform the actual restore based on type
      let restoreResult;
      switch (options.restoreType) {
      case 'full':
        restoreResult = await this.performFullRestore(localBackupPath, manifest, options);
        break;
      case 'database':
        restoreResult = await this.performDatabaseRestore(localBackupPath, manifest, options);
        break;
      case 'files':
        restoreResult = await this.performFilesRestore(localBackupPath, manifest, options);
        break;
      case 'selective':
        restoreResult = await this.performSelectiveRestore(localBackupPath, manifest, options);
        break;
      default:
        throw new Error(`Unknown restore type: ${options.restoreType}`);
      }

      // Step 7: Post-restore verification
      this.updateProgress('Performing post-restore verification...');
      const verification = await this.performPostRestoreVerification(manifest, options);
      
      if (!verification.isValid) {
        this.log('error', 'Post-restore verification failed', { errors: verification.errors });
        // Attempt rollback
        if (this.preRestoreBackupPath) {
          await this.attemptRollback(this.preRestoreBackupPath);
        }
        throw new Error(`Post-restore verification failed: ${verification.errors.join(', ')}`);
      }

      // Step 7b: Replay operator-meta settings AFTER verification.
      //
      // `performDatabaseRestore` stashed the pre-DROP snapshot of
      // operator-meta keys on `this.preservedMetaSnapshot`. We drain
      // it here, AFTER verification has already confirmed the
      // restored DB matches the backup's row counts. Running this
      // upsert sequence here instead of inside performDatabaseRestore
      // (where it used to live) prevents the replay from inflating
      // the post-restore row count and tripping the verification
      // check — see the round-3 PR #596 notes for the full story.
      //
      // UPSERT by setting_key: if the backup had the same key with a
      // different value, we overwrite; if the row doesn't exist in
      // the backup, we insert. Either way the operator's pre-restore
      // policy survives. SQLite branch leaves the snapshot empty so
      // this block is a no-op there.
      if (this.preservedMetaSnapshot && this.preservedMetaSnapshot.length > 0) {
        try {
          for (const row of this.preservedMetaSnapshot) {
            await db('app_settings')
              .insert({
                setting_key: row.setting_key,
                setting_value: row.setting_value,
                setting_type: row.setting_type || 'restore',
                updated_at: new Date(),
              })
              .onConflict('setting_key')
              .merge({
                setting_value: row.setting_value,
                updated_at: new Date(),
              });
          }
          this.log('info', `Replayed ${this.preservedMetaSnapshot.length} restore-meta setting(s) post-verification`);
        } catch (err) {
          this.log('warn', `Could not replay restore-meta settings (admin may need to re-set them): ${err.message}`);
        }
      }

      // Step 7c: Apply any post-backup migrations to the restored DB.
      //
      // The backup carries the schema state of whatever migrations had
      // been applied at backup time. If the running image is NEWER —
      // because the admin upgraded picpeak between when the backup
      // was taken and when they restored — the restored DB ends up
      // mismatched against the running code: queries fail, new
      // columns are missing, new tables don't exist.
      //
      // Previously the comment said "deferred to next container
      // restart" — but that left the running process serving a
      // mismatched schema until the operator manually restarted.
      // Not acceptable per the "backup must restore completely even
      // when new features have been added in the meantime" contract.
      //
      // Implementation: shell out to `npm run migrate:safe`, which is
      // the EXACT script wait-for-db.sh runs on boot. Running it as a
      // subprocess means no risk to our reinit'd pool (subprocess gets
      // its own knex instance, destroys it on exit; our parent pool
      // is untouched). Idempotent — migrations already applied are
      // tracked in the restored `migrations` table and get skipped.
      //
      // Failure is non-fatal: the restore data itself is in place,
      // and the next container restart's wait-for-db.sh will retry.
      // Surfacing the error gives the operator a chance to investigate
      // proactively rather than discovering it on the next 500 from
      // a missing column.
      try {
        this.log('info', 'Applying post-restore migrations to restored database...');
        this.updateProgress('Applying any post-backup migrations...');
        const backendRoot = path.join(__dirname, '..', '..');
        const { stderr } = await spawnAsync('npm', ['run', 'migrate:safe'], {
          cwd: backendRoot,
          env: { ...process.env },
        });
        if (stderr && stderr.trim()) {
          this.log('info', `Post-restore migrate:safe stderr: ${stderr.slice(0, 500)}`);
        }
        this.log('info', 'Post-restore migrations applied');
      } catch (migErr) {
        this.log('warn',
          'Post-restore migrate:safe failed — restore data is in place but the schema may lag the running image. ' +
          `A container restart will retry via wait-for-db.sh. Error: ${migErr.message}`);
      }

      // Step 8: Clean up temporary files
      if (localBackupPath !== options.source) {
        await fs.unlink(localBackupPath).catch(err => 
          this.log('warn', 'Failed to clean up temporary backup file', { error: err.message })
        );
      }

      // Calculate duration
      const endTime = new Date();
      const durationSeconds = Math.round((endTime - startTime) / 1000);

      // Update restore run record
      await db('restore_runs').where('id', runId).update({
        completed_at: endTime,
        status: 'completed',
        // Default for the column is `false`. Without this line, every
        // SUCCESSFUL restore ends up with `status='completed',
        // was_successful=false` — which the BackupDashboard "last
        // successful restore" widget then filters out, and any future
        // audit query that gates on was_successful misses the row
        // entirely. Cosmetic but enough to mislead an operator
        // scanning restore history. Catches Ralf 2026-06-01 + maintainer
        // PR #596 review note about the cosmetic.
        was_successful: true,
        duration_seconds: durationSeconds,
        pre_restore_backup_path: this.preRestoreBackupPath,
        statistics: JSON.stringify({
          ...restoreResult,
          verification,
          durationSeconds
        })
      });

      // Send success notification
      await this.sendRestoreNotification('success', {
        restoreType: options.restoreType,
        duration: durationSeconds,
        filesRestored: restoreResult.filesRestored || 0,
        backupId: manifest.backup.id
      });

      this.log('info', 'Restore completed successfully', {
        duration: `${durationSeconds}s`,
        result: restoreResult
      });

      return {
        success: true,
        duration: durationSeconds,
        result: restoreResult,
        verification,
        preRestoreBackup: this.preRestoreBackupPath,
        logs: this.restoreLog
      };

    } catch (error) {
      this.log('error', 'Restore failed', { error: error.message, stack: error.stack });

      // Always attempt rollback when a pre-restore backup exists.
      // Historically rollback was only triggered when post-restore
      // verification failed (inside the try block) — anything that
      // threw earlier (path-resolution bugs, pg_restore failure, file
      // copy errors) left the destination half-clobbered and forced
      // the admin to do another reset-from-volume cycle before the
      // next attempt could be honest. Fixing the rollback here closes
      // the "every failed restore makes the next one worse" footgun.
      let rollbackAttempted = false;
      let rollbackSucceeded = false;
      let rollbackError = null;
      if (this.preRestoreBackupPath) {
        rollbackAttempted = true;
        try {
          this.log('info', 'Attempting rollback from pre-restore safety backup', {
            path: this.preRestoreBackupPath,
          });
          await this.attemptRollback(this.preRestoreBackupPath);
          rollbackSucceeded = true;
          this.log('info', 'Rollback completed');
        } catch (rbErr) {
          rollbackError = rbErr.message;
          this.log('error', 'Rollback FAILED — install may be in a partial state',
            { error: rbErr.message, stack: rbErr.stack });
        }
      } else {
        this.log('warn', 'No pre-restore backup available — cannot auto-rollback. ' +
          'Destination may be in a partial state. Verify business-docs/ and the DB before retrying.');
      }

      // Update restore run record. We persist BOTH the original
      // restore failure AND the rollback status so the admin can tell
      // from a single SQL query which scenario they're in:
      //   - rollback succeeded → destination is back to pre-restore state, safe to retry
      //   - rollback failed   → partial state, admin must inspect before next attempt
      //   - rollback skipped  → user opted out via skipPreBackup; same as above
      if (restoreRun) {
        const failureMessage = rollbackAttempted
          ? (rollbackSucceeded
            ? `${error.message} (rolled back successfully to pre-restore state)`
            : `${error.message} | ROLLBACK ALSO FAILED: ${rollbackError} — destination is in a partial state, inspect before retrying`)
          : `${error.message} (no pre-restore backup available — destination may be partial)`;
        await db('restore_runs').where('id', restoreRun.id).update({
          completed_at: new Date(),
          status: 'failed',
          error_message: failureMessage,
          was_rollback_attempted: rollbackAttempted,
          restore_log: JSON.stringify(this.restoreLog)
        });
      }

      // Send failure notification
      await this.sendRestoreNotification('failure', {
        error: error.message,
        restoreType: options.restoreType,
        rollbackAttempted,
        rollbackSucceeded,
      });

      throw error;

    } finally {
      this.isRunning = false;
      this.currentProgress = null;
      
      // Clean up temp directory
      try {
        await fs.rmdir(this.tempDir, { recursive: true });
      } catch (err) {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Validate restore options
   */
  validateRestoreOptions(options) {
    if (!options.source) {
      throw new Error('Backup source is required');
    }

    if (!options.manifestPath) {
      throw new Error('Manifest path is required');
    }

    if (!options.restoreType) {
      throw new Error('Restore type is required');
    }

    const validTypes = ['full', 'database', 'files', 'selective'];
    if (!validTypes.includes(options.restoreType)) {
      throw new Error(`Invalid restore type. Must be one of: ${validTypes.join(', ')}`);
    }

    if (options.restoreType === 'selective' && (!options.selectedItems || options.selectedItems.length === 0)) {
      throw new Error('Selected items are required for selective restore');
    }

    if (options.source.startsWith('s3://') && !options.s3Config) {
      throw new Error('S3 configuration is required for S3-based backups');
    }
  }

  /**
   * Load and validate manifest
   */
  async loadAndValidateManifest(manifestPath, s3Config) {
    let manifest;

    if (manifestPath.startsWith('s3://')) {
      // Download manifest from S3
      const tempManifestPath = path.join(this.tempDir, 'manifest.json');
      await fs.mkdir(this.tempDir, { recursive: true });
      await this.downloadFileFromS3(manifestPath, tempManifestPath, s3Config);
      manifest = await backupManifest.loadManifest(tempManifestPath);
    } else {
      manifest = await backupManifest.loadManifest(manifestPath);
    }

    // Validate manifest
    backupManifest.validateManifest(manifest);

    return manifest;
  }

  /**
   * Perform pre-restore validation
   */
  async performPreRestoreValidation(manifest, options) {
    const validation = {
      isValid: true,
      errors: [],
      warnings: []
    };

    try {
      // Check backup integrity
      if (manifest.verification && manifest.verification.total_checksum) {
        const calculatedChecksum = backupManifest.calculateManifestChecksum(manifest);
        if (calculatedChecksum !== manifest.verification.total_checksum) {
          validation.errors.push('Manifest checksum verification failed');
          validation.isValid = false;
        }
      }

      // Check backup age
      const backupAge = Date.now() - new Date(manifest.backup.timestamp).getTime();
      const ageInDays = backupAge / (1000 * 60 * 60 * 24);
      if (ageInDays > 30) {
        validation.warnings.push(`Backup is ${Math.round(ageInDays)} days old`);
      }

      // Check version compatibility
      const currentVersion = require('../../package.json').version;
      if (manifest.application.version !== currentVersion) {
        validation.warnings.push(
          `Version mismatch: backup from v${manifest.application.version}, current v${currentVersion}`
        );
      }

      // Check database compatibility
      if (options.restoreType === 'full' || options.restoreType === 'database') {
        const currentDbType = this.dbType;
        if (manifest.database.type !== currentDbType) {
          validation.errors.push(
            `Database type mismatch: backup is ${manifest.database.type}, current is ${currentDbType}`
          );
          validation.isValid = false;
        }
      }

      // Check if restoring would overwrite existing data.
      //
      // NOTE: pg-driver returns `count('* as count')` as a STRING (it
      // serialises `bigint` to string to avoid JS precision loss for
      // huge counts) — see PR #596 review for the `bigint`-as-string
      // discussion. Both blocks below coerce to `Number` before
      // comparing AND before interpolating into the warning text, so
      // the count renders as `5` not `"5"` regardless of DB driver.
      // Don't drop the `Number()` calls without also re-auditing the
      // strict-equality call sites flagged in the same review.
      if (options.restoreType === 'full' || options.restoreType === 'database') {
        const eventCount = await db('events').count('* as count').first();
        const eventCountN = Number(eventCount?.count || 0);
        if (eventCountN > 0) {
          validation.warnings.push(`Database contains ${eventCountN} existing events that will be overwritten`);
        }
      }

      // Check for active users (same coercion contract as above).
      const activeUsers = await db('admin_users')
        .where('is_active', formatBoolean(true))
        .count('* as count')
        .first();
      const activeUsersN = Number(activeUsers?.count || 0);
      if (activeUsersN > 0) {
        validation.warnings.push(`There are ${activeUsersN} active admin users`);
      }

    } catch (error) {
      validation.errors.push(`Validation error: ${error.message}`);
      validation.isValid = false;
    }

    return validation;
  }

  /**
   * Check available disk space
   */
  async checkDiskSpace(manifest, options) {
    try {
      const storagePath = process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');

      // Calculate required space (with 20% buffer)
      let requiredBytes = 0;
      if (options.restoreType === 'full' || options.restoreType === 'files') {
        requiredBytes = (manifest.files?.total_size || 0) * 1.2;
      }
      if (options.restoreType === 'full' || options.restoreType === 'database') {
        requiredBytes += (manifest.database?.size || 0) * 1.2;
      }

      // Try to get disk space using df command (works on Linux and macOS)
      let availableBytes = 0;
      let diskCheckSucceeded = false;
      try {
        // Use root path as fallback if storage path doesn't exist yet
        const checkPath = await fs.access(storagePath).then(() => storagePath).catch(() => '/');
        const { stdout } = await spawnAsync('df', ['-k', checkPath]);
        // Parse df output: last line, 4th column is available KB
        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        const columns = lastLine.trim().split(/\s+/);
        const parsed = parseInt(columns[3]);
        if (!isNaN(parsed) && parsed > 0) {
          availableBytes = parsed * 1024; // Convert from KB to bytes
          diskCheckSucceeded = true;
        }
      } catch (dfError) {
        this.log('warn', 'Could not determine available disk space', { error: dfError.message });
      }

      // If disk check failed, return optimistic result
      if (!diskCheckSucceeded) {
        return {
          hasEnoughSpace: true,
          availableBytes: null, // null indicates unknown
          requiredBytes,
          availableFormatted: 'Unknown',
          requiredFormatted: this.formatBytes(requiredBytes)
        };
      }

      // Add space for pre-restore backup
      if (!options.skipPreBackup) {
        try {
          const currentUsage = await this.calculateCurrentStorageUsage();
          requiredBytes += currentUsage * 1.1; // 10% buffer for backup
        } catch (e) {
          // Ignore errors calculating current usage
        }
      }

      return {
        hasEnoughSpace: availableBytes > requiredBytes,
        availableBytes,
        requiredBytes,
        availableFormatted: this.formatBytes(availableBytes),
        requiredFormatted: this.formatBytes(requiredBytes)
      };

    } catch (error) {
      // Fallback for any errors
      this.log('warn', 'Could not check disk space', { error: error.message });
      return {
        hasEnoughSpace: true, // Assume we have space if we can't check
        availableBytes: null,
        requiredBytes: 0,
        availableFormatted: 'Unknown',
        requiredFormatted: 'Unknown'
      };
    }
  }

  /**
   * Create pre-restore backup
   */
  async createPreRestoreBackup(options) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `pre-restore-${timestamp}`;
    const backupPath = path.join(this.tempDir, backupName);

    await fs.mkdir(backupPath, { recursive: true });

    try {
      // Backup database
      if (options.restoreType === 'full' || options.restoreType === 'database') {
        this.log('info', 'Backing up current database...');
        const dbBackupPath = path.join(backupPath, 'database.sql');
        
        if (this.dbType === 'sqlite') {
          const dbPath = knexConfig.connection.filename;
          await spawnAsync('sqlite3', [dbPath, `.backup '${dbBackupPath}'`]);
        } else {
          // PostgreSQL backup
          const { host, port, user, password, database } = knexConfig.connection;
          const env = { ...process.env, PGPASSWORD: password };
          await spawnToFile('pg_dump', ['-h', host, '-p', String(port), '-U', user, '-d', database], dbBackupPath, { env });
        }

        // Compress database backup
        await this.compressFile(dbBackupPath, `${dbBackupPath}.gz`);
        await fs.unlink(dbBackupPath);
      }

      // Backup files
      if (options.restoreType === 'full' || options.restoreType === 'files') {
        this.log('info', 'Backing up current files...');
        const storagePath = process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');
        const filesBackupPath = path.join(backupPath, 'files.tar.gz');

        await spawnAsync('tar', ['-czf', filesBackupPath, '-C', path.dirname(storagePath), path.basename(storagePath)]);
      }

      // Create backup manifest
      const backupManifest = {
        timestamp: new Date().toISOString(),
        type: 'pre-restore-safety-backup',
        restoreOptions: this.sanitizeOptions(options),
        contents: await fs.readdir(backupPath)
      };

      await fs.writeFile(
        path.join(backupPath, 'backup-manifest.json'),
        JSON.stringify(backupManifest, null, 2)
      );

      return backupPath;

    } catch (error) {
      // Clean up on failure
      await fs.rmdir(backupPath, { recursive: true }).catch(() => {});
      throw new Error(`Failed to create pre-restore backup: ${error.message}`);
    }
  }

  /**
   * Download backup from S3
   */
  async downloadFromS3(s3Url, manifest, options) {
    const s3PathMatch = s3Url.match(/^s3:\/\/([^\/]+)\/(.+)$/);
    if (!s3PathMatch) {
      throw new Error('Invalid S3 URL format');
    }

    const [, bucket, prefix] = s3PathMatch;
    const s3Client = new S3StorageAdapter({
      ...options.s3Config,
      bucket
    });

    const localPath = path.join(this.tempDir, 'restore-download');
    await fs.mkdir(localPath, { recursive: true });

    try {
      // Test S3 connection
      await s3Client.testConnection();

      // Download database backup if needed
      if (options.restoreType === 'full' || options.restoreType === 'database') {
        if (manifest.database.backup_file) {
          const dbS3Key = path.posix.join(prefix, 'database', path.basename(manifest.database.backup_file));
          const localDbPath = path.join(localPath, 'database', path.basename(manifest.database.backup_file));
          
          await fs.mkdir(path.dirname(localDbPath), { recursive: true });
          
          this.log('info', 'Downloading database backup from S3...', { key: dbS3Key });
          await s3Client.download(dbS3Key, localDbPath, {
            onProgress: (loaded, total) => {
              const percent = Math.round((loaded / total) * 100);
              this.updateProgress(`Downloading database backup: ${percent}%`);
            }
          });
        }
      }

      // Download files if needed
      if (options.restoreType === 'full' || options.restoreType === 'files') {
        const filesToDownload = options.restoreType === 'selective' 
          ? options.selectedItems 
          : manifest.files.manifest;

        let downloaded = 0;
        for (const file of filesToDownload) {
          const s3Key = path.posix.join(prefix, file.path);
          const localFilePath = path.join(localPath, file.path);
          
          await fs.mkdir(path.dirname(localFilePath), { recursive: true });
          
          try {
            await s3Client.download(s3Key, localFilePath, {
              onProgress: (loaded, total) => {
                const filePercent = Math.round((loaded / total) * 100);
                const totalPercent = Math.round(((downloaded + (loaded / total)) / filesToDownload.length) * 100);
                this.updateProgress(`Downloading files: ${totalPercent}% (${file.path}: ${filePercent}%)`);
              }
            });
            
            // Verify checksum if available
            if (file.checksum) {
              const downloadedChecksum = await this.calculateChecksum(localFilePath);
              if (downloadedChecksum !== file.checksum) {
                throw new Error(`Checksum mismatch for ${file.path}`);
              }
            }
            
            downloaded++;
          } catch (error) {
            this.log('error', `Failed to download ${file.path}`, { error: error.message });
            throw error;
          }
        }
      }

      return localPath;

    } catch (error) {
      // Clean up on failure
      await fs.rmdir(localPath, { recursive: true }).catch(() => {});
      throw new Error(`Failed to download from S3: ${error.message}`);
    }
  }

  /**
   * Perform full restore (database + files)
   */
  async performFullRestore(backupPath, manifest, options) {
    const result = {
      databaseRestored: false,
      filesRestored: 0,
      errors: []
    };

    try {
      // Restore database first
      const dbResult = await this.performDatabaseRestore(backupPath, manifest, options);
      result.databaseRestored = dbResult.success;

      // Then restore files
      const filesResult = await this.performFilesRestore(backupPath, manifest, options);
      result.filesRestored = filesResult.filesRestored;

      return result;

    } catch (error) {
      result.errors.push(error.message);
      throw new Error(`Full restore failed: ${error.message}`);
    }
  }

  /**
   * Perform database-only restore
   */
  async performDatabaseRestore(backupPath, manifest, options) {
    this.updateProgress('Restoring database...');

    const dbBackupFile = manifest.database.backup_file;
    if (!dbBackupFile) {
      throw new Error('No database backup file found in manifest');
    }

    // Layered resolution for the database dump path:
    //
    //   1. Manifest stores the absolute path the dumper wrote to
    //      (e.g. `/backup/database/picpeak-db-postgresql-<ts>.sql.gz`).
    //      That's the truth — try it first.
    //   2. Some older manifests store a path RELATIVE to the file-backup
    //      destination root (`database/<file>.sql.gz`). Reconstruct that
    //      way as a fallback.
    //   3. Final fallback: `<backupPath>/database/<basename>`, the
    //      historical reconstruction used before this fix. Preserved so
    //      no existing valid path breaks.
    //
    // The original code used (3) exclusively, which meant the restore
    // service ignored the absolute path the manifest recorded and
    // looked under a synthetic `<backupPath>/database/<file>` root —
    // which on Ralf's install became `local/database/<file>` because
    // `backupPath` was the source type string, not a directory. Caused
    // the canonical disaster-recovery flow to fail with
    // `Database backup file not found: local/database/...sql.gz`
    // even though the file existed at exactly the path the manifest
    // recorded.
    const candidates = [
      // (1) Honour absolute paths recorded by the dumper.
      path.isAbsolute(dbBackupFile) ? dbBackupFile : null,
      // (2) Relative-to-backupPath as-stored (no basename munging).
      path.join(backupPath, dbBackupFile),
      // (3) Legacy reconstruct.
      path.join(backupPath, 'database', path.basename(dbBackupFile)),
    ].filter(Boolean);

    let dbBackupPath = null;
    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        dbBackupPath = candidate;
        break;
      } catch (_) {
        // try next candidate
      }
    }

    if (!dbBackupPath) {
      throw new Error(
        `Database backup file not found. Tried: ${candidates.join(', ')}. ` +
        `Manifest recorded path: ${dbBackupFile}. ` +
        'Hint: this usually means the manifest\'s database.backup_file path no longer ' +
        'exists on disk (deleted? moved? volume not mounted?). Check ' +
        '~/<your-compose-dir>/backup/database/ on the host.'
      );
    }

    // Decompress if needed
    let restoreFile = dbBackupPath;
    if (dbBackupPath.endsWith('.gz')) {
      this.log('info', 'Decompressing database backup...');
      const decompressedPath = dbBackupPath.replace('.gz', '');
      await this.decompressFile(dbBackupPath, decompressedPath);
      restoreFile = decompressedPath;
    }

    // Snapshot of operator-meta keys captured BEFORE the DROP.
    // Stashed onto `this.preservedMetaSnapshot` so the parent
    // `restore()` method can drain + apply it AFTER post-restore
    // verification passes. Order matters here:
    //
    //   - PR #596 round 1: lifted the declaration above the
    //     SQLite/PG split to fix a ReferenceError when the replay
    //     was inline at the bottom of this method.
    //   - PR #596 round 3: moved the REPLAY itself out of here and
    //     into restore(), because the round-1 in-method replay ran
    //     BEFORE post-restore verification — which then counted the
    //     replayed row and flagged
    //       Table app_settings row count mismatch: expected 190, got 191
    //     as a verification failure even though both Stage A and
    //     the replay had succeeded. Verification now sees the
    //     as-restored DB (matches the backup exactly), replay layers
    //     on top after verification has signed off.
    //
    // SQLite branch leaves `preservedMetaSnapshot` empty — verification
    // and replay both no-op for it, unchanged behaviour.
    const PRESERVED_META_KEYS = [
      'restore_allow_force',
      'restore_allow_force_auto_upgraded',
    ];

    try {
      if (this.dbType === 'sqlite') {
        // SQLite restore
        const dbPath = knexConfig.connection.filename;
        
        // Close all database connections
        await db.destroy();
        
        // Backup current database
        const currentBackup = `${dbPath}.restore-backup`;
        await fs.copyFile(dbPath, currentBackup);
        
        try {
          // Restore from backup
          await spawnAsync('sqlite3', [dbPath, `.restore '${restoreFile}'`]);

          // Verify integrity
          const integrityCheck = await spawnAsync('sqlite3', [dbPath, 'PRAGMA integrity_check']);
          if (!integrityCheck.stdout.includes('ok')) {
            throw new Error('Database integrity check failed after restore');
          }
          
          // Remove backup of previous database
          await fs.unlink(currentBackup);
          
        } catch (error) {
          // Rollback on failure
          await fs.copyFile(currentBackup, dbPath);
          await fs.unlink(currentBackup);
          throw error;
        }
        
      } else {
        // PostgreSQL restore
        const { host, port, user, password, database } = knexConfig.connection;
        const env = { ...process.env, PGPASSWORD: password };

        // Snapshot operator-meta settings BEFORE the DROP so we can
        // restore them after the psql load. These keys are about how
        // the operator wants the install to behave (force-restore
        // permission, auto-upgrade tracking), not user-facing state —
        // they should NOT be overwritten by whatever values the backup
        // happens to contain.
        //
        // Chicken-and-egg this closes: `restore_allow_force` defaults
        // to true (post tonight's migration 032 edit), but every
        // restore would overwrite it with whatever the backup carried.
        // Admin sets it to true → restores → wakes up with the row
        // back to whatever was in the backup. Two consecutive restores
        // needed the SQL workaround again. With this snapshot/replay,
        // the operator's policy persists across restores.
        //
        // PRESERVED_META_KEYS is declared above the SQLite/PG split
        // (~L820). The snapshot READ happens here in the PG branch
        // (must run before DROP), but is stashed on
        // `this.preservedMetaSnapshot` for the parent `restore()`
        // method to consume AFTER verification — see the round-3
        // notes there.
        try {
          this.preservedMetaSnapshot = await db('app_settings')
            .whereIn('setting_key', PRESERVED_META_KEYS)
            .select('setting_key', 'setting_value', 'setting_type');
          this.log('info', `Snapshotted ${this.preservedMetaSnapshot.length} restore-meta setting(s) for post-restore replay`, {
            keys: this.preservedMetaSnapshot.map(r => r.setting_key),
          });
        } catch (err) {
          this.log('warn', `Could not snapshot restore-meta settings (continuing): ${err.message}`);
        }

        // `psql` with no `-d` defaults to a database whose name matches
        // the connecting user, NOT a maintenance DB. So on installs
        // where the user's home DB doesn't exist (e.g. user=`picpeak`,
        // target DB=`picpeak_prod`, no `picpeak` DB), the next two
        // statements failed with:
        //   FATAL: database "picpeak" does not exist
        // even though the actual target DB was alive and connectable.
        //
        // Fix: explicitly connect to `postgres` (the maintenance DB
        // every PG cluster ships with) for the DROP/CREATE. We can't
        // connect to the target DB itself anyway — DROP DATABASE
        // refuses to run while a connection is open to it.
        //
        // Use `DB_CHECK_DB` env var as an override hook (matches the
        // pattern wait-for-db.sh already exposes) for installs where
        // the `postgres` DB is restricted to superusers.
        const maintenanceDb = process.env.DB_CHECK_DB || 'postgres';

        // The backend's own knex pool holds N active connections to
        // the target database (default 5-25 per knexfile.js). PostgreSQL
        // refuses DROP DATABASE while any session is connected:
        //   ERROR: database "X" is being accessed by other users
        //   DETAIL: There are N other sessions using the database.
        // We have to evict those sessions ourselves before issuing the
        // DROP. Two-step approach:
        //   1. Close knex's own pool so we don't fight ourselves.
        //   2. pg_terminate_backend() the rest (other server replicas,
        //      pg_stat_activity stragglers, leftover idle txns).
        //
        // After CREATE DATABASE, knex will lazily re-open the pool on
        // the next query — handled by db.js's connection retry logic.
        this.log('warn', 'Closing knex pool before dropping target database...');
        try { await db.destroy(); } catch (poolErr) {
          this.log('warn', `Pool destroy threw (continuing): ${poolErr.message}`);
        }

        this.log('warn', 'Terminating any remaining sessions on target database...', {
          target: database,
        });
        // pg_terminate_backend takes a pid. Kill every session against
        // the target DB except our own connection (which is to the
        // maintenance DB anyway). Wrapped in `SELECT ... FROM ... WHERE`
        // so we get one psql round-trip instead of N.
        await spawnAsync('psql', [
          '-h', host, '-p', String(port), '-U', user, '-d', maintenanceDb,
          '-c',
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity ' +
          `WHERE datname = '${database.replace(/'/g, '\'\'')}' AND pid <> pg_backend_pid()`,
        ], { env });

        // Drop and recreate database (extremely dangerous!)
        this.log('warn', 'Dropping and recreating PostgreSQL database...', {
          target: database, via: maintenanceDb,
        });

        // WITH (FORCE) on Postgres 13+ kills any remaining connections
        // atomically with the DROP. On older Postgres the FORCE option
        // doesn't exist, so we fall back to plain DROP IF EXISTS — by
        // which point pg_terminate_backend should have cleared the
        // table. Try FORCE first, fall back to plain on syntax error.
        try {
          await spawnAsync('psql', ['-h', host, '-p', String(port), '-U', user, '-d', maintenanceDb,
            '-c', `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`], { env });
        } catch (forceErr) {
          // PG < 13: WITH (FORCE) is a syntax error. Plain DROP after
          // our pg_terminate_backend pass should now succeed.
          this.log('info', 'DROP DATABASE WITH (FORCE) not supported — falling back to plain DROP', {
            error: forceErr.message,
          });
          await spawnAsync('psql', ['-h', host, '-p', String(port), '-U', user, '-d', maintenanceDb,
            '-c', `DROP DATABASE IF EXISTS "${database}"`], { env });
        }

        await spawnAsync('psql', ['-h', host, '-p', String(port), '-U', user, '-d', maintenanceDb, '-c', `CREATE DATABASE "${database}"`], { env });

        // Restore from backup — this one DOES connect to the target DB.
        await spawnFromFile('psql', ['-h', host, '-p', String(port), '-U', user, '-d', database], restoreFile, { env });

        // Re-sync every SERIAL / IDENTITY sequence in the public schema
        // to MAX(id)+1 of its owning table. pg_dump emits setval()
        // statements, but they don't always land cleanly when:
        //   - the dump has `--clean` (the setval may execute before
        //     the rebuilt rows, depending on dump ordering)
        //   - the in-process knex pool had a cached sequence value
        //     before db.destroy() (already mitigated, but defensive)
        //   - rows were inserted mid-restore (the pre-restore safety
        //     backup creates a database_backup_runs row before DROP)
        // Result if skipped: every subsequent INSERT into a serial-id
        // table fails with `duplicate key value violates unique
        // constraint "<table>_pkey"`. Surfaced on Ralf's install as
        // "A record with this value already exists" on every CRUD
        // action AND `database_backup_runs_pkey` violation on the
        // next Run Backup Now. Fix is a single DO block that walks
        // pg_class + pg_attribute and setval()s each sequence to
        // GREATEST(MAX(<col>), 1). Cheap (a few ms even on large
        // schemas), safe (doesn't touch row data), idempotent.
        this.log('info', 'Re-syncing PostgreSQL sequences to MAX(id) of each table...');
        await spawnAsync('psql', [
          '-h', host, '-p', String(port), '-U', user, '-d', database,
          '-c',
          `DO $$
DECLARE
  r RECORD;
  max_id BIGINT;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema_name, t.relname AS table_name, a.attname AS column_name,
           pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(t.relname), a.attname) AS seq_name
    FROM pg_class t
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = t.oid
    WHERE n.nspname = 'public'
      AND t.relkind = 'r'
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(t.relname), a.attname) IS NOT NULL
  LOOP
    EXECUTE format('SELECT COALESCE(MAX(%I), 0) FROM %I.%I', r.column_name, r.schema_name, r.table_name) INTO max_id;
    EXECUTE format('SELECT setval(%L, %s, true)', r.seq_name, GREATEST(max_id, 1));
  END LOOP;
END $$;`
        ], { env });
        this.log('info', 'Sequence resync completed');
      }

      // Re-initialize the in-process knex pool. The DROP/CREATE
      // DATABASE pair above destroyed our connections and the recreated
      // database has a different pg_database OID — any pooled
      // connection from before would either be dead or pointed at a
      // ghost. Without explicit reinit, every query in the process
      // after restore returns `Error: Unable to acquire a connection`
      // until the container is manually restarted (and admin sees
      // "An error occurred" on the login screen even after the restore
      // technically succeeded). reinitPool destroys + rebuilds the
      // pool and probes the new one with `SELECT 1` so failures here
      // surface immediately instead of polluting the next request.
      const { reinitPool } = require('../database/db');
      this.log('info', 'Re-initializing knex pool against the restored database...');
      await reinitPool();
      this.log('info', 'Knex pool re-initialized');

      // NOTE: we deliberately do NOT call `db.migrate.latest()` here.
      //
      // The picpeak migrations directory contains `helpers.js` (a
      // shared helper module, not a migration), plus `core/` and
      // `legacy/` subdirectories. Knex's built-in migrator scans the
      // top-level directory and rejects any file without `up`/`down`
      // exports — so `db.migrate.latest()` throws
      //   Invalid migration: helpers.js must have both an up and down function
      // every time it runs in this codebase. The production code path
      // uses `npm run migrate:safe` (run-migrations-safe.js) which
      // knows to skip helpers.js + walks core/ explicitly.
      //
      // The safe runner gets invoked AFTER verification in restore()
      // (see step 7c) to apply any post-backup migrations to the
      // restored DB. This closes the contract "backup must restore
      // completely even when new features have been added in the
      // meantime" — without this step, restoring an old backup on a
      // newer image would leave the running process serving a
      // mismatched schema until the next container restart.
      this.log('info', 'Schema migrations deferred to restore() step 7c (npm run migrate:safe subprocess)');

      // NOTE: operator-meta REPLAY does NOT happen here any more.
      // PR #596 round 3: if the replay runs inside performDatabaseRestore,
      // it lands BEFORE post-restore verification — and verification
      // then counts the replayed row as a mismatch (e.g. "expected 190,
      // got 191" because the fresh-install seeded
      // `restore_allow_force_auto_upgraded` that wasn't in the backup).
      // Replay is now drained by the parent `restore()` method AFTER
      // verification passes. Snapshot lives on
      // `this.preservedMetaSnapshot` for that drain.

      return { success: true };

    } catch (error) {
      this.log('error', 'Database restore failed', { error: error.message });
      throw error;
    } finally {
      // Clean up decompressed file
      if (restoreFile !== dbBackupPath) {
        await fs.unlink(restoreFile).catch(() => {});
      }
    }
  }

  /**
   * Perform files-only restore
   */
  async performFilesRestore(backupPath, manifest, options) {
    this.updateProgress('Restoring files...');

    const storagePath = process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');
    const filesToRestore = options.restoreType === 'selective' 
      ? options.selectedItems.filter(item => item.type === 'file')
      : manifest.files.manifest;

    let restoredCount = 0;
    const errors = [];

    for (const file of filesToRestore) {
      try {
        const sourcePath = path.join(backupPath, file.path);
        const targetPath = path.join(storagePath, file.path);

        // Check if source file exists
        try {
          await fs.access(sourcePath);
        } catch (error) {
          errors.push(`Source file not found: ${file.path}`);
          continue;
        }

        // Create target directory
        await fs.mkdir(path.dirname(targetPath), { recursive: true });

        // Check if target exists and create backup
        let targetBackup = null;
        try {
          await fs.access(targetPath);
          targetBackup = `${targetPath}.restore-backup`;
          await fs.copyFile(targetPath, targetBackup);
        } catch (error) {
          // Target doesn't exist, no backup needed
        }

        try {
          // Copy file
          await fs.copyFile(sourcePath, targetPath);

          // Verify checksum if available
          if (file.checksum) {
            const restoredChecksum = await this.calculateChecksum(targetPath);
            if (restoredChecksum !== file.checksum) {
              throw new Error('Checksum verification failed');
            }
          }

          // Set file permissions if available
          if (file.permissions) {
            await fs.chmod(targetPath, file.permissions);
          }

          // Set modification time
          if (file.modified) {
            const mtime = new Date(file.modified);
            await fs.utimes(targetPath, mtime, mtime);
          }

          // Remove backup of previous file
          if (targetBackup) {
            await fs.unlink(targetBackup);
          }

          restoredCount++;
          
          if (restoredCount % 100 === 0) {
            this.updateProgress(`Restored ${restoredCount}/${filesToRestore.length} files`);
          }

        } catch (error) {
          // Rollback on failure
          if (targetBackup) {
            await fs.copyFile(targetBackup, targetPath);
            await fs.unlink(targetBackup);
          }
          throw error;
        }

      } catch (error) {
        errors.push(`Failed to restore ${file.path}: ${error.message}`);
        this.log('error', `Failed to restore file ${file.path}`, { error: error.message });
      }
    }

    if (errors.length > 0 && errors.length === filesToRestore.length) {
      throw new Error('All file restorations failed');
    }

    return {
      filesRestored: restoredCount,
      totalFiles: filesToRestore.length,
      errors
    };
  }

  /**
   * Perform selective restore
   */
  async performSelectiveRestore(backupPath, manifest, options) {
    const result = {
      itemsRestored: 0,
      errors: []
    };

    // Separate selected items by type
    const databaseItems = options.selectedItems.filter(item => item.type === 'database');
    const fileItems = options.selectedItems.filter(item => item.type === 'file');

    // Restore database items (tables)
    if (databaseItems.length > 0) {
      this.log('warn', 'Selective database restore not implemented yet');
      result.errors.push('Selective database restore not implemented');
    }

    // Restore file items
    if (fileItems.length > 0) {
      const filesResult = await this.performFilesRestore(backupPath, manifest, {
        ...options,
        selectedItems: fileItems
      });
      result.itemsRestored += filesResult.filesRestored;
      result.errors.push(...filesResult.errors);
    }

    return result;
  }

  /**
   * Perform post-restore verification
   */
  async performPostRestoreVerification(manifest, options) {
    const verification = {
      isValid: true,
      errors: [],
      checksums: {}
    };

    try {
      // Verify database
      if (options.restoreType === 'full' || options.restoreType === 'database') {
        // Check database connectivity
        try {
          await db.raw('SELECT 1');
        } catch (error) {
          verification.errors.push('Database connection failed after restore');
          verification.isValid = false;
        }

        // Compare table checksums if available
        if (manifest.database.row_counts) {
          for (const [table, expected] of Object.entries(manifest.database.row_counts)) {
            try {
              const result = await db(table).count('* as count').first();
              // pg-driver serialises `bigint` as string to preserve
              // precision for huge counts, so `result.count` on PG is
              // e.g. `"16"` while the manifest's `expected.rowCount`
              // is the JS number `16`. Strict `!==` flagged every
              // match as a mismatch on PG. Caught on PR #596 review:
              //   `Table activity_logs row count mismatch:
              //    expected 16, got 16`
              // every table, all "matching". Coerce both sides to
              // Number to compare reliably across SQLite (number) and
              // PG (string).
              const actual = Number(result.count);
              if (actual !== expected.rowCount) {
                verification.errors.push(
                  `Table ${table} row count mismatch: expected ${expected.rowCount}, got ${actual}`
                );
              }
            } catch (error) {
              verification.errors.push(`Failed to verify table ${table}: ${error.message}`);
            }
          }
        }
      }

      // Verify files
      if (options.restoreType === 'full' || options.restoreType === 'files') {
        const storagePath = process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');
        const filesToVerify = options.restoreType === 'selective' 
          ? options.selectedItems.filter(item => item.type === 'file')
          : manifest.files.manifest.slice(0, 100); // Verify first 100 files for performance

        for (const file of filesToVerify) {
          const filePath = path.join(storagePath, file.path);
          try {
            await fs.access(filePath);
            
            if (file.checksum) {
              const actualChecksum = await this.calculateChecksum(filePath);
              verification.checksums[file.path] = {
                expected: file.checksum,
                actual: actualChecksum,
                match: actualChecksum === file.checksum
              };
              
              if (actualChecksum !== file.checksum) {
                verification.errors.push(`Checksum mismatch for ${file.path}`);
              }
            }
          } catch (error) {
            verification.errors.push(`File not found after restore: ${file.path}`);
          }
        }
      }

    } catch (error) {
      verification.errors.push(`Verification error: ${error.message}`);
      verification.isValid = false;
    }

    verification.isValid = verification.errors.length === 0;
    return verification;
  }

  /**
   * Attempt rollback using pre-restore backup
   */
  async attemptRollback(preRestoreBackupPath) {
    this.log('warn', 'Attempting rollback to pre-restore state...');

    try {
      // Read backup manifest
      const manifestPath = path.join(preRestoreBackupPath, 'backup-manifest.json');
      const backupManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

      // Restore database if backed up
      const dbBackupPath = path.join(preRestoreBackupPath, 'database.sql.gz');
      if (await fs.access(dbBackupPath).then(() => true).catch(() => false)) {
        const decompressedPath = dbBackupPath.replace('.gz', '');
        await this.decompressFile(dbBackupPath, decompressedPath);

        if (this.dbType === 'sqlite') {
          const dbPath = knexConfig.connection.filename;
          await spawnAsync('sqlite3', [dbPath, `.restore '${decompressedPath}'`]);
        } else {
          const { host, port, user, password, database } = knexConfig.connection;
          const env = { ...process.env, PGPASSWORD: password };
          await spawnFromFile('psql', ['-h', host, '-p', String(port), '-U', user, '-d', database], decompressedPath, { env });
        }

        await fs.unlink(decompressedPath);
      }

      // Restore files if backed up
      const filesBackupPath = path.join(preRestoreBackupPath, 'files.tar.gz');
      if (await fs.access(filesBackupPath).then(() => true).catch(() => false)) {
        const storagePath = process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');
        await spawnAsync('tar', ['-xzf', filesBackupPath, '-C', path.dirname(storagePath)]);
      }

      this.log('info', 'Rollback completed successfully');

    } catch (error) {
      this.log('error', 'Rollback failed', { error: error.message });
      throw new Error(`Rollback failed: ${error.message}. Manual intervention may be required.`);
    }
  }

  // Utility methods

  /**
   * Calculate file checksum
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
   * Compress file using gzip
   */
  async compressFile(inputPath, outputPath) {
    const gzip = zlib.createGzip({ level: 6 });
    const source = createReadStream(inputPath);
    const destination = createWriteStream(outputPath);
    await pipeline(source, gzip, destination);
  }

  /**
   * Decompress gzip file
   */
  async decompressFile(inputPath, outputPath) {
    const gunzip = zlib.createGunzip();
    const source = createReadStream(inputPath);
    const destination = createWriteStream(outputPath);
    await pipeline(source, gunzip, destination);
  }

  /**
   * Download file from S3
   */
  async downloadFileFromS3(s3Url, localPath, s3Config) {
    const s3PathMatch = s3Url.match(/^s3:\/\/([^\/]+)\/(.+)$/);
    if (!s3PathMatch) {
      throw new Error('Invalid S3 URL format');
    }

    const [, bucket, key] = s3PathMatch;
    const s3Client = new S3StorageAdapter({
      ...s3Config,
      bucket
    });

    await s3Client.download(key, localPath);
  }

  /**
   * Calculate current storage usage
   */
  async calculateCurrentStorageUsage() {
    const storagePath = process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');
    
    let totalSize = 0;
    async function calculateDirSize(dirPath) {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          await calculateDirSize(fullPath);
        } else if (entry.isFile()) {
          const stats = await fs.stat(fullPath);
          totalSize += stats.size;
        }
      }
    }

    await calculateDirSize(storagePath);
    return totalSize;
  }

  /**
   * Format bytes to human readable
   */
  formatBytes(bytes, decimals = 2) {
    return formatBytes(bytes, decimals);
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
    logger.info(`Restore progress: ${message}`, details);
  }

  /**
   * Get current progress
   */
  getProgress() {
    return this.currentProgress;
  }

  /**
   * Log message
   */
  log(level, message, details = {}) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      details
    };
    
    this.restoreLog.push(logEntry);
    logger[level](message, details);
  }

  /**
   * Sanitize options for logging
   */
  sanitizeOptions(options) {
    const sanitized = { ...options };
    if (sanitized.s3Config) {
      sanitized.s3Config = {
        ...sanitized.s3Config,
        accessKeyId: sanitized.s3Config.accessKeyId ? '***' : undefined,
        secretAccessKey: sanitized.s3Config.secretAccessKey ? '***' : undefined
      };
    }
    return sanitized;
  }

  /**
   * Send restore notification
   */
  async sendRestoreNotification(type, details) {
    try {
      const admins = await db('admin_users').where('is_active', formatBoolean(true));
      
      for (const admin of admins) {
        if (type === 'success') {
          await queueEmail(null, admin.email, 'restore_completed', {
            restore_type: details.restoreType,
            duration: `${details.duration} seconds`,
            files_restored: details.filesRestored,
            backup_id: details.backupId,
            timestamp: new Date().toISOString()
          });
        } else {
          await queueEmail(null, admin.email, 'restore_failed', {
            restore_type: details.restoreType,
            error_message: details.error,
            timestamp: new Date().toISOString()
          });
        }
      }
    } catch (error) {
      this.log('error', 'Failed to send restore notification', { error: error.message });
    }
  }

  /**
   * Get restore history
   */
  async getRestoreHistory(limit = 10) {
    return await db('restore_runs')
      .orderBy('started_at', 'desc')
      .limit(limit);
  }

  /**
   * Generate restore report
   */
  generateRestoreReport(restoreResult) {
    const report = [];
    
    report.push('=== RESTORE OPERATION REPORT ===');
    report.push(`Status: ${restoreResult.success ? 'SUCCESS' : 'FAILED'}`);
    report.push(`Duration: ${restoreResult.duration}s`);
    report.push(`Dry Run: ${restoreResult.dryRun ? 'Yes' : 'No'}`);
    
    if (restoreResult.result) {
      report.push('\n--- Restore Results ---');
      report.push(`Database Restored: ${restoreResult.result.databaseRestored ? 'Yes' : 'No'}`);
      report.push(`Files Restored: ${restoreResult.result.filesRestored || 0}`);
      if (restoreResult.result.errors && restoreResult.result.errors.length > 0) {
        report.push(`Errors: ${restoreResult.result.errors.length}`);
        restoreResult.result.errors.forEach(err => report.push(`  - ${err}`));
      }
    }
    
    if (restoreResult.verification) {
      report.push('\n--- Verification Results ---');
      report.push(`Valid: ${restoreResult.verification.isValid ? 'Yes' : 'No'}`);
      if (restoreResult.verification.errors.length > 0) {
        report.push('Errors:');
        restoreResult.verification.errors.forEach(err => report.push(`  - ${err}`));
      }
    }
    
    if (restoreResult.preRestoreBackup) {
      report.push('\n--- Safety Backup ---');
      report.push(`Location: ${restoreResult.preRestoreBackup}`);
    }
    
    report.push('\n--- Operation Log ---');
    restoreResult.logs.forEach(log => {
      report.push(`[${log.timestamp}] ${log.level.toUpperCase()}: ${log.message}`);
    });
    
    return report.join('\n');
  }
}

// Create singleton instance
const restoreService = new RestoreService();

module.exports = {
  restoreService,
  RestoreService // Export class for testing
};