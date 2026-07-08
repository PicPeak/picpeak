const express = require('express');
const router = express.Router();
const { restoreService } = require('../services/restoreService');
const { adminAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { body, query, validationResult } = require('express-validator');
const logger = require('../utils/logger');
const { getPagination } = require('../utils/routeHelpers');
const { db } = require('../database/db');
const path = require('path');
const fs = require('fs').promises;

/**
 * Admin routes for restore operations
 * All routes require admin authentication
 */

// Apply admin authentication to all routes
router.use(adminAuth);

/**
 * Transform frontend S3 config to backend format
 * Frontend sends: s3Endpoint, s3Bucket, s3AccessKey, s3SecretKey, s3Region
 * Backend expects: endpoint, bucket, accessKeyId, secretAccessKey, region
 */
function transformS3Config(body) {
  if (body.s3Config) {
    // Already in correct format
    return body.s3Config;
  }

  // Check if frontend sent flat S3 config fields
  if (body.s3Endpoint || body.s3Bucket || body.s3AccessKey || body.s3SecretKey) {
    return {
      endpoint: body.s3Endpoint,
      bucket: body.s3Bucket,
      accessKeyId: body.s3AccessKey,
      secretAccessKey: body.s3SecretKey,
      region: body.s3Region || 'us-east-1',
      forcePathStyle: body.s3ForcePathStyle !== false
    };
  }

  return null;
}

/**
 * Get restore service status and history
 */
router.get('/status', requirePermission('backup.view'), async (req, res) => {
  try {
    const { limit } = getPagination(req, { limit: 10 });
    const history = await restoreService.getRestoreHistory(limit);
    
    const status = {
      isRunning: restoreService.isRunning,
      currentProgress: restoreService.getProgress(),
      history: history,
      settings: await getRestoreSettings()
    };
    
    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    logger.error('Failed to get restore status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get restore status'
    });
  }
});

/**
 * Validate restore request
 */
router.post('/validate', requirePermission('backup.restore'), [
  body('source').notEmpty().withMessage('Backup source is required'),
  body('manifestPath').notEmpty().withMessage('Manifest path is required'),
  body('restoreType').isIn(['full', 'database', 'files', 'selective']).withMessage('Invalid restore type'),
  body('selectedItems').optional().isArray(),
  body('s3Config').optional().isObject()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      errors: errors.array()
    });
  }

  try {
    // Transform S3 config from frontend format
    const s3Config = transformS3Config(req.body);

    // Perform dry run validation
    const result = await restoreService.restore({
      source: req.body.source,
      manifestPath: req.body.manifestPath,
      restoreType: req.body.restoreType,
      selectedItems: req.body.selectedItems,
      s3Config,
      dryRun: true,
      force: false
    });

    // Transform spaceCheck to match frontend expected format
    const spaceCheck = result.spaceCheck ? {
      sufficient: result.spaceCheck.hasEnoughSpace,
      required: result.spaceCheck.requiredBytes,
      available: result.spaceCheck.availableBytes,
      requiredFormatted: result.spaceCheck.requiredFormatted,
      availableFormatted: result.spaceCheck.availableFormatted,
      // Keep original fields for backwards compatibility
      hasEnoughSpace: result.spaceCheck.hasEnoughSpace,
      requiredBytes: result.spaceCheck.requiredBytes,
      availableBytes: result.spaceCheck.availableBytes
    } : null;

    res.json({
      success: true,
      data: {
        validation: result.validation,
        spaceCheck,
        logs: result.logs
      }
    });
  } catch (error) {
    logger.error('Restore validation failed:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Restore validation failed',
      logs: restoreService.restoreLog
    });
  }
});

/**
 * Start restore operation
 */
