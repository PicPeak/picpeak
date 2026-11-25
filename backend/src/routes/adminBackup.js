const express = require('express');
const { db } = require('../database/db');
const { adminAuth } = require('../middleware/auth');
const { requirePermission, requireSuperAdmin, isSuperAdminUser } = require('../middleware/permissions');
const { triggerManualBackup, getBackupStatus, getBackupManifest } = require('../services/backupService');
const logger = require('../utils/logger');
const { errorResponse, getPagination } = require('../utils/routeHelpers');
const fs = require('fs').promises;
const path = require('path');
const archiver = require('archiver');
const S3StorageAdapter = require('../services/storage/s3Storage');
const { getStoragePath } = require('../config/storage');
const { findWriteBlocker, localDestinationHint } = require('../utils/localBackupDestination');
const {
  STANDALONE_SNAPSHOT_RE, isStandaloneRestorePoint, resolveBackupPointLocation, parseS3Location,
  standaloneSnapshotOfRun, removeLocalSnapshot,
} = require('../utils/backupRestorePoint');
const {
  APPROVAL_SETTING: S3_APPROVAL_SETTING,
  backupS3Access,
  backupS3Ssl,
  classifyS3Endpoint,
  endpointOrigin,
  isPrivateEndpointApproved,
  policyApplies: s3PolicyApplies,
} = require('../utils/s3EndpointPolicy');

const backupVerification = require('../services/backupVerificationService');
const { requireFeatureFlag } = require('../middleware/requireFeatureFlag');

const router = express.Router();
const restoreTestGate = requireFeatureFlag(backupVerification.FLAG);

// Where backups are sent, and whether they carry the database, decides who
// ends up with a full copy of this instance. backup.create is held by the
// built-in admin role, so changing those settings is limited to super_admin.
// Schedule, retention and which files to include stay on backup.create.
// The manifest path and format decide where the manifest file is written,
// so they count as a destination too.
const DESTINATION_SETTING_RE = /^backup_(destination_|s3_|rsync_|manifest_path$|manifest_format$)/;
const MANIFEST_FORMATS = new Set(['json', 'yaml']);
const DATABASE_SETTING_KEYS = new Set(['backup_include_database', 'backup_database_inline_dump']);
const SECRET_MASK = '••••••••';

// backup_rsync_ssh_key is the PATH of a private key file: buildRsyncArgs
// hands it to `ssh -i`. The form used to ask for the key itself, so some
// installs hold a pasted private key here instead; that value stays masked
// and is refused on save. Same charset and length as validateRsyncParam.
const isSshKeyPath = (value) => typeof value === 'string'
  && value.length <= 1024
  && /^\/[a-zA-Z0-9._/@:-]+$/.test(value);

// Read like backupService.normalizeBoolean, which decides what a backup
// actually does: booleans as they are, 'true'/'false' strings, and anything
// else by truthiness.
function readBackupBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
  }
  return Boolean(value);
}

