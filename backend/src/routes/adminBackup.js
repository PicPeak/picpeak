const express = require('express');
const { db } = require('../database/db');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { triggerManualBackup, getBackupStatus, cleanupOldBackupRuns, getBackupManifest, validateBackupManifest } = require('../services/backupService');
const logger = require('../utils/logger');
const { errorResponse, getPagination } = require('../utils/routeHelpers');
const { formatBytes } = require('../utils/formatBytes');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const S3StorageAdapter = require('../services/storage/s3Storage');

const router = express.Router();

// Get backup configuration
router.get('/config', adminAuth, requirePermission('backup.view'), async (req, res) => {
  try {
    const settings = await db('app_settings')
      .where('setting_type', 'backup')
      .select('setting_key', 'setting_value');
    
    const config = {};
    settings.forEach(setting => {
      try {
        config[setting.setting_key] = JSON.parse(setting.setting_value);
      } catch (e) {
        config[setting.setting_key] = setting.setting_value;
      }
    });
    
    res.json(config);
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to get backup configuration');
  }
});

// Update backup configuration
router.put('/config', adminAuth, requirePermission('backup.create'), async (req, res) => {
  try {
    const updates = req.body;
    
    // Validate required fields based on destination type
    if (updates.backup_destination_type) {
      switch (updates.backup_destination_type) {
      case 'local':
        if (!updates.backup_destination_path) {
          return res.status(400).json({ error: 'Local backup requires destination path' });
        }
        break;
      case 'rsync':
        if (!updates.backup_rsync_host || !updates.backup_rsync_path) {
          return res.status(400).json({ error: 'Rsync backup requires host and path' });
        }
        break;
      case 's3':
        if (!updates.backup_s3_endpoint || !updates.backup_s3_bucket || 
              !updates.backup_s3_access_key || !updates.backup_s3_secret_key) {
          return res.status(400).json({ error: 'S3 backup requires endpoint, bucket, and credentials' });
        }
        break;
      }
    }
    
    // Update settings
    for (const [key, value] of Object.entries(updates)) {
      if (key.startsWith('backup_')) {
        await db('app_settings')
          .insert({
            setting_key: key,
            setting_value: JSON.stringify(value),
            setting_type: 'backup',
            updated_at: new Date()
          })
          .onConflict('setting_key')
          .merge({
            setting_value: JSON.stringify(value),
            updated_at: new Date()
          });
      }
    }
    
    // Restart backup service if enabled status changed
    if ('backup_enabled' in updates) {
      const { startBackupService, stopBackupService } = require('../services/backupService');
      if (updates.backup_enabled) {
        await startBackupService();
      } else {
        stopBackupService();
      }
    }
    
    res.json({ success: true, message: 'Backup configuration updated' });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to update backup configuration');
  }
});

// Get backup status and history
router.get('/status', adminAuth, requirePermission('backup.view'), async (req, res) => {
  try {
    const { limit } = getPagination(req, { limit: 10 });
    const status = await getBackupStatus(limit);
    
    res.json(status);
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to get backup status');
  }
});

// Trigger manual backup
router.post('/run', adminAuth, requirePermission('backup.create'), async (req, res) => {
  try {
    // Check if backup is already running
    const status = await getBackupStatus();
    if (status.isRunning) {
      return res.status(409).json({ error: 'Backup is already running' });
    }
    
    // Start backup in background
    triggerManualBackup().catch(error => {
      logger.error('Manual backup failed:', error);
    });
    
    res.json({ success: true, message: 'Backup started' });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to trigger backup');
  }
});