router.post('/start', requirePermission('backup.restore'), [
  body('source').notEmpty().withMessage('Backup source is required'),
  body('manifestPath').notEmpty().withMessage('Manifest path is required'),
  body('restoreType').isIn(['full', 'database', 'files', 'selective']).withMessage('Invalid restore type'),
  body('selectedItems').optional().isArray(),
  body('skipPreBackup').optional().isBoolean(),
  body('force').optional().isBoolean(),
  body('s3Config').optional().isObject()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      errors: errors.array()
    });
  }

  try {
    // Check if restore is already running
    if (restoreService.isRunning) {
      return res.status(409).json({
        success: false,
        error: 'Restore operation already in progress'
      });
    }

    // Check permissions for dangerous options
    const settings = await getRestoreSettings();
    if (req.body.force && !settings.restore_allow_force) {
      return res.status(403).json({
        success: false,
        error: 'Force restore is not allowed by system settings'
      });
    }

    if (req.body.skipPreBackup && settings.restore_require_pre_backup) {
      return res.status(403).json({
        success: false,
        error: 'Skipping pre-restore backup is not allowed by system settings'
      });
    }

    // Log restore attempt
    logger.warn('Restore operation started', {
      user: req.admin.email,
      ip: req.ip,
      restoreType: req.body.restoreType,
      source: req.body.source
    });

    // Transform S3 config from frontend format
    const s3Config = transformS3Config(req.body);

    // Start restore in background
    restoreService.restore({
      source: req.body.source,
      manifestPath: req.body.manifestPath,
      restoreType: req.body.restoreType,
      selectedItems: req.body.selectedItems,
      skipPreBackup: req.body.skipPreBackup,
      force: req.body.force,
      s3Config,
      dryRun: false,
      operator: {
        type: 'manual',
        userId: req.admin.id,
        ip: req.ip
      }
    }).catch(error => {
      logger.error('Background restore failed:', error);
    });

    res.json({
      success: true,
      message: 'Restore operation started'
    });
  } catch (error) {
    logger.error('Failed to start restore:', error);
    logger.error('Error stack:', error.stack);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to start restore operation'
    });
  }
});

/**
 * Get current restore progress
 */
router.get('/progress', requirePermission('backup.view'), async (req, res) => {
  try {
    const progress = restoreService.getProgress();
    const logs = restoreService.restoreLog.slice(-50); // Last 50 log entries
    
    res.json({
      success: true,
      data: {
        isRunning: restoreService.isRunning,
        progress: progress,
        logs: logs
      }
    });
  } catch (error) {
    logger.error('Failed to get restore progress:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get restore progress'
    });
  }
});

/**
 * Get restore run details
 */
router.get('/run/:id', requirePermission('backup.view'), async (req, res) => {
  try {
    const run = await db('restore_runs')
      .where('id', req.params.id)
      .first();
    
    if (!run) {
      return res.status(404).json({
        success: false,
        error: 'Restore run not found'
      });
    }
    
    // Parse JSON fields
    if (run.statistics) run.statistics = JSON.parse(run.statistics);
    if (run.restore_log) run.restore_log = JSON.parse(run.restore_log);
    if (run.metadata) run.metadata = JSON.parse(run.metadata);
    
    // Get validation results
    const validations = await db('restore_validation_results')
      .where('restore_run_id', run.id)
      .select('*');
    
    validations.forEach(v => {
      if (v.errors) v.errors = JSON.parse(v.errors);
      if (v.warnings) v.warnings = JSON.parse(v.warnings);
      if (v.checksums) v.checksums = JSON.parse(v.checksums);
    });
    
    // Get file operations summary
    const fileOps = await db('restore_file_operations')
      .where('restore_run_id', run.id)
      .select('status', db.raw('COUNT(*) as count'))
      .groupBy('status');
    
    res.json({
      success: true,
      data: {
        run: run,
        validations: validations,
        fileOperations: fileOps
      }
    });
  } catch (error) {
    logger.error('Failed to get restore run details:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get restore run details'
    });
  }
});

/**
 * Get restore run report
 */
router.get('/run/:id/report', requirePermission('backup.view'), async (req, res) => {
  try {
    const run = await db('restore_runs')
      .where('id', req.params.id)
      .first();
    
    if (!run) {
      return res.status(404).json({
        success: false,
        error: 'Restore run not found'
      });
    }
    
    // Parse JSON fields
    if (run.statistics) run.statistics = JSON.parse(run.statistics);
    if (run.restore_log) run.restore_log = JSON.parse(run.restore_log);
    
    // Generate report
    const report = restoreService.generateRestoreReport({
      success: run.status === 'completed',
      duration: run.duration_seconds,
      dryRun: run.is_dry_run,
      result: run.statistics,
      logs: run.restore_log || []
    });
    
    res.type('text/plain').send(report);
  } catch (error) {
    logger.error('Failed to generate restore report:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate restore report'
    });
  }
});