function comparableBackupSetting(key, value) {
  if (key === 'backup_include_database') return readBackupBoolean(value);
  if (key === 'backup_database_inline_dump') {
    // The inline dump stays on unless it was explicitly turned off.
    return value === undefined || value === null ? true : readBackupBoolean(value);
  }
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

/** The destination and database-inclusion keys this update would change. */
async function changedRestrictedBackupSettings(updates) {
  const keys = Object.keys(updates || {}).filter((key) => (
    (DESTINATION_SETTING_RE.test(key) || DATABASE_SETTING_KEYS.has(key)) && updates[key] !== SECRET_MASK
  ));
  if (keys.length === 0) return [];
  const rows = await db('app_settings')
    .where('setting_type', 'backup')
    .whereIn('setting_key', keys)
    .select('setting_key', 'setting_value');
  const stored = new Map(rows.map((row) => {
    try {
      return [row.setting_key, JSON.parse(row.setting_value)];
    } catch {
      return [row.setting_key, row.setting_value];
    }
  }));
  return keys.filter((key) => comparableBackupSetting(key, updates[key]) !== comparableBackupSetting(key, stored.get(key)));
}

const S3_ERROR_MESSAGES = {
  S3_PRIVATE_ENDPOINT: 'S3 endpoint resolves to a private or internal network address. A Super Admin must approve this exact endpoint before it can be used.',
  S3_ENDPOINT_FORBIDDEN: 'S3 endpoint resolves to a link-local, metadata or reserved address, which can never be approved',
  S3_ENDPOINT_UNRESOLVED: 'S3 endpoint hostname could not be resolved',
  S3_ENDPOINT_INVALID: 'S3 endpoint is not a valid URL',
  S3_APPROVAL_MISMATCH: 'The approval does not match the configured S3 endpoint',
};

const s3ErrorBody = (code, origin) => ({
  error: S3_ERROR_MESSAGES[code] || 'S3 endpoint is not permitted',
  code,
  severity: code === 'S3_PRIVATE_ENDPOINT' ? 'warning' : 'error',
  ...(origin && { origin }),
  ...(code === 'S3_PRIVATE_ENDPOINT' && { requiresApproval: true }),
});

const S3_STATUS_CODES = {
  approvable: 'S3_PRIVATE_ENDPOINT',
  forbidden: 'S3_ENDPOINT_FORBIDDEN',
  unresolved: 'S3_ENDPOINT_UNRESOLVED',
  invalid: 'S3_ENDPOINT_INVALID',
};

/**
 * Vet the S3 endpoint a config update would leave in place. Returns
 * { error } with a 400 body, or {} — clearing a stored approval when the
 * endpoint it approved is no longer the configured one.
 */
async function checkS3EndpointUpdate(updates) {
  const touched = ['backup_s3_endpoint', 'backup_s3_ssl_enabled', S3_APPROVAL_SETTING]
    .some((key) => Object.prototype.hasOwnProperty.call(updates || {}, key) && updates[key] !== SECRET_MASK);
  if (!touched || !s3PolicyApplies()) return {};

  const effective = { ...(await getBackupConfig()) };
  for (const [key, value] of Object.entries(updates)) {
    if (value !== SECRET_MASK) effective[key] = value;
  }
  if (!effective.backup_s3_endpoint) return {};

  const sslEnabled = readBackupBoolean(effective.backup_s3_ssl_enabled ?? true);
  const { status, origin } = await classifyS3Endpoint(effective.backup_s3_endpoint, sslEnabled);
  const approval = typeof effective[S3_APPROVAL_SETTING] === 'string' ? effective[S3_APPROVAL_SETTING].trim() : '';
  const approvalSupplied = typeof updates[S3_APPROVAL_SETTING] === 'string' && updates[S3_APPROVAL_SETTING].trim() !== '';

  if (approvalSupplied && updates[S3_APPROVAL_SETTING].trim() !== origin) {
    return { error: s3ErrorBody('S3_APPROVAL_MISMATCH', origin) };
  }
  if (status === 'approvable' && approval === origin) return {};
  if (status !== 'public') return { error: s3ErrorBody(S3_STATUS_CODES[status], origin) };
  // A public endpoint needs no approval; drop one left over from an earlier
  // private endpoint so it cannot silently come back into force.
  if (approval) updates[S3_APPROVAL_SETTING] = '';
  return {};
}

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

    // Never return the stored credentials — mask like the email/WhatsApp
    // config endpoints do. The PUT below skips the mask sentinel, so the
    // form round-trips without clobbering the real values.
    if (config.backup_s3_secret_key) config.backup_s3_secret_key = '••••••••';
    // A key file path is not a secret and is shown; anything else is a
    // pasted key and stays masked.
    if (config.backup_rsync_ssh_key && !isSshKeyPath(config.backup_rsync_ssh_key)) {
      config.backup_rsync_ssh_key = '••••••••';
    }

    res.json(config);
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to get backup configuration');
  }
});

