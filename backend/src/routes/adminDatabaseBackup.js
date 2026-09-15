const express = require('express');
const path = require('path');
const router = express.Router();
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const {
  databaseBackupService,
  isUnderPubliclyServableRoot,
  resolveDatabaseBackupDestination,
} = require('../services/databaseBackup');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const { getPagination } = require('../utils/routeHelpers');

// All routes require admin authentication
router.use(adminAuth);

/**
 * Get database backup status and configuration
 */
router.get('/status', requirePermission('backup.view'), async (req, res) => {
  try {
    // Get configuration
    const config = await databaseBackupService.getBackupConfig();
    
    // Get recent backup history
    const history = await databaseBackupService.getBackupHistory(10);
    
    // Get current progress if running
    const progress = databaseBackupService.getProgress();
    
    // Calculate health status
    const lastBackup = history[0];
    const isHealthy = lastBackup && lastBackup.status === 'completed' && 
      new Date(lastBackup.completed_at) > new Date(Date.now() - 48 * 60 * 60 * 1000); // Within 48 hours
    
    res.json({
      config,
      isRunning: databaseBackupService.isRunning,
      isHealthy,
      currentProgress: progress,
      lastBackup,
      recentBackups: history,
      dbType: databaseBackupService.dbType
    });
  } catch (error) {
    logger.error('Failed to get database backup status:', error);
    res.status(500).json({ error: 'Failed to get backup status' });
  }
});

/**
 * Update database backup configuration
 */
router.put('/config', requirePermission('backup.create'), async (req, res) => {
  try {
    const allowedSettings = [
      'database_backup_enabled',
      'database_backup_schedule',
      'database_backup_destination_path',
      'database_backup_compress',
      'database_backup_validate_integrity',
      'database_backup_include_checksums',
      'database_backup_retention_days',
      'database_backup_email_on_failure',
      'database_backup_email_on_success'
    ];

    // A backup.create holder (the built-in `admin` role has it without
    // settings.edit or backup.restore) could otherwise point backups at a
    // public static mount and fetch the dump unauthenticated — see
    // isUnderPubliclyServableRoot's comment (GHSA-jw8m-43r2-jqrm class).
    if (
      typeof req.body.database_backup_destination_path === 'string'
      && isUnderPubliclyServableRoot(req.body.database_backup_destination_path)
    ) {
      return res.status(400).json({ error: 'Destination path must not be inside a publicly served directory' });
    }

    // A retention of 0 or less pushes cleanupOldBackups' cutoff to today or
    // the future, deleting every completed backup on the next scheduled run
    // — a backup.create holder achieving what backup.delete gates on /cleanup.
    if (
      req.body.database_backup_retention_days !== undefined
      && (!Number.isFinite(req.body.database_backup_retention_days) || req.body.database_backup_retention_days < 1)
    ) {
      return res.status(400).json({ error: 'database_backup_retention_days must be a positive number' });
    }

    const updates = [];
    
    for (const [key, value] of Object.entries(req.body)) {
      if (allowedSettings.includes(key)) {
        // Check if setting exists
        const existing = await db('app_settings')
          .where('setting_key', key)
          .first();
        
        if (existing) {
          await db('app_settings')
            .where('setting_key', key)
            .update({
              setting_value: JSON.stringify(value),
              updated_at: new Date()
            });
        } else {
          await db('app_settings').insert({
            setting_key: key,
            setting_value: JSON.stringify(value),
            setting_type: 'database_backup'
          });
        }
        
        updates.push(key);
      }
    }
    
    // Restart scheduled backups if enabled state changed
    if (updates.includes('database_backup_enabled') || updates.includes('database_backup_schedule')) {
      const { startScheduledBackups, stopScheduledBackups } = require('../services/databaseBackup');
      stopScheduledBackups();
      await startScheduledBackups();
    }
    
    res.json({ 
      success: true, 
      updatedSettings: updates,
      message: 'Database backup configuration updated successfully'
    });
  } catch (error) {
    logger.error('Failed to update database backup config:', error);
    res.status(500).json({ error: 'Failed to update configuration' });
  }
});

/**
 * Trigger manual database backup
 */
router.post('/backup', requirePermission('backup.create'), async (req, res) => {
  try {
    if (databaseBackupService.isRunning) {
      return res.status(409).json({ error: 'Backup already in progress' });
    }
    
    // Start backup asynchronously
    res.json({ 
      success: true, 
      message: 'Database backup started',
      trackingUrl: '/api/admin/database-backup/progress'
    });
    
    // Forward ONLY the real backup knobs (GHSA-jw8m). Passing req.body
    // straight through let the caller set `destinationPath`, which the
    // service merges over its config — so a backup.create holder (the
    // `admin` role, which has neither settings.edit nor backup.restore)
    // could dump the whole database into the PUBLIC /uploads static mount
    // and fetch it unauthenticated, hashes and encrypted SMTP creds included.
    // destinationPath is not a persistable setting; the request body was its
    // only source, so dropping it here costs no legitimate behaviour.
    const body = req.body || {};
    const options = {};
    for (const key of ['compress', 'validateIntegrity', 'includeChecksums']) {
      if (body[key] !== undefined) options[key] = body[key];
    }
    databaseBackupService.backup(options).catch(error => {
      logger.error('Manual database backup failed:', error);
    });
  } catch (error) {
    logger.error('Failed to start database backup:', error);
    res.status(500).json({ error: 'Failed to start backup' });
  }
});