/**
 * List available backups for restore
 */
router.get('/available-backups', requirePermission('backup.view'), async (req, res) => {
  try {
    const backups = await discoverAvailableBackups();
    res.json({
      success: true,
      data: backups
    });
  } catch (error) {
    logger.error('Failed to list available backups:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list available backups'
    });
  }
});

/**
 * Discover restorable backups by walking the configured destination
 * directory + harvesting the backup_runs table.
 *
 * **Why we recurse the disk first, DB second**
 *
 * The disk is the source of truth for restore. After a disaster
 * (`docker compose down -v`, drive corruption, fresh install) the
 * `backup_runs` table is empty — but the manifest JSONs are exactly
 * what's left on disk for an admin to recover from. A wizard that
 * only reads the DB shows "No backups found" precisely when the
 * admin needs it most. So we walk first, dedupe-by-manifestId
 * against any surviving DB rows, and present a unified list.
 *
 * Discovery rules:
 *   - Walks `backup_destination_path` AND `backup_manifest_path` if
 *     they're distinct (manifests can live in a sibling directory).
 *   - Recurses up to 3 levels deep — enough to find
 *     `<root>/manifests/backup-manifest-<id>.json` (the default
 *     layout) without scanning the entire photo tree.
 *   - Matches manifest files by glob: `backup-manifest-*.json`,
 *     `backup-manifest-*.yaml`, and the legacy bare `manifest.json`.
 *   - Parses each manifest to extract real metadata (timestamp,
 *     size, file count, source type) instead of showing the admin
 *     a list of opaque filenames.
 *
 * Returns: array of `{ type, name, path, manifestId, size,
 * filesCount, completed, source: 'disk' | 'db' }`.
 */
async function discoverAvailableBackups() {
  const backupConfig = await getBackupConfig();
  const backups = [];
  const seenManifestIds = new Set();

  if (backupConfig.backup_destination_type === 'local') {
    const roots = new Set();
    if (backupConfig.backup_destination_path) roots.add(backupConfig.backup_destination_path);
    if (backupConfig.backup_manifest_path)    roots.add(backupConfig.backup_manifest_path);

    for (const root of roots) {
      try {
        const manifestPaths = await walkForManifests(root, 3);
        for (const filePath of manifestPaths) {
          try {
            const parsed = await parseManifestMetadata(filePath);
            if (parsed.manifestId) seenManifestIds.add(parsed.manifestId);
            backups.push(parsed);
          } catch (err) {
            // Don't fail discovery because ONE manifest is corrupt —
            // surface the file with a note so the admin sees something
            // is wrong and can investigate.
            logger.warn(`Manifest unreadable at ${filePath}: ${err.message}`);
            const stats = await fs.stat(filePath).catch(() => null);
            backups.push({
              type: 'local',
              name: path.basename(filePath),
              path: filePath,
              manifestId: null,
              size: stats?.size || 0,
              filesCount: null,
              completed: stats?.mtime || null,
              source: 'disk',
              corrupt: true,
              error: err.message,
            });
          }
        }
      } catch (err) {
        logger.warn(`Could not scan backup root ${root}: ${err.message}`);
      }
    }
  }

  // Layer in surviving DB rows, deduping by manifest_id so we don't
  // show the same backup twice with different shapes.
  const backupRuns = await db('backup_runs')
    .where('status', 'completed')
    .whereNotNull('manifest_path')
    .orderBy('completed_at', 'desc')
    .limit(50);

  for (const run of backupRuns) {
    if (run.manifest_id && seenManifestIds.has(run.manifest_id)) continue;
    backups.push({
      type: run.manifest_path.startsWith('s3://') ? 's3' : 'local',
      name: `Backup ${run.completed_at}`,
      path: run.manifest_path,
      manifestId: run.manifest_id,
      size: run.total_size_bytes,
      filesCount: run.files_backed_up,
      duration: run.duration_seconds,
      completed: run.completed_at,
      source: 'db',
    });
  }

  // Most recent first.
  backups.sort((a, b) => {
    const aTime = a.completed ? new Date(a.completed).getTime() : 0;
    const bTime = b.completed ? new Date(b.completed).getTime() : 0;
    return bTime - aTime;
  });

  return backups;
}