// Update backup configuration
router.put('/config', adminAuth, requirePermission('backup.create'), async (req, res) => {
  try {
    const updates = req.body;

    // Real booleans only: a string such as "0" would compare as off here but
    // read as on when the backup runs.
    for (const key of DATABASE_SETTING_KEYS) {
      if (Object.prototype.hasOwnProperty.call(updates || {}, key) && typeof updates[key] !== 'boolean') {
        return res.status(400).json({ error: `${key} must be true or false` });
      }
    }

    const sshKeyUpdate = (updates || {}).backup_rsync_ssh_key;
    const sshKeyNotPath = (sshKeyUpdate !== undefined && sshKeyUpdate !== null && typeof sshKeyUpdate !== 'string')
      || (typeof sshKeyUpdate === 'string' && sshKeyUpdate !== SECRET_MASK && sshKeyUpdate.trim() !== ''
        && !isSshKeyPath(sshKeyUpdate.trim()));
    if (sshKeyNotPath) {
      return res.status(400).json({
        error: 'backup_rsync_ssh_key must be the absolute path to a private key file, not the key itself',
        code: 'RSYNC_SSH_KEY_NOT_PATH',
      });
    }
    if (typeof sshKeyUpdate === 'string' && sshKeyUpdate !== SECRET_MASK) {
      updates.backup_rsync_ssh_key = sshKeyUpdate.trim();
    }

    // Stored trimmed: the database dump reads this setting trimmed
    // (databaseBackup.js readSettingValue) while the file backup and the
    // restore use it as stored, so a padded value split one backup across
    // two directories.
    if (typeof (updates || {}).backup_destination_path === 'string') {
      updates.backup_destination_path = updates.backup_destination_path.trim();
    }

    if (Object.prototype.hasOwnProperty.call(updates || {}, 'backup_rsync_port')) {
      const port = updates.backup_rsync_port;
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return res.status(400).json({ error: 'backup_rsync_port must be a whole number from 1 to 65535', code: 'RSYNC_CONFIG_INVALID' });
      }
    }

    if (Object.prototype.hasOwnProperty.call(updates || {}, 'backup_manifest_format')
        && !MANIFEST_FORMATS.has(updates.backup_manifest_format)) {
      return res.status(400).json({ error: 'backup_manifest_format must be json or yaml' });
    }

    // How many standalone restore points a local or S3 destination keeps;
    // 0 keeps all. A whole number only: the backup prunes by it unattended.
    if (Object.prototype.hasOwnProperty.call(updates || {}, 'backup_retention_count')
        && (!Number.isInteger(updates.backup_retention_count)
          || updates.backup_retention_count < 0 || updates.backup_retention_count > 1000)) {
      return res.status(400).json({ error: 'backup_retention_count must be a whole number between 0 and 1000' });
    }

    // Extra restore points kept per calendar month (the first backup of each
    // of the last N months), on top of backup_retention_count. 0 = none.
    if (Object.prototype.hasOwnProperty.call(updates || {}, 'backup_retention_monthly_count')
        && (!Number.isInteger(updates.backup_retention_monthly_count)
          || updates.backup_retention_monthly_count < 0 || updates.backup_retention_monthly_count > 120)) {
      return res.status(400).json({ error: 'backup_retention_monthly_count must be a whole number between 0 and 120' });
    }

    // Restore test settings (backupRestoreTest): validated here because the
    // schedule and the sampler run unattended on whatever is stored.
    const has = (key) => Object.prototype.hasOwnProperty.call(updates || {}, key);
    if (has('backup_verify_enabled') && typeof updates.backup_verify_enabled !== 'boolean') {
      return res.status(400).json({ error: 'backup_verify_enabled must be true or false' });
    }
    if (has('backup_verify_cron') && !backupVerification.isCron(updates.backup_verify_cron)) {
      return res.status(400).json({ error: 'backup_verify_cron must be a valid 5-field cron expression' });
    }
    if (has('backup_verify_sample_percent') && (!Number.isInteger(updates.backup_verify_sample_percent)
        || updates.backup_verify_sample_percent < 0 || updates.backup_verify_sample_percent > 100)) {
      return res.status(400).json({ error: 'backup_verify_sample_percent must be a whole number between 0 and 100' });
    }

    const restricted = await changedRestrictedBackupSettings(updates);
    if (restricted.length > 0 && !(await isSuperAdminUser(req.admin && req.admin.id))) {
      return res.status(403).json({
        error: 'Only a Super Admin can change where backups are stored or whether they include the database',
        code: 'SUPER_ADMIN_REQUIRED',
        fields: restricted,
      });
    }
    
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

    // SSRF: validate the S3 endpoint whenever it (or its approval) is
    // supplied — NOT only when the payload also flips backup_destination_type
    // to 's3'. The PUT persists every backup_* field independently, so with
    // S3 already selected a caller could PATCH just backup_s3_endpoint to a
    // private-resolving host; the management ops (manifest, bucket/file
    // browse, cleanup, test-upload) then connect without going through
    // testConnection. Prod-only; dev points at localhost MinIO deliberately.
    //
    // A private endpoint is accepted only with a Super Admin's approval of
    // that exact origin (issue 1641). The approval key matches
    // DESTINATION_SETTING_RE, so the Super Admin check above already covers
    // who may set it.
    const endpointUpdate = await checkS3EndpointUpdate(updates);
    if (endpointUpdate.error) {
      return res.status(400).json(endpointUpdate.error);
    }

    // Update settings
    for (const [key, value] of Object.entries(updates)) {
      // An unchanged secret round-trips as the GET mask sentinel — keep the
      // stored value instead of overwriting it with bullets.
      if (value === '••••••••') {
        continue;
      }
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
    
    if (has('backup_verify_enabled') || has('backup_verify_cron')) {
      await backupVerification.startVerificationSchedule();
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

// Restore tests (backupRestoreTest flag): the latest results and the
// health they add up to.
router.get('/verifications', adminAuth, restoreTestGate, requirePermission('backup.view'), async (req, res) => {
  try {
    const { limit } = getPagination(req, { limit: 20 });
    res.json(await backupVerification.getSummary({ limit }));
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to load backup restore tests');
  }
});

// Run a restore test now. Same bar as a restore dry run (backup.restore):
// it fetches the backup back and loads its dump, if into a throwaway DB.
router.post('/verifications', adminAuth, restoreTestGate, requirePermission('backup.restore'), async (req, res) => {
  try {
    const body = req.body || {};
    const id = (value) => (value === undefined || value === null ? null : value);
    const backupRunId = id(body.backupRunId);
    const databaseBackupRunId = id(body.databaseBackupRunId);
    for (const [key, value] of [['backupRunId', backupRunId], ['databaseBackupRunId', databaseBackupRunId]]) {
      if (value !== null && (!Number.isInteger(value) || value <= 0)) {
        return res.status(400).json({ error: `${key} must be a positive whole number` });
      }
    }
    if (backupRunId !== null && databaseBackupRunId !== null) {
      return res.status(400).json({ error: 'Give either backupRunId or databaseBackupRunId, not both' });
    }
    if (body.full !== undefined && typeof body.full !== 'boolean') {
      return res.status(400).json({ error: 'full must be true or false' });
    }
    const verificationId = await backupVerification.startNow({
      backupRunId, databaseBackupRunId, full: body.full === true, adminId: req.admin && req.admin.id,
    });
    res.status(202).json({ id: verificationId });
  } catch (error) {
    if (error.code === 'VERIFICATION_BUSY') return res.status(409).json({ error: error.message, code: error.code });
    if (error.code === 'NO_BACKUP') return res.status(404).json({ error: error.message, code: error.code });
    errorResponse(res, error, 500, 'Failed to start the backup restore test');
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
// Full-instance export dumps every table unredacted — bcrypt password
// hashes, 2FA columns, and all integration secrets (SMTP/SSO/WhatsApp/
// webhook/S3) in cleartext. The built-in `admin` role holds backup.create,
// but is denied this data everywhere else (config APIs mask secrets as
// ********). Gate the raw dump behind super_admin (GHSA-pv6w-rj34-wj9v).
router.get('/picpeak/export', adminAuth, requireSuperAdmin(), async (req, res) => {
  const fsSync = require('fs');
  try {
    const includePhotos = req.query.includePhotos === 'true' || req.query.includePhotos === '1';
    const { createPicpeak } = require('../services/picpeakExportService');
    const { filePath } = await createPicpeak({ includePhotos });
    const filename = path.basename(filePath);
    res.setHeader('X-Picpeak-Contains-Secrets', 'true');
    // A .picpeak is a zip; Express does not know the extension and would send
    // application/octet-stream (issue 2178).
    res.download(filePath, filename, { headers: { 'Content-Type': 'application/zip' } }, (err) => {
      // Best-effort cleanup of the temp .picpeak (and its temp dir) after send.
      fsSync.rm(path.dirname(filePath), { recursive: true, force: true }, () => {});
      if (err) logger.error('[picpeak-export] download failed', { error: err.message });
    });
  } catch (error) {
    logger.error('[picpeak-export] failed to create export', { error: error.message });
    if (!res.headersSent) res.status(500).json({ error: 'Failed to create .picpeak export' });
  }
});

// Portable import is mounted by server.js at the dedicated, exact-path
// maintenance control boundary. It must not have a second unsupervised
// importer entrypoint in the ordinary API router.

// Delete one backup run (issue 1711). The History table's trash action called
// this route before it existed, so every click was a 404.
//
// What "the stored artifact" is depends on the destination, and only the
// metadata recorded on the run at backup time decides where to look, never
// anything in the request. A standalone run (backup-<uuid>) is a complete
// copy nothing else depends on, so its whole validated snapshot directory or
// prefix goes with it. For a legacy run it is the run's own
// metadata, never its data files: a legacy incremental run only stores files
// that changed since the previous one (hasFileChanged against the shared
// backup_file_states table), so a later run's manifest points at files that
// exist only under an earlier run. Removing those would take the only copy.
//   s3     the manifest objects under <run prefix>/manifests/ and the run's
//          backup-summary.json, with the prefix derived from the recorded
//          manifest_path (<base>/<date>/backup-<ts>/manifests/<file>) and
//          only when it sits under the configured bucket and base prefix.
//          The data objects under a legacy prefix stay.
//   local  the manifest file, in the configured manifest directory. The
//          legacy mirror under backup_destination_path stays.
//   rsync  the local manifest as above; nothing on the remote mirror.
// The record goes only after the artifact step succeeded or found nothing to
// do, so the UI never reports a deletion that left storage behind.
const backupDeleteError = (res, status, code, message) => res.status(status).json({ error: message, code });

// A 'running' row the dashboard flags as possibly crashed (older than
// ZOMBIE_THRESHOLD_MS) that started before this process booted and that this
// process is not writing: with one backend process, a process that has since
// died left it. A restore ends the rows it brings back itself
// (interruptedRuns). Backups have no lease, so this cannot tell abandonment
// across processes: with several workers (a PM2 cluster, which backups do
// not support anyway, their lock being in memory) a worker that restarted
// alone could delete a sibling's live row.
function isAbandonedRunningRow(run) {
  const { BOOTED_AT, ZOMBIE_THRESHOLD_MS } = require('../services/interruptedRuns');
  const { toTimestamp } = require('../utils/dateNormalize');
  const backupService = require('../services/backupService');
  if (backupService.isBackupRunning() && Number(backupService.currentRunId()) === Number(run.id)) return false;
  const startedAt = toTimestamp(run.started_at);
  return Number.isFinite(startedAt) && startedAt < BOOTED_AT && Date.now() - startedAt > ZOMBIE_THRESHOLD_MS;
}

class ArtifactOutOfScopeError extends Error {
  constructor(message) {
    super(message);
    this.code = 'ARTIFACT_OUT_OF_SCOPE';
  }
}

async function deleteLocalBackupManifest(config, run) {
  const manifestPath = run.manifest_path.trim();
  const destinationRoot = config.backup_destination_path || path.join(getStoragePath(), 'backups');
  const manifestDir = config.backup_manifest_path || path.join(destinationRoot, 'manifests');
  const resolved = path.resolve(manifestPath);
  // The writer stores path.join(manifestDir, basename), so a genuine manifest
  // sits directly in the manifest directory. Requiring exactly that, rather
  // than "somewhere below it", also rules out a symlinked subdirectory that
  // points outside, which a prefix check would follow.
  // <destination>/manifests is also where a manifest lands when the configured
  // directory was not usable (saveManifestToLocal), as is a standalone
  // snapshot's own manifests directory.
  if (path.dirname(resolved) !== path.resolve(manifestDir)
      && path.dirname(resolved) !== path.resolve(destinationRoot, 'manifests')) {
    const selectedManifestDir = path.dirname(resolved);
    const snapshotRoot = path.dirname(selectedManifestDir);
    if (path.basename(selectedManifestDir) !== 'manifests'
        || path.dirname(snapshotRoot) !== path.resolve(destinationRoot)
        || !STANDALONE_SNAPSHOT_RE.test(path.basename(snapshotRoot))) {
      throw new ArtifactOutOfScopeError('The recorded manifest is outside the configured manifest directory');
    }
    try {
      const realDestination = await fs.realpath(destinationRoot);
      const realSnapshot = await fs.realpath(snapshotRoot);
      const realManifestDir = await fs.realpath(selectedManifestDir);
      if (path.dirname(realSnapshot) !== realDestination
          || realManifestDir !== path.join(realSnapshot, 'manifests')) {
        throw new ArtifactOutOfScopeError('The recorded snapshot manifest escapes its configured directory');
      }
    } catch (error) {
      if (error.code === 'ENOENT') return { kind: 'manifest', status: 'missing', removed: 0 };
      throw error;
    }
    const removed = await removeLocalSnapshot(destinationRoot, snapshotRoot);
    return { kind: 'snapshot', status: removed ? 'deleted' : 'missing', removed: removed ? 1 : 0 };
  }
  // A manifest kept in backup_manifest_path: its snapshot is where the run
  // recorded it.
  const snapshot = standaloneSnapshotOfRun(config, run);
  if (snapshot && snapshot.type === 'local') {
    const removed = await removeLocalSnapshot(snapshot.destinationRoot, snapshot.root);
    await fs.rm(resolved, { force: true });
    return { kind: 'snapshot', status: removed ? 'deleted' : 'missing', removed: removed ? 1 : 0 };
  }
  try {
    await fs.unlink(resolved);
    return { kind: 'manifest', status: 'deleted', removed: 1 };
  } catch (error) {
    if (error.code === 'ENOENT') return { kind: 'manifest', status: 'missing', removed: 0 };
    throw error;
  }
}

async function deleteS3BackupRun(config, manifestPath) {
  const match = manifestPath.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new ArtifactOutOfScopeError('The recorded manifest location is not a usable S3 reference');
  const [, bucket, key] = match;
  if (config.backup_destination_type !== 's3' || !config.backup_s3_bucket || bucket !== config.backup_s3_bucket) {
    throw new ArtifactOutOfScopeError('This backup is stored in a bucket that is not the configured backup destination');
  }
  // The same normalisation performS3Backup applies when it builds the key
  // (path.posix.join keeps a leading slash and collapses doubled ones), so a
  // prefix configured as "/backups" or "archive/picpeak/" matches its own runs.
  const baseWithSlash = path.posix.join(config.backup_s3_prefix ? String(config.backup_s3_prefix) : 'backups', '/');
  const manifestsAt = key.lastIndexOf('/manifests/');
  const runPrefix = manifestsAt > 0 ? key.slice(0, manifestsAt) : '';
  const runSegment = runPrefix.split('/').pop() || '';
  if (baseWithSlash === '/' || !runPrefix.startsWith(baseWithSlash)
      || (!/^backup-\d+$/.test(runSegment) && !STANDALONE_SNAPSHOT_RE.test(runSegment)) || runPrefix.includes('..')) {
    throw new ArtifactOutOfScopeError('The recorded manifest location is outside the configured backup prefix');
  }

  const s3Adapter = new S3StorageAdapter({
    endpoint: config.backup_s3_endpoint,
    bucket: config.backup_s3_bucket,
    accessKeyId: config.backup_s3_access_key,
    secretAccessKey: config.backup_s3_secret_key,
    region: config.backup_s3_region || 'us-east-1',
    forcePathStyle: config.backup_s3_force_path_style || false,
    sslEnabled: backupS3Ssl(config),
    ...backupS3Access(config)
  });

  // A standalone snapshot goes whole; of a legacy run only the metadata
  // objects (see the comment above the route).
  const standalone = STANDALONE_SNAPSHOT_RE.test(runSegment);
  const kind = standalone ? 'snapshot' : 'manifest';
  const keys = [];
  for (const listPrefix of standalone ? [`${runPrefix}/`] : [`${runPrefix}/manifests/`, `${runPrefix}/backup-summary.json`]) {
    let continuationToken;
    do {
      const page = await s3Adapter.list(listPrefix, { maxKeys: 1000, continuationToken });
      for (const object of page.Contents || page.objects || []) {
        const objectKey = object.Key || object.key;
        // The listing is prefix-scoped already; refuse anything that is not.
        if (objectKey && objectKey.startsWith(listPrefix)) keys.push(objectKey);
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  if (keys.length === 0) return { kind, status: 'missing', removed: 0 };
  const result = await s3Adapter.deleteMany(keys);
  const removed = result.Deleted ? result.Deleted.length : 0;
  const errors = result.Errors || [];
  if (errors.length > 0) {
    const error = new Error(`${errors.length} of ${keys.length} objects could not be deleted`);
    error.code = 'ARTIFACT_DELETE_FAILED';
    error.removed = removed;
    throw error;
  }
  return { kind, status: 'deleted', removed };
}

router.delete('/runs/:id', adminAuth, requirePermission('backup.delete'), async (req, res) => {
  const rawId = String(req.params.id || '').trim();
  const id = /^\d+$/.test(rawId) ? Number.parseInt(rawId, 10) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) {
    return backupDeleteError(res, 404, 'BACKUP_NOT_FOUND', 'Backup run not found');
  }

  const audit = async (activityType, metadata) => {
    try {
      await db('activity_logs').insert({
        activity_type: activityType,
        actor_type: 'admin',
        actor_id: req.admin?.id ?? null,
        actor_name: req.admin?.username ?? null,
        metadata: JSON.stringify(metadata)
      });
    } catch (error) {
      logger.warn('backup run delete: audit entry failed', { error: error.message });
    }
  };

  try {
    const run = await db('backup_runs').where('id', id).first();
    if (!run) {
      return backupDeleteError(res, 404, 'BACKUP_NOT_FOUND', 'Backup run not found');
    }
    if (run.status === 'running' && !isAbandonedRunningRow(run)) {
      return backupDeleteError(res, 409, 'BACKUP_RUNNING', 'A running backup cannot be deleted');
    }

    const config = await getBackupConfig();
    const manifestPath = typeof run.manifest_path === 'string' ? run.manifest_path.trim() : '';
    const destination = manifestPath.startsWith('s3://')
      ? 's3'
      : (config.backup_destination_type || 'local');

    let artifact = { kind: 'none', status: 'none', removed: 0 };
    try {
      if (manifestPath.startsWith('s3://')) {
        artifact = await deleteS3BackupRun(config, manifestPath);
      } else if (manifestPath) {
        artifact = await deleteLocalBackupManifest(config, run);
      }
    } catch (error) {
      const code = error.code === 'ARTIFACT_OUT_OF_SCOPE' ? 'ARTIFACT_OUT_OF_SCOPE' : 'ARTIFACT_DELETE_FAILED';
      logger.error('backup run delete: artifact step failed', {
        backup_run_id: id, destination, code, error: error.message
      });
      await audit('backup_run_delete_failed', {
        backup_run_id: id, destination, code, removed: error.removed || 0
      });
      if (code === 'ARTIFACT_OUT_OF_SCOPE') {
        return backupDeleteError(res, 409, code, `${error.message}; the record was kept`);
      }
      return backupDeleteError(res, 500, code, 'The stored backup files could not be removed; the record was kept');
    }

    // The success audit commits with the deletion, so a deleted run is never
    // without its audit row; a failed audit rolls the record back.
    await db.transaction(async (trx) => {
      await trx('backup_manifest').where('backup_run_id', id).del();
      await require('../services/backupService').deleteVerificationsOf(trx, { backupRunIds: [id] });
      await trx('backup_runs').where('parent_backup_id', id).update({ parent_backup_id: null });
      await trx('backup_runs').where('id', id).del();
      await trx('activity_logs').insert({
        activity_type: 'backup_run_deleted',
        actor_type: 'admin',
        actor_id: req.admin?.id ?? null,
        actor_name: req.admin?.username ?? null,
        metadata: JSON.stringify({
          backup_run_id: id, destination, artifact: artifact.status, removed: artifact.removed
        })
      });
    });

    res.json({ success: true, id, destination, artifact });
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to delete backup run');
  }
});

// Test backup destination connectivity
// Probes a caller-supplied destination, which only matters to whoever may set
// one: super_admin (see changedRestrictedBackupSettings).
router.post('/test-connection', adminAuth, requireSuperAdmin(), async (req, res) => {
  try {
    const { destination_type, ...config } = req.body;
    
    switch (destination_type) {
    case 'local': {
      // The rule the backup itself applies: writable, or missing below a
      // writable ancestor, since performLocalBackup creates the directory.
      // The reason goes into the answer: in production a warn only reaches
      // logs/combined.log, so "check the server logs" showed nothing in
      // `docker compose logs` (issue 1365).
      // Trimmed, as PUT /config stores it.
      const target = typeof config.path === 'string' ? config.path.trim() : '';
      if (!target) {
        res.json({ success: false, message: 'Local backup requires destination path' });
        break;
      }
      const blocker = await findWriteBlocker(target);
      if (!blocker) {
        // Writable, but the backup run refuses a destination that is itself
        // a backed-up folder (issue 1780); say so here rather than there.
        const backupService = require('../services/backupService');
        const clashingFolder = await backupService.backedUpFolderAtDestination({
          ...(await getBackupConfig()),
          backup_destination_type: 'local',
          backup_destination_path: target,
        }, { everyPath: true });
        if (clashingFolder) {
          res.json({
            success: false,
            code: 'LOCAL_PATH_IS_BACKED_UP_FOLDER',
            message: backupService.destinationIsBackedUpFolderMessage(clashingFolder)
          });
          break;
        }
        res.json({ success: true, message: 'Local path is writable' });
        break;
      }
      logger.warn('Local backup path not writable', {
        path: target,
        blockedAt: blocker.path,
        error: blocker.code
      });
      const reason = path.resolve(blocker.path) === path.resolve(target)
        ? `The backend cannot write to ${target} (${blocker.code}).`
        : `${target} does not exist and the backend cannot create it: ${blocker.path} is not writable (${blocker.code}).`;
      res.json({
        success: false,
        code: 'LOCAL_PATH_NOT_WRITABLE',
        message: `${reason} ${localDestinationHint()}`
      });
      break;
    }

    case 'rsync': {
      // The key file path from the form, or the saved one when the form
      // holds the mask or sends none. An explicit '' tests without a key, as
      // saving the emptied field would. A value that is not a path (a pasted
      // key) is never handed to ssh.
      const useSavedKey = typeof config.ssh_key !== 'string' || config.ssh_key.trim() === SECRET_MASK;
      const keyCandidate = useSavedKey
        ? (await getBackupConfig()).backup_rsync_ssh_key
        : config.ssh_key.trim();
      if (keyCandidate && !isSshKeyPath(keyCandidate)) {
        res.json({
          success: false,
          code: 'RSYNC_SSH_KEY_NOT_PATH',
          message: 'The SSH key setting must be the absolute path to a private key file, not the key itself',
        });
        break;
      }
      const sshKeyPath = keyCandidate || null;

      // The remote path a backup would write to, validated as the run does.
      let remotePath;
      try {
        remotePath = require('../services/backupService').validateRsyncParam(config.path, 'remote path');
      } catch (pathError) {
        res.json({ success: false, code: 'RSYNC_CONFIG_INVALID', message: pathError.message });
        break;
      }
      if (!remotePath) {
        res.json({ success: false, code: 'RSYNC_CONFIG_INVALID', message: 'Rsync test requires a remote path' });
        break;
      }

      const rsyncConnection = require('../utils/rsyncConnection');
      let connection;
      try {
        connection = await rsyncConnection.resolveRsyncConnection({
          host: config.host, user: config.user, sshKey: sshKeyPath, port: config.port
        });
      } catch (optionError) {
        res.json({ success: false, code: optionError.code, message: optionError.message });
        break;
      }

      // rsync itself over the backup's -e transport, not `ssh … echo`:
      // rsync-only hosts refuse arbitrary commands (Hetzner Storage Box).
      const probe = await rsyncConnection.probeRsyncDestination(connection, remotePath);
      if (probe.ok) {
        res.json({
          success: true,
          message: probe.exists
            ? 'Rsync connection successful'
            : `Rsync connection successful. ${remotePath} does not exist yet; the first backup creates it.`
        });
        break;
      }
      const failure = rsyncConnection.rsyncProbeFailure(probe.outcome, connection, { remotePath, parent: probe.parent });
      logger.warn('Rsync connection test failed', {
        destination: connection.host,
        code: failure.code,
        error: failure.detail || failure.message
      });
      res.json({ success: false, code: failure.code, message: failure.message.replace(`${failure.code}: `, '') });
      break;
    }

    case 's3': {
      // A real HeadBucket against the values in the form (issue 1641).
      const stored = await getBackupConfig();
      const endpoint = typeof config.endpoint === 'string' ? config.endpoint.trim() : '';
      // The scheme a scheme-less endpoint gets, as a backup run would use it:
      // the form has no SSL field, so the saved setting applies unless the
      // caller sends one.
      const sslEnabled = readBackupBoolean(config.ssl_enabled ?? stored.backup_s3_ssl_enabled ?? true);
      const storedSsl = readBackupBoolean(stored.backup_s3_ssl_enabled ?? true);
      const sameEndpoint = endpointOrigin(endpoint, sslEnabled) === endpointOrigin(stored.backup_s3_endpoint, storedSsl);
      // The form holds the mask for a saved secret. Reuse the stored one only
      // against the endpoint it was saved for, so a test cannot send the
      // saved credentials somewhere new.
      const secretKey = config.secret_key === SECRET_MASK
        ? (sameEndpoint ? stored.backup_s3_secret_key : '')
        : config.secret_key;
      if (!config.bucket || !config.access_key || !secretKey) {
        res.json({ success: false, code: 'S3_CONFIG_INCOMPLETE', message: 'S3 test requires endpoint, bucket and credentials' });
        break;
      }
      const approval = typeof config.private_endpoint_approval === 'string'
        ? config.private_endpoint_approval
        : stored[S3_APPROVAL_SETTING];
      try {
        const s3Adapter = new S3StorageAdapter({
          endpoint: endpoint || undefined,
          bucket: config.bucket,
          accessKeyId: config.access_key,
          secretAccessKey: secretKey,
          region: config.region || 'us-east-1',
          sslEnabled,
          allowPrivateEndpoint: isPrivateEndpointApproved(endpoint, sslEnabled, approval),
          maxRetries: 1,
          connectionTimeout: 10000,
          socketTimeout: 15000,
        });
        await s3Adapter.testConnection();
        res.json({ success: true, message: 'S3 bucket is reachable' });
      } catch (error) {
        if (S3_ERROR_MESSAGES[error.code]) {
          res.json({ success: false, ...s3ErrorBody(error.code, error.origin || endpointOrigin(endpoint, sslEnabled)), message: S3_ERROR_MESSAGES[error.code] });
          break;
        }
        logger.warn('S3 connection test failed', { bucket: config.bucket, error: error.message });
        res.json({ success: false, code: 'S3_CONNECTION_FAILED', message: 'Could not reach the S3 bucket with these settings. Check server logs for details.' });
      }
      break;
    }
        
    default:
      res.status(400).json({ error: 'Invalid destination type' });
    }
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to test connection');
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
      forcePathStyle: config.backup_s3_force_path_style || false,
      sslEnabled: backupS3Ssl(config),
      ...backupS3Access(config)
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

    if (contentMatch) require('../usage/capabilityEvidence').capabilityEvidence(res, 's3_storage', 's3_backups');
    
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
    const { manifest } = await getBackupManifest(backupRun.id);
    const destinationType = manifest.metadata?.destination_type || config.backup_destination_type;

    // A restore point that carries the database dump is database contents,
    // which only a Super Admin may take out (the .picpeak export holds the
    // same line). backup.view still downloads restore points without one.
    if (manifest.database?.backup_file && !(await isSuperAdminUser(req.admin && req.admin.id))) {
      return res.status(403).json({
        error: 'Only a Super Admin can download a backup that contains the database',
        code: 'SUPER_ADMIN_REQUIRED',
      });
    }

    // History belongs to the selected manifest, not the current destination.
    switch (destinationType) {
    case 'local': {
      // Stream local backup as zip
      const backupPath = await resolveBackupPointLocation(manifest, {
        source: 'local', manifestPath: backupRun.manifest_path
      }, config);
      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('error', error => res.destroy(error));
        
      res.attachment(`picpeak-backup-${backupRun.id}.zip`);
      archive.pipe(res);
        
      // Add backup directory contents. A legacy run's tree is the destination
      // root, which now also holds every standalone snapshot; those are not
      // part of it.
      if (isStandaloneRestorePoint(manifest)) {
        archive.directory(backupPath, false);
      } else {
        for (const entry of await fs.readdir(backupPath, { withFileTypes: true })) {
          if (STANDALONE_SNAPSHOT_RE.test(entry.name)) continue;
          if (entry.isDirectory()) archive.directory(path.join(backupPath, entry.name), entry.name);
          else if (entry.isFile()) archive.file(path.join(backupPath, entry.name), { name: entry.name });
        }
      }
        
      // Add manifest if exists
      if (backupRun.manifest_path && await fs.access(backupRun.manifest_path).then(() => true).catch(() => false)) {
        archive.file(backupRun.manifest_path, { name: 'manifest.json' });
      }
        
      await archive.finalize();
      break;
    }

    case 's3': {
      // For S3, provide pre-signed URLs or stream files
      const location = await resolveBackupPointLocation(manifest, {
        source: 's3', manifestPath: backupRun.manifest_path
      }, config);
      const selected = parseS3Location(location);
      const s3Adapter = new S3StorageAdapter({
        endpoint: config.backup_s3_endpoint,
        bucket: selected.bucket,
        accessKeyId: config.backup_s3_access_key,
        secretAccessKey: config.backup_s3_secret_key,
        region: config.backup_s3_region || 'us-east-1',
        forcePathStyle: config.backup_s3_force_path_style || false,
        sslEnabled: backupS3Ssl(config),
        ...backupS3Access(config)
      });
        
      // The adapter returns AWS Contents, not an objects property. Follow
      // every page within this exact point; never return a truncated backup.
      const prefix = selected.prefix + '/';
      const urls = [];
      const seenKeys = new Set();
      const seenTokens = new Set();
      const maxObjects = Math.max(manifest.files.count, manifest.files.manifest.length) + 10;
      let continuationToken;
      do {
        const page = await s3Adapter.list(prefix, { maxKeys: 1000, continuationToken });
        for (const file of page.Contents || []) {
          if (typeof file.Key !== 'string' || !file.Key.startsWith(prefix)
              || seenKeys.has(file.Key) || seenKeys.size >= maxObjects) {
            throw new Error('Invalid or oversized backup object listing');
          }
          seenKeys.add(file.Key);
          urls.push({
            key: file.Key, size: file.Size,
            url: await s3Adapter.getSignedUrl('getObject', file.Key, { expiresIn: 3600 })
          });
        }
        continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
        if (page.IsTruncated && (!continuationToken || seenTokens.has(continuationToken))) {
          throw new Error('Incomplete backup object listing');
        }
        if (continuationToken) seenTokens.add(continuationToken);
      } while (continuationToken);
        
      res.json({
        backupId: backupRun.id,
        type: 's3',
        files: urls,
        expiresIn: 3600,
        message: 'Use the provided URLs to download individual files'
      });
      break;
    }

    case 'rsync':
      return res.status(400).json({ error: 'Direct download not available for rsync backups' });
        
    default:
      return res.status(400).json({ error: 'Unknown backup type' });
    }
  } catch (error) {
    errorResponse(res, error, 500, 'Failed to download backup');
  }
});

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

module.exports = router;