// Generate + download a portable ".picpeak" export — an engine-neutral logical
// snapshot (DB rows as NDJSON + PDFs/business-docs) that can be re-uploaded to
// another instance via the web UI. `?includePhotos=true` also bundles original
// gallery photos (larger); otherwise the admin re-uploads them per gallery.
//
// SECURITY: the file contains plaintext secrets (SMTP password, admin password
// hashes, API keys). The download UI must warn before offering it. We surface
// the flag as a response header too so the client can double-confirm.
router.get('/picpeak/export', adminAuth, requirePermission('backup.create'), async (req, res) => {
  const fsSync = require('fs');
  try {
    const includePhotos = req.query.includePhotos === 'true' || req.query.includePhotos === '1';
    const { createPicpeak } = require('../services/picpeakExportService');
    const { filePath } = await createPicpeak({ includePhotos });
    const filename = path.basename(filePath);
    res.setHeader('X-Picpeak-Contains-Secrets', 'true');
    res.download(filePath, filename, (err) => {
      // Best-effort cleanup of the temp .picpeak (and its temp dir) after send.
      fsSync.rm(path.dirname(filePath), { recursive: true, force: true }, () => {});
      if (err) logger.error('[picpeak-export] download failed', { error: err.message });
    });
  } catch (error) {
    logger.error('[picpeak-export] failed to create export', { error: error.message });
    if (!res.headersSent) res.status(500).json({ error: 'Failed to create .picpeak export' });
  }
});

// Multipart upload for .picpeak restore — streamed to a temp file. Runs AFTER
// auth so an unauthenticated request can't push a large file to disk.
const os = require('os');
const multer = require('multer');
const picpeakUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => cb(null, `picpeak-upload-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.picpeak`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 * 1024 }, // 5 GB — .picpeak with photos can be large
});

// Upload + restore a .picpeak onto THIS instance. DESTRUCTIVE: full override of
// all data except the current logged-in account (the client shows an explicit
// confirmation before calling this). Returns `usesExternalMedia` so the UI can
// prompt the admin to reconfigure the external-media mount afterwards.
router.post('/picpeak/import', adminAuth, requirePermission('backup.restore'), picpeakUpload.single('backup'), async (req, res) => {
  const fsSync = require('fs');
  if (!req.file) return res.status(400).json({ error: 'No backup file uploaded' });
  const picpeakPath = req.file.path;
  try {
    const { importFromPicpeak } = require('../services/picpeakImportService');
    const result = await importFromPicpeak({ picpeakPath, currentAdminId: req.user && req.user.id });
    res.json({
      success: true,
      tables: result.tables,
      filesRestored: result.filesRestored,
      usesExternalMedia: result.usesExternalMedia,
    });
  } catch (error) {
    const status = error.statusCode || 500;
    logger.error('[picpeak-import] restore failed', { error: error.message });
    res.status(status).json({ error: error.message || 'Restore failed', validation: error.validation });
  } finally {
    fsSync.unlink(picpeakPath, () => {});
  }
});

// Get backup run details
router.get('/runs/:id', adminAuth, requirePermission('backup.view'), async (req, res) => {
  try {
    const { id } = req.params;
    
    const run = await db('backup_runs')
      .where('id', id)
      .first();
    
    if (!run) {
      return res.status(404).json({ error: 'Backup run not found' });
    }
    
    // Parse JSON fields
    if (run.statistics) {
      try {
        run.statistics = JSON.parse(run.statistics);
      } catch (e) {
        // Keep as string if parsing fails
      }
    }
    
    res.json(run);
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to get backup run details');
  }
});