/**
 * Recursive manifest finder. Depth-limited so we don't enumerate
 * thousands of photo files. Yields absolute paths.
 */
async function walkForManifests(dir, maxDepth, depth = 0) {
  if (depth > maxDepth) return [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const out = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip obvious noise: photo trees, node_modules, hidden dirs.
      if (entry.name === 'events' || entry.name === 'business-docs'
          || entry.name === 'thumbnails' || entry.name === 'previews'
          || entry.name === 'heroes' || entry.name === 'uploads'
          || entry.name.startsWith('.')
          || entry.name === 'node_modules') continue;
      out.push(...await walkForManifests(full, maxDepth, depth + 1));
    } else if (entry.isFile() && isManifestFilename(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function isManifestFilename(name) {
  // Canonical: backup-manifest-<id>.json / .yaml
  // Legacy:    manifest.json (inside backup-<id>/manifest.json layout)
  // Be liberal in what we accept — admin may have renamed.
  if (/^backup-manifest-.+\.(json|ya?ml)$/i.test(name)) return true;
  if (/^manifest\.(json|ya?ml)$/i.test(name)) return true;
  return false;
}

/**
 * Parse a manifest file and pull out the fields the wizard wants.
 * Tolerates schema drift across manifest versions (v1, v2) by
 * checking multiple shapes.
 */
async function parseManifestMetadata(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  let parsed;
  if (filePath.toLowerCase().endsWith('.json')) {
    parsed = JSON.parse(raw);
  } else {
    // Minimal YAML support — most admins use JSON; only do require()
    // if a .yaml manifest is actually present.
    const yaml = require('js-yaml');
    parsed = yaml.load(raw);
  }

  const stats = await fs.stat(filePath);

  // v2 shape: { manifest: { id, timestamp }, backup: { ... }, files: [...], database: { ... } }
  // v1 shape: { backup_id, started_at, files: [...] }  (older)
  const manifestId =
    parsed?.manifest?.id
    || parsed?.backup?.id
    || parsed?.backup_id
    || null;

  const completed =
    parsed?.backup?.completed_at
    || parsed?.manifest?.timestamp
    || parsed?.completed_at
    || stats.mtime;

  const filesCount =
    (Array.isArray(parsed?.files) ? parsed.files.length : null)
    ?? parsed?.backup?.total_files
    ?? null;

  const totalSizeBytes =
    parsed?.backup?.total_size_bytes
    ?? parsed?.total_size_bytes
    ?? null;

  return {
    type: 'local',
    name: path.basename(filePath),
    path: filePath,
    manifestId,
    size: totalSizeBytes ?? stats.size,
    filesCount,
    completed,
    source: 'disk',
    databaseIncluded: Boolean(parsed?.database?.backup_file),
    // Helpful for the UI: lets it show "This backup has no DB" warning
    // — exactly the surface that would have caught Ralf's original
    // four files-only manifests if it had existed.
    schemaVersion: parsed?.manifest?.version || parsed?.version || '1.0',
  };
}

/**
 * List backups for restore (POST version for frontend compatibility)
 * Accepts source type in request body
 */
router.post('/list-backups', requirePermission('backup.view'), async (req, res) => {
  try {
    const { source } = req.body; // 'local', 's3', or undefined for all

    // Use the same disk-first discovery the GET endpoint uses so that
    // a fresh post-`docker compose down -v` install (empty backup_runs
    // table) can still see what's on disk. The whole point of restore
    // is "the DB is broken, rebuild it from disk" — a wizard that
    // only queries the DB shows "No backups found" exactly when it's
    // needed most. See discoverAvailableBackups for the full rationale.
    const discovered = await discoverAvailableBackups();

    const filtered = source
      ? discovered.filter((b) => b.type === source)
      : discovered;

    // Shape for frontend compatibility — preserves every alias the
    // frontend was already reading (snake_case + camelCase), so the
    // UI rendering doesn't have to change.
    const backups = filtered.map((b) => ({
      id: b.manifestId || null,
      type: b.type,
      name: b.completed
        ? `Backup from ${new Date(b.completed).toLocaleString()}`
        : b.name,
      path: b.path,
      manifest_path: b.path,
      manifestId: b.manifestId,
      manifestPath: b.path,
      size: parseInt(b.size) || 0,
      total_size: parseInt(b.size) || 0,
      total_size_bytes: parseInt(b.size) || 0,
      filesCount: b.filesCount || 0,
      files_backed_up: b.filesCount || 0,
      duration: b.duration || null,
      duration_seconds: b.duration || null,
      created_at: b.completed,
      completed_at: b.completed,
      started_at: b.completed,
      completedAt: b.completed,
      startedAt: b.completed,
      status: 'completed',
      // Stage A-aware: when the source is a disk-scanned manifest we
      // can tell the wizard whether the DB dump is present, so the
      // UI can warn before the admin picks a files-only backup.
      database_included: b.databaseIncluded,
      databaseIncluded: b.databaseIncluded,
      corrupt: b.corrupt || false,
      // Provenance: 'disk' (manifest read from filesystem) vs 'db'
      // (backup_runs row that the disk didn't surface) — useful for
      // debugging which side is missing.
      source: b.source,
      schema_version: b.schemaVersion,
      schemaVersion: b.schemaVersion,
    }));

    res.json({
      success: true,
      data: backups,
      source: source || 'all'
    });
  } catch (error) {
    logger.error('Failed to list backups for restore:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list backups for restore'
    });
  }
});

/**
 * Get restore settings
 */
router.get('/settings', requirePermission('backup.view'), async (req, res) => {
  try {
    const settings = await getRestoreSettings();
    res.json({
      success: true,
      data: settings
    });
  } catch (error) {
    logger.error('Failed to get restore settings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get restore settings'
    });
  }
});

/**
 * Update restore settings
 */
router.put('/settings', requirePermission('backup.restore'), [
  body('restore_allow_force').optional().isBoolean(),
  body('restore_require_pre_backup').optional().isBoolean(),
  body('restore_max_file_size_mb').optional().isInt({ min: 1 }),
  body('restore_verify_checksums').optional().isBoolean(),
  body('restore_email_on_completion').optional().isBoolean(),
  body('restore_retention_days').optional().isInt({ min: 1 })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      errors: errors.array()
    });
  }

  try {
    // Update settings
    for (const [key, value] of Object.entries(req.body)) {
      await db('app_settings')
        .where('setting_key', key)
        .where('setting_type', 'restore')
        .update({
          setting_value: typeof value === 'boolean' ? (value ? '1' : '0') : value.toString(),
          updated_at: db.fn.now()
        });
    }
    
    logger.info('Restore settings updated', {
      user: req.user.email,
      settings: req.body
    });
    
    res.json({
      success: true,
      message: 'Settings updated successfully'
    });
  } catch (error) {
    logger.error('Failed to update restore settings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update settings'
    });
  }
});

/**
 * Helper function to get restore settings
 */
async function getRestoreSettings() {
  const settings = await db('app_settings')
    .where('setting_type', 'restore')
    .select('setting_key', 'setting_value');

  const result = {};
  settings.forEach(setting => {
    // Boolean-string normalization. Historically only handled '1'/'0',
    // but other code paths (boot self-heal, admin UI, direct SQL) write
    // 'true' / 'false' or JSON-encoded "true" / "false". Accept all four
    // shapes so `!settings.<key>` evaluates correctly downstream.
    const raw = setting.setting_value;
    if (raw === '1' || raw === 'true' || raw === '"true"') {
      result[setting.setting_key] = true;
    } else if (raw === '0' || raw === 'false' || raw === '"false"') {
      result[setting.setting_key] = false;
    } else {
      result[setting.setting_key] = raw;
    }
  });

  return result;
}

/**
 * Helper function to get backup configuration
 */
async function getBackupConfig() {
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
}

module.exports = router;
