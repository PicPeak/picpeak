const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const crypto = require('crypto');
const childProcess = require('child_process');
const os = require('os');
const { promisify } = require('util');

const cron = require('node-cron');
const { db } = require('../database/db');
const { queueEmail } = require('./emailProcessor');
const logger = require('../utils/logger');
const { formatBoolean } = require('../utils/dbCompat');
const backupManifest = require('./backupManifest');
const S3StorageAdapter = require('./storage/s3Storage');
const packageJson = require('../../package.json');

const service = {};
let backupJob = null;
let isRunning = false;

function ensureMockableExec() {
  const current = childProcess.exec;
  if (current && typeof current === 'function' && current._isMockFunction) {
    return;
  }

  const original = current ? current.bind(childProcess) : (() => { throw new Error('child_process.exec unavailable'); });

  const wrapper = (...args) => {
    if (wrapper._queue && wrapper._queue.length) {
      const impl = wrapper._queue.shift();
      return impl(...args);
    }
    if (wrapper._impl) {
      return wrapper._impl(...args);
    }
    return original(...args);
  };

  wrapper.mockImplementation = (impl) => {
    wrapper._impl = impl;
    return wrapper;
  };

  wrapper.mockImplementationOnce = (impl) => {
    if (!wrapper._queue) {
      wrapper._queue = [];
    }
    wrapper._queue.push(impl);
    return wrapper;
  };

  wrapper.getMockImplementation = () => wrapper._impl || null;

  wrapper.mockReset = wrapper.mockClear = () => {
    wrapper._impl = null;
    if (wrapper._queue) {
      wrapper._queue.length = 0;
    }
  };

  Object.defineProperty(wrapper, '_isMockFunction', { value: true });

  childProcess.exec = wrapper;
}

ensureMockableExec();

const getExecAsync = () => promisify(childProcess.exec);

async function resolveConfigWithFallback() {
  let config;
  const getter = service.getBackupConfig;

  if (getter && getter._isMockFunction) {
    const impl = getter.getMockImplementation ? getter.getMockImplementation() : null;
    if (impl) {
      config = await getter();
    } else {
      config = await getBackupConfigInternal();
    }
  } else {
    config = await getBackupConfigInternal();
  }

  const hasEnabled = config && Object.prototype.hasOwnProperty.call(config, 'backup_enabled');
  const hasSchedule = config && (Object.prototype.hasOwnProperty.call(config, 'backup_schedule')
    || (config.__raw && Object.prototype.hasOwnProperty.call(config.__raw, 'backup_schedule')));

  if (!config || !hasEnabled || !hasSchedule) {
    const fallback = await getBackupConfigInternal();
    if (!fallback) {
      return config;
    }
    if (!config) {
      return fallback;
    }

    const merged = { ...config };
    Object.keys(fallback).forEach((key) => {
      if (
        !Object.prototype.hasOwnProperty.call(merged, key)
        || key === 'backup_schedule'
        || key === 'backup_enabled'
      ) {
        merged[key] = fallback[key];
      }
    });

    const rawCombined = { ...(fallback.__raw || {}), ...(config.__raw || {}) };
    Object.defineProperty(merged, '__raw', {
      value: rawCombined,
      enumerable: false,
      configurable: true
    });

    return merged;
  }

  return config;
}

function getStoragePath() {
  return process.env.STORAGE_PATH || path.join(__dirname, '../../../storage');
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === 'true') {
      return true;
    }
    if (trimmed === 'false') {
      return false;
    }
  }
  return Boolean(value);
}

function parseSettingValue(raw) {
  if (raw === null || raw === undefined) {
    return raw;
  }

  if (typeof raw !== 'string') {
    return raw;
  }

  const trimmed = raw.trim();
  if (!trimmed.length) {
    return trimmed;
  }

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    if (trimmed.toLowerCase() === 'true') {
      return true;
    }
    if (trimmed.toLowerCase() === 'false') {
      return false;
    }
    if (!Number.isNaN(Number(trimmed))) {
      return Number(trimmed);
    }
    return raw;
  }
}