// Get file states (for debugging/monitoring)
router.get('/files', adminAuth, requirePermission('backup.view'), async (req, res) => {
  try {
    const { page = 1, limit = 50, search = '' } = req.query;
    const offset = (page - 1) * limit;
    
    let query = db('backup_file_states');
    
    if (search) {
      query = query.where('file_path', 'like', `%${search}%`);
    }
    
    const [files, totalCount] = await Promise.all([
      query
        .orderBy('last_backed_up', 'desc')
        .limit(limit)
        .offset(offset),
      db('backup_file_states').count('* as count').first()
    ]);
    
    res.json({
      files,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalCount.count,
        pages: Math.ceil(totalCount.count / limit)
      }
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to get file states');
  }
});

// Clean up old backup runs
router.delete('/cleanup', adminAuth, requirePermission('backup.delete'), async (req, res) => {
  try {
    const { days = 30 } = req.body;
    
    await cleanupOldBackupRuns(days);
    
    res.json({ success: true, message: `Cleaned up backup runs older than ${days} days` });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to cleanup backup runs');
  }
});

// Test backup destination connectivity
router.post('/test-connection', adminAuth, requirePermission('backup.create'), async (req, res) => {
  try {
    const { destination_type, ...config } = req.body;
    
    switch (destination_type) {
    case 'local':
      // Test local path access
      const fs = require('fs').promises;
      try {
        await fs.access(config.path, fs.constants.W_OK);
        res.json({ success: true, message: 'Local path is writable' });
      } catch (error) {
        logger.warn('Local backup path not writable', {
          path: config.path,
          error: error.message
        });
        res.json({ success: false, message: 'Cannot write to local path. Check server logs for details.' });
      }
      break;
        
    case 'rsync':
      // Test rsync connection using spawn with argument arrays to prevent command injection
      const { spawn } = require('child_process');

      // Validate and sanitize inputs to prevent command injection
      const sanitizeInput = (input) => {
        if (!input || typeof input !== 'string') return null;
        // Remove any shell metacharacters and limit length
        return input.replace(/[;&|`$(){}[\]<>\\!#*?"'\n\r]/g, '').substring(0, 255);
      };

      const host = sanitizeInput(config.host);
      const user = sanitizeInput(config.user);
      const sshKeyPath = sanitizeInput(config.ssh_key);

      if (!host) {
        res.json({ success: false, message: 'Invalid host specified' });
        break;
      }

      // Validate host format (hostname or IP only)
      const hostRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;
      const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
      if (!hostRegex.test(host) && !ipRegex.test(host)) {
        res.json({ success: false, message: 'Invalid host format' });
        break;
      }

      // SSRF protection: block connections to private/internal addresses
      const { isPrivateIP } = require('../utils/networkValidation');
      if (isPrivateIP(host)) {
        res.json({ success: false, message: 'Host cannot be a private or internal network address' });
        break;
      }

      // Validate username format if provided
      if (user && !/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(user)) {
        res.json({ success: false, message: 'Invalid username format' });
        break;
      }

      // Build SSH arguments as array (safe from injection)
      const sshArgs = [];
      if (sshKeyPath) {
        // Validate SSH key path exists and is a file
        const fsSync = require('fs');
        if (!fsSync.existsSync(sshKeyPath) || !fsSync.statSync(sshKeyPath).isFile()) {
          res.json({ success: false, message: 'SSH key file not found' });
          break;
        }
        sshArgs.push('-i', sshKeyPath);
      }
      sshArgs.push('-o', 'StrictHostKeyChecking=no');
      sshArgs.push('-o', 'ConnectTimeout=10');
      sshArgs.push('-o', 'BatchMode=yes');

      // Add target (user@host or just host)
      const target = user ? `${user}@${host}` : host;
      sshArgs.push(target);
      sshArgs.push('echo', 'Connection successful');

      try {
        const result = await new Promise((resolve, reject) => {
          const sshProcess = spawn('ssh', sshArgs, {
            timeout: 15000,
            stdio: ['ignore', 'pipe', 'pipe']
          });

          let stdout = '';
          let stderr = '';

          sshProcess.stdout.on('data', (data) => { stdout += data; });
          sshProcess.stderr.on('data', (data) => { stderr += data; });

          sshProcess.on('close', (code) => {
            if (code === 0) {
              resolve({ success: true, stdout });
            } else {
              reject(new Error(stderr || `SSH exited with code ${code}`));
            }
          });

          sshProcess.on('error', (err) => {
            reject(err);
          });
        });

        res.json({ success: true, message: 'Rsync connection successful' });
      } catch (error) {
        logger.warn('Rsync connection test failed', {
          destination: host,
          error: error.message
        });
        res.json({ success: false, message: 'Rsync connection failed. Check server logs for details.' });
      }
      break;
        
    case 's3':
      // Test S3 connection (would need AWS SDK)
      res.json({ success: false, message: 'S3 testing not implemented yet' });
      break;
        
    default:
      res.status(400).json({ error: 'Invalid destination type' });
    }
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to test connection');
  }
});

// Get backup manifest for a specific backup run
router.get('/manifest/:backupRunId', adminAuth, requirePermission('backup.view'), async (req, res) => {
  try {
    const { backupRunId } = req.params;
    const result = await getBackupManifest(backupRunId);
    
    res.json({
      backupRunId,
      manifest: result.manifest,
      summary: result.summary
    });
  } catch (error) {
    logger.error('Failed to get backup manifest:', error);
    res.status(404).json({ error: 'Backup manifest not found' });
  }
});

// Validate a backup manifest
router.post('/manifest/validate', adminAuth, requirePermission('backup.view'), async (req, res) => {
  try {
    const { manifestPath } = req.body;

    if (!manifestPath) {
      return res.status(400).json({ error: 'manifestPath is required' });
    }

    // Prevent path traversal — manifest must be within backup directory
    const backupBasePath = process.env.BACKUP_PATH || path.join(__dirname, '../../../backups');
    const { safePathJoin } = require('../utils/fileSecurityUtils');
    const safePath = safePathJoin(backupBasePath, manifestPath);

    const result = await validateBackupManifest(safePath);
    
    res.json({
      valid: result.valid,
      error: result.error,
      manifestPath
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to validate manifest');
  }
});

// Download backup manifest
router.get('/manifest/:backupRunId/download', adminAuth, requirePermission('backup.view'), async (req, res) => {
  try {
    const { backupRunId } = req.params;
    const { format = 'json' } = req.query;
    
    const result = await getBackupManifest(backupRunId);
    
    // Set appropriate headers
    const filename = `backup-manifest-${backupRunId}.${format}`;
    res.setHeader('Content-Type', format === 'yaml' ? 'text/yaml' : 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    
    // Send the manifest in requested format
    if (format === 'yaml') {
      const yaml = require('js-yaml');
      res.send(yaml.dump(result.manifest, {
        indent: 2,
        lineWidth: -1,
        noRefs: true,
        sortKeys: true
      }));
    } else {
      res.json(result.manifest);
    }
  } catch (error) {
    logger.error('Failed to download backup manifest:', error);
    res.status(404).json({ error: 'Backup manifest not found' });
  }
});

// Get manifest for specific backup
router.get('/manifests/:backupId', adminAuth, requirePermission('backup.view'), async (req, res) => {
  try {
    const { backupId } = req.params;
    const result = await getBackupManifest(backupId);
    
    res.json({
      backupId,
      manifest: result.manifest,
      summary: result.summary
    });
  } catch (error) {
    logger.error('Failed to get backup manifest:', error);
    res.status(404).json({ error: 'Backup manifest not found' });
  }
});

// Download manifest file
router.get('/manifests/:backupId/download', adminAuth, requirePermission('backup.view'), async (req, res) => {
  try {
    const { backupId } = req.params;
    const { format = 'json' } = req.query;
    
    const result = await getBackupManifest(backupId);
    
    // Set appropriate headers
    const filename = `backup-manifest-${backupId}.${format}`;
    res.setHeader('Content-Type', format === 'yaml' ? 'text/yaml' : 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    
    // Send the manifest in requested format
    if (format === 'yaml') {
      const yaml = require('js-yaml');
      res.send(yaml.dump(result.manifest, {
        indent: 2,
        lineWidth: -1,
        noRefs: true,
        sortKeys: true
      }));
    } else {
      res.json(result.manifest);
    }
  } catch (error) {
    logger.error('Failed to download backup manifest:', error);
    res.status(404).json({ error: 'Backup manifest not found' });
  }
});

// Validate a manifest
router.post('/manifests/validate', adminAuth, requirePermission('backup.view'), async (req, res) => {
  try {
    const { manifestPath, manifestData } = req.body;

    if (!manifestPath && !manifestData) {
      return res.status(400).json({ error: 'Either manifestPath or manifestData is required' });
    }

    if (manifestData) {
      // Validate provided manifest data directly
      const validationResult = await validateManifestData(manifestData);
      return res.json(validationResult);
    }

    // Prevent path traversal — manifest must be within backup directory
    const backupBasePath = process.env.BACKUP_PATH || path.join(__dirname, '../../../backups');
    const { safePathJoin } = require('../utils/fileSecurityUtils');
    const safePath = safePathJoin(backupBasePath, manifestPath);

    // Use existing validation function for path
    const result = await validateBackupManifest(safePath);
    
    res.json({
      valid: result.valid,
      error: result.error,
      manifestPath
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to validate manifest');
  }
});

// List S3 buckets
router.get('/s3/buckets', adminAuth, requirePermission('backup.view'), async (req, res) => {
  try {
    const config = await getBackupConfig();
    
    if (config.backup_destination_type !== 's3') {
      return res.status(400).json({ error: 'S3 backup not configured' });
    }
    
    const s3Adapter = new S3StorageAdapter({
      endpoint: config.backup_s3_endpoint,
      bucket: config.backup_s3_bucket,
      accessKeyId: config.backup_s3_access_key,
      secretAccessKey: config.backup_s3_secret_key,
      region: config.backup_s3_region || 'us-east-1',
      forcePathStyle: config.backup_s3_force_path_style || false
    });
    
    // List buckets using the S3 client
    const { ListBucketsCommand } = require('@aws-sdk/client-s3');
    const result = await s3Adapter.s3Client.send(new ListBucketsCommand({}));
    
    res.json({
      buckets: result.Buckets || [],
      owner: result.Owner || null
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to list S3 buckets');
  }
});

// List files in S3 backup location
router.get('/s3/files', adminAuth, requirePermission('backup.view'), async (req, res) => {
  try {
    const { prefix = '', maxKeys = 100, continuationToken } = req.query;
    const config = await getBackupConfig();
    
    if (config.backup_destination_type !== 's3') {
      return res.status(400).json({ error: 'S3 backup not configured' });
    }
    
    const s3Adapter = new S3StorageAdapter({
      endpoint: config.backup_s3_endpoint,
      bucket: config.backup_s3_bucket,
      accessKeyId: config.backup_s3_access_key,
      secretAccessKey: config.backup_s3_secret_key,
      region: config.backup_s3_region || 'us-east-1',
      forcePathStyle: config.backup_s3_force_path_style || false
    });
    
    const result = await s3Adapter.list(prefix, {
      maxKeys: parseInt(maxKeys),
      continuationToken
    });
    
    res.json({
      files: result.objects || [],
      directories: result.directories || [],
      isTruncated: result.isTruncated,
      nextContinuationToken: result.nextContinuationToken,
      prefix: prefix
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to list S3 files');
  }
});

// Clean up old S3 backups
router.delete('/s3/cleanup', adminAuth, requirePermission('backup.delete'), async (req, res) => {
  try {
    const { retentionDays = 30, dryRun = false } = req.body;
    const config = await getBackupConfig();
    
    if (config.backup_destination_type !== 's3') {
      return res.status(400).json({ error: 'S3 backup not configured' });
    }
    
    const s3Adapter = new S3StorageAdapter({
      endpoint: config.backup_s3_endpoint,
      bucket: config.backup_s3_bucket,
      accessKeyId: config.backup_s3_access_key,
      secretAccessKey: config.backup_s3_secret_key,
      region: config.backup_s3_region || 'us-east-1',
      forcePathStyle: config.backup_s3_force_path_style || false
    });
    
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
    
    // List all backup files
    const backupFiles = await s3Adapter.list('backups/', { maxKeys: 1000 });
    const filesToDelete = [];
    let totalSize = 0;
    
    for (const file of backupFiles.objects || []) {
      if (file.lastModified && new Date(file.lastModified) < cutoffDate) {
        filesToDelete.push(file.key);
        totalSize += file.size || 0;
      }
    }
    
    if (dryRun) {
      return res.json({
        wouldDelete: filesToDelete.length,
        totalSize: totalSize,
        files: filesToDelete.slice(0, 100), // Limit preview
        message: 'Dry run completed - no files were deleted'
      });
    }
    
    // Delete files in batches
    const deleteResult = await s3Adapter.deleteMany(filesToDelete);
    const deletedCount = deleteResult.Deleted ? deleteResult.Deleted.length : 0;
    
    // Also clean up database records
    await cleanupOldBackupRuns(retentionDays);
    
    res.json({
      success: true,
      deletedCount: deletedCount,
      totalSize: totalSize,
      message: `Cleaned up ${deletedCount} S3 backup files older than ${retentionDays} days`
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to cleanup S3 backups');
  }
});

// Test S3 upload functionality
router.post('/s3/test-upload', adminAuth, requirePermission('backup.create'), async (req, res) => {
  try {
    const config = await getBackupConfig();
    
    if (config.backup_destination_type !== 's3') {
      return res.status(400).json({ error: 'S3 backup not configured' });
    }
    
    const s3Adapter = new S3StorageAdapter({
      endpoint: config.backup_s3_endpoint,
      bucket: config.backup_s3_bucket,
      accessKeyId: config.backup_s3_access_key,
      secretAccessKey: config.backup_s3_secret_key,
      region: config.backup_s3_region || 'us-east-1',
      forcePathStyle: config.backup_s3_force_path_style || false
    });
    
    // Create test content
    const testKey = `test/backup-test-${Date.now()}.txt`;
    const testContent = `PicPeak S3 backup test\nTimestamp: ${new Date().toISOString()}\nEndpoint: ${config.backup_s3_endpoint || 'AWS'}\nBucket: ${config.backup_s3_bucket}`;
    
    // Test upload
    const uploadStart = Date.now();
    await s3Adapter.upload(testKey, Buffer.from(testContent));
    const uploadTime = Date.now() - uploadStart;
    
    // Test download
    const downloadStart = Date.now();
    const downloadedContent = await s3Adapter.download(testKey);
    const downloadTime = Date.now() - downloadStart;
    
    // Verify content
    const contentMatch = downloadedContent.toString() === testContent;
    
    // Test deletion
    await s3Adapter.delete(testKey);
    
    res.json({
      success: true,
      testKey: testKey,
      uploadTime: uploadTime,
      downloadTime: downloadTime,
      contentMatch: contentMatch,
      message: 'S3 upload test completed successfully'
    });
  } catch (error) {
    errorResponse(res, error, 500, 'S3 upload test failed');
  }
});

// Download entire backup
router.get('/download/:backupId', adminAuth, requirePermission('backup.view'), async (req, res) => {
  try {
    const { backupId } = req.params;
    
    // Get backup run details
    const backupRun = await db('backup_runs')
      .where('id', backupId)
      .first();
    
    if (!backupRun) {
      return res.status(404).json({ error: 'Backup not found' });
    }
    
    if (backupRun.status !== 'completed') {
      return res.status(400).json({ error: 'Backup is not completed' });
    }
    
    const config = await getBackupConfig();
    
    // Handle different backup types
    switch (config.backup_destination_type) {
    case 'local':
      // Stream local backup as zip
      const backupPath = path.join(config.backup_destination_path, `backup-${backupRun.id}`);
      const archive = archiver('zip', { zlib: { level: 9 } });
        
      res.attachment(`picpeak-backup-${backupRun.id}.zip`);
      archive.pipe(res);
        
      // Add backup directory contents
      archive.directory(backupPath, false);
        
      // Add manifest if exists
      if (backupRun.manifest_path && await fs.access(backupRun.manifest_path).then(() => true).catch(() => false)) {
        archive.file(backupRun.manifest_path, { name: 'manifest.json' });
      }
        
      await archive.finalize();
      break;
        
    case 's3':
      // For S3, provide pre-signed URLs or stream files
      const s3Adapter = new S3StorageAdapter({
        endpoint: config.backup_s3_endpoint,
        bucket: config.backup_s3_bucket,
        accessKeyId: config.backup_s3_access_key,
        secretAccessKey: config.backup_s3_secret_key,
        region: config.backup_s3_region || 'us-east-1',
        forcePathStyle: config.backup_s3_force_path_style || false
      });
        
      // List all files for this backup
      const prefix = `backups/${backupRun.id}/`;
      const files = await s3Adapter.list(prefix, { maxKeys: 1000 });
        
      // Generate pre-signed URLs
      const urls = [];
      for (const file of files.objects || []) {
        const url = await s3Adapter.getSignedUrl('getObject', file.key, { expiresIn: 3600 }); // 1 hour
        urls.push({
          key: file.key,
          size: file.size,
          url: url
        });
      }
        
      res.json({
        backupId: backupRun.id,
        type: 's3',
        files: urls,
        expiresIn: 3600,
        message: 'Use the provided URLs to download individual files'
      });
      break;
        
    case 'rsync':
      return res.status(400).json({ error: 'Direct download not available for rsync backups' });
        
    default:
      return res.status(400).json({ error: 'Unknown backup type' });
    }
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to download backup');
  }
});

// Get current file checksums
router.get('/checksums', adminAuth, requirePermission('backup.view'), async (req, res) => {
  try {
    const { path: targetPath = '', recursive = true } = req.query;
    const checksums = {};

    // Get storage path
    const storagePath = process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');
    let basePath = storagePath;
    if (targetPath) {
      const { safePathJoin } = require('../utils/fileSecurityUtils');
      basePath = safePathJoin(storagePath, targetPath);
    }
    
    // Calculate checksums for files
    async function calculateDirChecksums(dirPath, relative = '') {
      try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        
        for (const entry of entries) {
          const fullPath = path.join(dirPath, entry.name);
          const relativePath = path.join(relative, entry.name);
          
          if (entry.isDirectory() && recursive) {
            await calculateDirChecksums(fullPath, relativePath);
          } else if (entry.isFile()) {
            const hash = crypto.createHash('sha256');
            const stream = require('fs').createReadStream(fullPath);
            
            await new Promise((resolve, reject) => {
              stream.on('data', data => hash.update(data));
              stream.on('end', () => {
                checksums[relativePath] = {
                  checksum: hash.digest('hex'),
                  size: entry.size,
                  modified: entry.mtime
                };
                resolve();
              });
              stream.on('error', reject);
            });
          }
        }
      } catch (error) {
        logger.error(`Failed to calculate checksums for ${dirPath}:`, error);
      }
    }
    
    await calculateDirChecksums(basePath);
    
    // Also get database checksums from backup_file_states
    const dbChecksums = await db('backup_file_states')
      .select('file_path', 'checksum', 'size_bytes', 'last_modified');
    
    res.json({
      currentChecksums: checksums,
      totalFiles: Object.keys(checksums).length,
      databaseChecksums: dbChecksums.reduce((acc, row) => {
        acc[row.file_path] = {
          checksum: row.checksum,
          size: row.size_bytes,
          modified: row.last_modified
        };
        return acc;
      }, {}),
      path: targetPath || '/'
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to get file checksums');
  }
});

// Estimate backup size before running
router.post('/estimate', adminAuth, requirePermission('backup.view'), async (req, res) => {
  try {
    const { includeArchived = true } = req.body;
    
    // Get storage path
    const storagePath = process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');
    let totalSize = 0;
    let fileCount = 0;
    const breakdown = {};
    
    // Estimate size for each directory
    async function estimateDir(dirPath, category) {
      let dirSize = 0;
      let dirCount = 0;
      
      try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        
        for (const entry of entries) {
          const fullPath = path.join(dirPath, entry.name);
          
          if (entry.isDirectory()) {
            const subResult = await estimateDir(fullPath, category);
            dirSize += subResult.size;
            dirCount += subResult.count;
          } else if (entry.isFile()) {
            const stats = await fs.stat(fullPath);
            dirSize += stats.size;
            dirCount++;
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          logger.error(`Failed to estimate ${dirPath}:`, error);
        }
      }
      
      return { size: dirSize, count: dirCount };
    }
    
    // Estimate each category
    const categories = [
      { path: 'events/active', name: 'Active Events' },
      { path: 'thumbnails', name: 'Thumbnails' },
      { path: 'uploads', name: 'Uploads' }
    ];
    
    if (includeArchived) {
      categories.push({ path: 'events/archived', name: 'Archived Events' });
    }
    
    for (const category of categories) {
      const result = await estimateDir(path.join(storagePath, category.path), category.name);
      breakdown[category.name] = {
        size: result.size,
        sizeFormatted: formatBytes(result.size),
        fileCount: result.count
      };
      totalSize += result.size;
      fileCount += result.count;
    }
    
    // Estimate database size
    const dbPath = process.env.DB_TYPE === 'postgresql' 
      ? null 
      : path.join(__dirname, '../../database.sqlite');
    
    if (dbPath) {
      try {
        const dbStats = await fs.stat(dbPath);
        breakdown['Database'] = {
          size: dbStats.size,
          sizeFormatted: formatBytes(dbStats.size),
          fileCount: 1
        };
        totalSize += dbStats.size;
        fileCount += 1;
      } catch (error) {
        logger.error('Failed to get database size:', error);
      }
    }
    
    // Estimate compression ratio (typically 20-40% for mixed media)
    const estimatedCompressedSize = Math.round(totalSize * 0.7);
    
    res.json({
      totalSize: totalSize,
      totalSizeFormatted: formatBytes(totalSize),
      estimatedCompressedSize: estimatedCompressedSize,
      estimatedCompressedSizeFormatted: formatBytes(estimatedCompressedSize),
      fileCount: fileCount,
      breakdown: breakdown,
      includeArchived: includeArchived,
      estimatedDuration: Math.max(60, Math.round(totalSize / (50 * 1024 * 1024))), // Estimate 50MB/s
      warnings: totalSize > 10 * 1024 * 1024 * 1024 ? ['Backup size exceeds 10GB, may take significant time'] : []
    });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to estimate backup size');
  }
});

// Helper function to format bytes
// Helper function to get backup configuration
async function getBackupConfig() {
  try {
    const settings = await db('app_settings')
      .where('setting_type', 'backup')
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
  } catch (error) {
    logger.error('Failed to get backup configuration:', error);
    return {};
  }
}

// Helper function to validate manifest data
async function validateManifestData(manifestData) {
  try {
    // Check required fields
    const requiredFields = ['version', 'backupId', 'timestamp', 'files'];
    const missingFields = requiredFields.filter(field => !manifestData[field]);
    
    if (missingFields.length > 0) {
      return {
        valid: false,
        error: `Missing required fields: ${missingFields.join(', ')}`,
        details: { missingFields }
      };
    }
    
    // Validate version
    if (manifestData.version !== '1.0') {
      return {
        valid: false,
        error: `Unsupported manifest version: ${manifestData.version}`,
        details: { version: manifestData.version }
      };
    }
    
    // Validate files array
    if (!Array.isArray(manifestData.files)) {
      return {
        valid: false,
        error: 'Files must be an array',
        details: { filesType: typeof manifestData.files }
      };
    }
    
    // Validate each file entry
    const invalidFiles = [];
    for (let i = 0; i < manifestData.files.length; i++) {
      const file = manifestData.files[i];
      if (!file.path || !file.checksum || typeof file.size !== 'number') {
        invalidFiles.push({ index: i, file });
      }
    }
    
    if (invalidFiles.length > 0) {
      return {
        valid: false,
        error: `Invalid file entries: ${invalidFiles.length}`,
        details: { invalidFiles: invalidFiles.slice(0, 10) } // Limit to first 10
      };
    }
    
    return {
      valid: true,
      details: {
        version: manifestData.version,
        backupId: manifestData.backupId,
        timestamp: manifestData.timestamp,
        fileCount: manifestData.files.length,
        totalSize: manifestData.files.reduce((sum, f) => sum + (f.size || 0), 0)
      }
    };
  } catch (error) {
    logger.error('Manifest validation error', { error: error.message });
    return {
      valid: false,
      error: 'Validation error encountered while processing manifest',
      details: { hint: 'See server logs for diagnostic details.' }
    };
  }
}

module.exports = router;