/**
 * Get current backup progress
 */
router.get('/progress', requirePermission('backup.view'), async (req, res) => {
  try {
    const progress = databaseBackupService.getProgress();
    
    res.json({
      isRunning: databaseBackupService.isRunning,
      progress
    });
  } catch (error) {
    logger.error('Failed to get backup progress:', error);
    res.status(500).json({ error: 'Failed to get progress' });
  }
});

/**
 * Get backup history with pagination
 */
router.get('/history', requirePermission('backup.view'), async (req, res) => {
  try {
    const { page, limit, offset } = getPagination(req);

    const [backups, totalCount] = await Promise.all([
      db('database_backup_runs')
        .orderBy('started_at', 'desc')
        .limit(limit)
        .offset(offset),
      db('database_backup_runs').count('* as count').first()
    ]);
    
    res.json({
      backups,
      pagination: {
        page,
        limit,
        total: totalCount.count,
        pages: Math.ceil(totalCount.count / limit)
      }
    });
  } catch (error) {
    logger.error('Failed to get backup history:', error);
    res.status(500).json({ error: 'Failed to get history' });
  }
});

/**
 * Delete old backup files
 */
router.delete('/cleanup', requirePermission('backup.delete'), async (req, res) => {
  try {
    const { retentionDays = 30 } = req.body;
    
    await databaseBackupService.cleanupOldBackups(retentionDays);
    
    res.json({ 
      success: true, 
      message: `Cleaned up backups older than ${retentionDays} days`
    });
  } catch (error) {
    logger.error('Failed to cleanup old backups:', error);
    res.status(500).json({ error: 'Failed to cleanup backups' });
  }
});

/**
 * Test database backup configuration
 */
router.post('/test', requirePermission('backup.create'), async (req, res) => {
  try {
    const config = await databaseBackupService.getBackupConfig();
    
    // Test database connection
    const testResults = {
      databaseConnection: false,
      destinationWritable: false,
      compressionAvailable: true,
      estimatedSize: null
    };
    
    // Test database connection
    try {
      await db.raw('SELECT 1');
      testResults.databaseConnection = true;
    } catch (error) {
      testResults.databaseConnectionError = error.message;
    }
    
    // Test the directory a real backup would write to. This read an
    // unprefixed `destinationPath` that getBackupConfig() never returns, so
    // the check was skipped and always reported the destination unwritable.
    const destinationPath = await resolveDatabaseBackupDestination(config);
    testResults.destinationPath = destinationPath;
    if (isUnderPubliclyServableRoot(destinationPath)) {
      testResults.destinationError = `Refusing to write a database backup to a publicly served directory: ${destinationPath}`;
    } else {
      try {
        const fs = require('fs').promises;
        await fs.mkdir(destinationPath, { recursive: true });
        const testFile = path.join(destinationPath, `.test-${Date.now()}`);
        await fs.writeFile(testFile, 'test');
        await fs.unlink(testFile);
        testResults.destinationWritable = true;
      } catch (error) {
        testResults.destinationError = `Cannot write to the database backup directory ${destinationPath}: ${error.code || error.message}. `
          + 'Set database_backup_destination_path to a directory the backend can write to, or mount a writable volume at that path.';
      }
    }
    
    // Estimate database size
    try {
      testResults.estimatedSize = await databaseBackupService.getDatabaseSize();
    } catch (error) {
      testResults.sizeError = error.message;
    }
    
    res.json({
      success: testResults.databaseConnection && testResults.destinationWritable,
      results: testResults
    });
  } catch (error) {
    logger.error('Failed to test backup configuration:', error);
    res.status(500).json({ error: 'Failed to test configuration' });
  }
});

/**
 * Get table checksums
 */
router.get('/checksums', requirePermission('backup.view'), async (req, res) => {
  try {
    const checksums = await databaseBackupService.getTableChecksums();
    
    res.json({
      checksums,
      tableCount: Object.keys(checksums).length,
      totalRows: Object.values(checksums).reduce((sum, table) => sum + table.rowCount, 0)
    });
  } catch (error) {
    logger.error('Failed to get table checksums:', error);
    res.status(500).json({ error: 'Failed to get checksums' });
  }
});

module.exports = router;