async function calculateChecksum(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fsSync.createReadStream(filePath);

  return new Promise((resolve, reject) => {
    stream.on('data', data => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function getCurrentSchemaVersion() {
  try {
    const record = await db('knex_migrations')
      .orderBy('id', 'desc')
      .first();
    return record ? record.name : 'unknown';
  } catch (error) {
    logger.error('Failed to get schema version:', error);
    return 'unknown';
  }
}

async function getBackupConfigInternal() {
  try {
    const settings = await db('app_settings')
      .where('setting_type', 'backup')
      .select('setting_key', 'setting_value');

    const config = {};
    const raw = {};
    settings.forEach(({ setting_key: key, setting_value: value }) => {
      raw[key] = value;
      config[key] = parseSettingValue(value);
    });

    Object.defineProperty(config, '__raw', {
      value: raw,
      enumerable: false,
      configurable: true
    });

    return config;
  } catch (error) {
    logger.error('Failed to get backup configuration:', error);
    return null;
  }
}

async function hasDatabaseChanged(sinceTime) {
  try {
    const tablesToCheck = [
      'events',
      'photos',
      'admin_users',
      'app_settings',
      'email_queue',
      'access_logs'
    ];

    for (const table of tablesToCheck) {
      try {
        const updated = await db(table)
          .where('updated_at', '>', sinceTime)
          .limit(1)
          .first();
        if (updated) {
          return true;
        }

        const created = await db(table)
          .where('created_at', '>', sinceTime)
          .limit(1)
          .first();
        if (created) {
          return true;
        }
      } catch (innerError) {
        logger.debug(`Skipping change detection for table ${table}:`, innerError.message);
      }
    }
    return false;
  } catch (error) {
    logger.error('Failed to check database changes:', error);
    return true;
  }
}

async function getDatabaseBackupInfoInternal() {
  try {
    const recent = await db('database_backup_runs')
      .where('status', 'completed')
      .orderBy('completed_at', 'desc')
      .first();

    if (recent && recent.file_path) {
      const hasChanged = await hasDatabaseChanged(recent.completed_at);
      // Postgres jsonb columns come back already parsed; sqlite TEXT comes
      // back as a JSON string. Accept both.
      const parseField = (v) => {
        if (v == null) return null;
        if (typeof v === 'object') return v;
        try { return JSON.parse(v); } catch { return null; }
      };
      const stats = parseField(recent.statistics);
      const checksums = parseField(recent.table_checksums);
      return {
        type: recent.backup_type || 'unknown',
        backupFile: recent.file_path,
        size: recent.file_size_bytes,
        checksum: recent.checksum,
        hasChanged,
        backupTime: recent.completed_at,
        tables: (stats && stats.tables) || {},
        rowCounts: checksums || {}
      };
    }

    return {
      type: process.env.DB_TYPE === 'postgresql' ? 'postgresql' : 'sqlite',
      backupFile: null,
      size: 0,
      checksum: null,
      hasChanged: true,
      tables: {},
      rowCounts: {}
    };
  } catch (error) {
    logger.error('Failed to get database backup info:', error);
    return {
      type: 'unknown',
      backupFile: null,
      size: 0,
      checksum: null,
      hasChanged: true,
      tables: {},
      rowCounts: {}
    };
  }
}

async function scanDirectory(dirPath, fileList, basePath, excludePatterns = []) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const relativePath = path.relative(basePath, fullPath);

      const isExcluded = excludePatterns.some(pattern => {
        if (pattern.includes('*')) {
          const regex = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);
          return regex.test(entry.name);
        }
        return entry.name === pattern;
      });

      if (isExcluded) {
        continue;
      }

      if (entry.isDirectory()) {
        await scanDirectory(fullPath, fileList, basePath, excludePatterns);
      } else if (entry.isFile()) {
        const stats = await fs.stat(fullPath);
        fileList.push({
          path: fullPath,
          relativePath,
          size: stats.size,
          modified: stats.mtime
        });
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.error(`Failed to scan directory ${dirPath}:`, error);
    }
  }
}

async function getFilesToBackupInternal(includeArchived = true) {
  const files = [];
  const storagePath = getStoragePath();

  await scanDirectory(path.join(storagePath, 'events/active'), files, storagePath);

  if (normalizeBoolean(includeArchived)) {
    await scanDirectory(path.join(storagePath, 'events/archived'), files, storagePath);
  }

  await scanDirectory(path.join(storagePath, 'thumbnails'), files, storagePath);
  // Lightbox preview tier (#492). Cheap to back up — typically a few
  // hundred KB per photo — and saves admins the regenerate cycle on
  // a restore. Tolerated when missing (admins who never enabled the
  // feature won't have the folder; scanDirectory short-circuits on
  // ENOENT cleanly).
  await scanDirectory(path.join(storagePath, 'previews'), files, storagePath);
  // Heroes too — same logic; admins who picked a hero photo for the
  // gallery header had its 1920x1080 file generated and was missed
  // by the original backup walk before this addition.
  await scanDirectory(path.join(storagePath, 'heroes'), files, storagePath);
  await scanDirectory(path.join(storagePath, 'uploads'), files, storagePath);

  return files;
}

async function hasFileChanged(filePath, checksum) {
  try {
    const existing = await db('backup_file_states')
      .where('file_path', filePath)
      .first();
    return !existing || existing.checksum !== checksum;
  } catch (error) {
    logger.error('Failed to check file state:', error);
    return true;
  }
}

async function updateFileState(filePath, checksum, size, modified) {
  try {
    const existing = await db('backup_file_states')
      .where('file_path', filePath)
      .first();

    const payload = {
      file_path: filePath,
      checksum,
      size_bytes: size,
      last_modified: modified,
      last_backed_up: new Date()
    };

    if (existing) {
      await db('backup_file_states').where('id', existing.id).update(payload);
    } else {
      await db('backup_file_states').insert(payload);
    }
  } catch (error) {
    logger.error('Failed to update file state:', error);
  }
}

async function performLocalBackup(config, files) {
  const destinationRoot = config.backup_destination_path || path.join(getStoragePath(), 'backups');
  await fs.mkdir(destinationRoot, { recursive: true });

  const backedUpFiles = [];
  let backedUpSize = 0;

  for (const file of files) {
    try {
      const maxSizeMb = config.backup_max_file_size_mb || 5000;
      if (file.size > maxSizeMb * 1024 * 1024) {
        logger.warn(`Skipping large file: ${file.relativePath} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
        continue;
      }

      const checksum = await calculateChecksum(file.path);
      file.checksum = checksum;

      const changed = await hasFileChanged(file.relativePath, checksum);
      if (!changed && normalizeBoolean(config.backup_incremental) !== false) {
        continue;
      }

      const destinationFile = path.join(destinationRoot, file.relativePath);
      await fs.mkdir(path.dirname(destinationFile), { recursive: true });
      await fs.copyFile(file.path, destinationFile);

      await updateFileState(file.relativePath, checksum, file.size, file.modified);

      backedUpFiles.push(file.relativePath);
      backedUpSize += file.size;
    } catch (error) {
      logger.error(`Failed to backup file ${file.relativePath}:`, error);
    }
  }

  return {
    backedUpCount: backedUpFiles.length,
    backedUpSize,
    backedUpFiles,
    backupPath: destinationRoot
  };
}

function validateRsyncParam(value, label) {
  if (!value || typeof value !== 'string') return null;
  if (!/^[a-zA-Z0-9._\/@:-]+$/.test(value)) {
    throw new Error(`Invalid ${label}: contains disallowed characters`);
  }
  if (value.length > 1024) {
    throw new Error(`Invalid ${label}: too long`);
  }
  return value;
}

function buildRsyncArgs(config) {
  const storagePath = getStoragePath();
  const host = validateRsyncParam(config.backup_rsync_host, 'host');
  const remotePath = validateRsyncParam(config.backup_rsync_path, 'remote path');

  if (!host || !remotePath) {
    throw new Error('Rsync configuration incomplete');
  }

  // Validate host format (hostname or IP only)
  const hostRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;
  const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (!hostRegex.test(host) && !ipRegex.test(host)) {
    throw new Error('Invalid rsync host format');
  }

  const args = ['-avz', '--delete', '--stats'];
  if (config.backup_rsync_ssh_key) {
    const sshKey = validateRsyncParam(config.backup_rsync_ssh_key, 'SSH key path');
    const fs = require('fs');
    if (!fs.existsSync(sshKey) || !fs.statSync(sshKey).isFile()) {
      throw new Error('SSH key file not found or is not a file');
    }
    // Pass SSH options as separate array elements to avoid shell interpretation
    args.push('-e', `ssh -i ${sshKey} -o StrictHostKeyChecking=no`);
  }

  const excludePatterns = config.backup_exclude_patterns || [];
  excludePatterns.forEach(pattern => args.push('--exclude', pattern));

  const source = `${storagePath}/`;

  const user = config.backup_rsync_user;
  if (user) {
    validateRsyncParam(user, 'user');
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(user)) {
      throw new Error('Invalid rsync username format');
    }
  }

  const destination = user
    ? `${user}@${host}:${remotePath}`
    : `${host}:${remotePath}`;

  args.push(source, destination);
  return args;
}

function parseRsyncStats(output) {
  const stats = {};

  const filesMatch = output.match(/Number of files transferred: (\d+)/);
  if (filesMatch) {
    stats.filesTransferred = parseInt(filesMatch[1], 10);
  }

  const sizeMatch = output.match(/Total file size: ([\d,]+) bytes/);
  if (sizeMatch) {
    stats.totalSize = parseInt(sizeMatch[1].replace(/,/g, ''), 10);
  }

  return stats;
}

async function performRsyncBackup(config, files) {
  const { spawnAsync } = require('../utils/safeExec');
  const rsyncArgs = buildRsyncArgs(config);
  const { stdout } = await spawnAsync('rsync', rsyncArgs);
  const stats = parseRsyncStats(stdout);

  const backedUpFiles = files.map(file => file.relativePath);

  const totalSize = typeof stats.totalSize === 'number'
    ? stats.totalSize
    : files.reduce((acc, file) => acc + file.size, 0);

  for (const file of files) {
    try {
      const checksum = await calculateChecksum(file.path);
      await updateFileState(file.relativePath, checksum, file.size, file.modified);
    } catch (error) {
      logger.error(`Failed to update rsync file state for ${file.relativePath}:`, error);
    }
  }

  return {
    backedUpCount: typeof stats.filesTransferred === 'number' ? stats.filesTransferred : backedUpFiles.length,
    backedUpSize: totalSize,
    backedUpFiles,
    backupPath: `${config.backup_rsync_host}:${config.backup_rsync_path}`
  };
}

function formatBytes(bytes, decimals = 2) {
  if (!bytes) {
    return '0 Bytes';
  }

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

async function performS3Backup(config, files) {
  try {
    const bucket = config.backup_s3_bucket;
    if (!bucket || !config.backup_s3_access_key || !config.backup_s3_secret_key) {
      throw new Error('S3 backup configuration incomplete: bucket, access key, and secret key are required');
    }

    const s3Config = {
      bucket,
      region: config.backup_s3_region || 'us-east-1',
      endpoint: config.backup_s3_endpoint,
      accessKeyId: config.backup_s3_access_key,
      secretAccessKey: config.backup_s3_secret_key,
      forcePathStyle: normalizeBoolean(config.backup_s3_force_path_style),
      sslEnabled: config.backup_s3_ssl_enabled === undefined ? true : normalizeBoolean(config.backup_s3_ssl_enabled),
      maxRetries: config.backup_s3_max_retries || 3,
      retryDelay: config.backup_s3_retry_delay || 1000
    };

    const s3Client = new S3StorageAdapter(s3Config);
    await s3Client.testConnection();

    const now = new Date();
    const datePrefix = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
    const backupId = `backup-${now.getTime()}`;
    const basePrefix = config.backup_s3_prefix ? config.backup_s3_prefix : 'backups';
    const s3Prefix = path.posix.join(basePrefix, datePrefix, backupId);

    const backedUpFiles = [];
    let backedUpSize = 0;

    for (const file of files) {
      try {
        const maxSizeMb = config.backup_max_file_size_mb || 5000;
        if (file.size > maxSizeMb * 1024 * 1024) {
          logger.warn(`Skipping large file: ${file.relativePath} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
          continue;
        }

        const checksum = await calculateChecksum(file.path);
        file.checksum = checksum;

        const changed = await hasFileChanged(file.relativePath, checksum);
        if (!changed && normalizeBoolean(config.backup_incremental) !== false) {
          continue;
        }

        const s3Key = path.posix.join(s3Prefix, file.relativePath);
        await s3Client.upload(file.path, s3Key, {
          metadata: {
            'original-path': file.relativePath,
            checksum,
            'backup-id': backupId,
            'backup-time': now.toISOString()
          }
        });

        await updateFileState(file.relativePath, checksum, file.size, file.modified);

        backedUpFiles.push(file.relativePath);
        backedUpSize += file.size;
      } catch (error) {
        logger.error(`Failed to backup file ${file.relativePath} to S3:`, error);
      }
    }

    let databaseInfo = null;
    if (normalizeBoolean(config.backup_include_database) !== false) {
      try {
        databaseInfo = await service.getDatabaseBackupInfo();
        if (databaseInfo.backupFile && await fs.stat(databaseInfo.backupFile).catch(() => null)) {
          const dbKey = path.posix.join(s3Prefix, 'database', path.basename(databaseInfo.backupFile));
          await s3Client.upload(databaseInfo.backupFile, dbKey, {
            metadata: {
              'backup-id': backupId,
              'backup-type': 'database',
              'database-type': databaseInfo.type,
              checksum: databaseInfo.checksum || ''
            }
          });
          backedUpFiles.push(path.posix.join('database', path.basename(databaseInfo.backupFile)));
          backedUpSize += databaseInfo.size || 0;
        } else {
          logger.warn('No recent database backup found to include in S3 backup');
        }
      } catch (error) {
        logger.error('Failed to include database backup in S3:', error);
      }
    }

    try {
      const summary = {
        backupId,
        timestamp: now.toISOString(),
        bucket,
        prefix: s3Prefix,
        filesBackedUp: backedUpFiles.length,
        totalSizeBytes: backedUpSize,
        totalSizeFormatted: formatBytes(backedUpSize)
      };
      const summaryPath = path.join(getStoragePath(), `backup-summary-${backupId}.json`);
      await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
      await s3Client.upload(summaryPath, path.posix.join(s3Prefix, 'backup-summary.json'), {
        contentType: 'application/json'
      });
      await fs.unlink(summaryPath).catch(() => {});
    } catch (error) {
      logger.error('Failed to upload backup summary:', error);
    }

    logger.info(`S3 backup completed: ${backedUpFiles.length} files, ${formatBytes(backedUpSize)} uploaded to ${s3Prefix}`);

    return {
      backedUpCount: backedUpFiles.length,
      backedUpSize,
      backedUpFiles,
      backupPath: `s3://${bucket}/${s3Prefix}`,
      s3Prefix,
      s3Bucket: bucket,
      s3Client,
      databaseInfo
    };
  } catch (error) {
    logger.error('S3 backup failed:', error);
    throw error;
  }
}

async function getPreviousSuccessfulBackup(currentRunId) {
  const record = await db('backup_runs')
    .where('status', 'completed')
    .orderBy('completed_at', 'desc')
    .first();

  if (record && record.id === currentRunId) {
    return null;
  }

  return record || null;
}

function buildManifestFiles(backedUpFiles, allFiles) {
  const fileMap = new Map();
  allFiles.forEach(file => {
    fileMap.set(file.relativePath, file);
  });

  return backedUpFiles.map(relativePath => {
    const source = fileMap.get(relativePath) || {};
    return {
      path: relativePath,
      size: source.size || null,
      checksum: source.checksum || null
    };
  });
}

async function saveManifestToLocal(manifest, manifestFileName, config) {
  const manifestDir = config.backup_manifest_path
    || path.join(config.backup_destination_path || '/backup', 'manifests');
  await fs.mkdir(manifestDir, { recursive: true });
  const manifestPath = path.join(manifestDir, manifestFileName);
  await backupManifest.saveManifest(manifest, manifestPath, config.backup_manifest_format || 'json');
  logger.info(`Backup manifest saved to ${manifestPath}`);
  return manifestPath;
}

async function saveManifestToS3(manifest, manifestFileName, config, result) {
  const tempDir = path.join(getStoragePath(), 'temp');
  await fs.mkdir(tempDir, { recursive: true });
  const tempManifestPath = path.join(tempDir, manifestFileName);
  await backupManifest.saveManifest(manifest, tempManifestPath, config.backup_manifest_format || 'json');

  const manifestKey = path.posix.join(result.s3Prefix, 'manifests', manifestFileName);
  await result.s3Client.upload(tempManifestPath, manifestKey, {
    contentType: config.backup_manifest_format === 'xml' ? 'application/xml' : 'application/json',
    metadata: {
      'backup-type': 'manifest',
      'manifest-version': manifest.version,
      'backup-id': manifest.backup?.id || ''
    }
  });

  await fs.unlink(tempManifestPath).catch(() => {});
  const manifestPath = `s3://${result.s3Bucket}/${manifestKey}`;
  logger.info(`Backup manifest uploaded to S3: ${manifestPath}`);
  return manifestPath;
}

async function runBackupInternal(isManual = false) {
  if (isRunning) {
    logger.warn('Backup already running, skipping');
    return;
  }

  isRunning = true;
  const startTime = new Date();
  let runId = null;

  try {
    const config = await resolveConfigWithFallback();

    // For scheduled backups, check if backup is enabled
    // Manual backups should always be allowed (just need valid destination config)
    if (!isManual && (!config || !normalizeBoolean(config.backup_enabled))) {
      logger.info('Scheduled backup is disabled, skipping');
      return;
    }

    // For manual backups, just ensure we have a destination configured
    if (!config || !config.backup_destination_type) {
      logger.warn('Backup destination not configured');
      throw new Error('Backup destination not configured. Please configure backup settings first.');
    }

    const schemaVersion = await getCurrentSchemaVersion();
    const insertResult = await db('backup_runs').insert({
      started_at: startTime,
      status: 'running',
      backup_type: isManual ? 'manual' : 'scheduled',
      app_version: packageJson.version,
      node_version: process.version,
      db_schema_version: schemaVersion
    }).returning('id');
    runId = insertResult[0]?.id || insertResult[0];

    const files = await service.getFilesToBackup(config.backup_include_archived);
    logger.info(`Found ${files.length} files to check for backup`);

    let result;
    const destinationType = (config.backup_destination_type || 'local').toLowerCase();

    if (destinationType === 'local') {
      result = await performLocalBackup(config, files);
    } else if (destinationType === 'rsync') {
      result = await performRsyncBackup(config, files);
    } else if (destinationType === 's3') {
      result = await performS3Backup(config, files);
    } else {
      throw new Error(`Unknown backup destination type: ${config.backup_destination_type}`);
    }

    const endTime = new Date();
    const durationSeconds = Math.round((endTime - startTime) / 1000);

    let manifestPath = null;
    let manifestSummary = null;

    try {
      logger.info('Generating backup manifest...');

      const previousBackup = await getPreviousSuccessfulBackup(runId);
      const manifestFiles = buildManifestFiles(result.backedUpFiles, files);
      const databaseInfo = result.databaseInfo || await service.getDatabaseBackupInfo();

      const manifestOptions = {
        backupType: previousBackup ? 'incremental' : 'full',
        backupPath: result.backupPath,
        files: manifestFiles,
        databaseInfo,
        parentBackupId: previousBackup ? previousBackup.manifest_id : null,
        format: config.backup_manifest_format || 'json',
        customMetadata: {
          backup_run_id: runId,
          destination_type: destinationType,
          retentionDays: config.backup_retention_days || 30
        }
      };

      let manifest = await backupManifest.generateManifest(manifestOptions);
      if (previousBackup && previousBackup.manifest_path) {
        try {
          const parentManifest = await loadManifestFromAnywhere(previousBackup.manifest_path, config);
          manifest = await backupManifest.generateIncrementalManifest(manifestOptions, parentManifest);
        } catch (error) {
          logger.warn('Failed to load parent manifest, generating full manifest:', error);
        }
      }

      if (result.s3Client) {
        manifestPath = await saveManifestToS3(manifest, `backup-manifest-${manifest.backup.id}.${manifestOptions.format}`, config, result);
      } else {
        manifestPath = await saveManifestToLocal(manifest, `backup-manifest-${manifest.backup.id}.${manifestOptions.format}`, config);
      }

      try {
        manifestSummary = backupManifest.generateSummaryReport
          ? backupManifest.generateSummaryReport(manifest)
          : null;
      } catch (error) {
        logger.warn('Failed to generate manifest summary:', error);
      }
    } catch (error) {
      logger.error('Failed to generate backup manifest:', error);
    }

    await db('backup_runs')
      .where('id', runId)
      .update({
        completed_at: endTime,
        status: 'completed',
        files_backed_up: result.backedUpCount,
        total_size_bytes: result.backedUpSize,
        duration_seconds: durationSeconds,
        manifest_path: manifestPath,
        manifest_id: manifestPath ? path.basename(manifestPath, path.extname(manifestPath)) : null,
        manifest_info: manifestSummary ? JSON.stringify({ summary: manifestSummary }) : null,
        statistics: JSON.stringify({
          // Use snake_case for frontend compatibility
          files_processed: result.backedUpCount,
          total_size: result.backedUpSize,
          total_files_checked: files.length,
          average_file_size: result.backedUpCount ? Math.round(result.backedUpSize / result.backedUpCount) : 0,
          destination: destinationType,
          // Keep camelCase for backward compatibility
          totalFilesChecked: files.length,
          filesBackedUp: result.backedUpCount,
          totalSize: result.backedUpSize,
          averageFileSize: result.backedUpCount ? Math.round(result.backedUpSize / result.backedUpCount) : 0
        })
      });

    logger.info(`Backup completed: ${result.backedUpCount} files, ${(result.backedUpSize / 1024 / 1024).toFixed(2)} MB in ${durationSeconds}s`);

    if (normalizeBoolean(config.backup_email_on_success)) {
      const admins = await db('admin_users').where('is_active', formatBoolean(true));
      for (const admin of admins) {
        await queueEmail(null, admin.email, 'backup_completed', {
          start_time: startTime.toISOString(),
          duration: `${durationSeconds} seconds`,
          files_count: String(result.backedUpCount),
          total_size: formatBytes(result.backedUpSize),
          backup_type: destinationType
        });
      }
    }
  } catch (error) {
    logger.error('Backup failed:', error);

    if (runId !== null) {
      await db('backup_runs')
        .where('id', runId)
        .update({
          completed_at: new Date(),
          status: 'failed',
          error_message: error.message
        });
    }

    const config = await resolveConfigWithFallback();
    if (config && normalizeBoolean(config.backup_email_on_failure)) {
      const admins = await db('admin_users').where('is_active', formatBoolean(true));
      for (const admin of admins) {
        await queueEmail(null, admin.email, 'backup_failed', {
          start_time: startTime.toISOString(),
          backup_type: (config.backup_destination_type || 'unknown').toString(),
          error_message: error.message
        });
      }
    }
  } finally {
    isRunning = false;
  }
}

async function startBackupService() {
  try {
  const config = await resolveConfigWithFallback();
    if (!config || !normalizeBoolean(config.backup_enabled)) {
      if (backupJob) {
        backupJob.stop();
        backupJob = null;
      }
      logger.info('Backup service is disabled');
      return;
    }

    if (backupJob) {
      backupJob.stop();
      backupJob = null;
    }

    // Two settings cooperate here:
    //   - backup_schedule           — UI label like "daily" / "weekly" / "custom"
    //   - backup_schedule_cron      — actual cron expression
    // The frontend writes both (BackupConfiguration.jsx). Older startup code
    // here read backup_schedule and crashed when it found a label instead of
    // a cron expression. Resolution order: explicit cron field, then map known
    // labels, then fall back to default.
    const NAMED_SCHEDULES = {
      hourly: '0 * * * *',
      daily: '0 2 * * *',
      weekly: '0 3 * * 0',  // Sunday 03:00
      monthly: '0 4 1 * *',
    };
    const isCronExpression = (s) => typeof s === 'string' && /^\s*\S+(\s+\S+){4}\s*$/.test(s);
    const readSetting = (key) => {
      if (config && Object.prototype.hasOwnProperty.call(config, key)) {
        return String(config[key] ?? '').trim();
      }
      if (config?.__raw && Object.prototype.hasOwnProperty.call(config.__raw, key)) {
        return String(parseSettingValue(config.__raw[key]) ?? '').trim();
      }
      return '';
    };

    let schedule = '0 2 * * *';
    const cronCandidate = readSetting('backup_schedule_cron');
    const labelCandidate = readSetting('backup_schedule');
    if (cronCandidate && isCronExpression(cronCandidate)) {
      schedule = cronCandidate;
    } else if (labelCandidate && NAMED_SCHEDULES[labelCandidate.toLowerCase()]) {
      schedule = NAMED_SCHEDULES[labelCandidate.toLowerCase()];
    } else if (labelCandidate && isCronExpression(labelCandidate)) {
      // Back-compat: a deployment that wrote a cron expression directly into
      // backup_schedule (no _cron field) still works.
      schedule = labelCandidate;
    }

    backupJob = cron.schedule(schedule, async () => {
      logger.info('Starting scheduled backup');
      await service.runBackup();
    });

    logger.info(`Backup service started with schedule: ${schedule}`);
  } catch (error) {
    logger.error('Failed to start backup service:', error);
  }
}

function stopBackupService() {
  if (backupJob) {
    backupJob.stop();
    backupJob = null;
    logger.info('Backup service stopped');
  }
}

async function triggerManualBackup() {
  logger.info('Starting manual backup');
  await service.runBackup(true); // Pass flag to indicate manual backup
}

async function getBackupStatus(limit = 10) {
  try {
    const rawRuns = await db('backup_runs')
      .orderBy('started_at', 'desc')
      .limit(limit);

    // Transform runs to add frontend-compatible field aliases
    const runs = rawRuns.map(run => {
      // Parse and transform statistics to snake_case for frontend compatibility
      let statistics = run.statistics;
      if (statistics) {
        // Handle both string (SQLite) and object (PostgreSQL JSONB) types
        let stats = statistics;
        if (typeof statistics === 'string') {
          try {
            stats = JSON.parse(statistics);
          } catch (e) {
            stats = {};
          }
        }
        // Add snake_case aliases for frontend
        statistics = {
          ...stats,
          files_processed: stats.filesBackedUp || stats.files_processed || 0,
          total_size: stats.totalSize || stats.total_size || 0,
          total_files_checked: stats.totalFilesChecked || stats.total_files_checked || 0,
          average_file_size: stats.averageFileSize || stats.average_file_size || 0
        };
      }

      return {
        ...run,
        created_at: run.started_at, // Alias for frontend compatibility
        statistics
      };
    });

    const lastRun = runs[0];
    let manifestValid = false;

    if (lastRun && lastRun.manifest_path) {
      try {
        // Use validateBackupManifest which handles both local and S3 paths
        const result = await validateBackupManifest(lastRun.manifest_path);
        manifestValid = result.valid;
        if (!result.valid) {
          logger.warn('Manifest validation failed:', result.error);
        }
      } catch (error) {
        logger.warn('Manifest validation failed:', error.message);
      }
    }

    const lastRunWithManifest = lastRun ? { ...lastRun, manifestValid } : null;

    return {
      isRunning,
      isHealthy: Boolean(lastRun && lastRun.status === 'completed'),
      lastRun: lastRunWithManifest,
      lastBackup: lastRunWithManifest, // Alias for frontend compatibility
      recentRuns: runs,
      recentBackups: runs, // Alias for frontend compatibility
      totalBackups: runs.filter(r => r.status === 'completed').length,
      nextScheduledRun: getNextScheduledRun()
    };
  } catch (error) {
    logger.error('Failed to get backup status:', error);
    return {
      isRunning,
      isHealthy: false,
      error: error.message
    };
  }
}

function getNextScheduledRun() {
  const now = new Date();
  const next = new Date(now);
  next.setDate(now.getDate() + 1);
  next.setHours(2, 0, 0, 0);
  return next.toISOString();
}

async function cleanupOldBackupRuns(retentionDays = 30) {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);

    const deleted = await db('backup_runs')
      .where('started_at', '<', cutoff)
      .delete();

    if (deleted > 0) {
      logger.info(`Cleaned up ${deleted} old backup runs`);
    }
  } catch (error) {
    logger.error('Failed to cleanup old backup runs:', error);
  }
}

/**
 * Load a backup manifest regardless of whether it lives on the local
 * filesystem or in S3. Used by both the public getBackupManifest API
 * and the incremental-manifest path in runBackupInternal — previously
 * the latter called loadManifest() with an s3:// URI directly, which
 * tried fs.readFile on the literal string and threw ENOENT, silently
 * downgrading every incremental backup to a full manifest.
 */
async function loadManifestFromAnywhere(manifestPath, config) {
  if (!manifestPath) {
    throw new Error('Manifest path is required');
  }
  if (!manifestPath.startsWith('s3://')) {
    return backupManifest.loadManifest(manifestPath);
  }

  const cfg = config || (await resolveConfigWithFallback());
  const accessKey = cfg?.backup_s3_access_key
    ?? (cfg?.__raw && Object.prototype.hasOwnProperty.call(cfg.__raw, 'backup_s3_access_key')
      ? parseSettingValue(cfg.__raw.backup_s3_access_key)
      : undefined)
    ?? process.env.BACKUP_S3_ACCESS_KEY;
  const secretKey = cfg?.backup_s3_secret_key
    ?? (cfg?.__raw && Object.prototype.hasOwnProperty.call(cfg.__raw, 'backup_s3_secret_key')
      ? parseSettingValue(cfg.__raw.backup_s3_secret_key)
      : undefined)
    ?? process.env.BACKUP_S3_SECRET_KEY;

  if (!accessKey || !secretKey) {
    throw new Error('S3 credentials not configured for manifest retrieval');
  }

  const match = manifestPath.match(/^s3:\/\/([^\/]+)\/(.+)$/);
  if (!match) {
    throw new Error('Invalid S3 manifest path');
  }
  const [, bucket, key] = match;

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-manifest-'));
  // Preserve the original extension so loadManifest's format detection
  // picks the right parser.
  const ext = path.extname(key) || '.json';
  const tempPath = path.join(tempDir, `manifest-${Date.now()}${ext}`);

  const s3Client = new S3StorageAdapter({
    bucket,
    region: (cfg && cfg.backup_s3_region) || 'us-east-1',
    endpoint: cfg && cfg.backup_s3_endpoint,
    accessKeyId: accessKey,
    secretAccessKey: secretKey,
    forcePathStyle: cfg ? normalizeBoolean(cfg.backup_s3_force_path_style) : false,
    sslEnabled: cfg && cfg.backup_s3_ssl_enabled !== undefined
      ? normalizeBoolean(cfg.backup_s3_ssl_enabled)
      : true,
  });

  try {
    await s3Client.download(key, tempPath);
    return await backupManifest.loadManifest(tempPath);
  } finally {
    await fs.unlink(tempPath).catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function getBackupManifest(backupRunId) {
  const run = await db('backup_runs')
    .where('id', backupRunId)
    .first();

  if (!run || !run.manifest_path) {
    throw new Error('Backup manifest not found');
  }

  if (!run.manifest_path.startsWith('s3://')) {
    const manifest = await backupManifest.loadManifest(run.manifest_path);
    return {
      manifest,
      summary: backupManifest.generateSummaryReport
        ? backupManifest.generateSummaryReport(manifest)
        : null
    };
  }

  const config = await resolveConfigWithFallback();
  const accessKey = config?.backup_s3_access_key
    ?? (config?.__raw && Object.prototype.hasOwnProperty.call(config.__raw, 'backup_s3_access_key')
      ? parseSettingValue(config.__raw.backup_s3_access_key)
      : undefined)
    ?? process.env.BACKUP_S3_ACCESS_KEY;

  const secretKey = config?.backup_s3_secret_key
    ?? (config?.__raw && Object.prototype.hasOwnProperty.call(config.__raw, 'backup_s3_secret_key')
      ? parseSettingValue(config.__raw.backup_s3_secret_key)
      : undefined)
    ?? process.env.BACKUP_S3_SECRET_KEY;

  if (!accessKey || !secretKey) {
    throw new Error('S3 credentials not configured for manifest retrieval');
  }

  const match = run.manifest_path.match(/^s3:\/\/([^\/]+)\/(.+)$/);
  if (!match) {
    throw new Error('Invalid S3 manifest path');
  }

  const [, bucket, key] = match;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-manifest-'));
  const tempPath = path.join(tempDir, `manifest-${backupRunId}.json`);

  const s3Client = new S3StorageAdapter({
    bucket,
    region: (config && config.backup_s3_region) || 'us-east-1',
    endpoint: config && config.backup_s3_endpoint,
    accessKeyId: accessKey,
    secretAccessKey: secretKey,
    forcePathStyle: config ? normalizeBoolean(config.backup_s3_force_path_style) : false,
    sslEnabled: config && config.backup_s3_ssl_enabled !== undefined
      ? normalizeBoolean(config.backup_s3_ssl_enabled)
      : true
  });

  await s3Client.download(key, tempPath);
  const manifest = await backupManifest.loadManifest(tempPath);
  await fs.unlink(tempPath).catch(() => {});
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});

  return {
    manifest,
    summary: backupManifest.generateSummaryReport
      ? backupManifest.generateSummaryReport(manifest)
      : null
  };
}

async function validateBackupManifest(manifestPath) {
  try {
    let manifest;

    if (manifestPath.startsWith('s3://')) {
      const match = manifestPath.match(/^s3:\/\/([^\/]+)\/(.+)$/);
      if (!match) {
        throw new Error('Invalid S3 manifest path');
      }
      const [, bucket, key] = match;

      const config = await service.getBackupConfig();
      if (!config || !config.backup_s3_access_key || !config.backup_s3_secret_key) {
        throw new Error('S3 credentials not configured for manifest validation');
      }

      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-manifest-'));
      const tempPath = path.join(tempDir, `validate-${Date.now()}.json`);

      const s3Client = new S3StorageAdapter({
        bucket,
        region: config.backup_s3_region || 'us-east-1',
        endpoint: config.backup_s3_endpoint,
        accessKeyId: config.backup_s3_access_key,
        secretAccessKey: config.backup_s3_secret_key,
        forcePathStyle: normalizeBoolean(config.backup_s3_force_path_style),
        sslEnabled: config.backup_s3_ssl_enabled === undefined ? true : normalizeBoolean(config.backup_s3_ssl_enabled)
      });

      await s3Client.download(key, tempPath);
      manifest = await backupManifest.loadManifest(tempPath);
      await fs.unlink(tempPath).catch(() => {});
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    } else {
      manifest = await backupManifest.loadManifest(manifestPath);
    }

    if (backupManifest.validateManifest) {
      backupManifest.validateManifest(manifest);
    }

    return { valid: true, manifest };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

service.getBackupConfig = getBackupConfigInternal;
service.getDatabaseBackupInfo = getDatabaseBackupInfoInternal;
service.getFilesToBackup = getFilesToBackupInternal;
service.runBackup = runBackupInternal;
service.startBackupService = startBackupService;
service.stopBackupService = stopBackupService;
service.triggerManualBackup = triggerManualBackup;
service.getBackupStatus = getBackupStatus;
service.cleanupOldBackupRuns = cleanupOldBackupRuns;
service.getBackupManifest = getBackupManifest;
service.validateBackupManifest = validateBackupManifest;

module.exports = service;
