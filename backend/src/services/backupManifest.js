const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');
const os = require('os');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const manifestKey = require('../utils/backupManifestKey');
const { canonicalize, recoveryDigest } = require('../utils/manifestCanonical');
const authenticationResults = new WeakMap();

// Backup settings that are credentials. The manifest is readable by every
// `backup.view` admin and travels with the backup, so these never go in —
// the same set the GET /config endpoint in adminBackup.js masks (the SSH key
// setting may hold a pasted private key instead of a path). Nothing in
// restore reads `metadata.backup_settings`; it is informational only.
const MANIFEST_SECRET_SETTING_KEYS = new Set([
  'backup_s3_access_key',
  'backup_s3_secret_key',
  'backup_rsync_ssh_key',
]);
const MANIFEST_SECRET_SETTING_RE = /(secret|password|passwd|token|credential|private_key|ssh_key|access_key)/i;

function isManifestSecretSetting(key) {
  return MANIFEST_SECRET_SETTING_KEYS.has(key) || MANIFEST_SECRET_SETTING_RE.test(String(key)) || /manifest.*key/i.test(String(key));
}

/**
 * Backup Manifest Generator
 * 
 * Generates comprehensive manifests for backups including:
 * - Version information (app, node, OS)
 * - File listings with metadata and checksums
 * - Database information
 * - System state at backup time
 * - Support for both JSON and YAML formats
 * - Incremental backup support with parent references
 */

class BackupManifestGenerator {
  constructor() {
    this.appVersion = require('../../package.json').version;
    this.nodeVersion = process.version;
    this.platform = process.platform;
    this.osRelease = os.release();
    this.hostname = os.hostname();
  }

  /**
   * Generate a comprehensive backup manifest
   * @param {Object} options - Manifest generation options
   * @param {string} options.backupType - 'full' or 'incremental'
   * @param {string} options.backupPath - Path to the backup directory
   * @param {Array} options.files - Array of backed up files with metadata
   * @param {Object} options.databaseInfo - Database backup information
   * @param {string} options.parentBackupId - For incremental backups, reference to parent
   * @param {string} options.format - 'json' or 'yaml' (default: 'json')
   * @param {Object} options.customMetadata - Additional metadata to include
   * @returns {Object} Generated manifest object
   */
  async generateManifest(options) {
    const {
      backupType = 'full',
      backupPath,
      files = [],
      databaseInfo = {},
      parentBackupId = null,
      format = 'json',
      customMetadata = {}
    } = options;

    const manifest = {
      // Manifest metadata
      manifest: {
        version: '3.0',
        created: new Date().toISOString(),
        generator: 'PicPeak Backup Manifest Generator',
        format: format
      },

      // Backup information
      backup: {
        id: this.generateBackupId(),
        type: backupType,
        timestamp: new Date().toISOString(),
        path: backupPath,
        parent_backup_id: parentBackupId,
        retention_days: customMetadata.retentionDays || 30
      },

      // System information
      system: {
        hostname: this.hostname,
        platform: this.platform,
        os_release: this.osRelease,
        architecture: os.arch(),
        cpu_count: os.cpus().length,
        total_memory: os.totalmem(),
        free_memory: os.freemem(),
        uptime: os.uptime()
      },

      // Application information
      application: {
        name: 'PicPeak',
        version: this.appVersion,
        node_version: this.nodeVersion,
        environment: process.env.NODE_ENV || 'production',
        storage_path: process.env.STORAGE_PATH || path.join(__dirname, '../../../storage')
      },

      // Files information
      files: {
        count: files.length,
        total_size: files.reduce((sum, file) => sum + (file.size || 0), 0),
        checksums: await this.generateFileChecksums(files),
        manifest: files.map(file => ({
          path: file.relativePath || file.path,
          size: file.size,
          modified: file.modified,
          checksum: file.checksum,
          type: this.getFileType(file.path),
          permissions: file.permissions,
          object_metadata: file.object_metadata
        }))
      },

      // Database information
      database: {
        type: databaseInfo.type || this.getDatabaseType(),
        backup_file: databaseInfo.backupFile,
        size: databaseInfo.size,
        checksum: databaseInfo.checksum,
        tables: databaseInfo.tables || {},
        row_counts: databaseInfo.rowCounts || {},
        schema_version: await this.getSchemaVersion()
      },

      // Verification information
      verification: {
        total_checksum: null, // Will be calculated after manifest is complete
        file_count_check: files.length,
        size_check: files.reduce((sum, file) => sum + (file.size || 0), 0),
        integrity_timestamp: new Date().toISOString()
      },

      // Custom metadata
      metadata: {
        ...customMetadata,
        backup_settings: await this.getBackupSettings(),
        active_events_count: await this.getActiveEventsCount(),
        archived_events_count: await this.getArchivedEventsCount(),
        total_photos_count: await this.getTotalPhotosCount()
      }
    };

    // Calculate total checksum of the manifest. Records WHICH algorithm was
    // used so validation can tell a keyed manifest from a legacy unkeyed one
    // (GHSA-hgp8).
    this.signManifest(manifest);

    return manifest;
  }

  /**
   * Save manifest to file
   * @param {Object} manifest - Manifest object to save
   * @param {string} filePath - Path to save the manifest
   * @param {string} format - 'json' or 'yaml'
   */
  async saveManifest(manifest, filePath, format = 'json') {
    try {
      let content;
      
      if (format === 'yaml') {
        content = yaml.dump(manifest, {
          indent: 2,
          lineWidth: -1,
          noRefs: true,
          sortKeys: true
        });
      } else {
        content = JSON.stringify(manifest, null, 2);
      }

      // Written beside the target and renamed into place, so a crash never
      // leaves a truncated manifest under the final name.
      const tempPath = `${filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      try {
        await fs.writeFile(tempPath, content, 'utf8');
        await fs.rename(tempPath, filePath);
      } catch (error) {
        await fs.rm(tempPath, { force: true }).catch(() => {});
        throw error;
      }
      logger.info(`Manifest saved to ${filePath} (format: ${format})`);
      
      return filePath;
    } catch (error) {
      logger.error('Failed to save manifest:', error);
      throw error;
    }
  }

  /**
   * Load and validate an existing manifest
   * @param {string} filePath - Path to the manifest file
   * @returns {Object} Loaded and validated manifest
   */
  async loadManifest(filePath, options = {}) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      let manifest;

      // Detect format from BOTH the extension and the content. Earlier code
      // trusted the extension alone, which broke when callers stored a YAML
      // manifest under a .json temp name (getBackupManifest does this when
      // downloading the s3:// path to a tmp file).
      const looksLikeJson = content.trimStart().startsWith('{')
        || content.trimStart().startsWith('[');
      if (filePath.endsWith('.yaml') || filePath.endsWith('.yml') || !looksLikeJson) {
        manifest = yaml.load(content);
      } else {
        manifest = JSON.parse(content);
      }

      // Validate manifest structure
      this.validateManifest(manifest, options);

      return manifest;
    } catch (error) {
      logger.error('Failed to load manifest:', error);
      throw error;
    }
  }

  /**
   * Validate manifest structure and integrity
   * @param {Object} manifest - Manifest to validate
   * @throws {Error} If validation fails
   */
  validateManifest(manifest, options = {}) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new Error('Invalid manifest object');
    }
    // Check required sections
    const requiredSections = ['manifest', 'backup', 'system', 'application', 'files', 'database', 'verification'];
    for (const section of requiredSections) {
      if (!manifest[section]) {
        throw new Error(`Missing required section: ${section}`);
      }
    }

    // Validate manifest version
    if (!manifest.manifest.version) {
      throw new Error('Missing manifest version');
    }

    // Validate file checksums
    if (!Array.isArray(manifest.files.manifest) || manifest.files.count !== manifest.files.manifest.length) {
      throw new Error('File count mismatch');
    }

    // Every caller shares mandatory authentication and explicit migration
    // rules; ordinary force/dry-run flags cannot enable legacy recovery.
    // `inspect` (listing, download, health) may still READ an intact manifest
    // written before authentication existed; it comes back flagged
    // unauthenticated. Restore never passes it.
    const checksumResult = this.verifyManifestChecksum(manifest, options);
    if (!checksumResult.valid && !(options.inspect && checksumResult.legacy)) {
      throw new Error(checksumResult.error || 'Manifest checksum verification failed');
    }
    checksumResult.warnings.forEach((w) => logger.warn(w));
    authenticationResults.set(manifest, checksumResult);

    logger.info('Manifest validation passed');
    return true;
  }

  /**
   * Compare two manifests for incremental backup
   * @param {Object} currentManifest - Current backup manifest
   * @param {Object} parentManifest - Parent backup manifest
   * @returns {Object} Comparison results
   */
  compareManifests(currentManifest, parentManifest) {
    const comparison = {
      added_files: [],
      modified_files: [],
      deleted_files: [],
      unchanged_files: [],
      size_difference: 0,
      database_changes: {}
    };

    // Create file maps for easy comparison
    const currentFiles = new Map(
      currentManifest.files.manifest.map(f => [f.path, f])
    );
    const parentFiles = new Map(
      parentManifest.files.manifest.map(f => [f.path, f])
    );

    // Find added and modified files
    for (const [path, file] of currentFiles) {
      const parentFile = parentFiles.get(path);
      if (!parentFile) {
        comparison.added_files.push(file);
        comparison.size_difference += file.size;
      } else if (file.checksum !== parentFile.checksum) {
        comparison.modified_files.push(file);
        comparison.size_difference += file.size - parentFile.size;
      } else {
        comparison.unchanged_files.push(file);
      }
    }

    // Find deleted files
    for (const [path, file] of parentFiles) {
      if (!currentFiles.has(path)) {
        comparison.deleted_files.push(file);
        comparison.size_difference -= file.size;
      }
    }

    // Compare database info
    comparison.database_changes = {
      size_difference: currentManifest.database.size - parentManifest.database.size,
      checksum_changed: currentManifest.database.checksum !== parentManifest.database.checksum,
      schema_version_changed: currentManifest.database.schema_version !== parentManifest.database.schema_version
    };

    return comparison;
  }

  /**
   * Generate incremental manifest based on parent
   * @param {Object} options - Manifest generation options
   * @param {Object} parentManifest - Parent backup manifest
   * @returns {Object} Incremental manifest
   */
  async generateIncrementalManifest(options, parentManifest) {
    const fullManifest = await this.generateManifest({
      ...options,
      backupType: 'incremental'
    });

    const comparison = this.compareManifests(fullManifest, parentManifest);

    // Add incremental-specific information
    fullManifest.incremental = {
      parent_backup_id: parentManifest.backup.id,
      parent_timestamp: parentManifest.backup.timestamp,
      changes: {
        added_files_count: comparison.added_files.length,
        modified_files_count: comparison.modified_files.length,
        deleted_files_count: comparison.deleted_files.length,
        unchanged_files_count: comparison.unchanged_files.length,
        size_difference: comparison.size_difference
      },
      added_files: comparison.added_files.map(f => f.path),
      modified_files: comparison.modified_files.map(f => f.path),
      deleted_files: comparison.deleted_files.map(f => f.path)
    };

    // Recalculate the checksum after attaching the incremental section,
    // otherwise validateManifest() rejects the loaded manifest because
    // generateManifest() stamped a checksum that did NOT include this
    // section.
    this.signManifest(fullManifest);

    return fullManifest;
  }

  // Helper methods

  generateBackupId() {
    const timestamp = new Date().toISOString().replace(/[:-]/g, '').replace('T', '-').split('.')[0];
    const random = crypto.randomBytes(4).toString('hex');
    return `backup-${timestamp}-${random}`;
  }

  async generateFileChecksums(files) {
    const checksums = {};
    for (const file of files) {
      if (file.checksum) {
        checksums[file.relativePath || file.path] = file.checksum;
      }
    }
    return checksums;
  }

  getFileType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const typeMap = {
      '.jpg': 'image',
      '.jpeg': 'image',
      '.png': 'image',
      '.gif': 'image',
      '.webp': 'image',
      '.zip': 'archive',
      '.sql': 'database',
      '.db': 'database',
      '.json': 'config',
      '.yaml': 'config',
      '.yml': 'config'
    };
    return typeMap[ext] || 'other';
  }

  getDatabaseType() {
    return process.env.DB_TYPE === 'postgresql' ? 'postgresql' : 'sqlite';
  }

  async getSchemaVersion() {
    try {
      const result = await db('migrations')
        .orderBy('run_at', 'desc')
        .first();
      return result ? result.migration_name : 'unknown';
    } catch (error) {
      return 'unknown';
    }
  }

  async getBackupSettings() {
    try {
      const settings = await db('app_settings')
        .where('setting_type', 'backup')
        .select('setting_key', 'setting_value');
      
      const config = {};
      settings.forEach(setting => {
        if (isManifestSecretSetting(setting.setting_key)) return;
        try {
          config[setting.setting_key] = JSON.parse(setting.setting_value);
        } catch (e) {
          config[setting.setting_key] = setting.setting_value;
        }
      });

      return config;
    } catch (error) {
      return {};
    }
  }

  async getActiveEventsCount() {
    try {
      const result = await db('events')
        .where('status', 'active')
        .count('* as count')
        .first();
      return result ? parseInt(result.count) : 0;
    } catch (error) {
      return 0;
    }
  }

  async getArchivedEventsCount() {
    try {
      const result = await db('events')
        .where('status', 'archived')
        .count('* as count')
        .first();
      return result ? parseInt(result.count) : 0;
    } catch (error) {
      return 0;
    }
  }

  async getTotalPhotosCount() {
    try {
      const result = await db('photos')
        .count('* as count')
        .first();
      return result ? parseInt(result.count) : 0;
    } catch (error) {
      return 0;
    }
  }

  // Never create a new key while verifying somebody else's artifact.
  getManifestKey() {
    try { return manifestKey.loadKey().key; } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  signManifest(manifest) {
    for (const file of manifest.files.manifest) {
      if (!/^[a-f0-9]{64}$/i.test(file.checksum || '')) {
        throw new Error('Cannot authenticate a file backup without its SHA-256 checksum');
      }
    }
    if (manifest.database.backup_file && !/^[a-f0-9]{64}$/i.test(manifest.database.checksum || '')) {
      throw new Error('Cannot authenticate a database backup without its SHA-256 checksum');
    }
    const { key, keyId } = manifestKey.loadKey({ create: true });
    manifest.manifest.version = '3.0';
    Object.assign(manifest.verification, {
      checksum_algorithm: 'hmac-sha256', serialization: 'canonical-v1', key_id: keyId,
    });
    manifest.verification.total_checksum = this.calculateManifestChecksum(manifest, { keyed: key });
    return manifest;
  }

  getAuthentication(manifest) {
    return authenticationResults.get(manifest) || this.verifyManifestChecksum(manifest);
  }

  // Recovery is authorized ONLY by trusted host configuration and bound to
  // this entire parsed artifact. Neither force, trigger bytes, nor manifest
  // metadata can enable it. Inspection/health/parent loaders never opt in.
  verifyManifestChecksum(manifest, { allowRecovery = false } = {}) {
    const reject = (error, legacy = false) => {
      const approved = process.env.BACKUP_MANIFEST_RECOVERY_SHA256;
      const reason = process.env.BACKUP_MANIFEST_RECOVERY_REASON;
      if (allowRecovery && manifest && typeof manifest === 'object' && /^[a-f0-9]{64}$/i.test(approved || '')
          && typeof reason === 'string' && reason.trim().length >= 12 && reason.length <= 1000
          && approved.toLowerCase() === recoveryDigest(manifest)) {
        return { valid: true, authenticated: false, recovery: true,
          recoveryDigest: approved.toLowerCase(), reason: reason.trim(),
          warnings: ['UNAUTHENTICATED backup recovery explicitly approved on the host: ' + reason.trim()] };
      }
      return { valid: false, authenticated: false, legacy, error, warnings: [] };
    };
    const verification = manifest?.verification;
    if (!/^[a-f0-9]{64}$/i.test(verification?.total_checksum || '')) {
      return reject('Manifest carries no checksum or an invalid signature');
    }
    if (verification.checksum_algorithm !== 'hmac-sha256') {
      return reject(
        'Manifest is not authenticated — refusing an unkeyed algorithm downgrade. A backup taken before '
        + 'manifest authentication can only be restored on an isolated host by approving that one artifact '
        + 'with BACKUP_MANIFEST_RECOVERY_SHA256 and BACKUP_MANIFEST_RECOVERY_REASON '
        + '(digest: backend/scripts/backup-manifest-recovery-digest.js).',
        this.isIntactLegacyManifest(manifest),
      );
    }
    try {
      let key;
      let keyId;
      if (manifest.manifest?.version === '3.0') {
        if (verification.serialization !== 'canonical-v1' || !/^[a-f0-9]{16}$/.test(verification.key_id || '')) {
          return reject('Manifest authentication envelope is invalid');
        }
        keyId = verification.key_id;
        key = manifestKey.keyRing().get(keyId);
        if (!key) return reject('Manifest signing key is missing — retain the original key for disaster recovery');
      } else {
        // Explicit migration compatibility for canonical pre-v3 HMACs.
        // The unsafe array-replacer serializer is NEVER retried.
        //
        // Before v3 the HMAC key was the BACKUP_MANIFEST_KEY string as typed,
        // of any length, so that string must keep verifying what it signed:
        // either retained as BACKUP_MANIFEST_LEGACY_KEY or still sitting in
        // BACKUP_MANIFEST_KEY. Neither is ever used to sign (signManifest
        // only takes a 32-byte key from loadKey).
        const legacyKeys = [process.env.BACKUP_MANIFEST_LEGACY_KEY, process.env.BACKUP_MANIFEST_KEY]
          .filter(value => typeof value === 'string' && value.trim())
          .map(value => value.trim());
        if (!legacyKeys.length) {
          return reject('Legacy manifest authentication requires the explicitly retained canonical HMAC key');
        }
        const expected = Buffer.from(verification.total_checksum, 'hex');
        key = legacyKeys.find(candidate => crypto.timingSafeEqual(
          Buffer.from(this.calculateManifestChecksum(manifest, { keyed: candidate }), 'hex'), expected,
        ));
        if (!key) return reject('Manifest checksum verification failed');
        keyId = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
      }
      const actual = this.calculateManifestChecksum(manifest, { keyed: key });
      if (!crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(verification.total_checksum, 'hex'))) {
        return reject('Manifest checksum verification failed');
      }
      return { valid: true, authenticated: true, keyId, recovery: false, warnings: [] };
    } catch (_) {
      return reject('Manifest signing key is missing or invalid; authenticity cannot be verified');
    }
  }

  // A pre-authentication manifest whose plain SHA-256 still matches: not
  // authentic (anyone can recompute it), but not damaged either.
  isIntactLegacyManifest(manifest) {
    try {
      if (manifest.manifest?.version === '3.0') return false;
      const expected = manifest.verification.total_checksum;
      return expected === this.calculateManifestChecksum(manifest, { keyed: false })
        || expected === this.calculateManifestChecksum(manifest, { keyed: false, legacy: true });
    } catch (_) {
      return false;
    }
  }

  /**
   * Canonical JSON: object keys sorted recursively so the digest is stable
   * regardless of property insertion order, and — critically — so NESTED
   * values are actually covered.
   *
   * The previous implementation passed `Object.keys(manifest).sort()` as
   * JSON.stringify's second argument. That parameter is an array *replacer*
   * (a property allowlist applied at every depth), not a key sorter, so every
   * nested key absent from that top-level list — `path`, `size`, per-file
   * `checksum` — was dropped before hashing. The file list was therefore
   * outside the "integrity" check entirely: a manifest path could be rewritten
   * to `../../etc/passwd` without disturbing the checksum.
   */
  canonicalize(value) {
    return canonicalize(value);
  }

  calculateManifestChecksum(manifest, { keyed = null, legacy = false } = {}) {
    // Create a copy without the checksum field
    const manifestCopy = JSON.parse(JSON.stringify(manifest));
    if (manifestCopy.verification) {
      delete manifestCopy.verification.total_checksum;
      if (manifest.manifest?.version !== '3.0') delete manifestCopy.verification.checksum_algorithm;
    }

    // `legacy` reproduces the unsafe old serializer for regression fixtures
    // only. Verification never accepts it as an authentication fallback.
    const content = legacy
      ? JSON.stringify(manifestCopy, Object.keys(manifestCopy).sort())
      : JSON.stringify(this.canonicalize(manifestCopy));

    const key = keyed === null ? this.getManifestKey() : keyed;
    return key
      ? crypto.createHmac('sha256', key).update(content).digest('hex')
      : crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Generate a summary report from a manifest
   * @param {Object} manifest - Manifest to summarize
   * @returns {string} Human-readable summary
   */
  generateSummaryReport(manifest) {
    const report = [];
    
    report.push('=== BACKUP MANIFEST SUMMARY ===');
    report.push(`Backup ID: ${manifest.backup.id}`);
    report.push(`Type: ${manifest.backup.type}`);
    report.push(`Created: ${manifest.backup.timestamp}`);
    
    if (manifest.backup.parent_backup_id) {
      report.push(`Parent Backup: ${manifest.backup.parent_backup_id}`);
    }
    
    report.push('\n--- System Information ---');
    report.push(`Host: ${manifest.system.hostname}`);
    report.push(`Platform: ${manifest.system.platform} ${manifest.system.os_release}`);
    report.push(`Architecture: ${manifest.system.architecture}`);
    
    report.push('\n--- Application Information ---');
    report.push(`App Version: ${manifest.application.version}`);
    report.push(`Node Version: ${manifest.application.node_version}`);
    report.push(`Environment: ${manifest.application.environment}`);
    
    report.push('\n--- Files Summary ---');
    report.push(`Total Files: ${manifest.files.count}`);
    report.push(`Total Size: ${(manifest.files.total_size / 1024 / 1024).toFixed(2)} MB`);
    
    if (manifest.incremental) {
      report.push('\n--- Incremental Changes ---');
      report.push(`Added Files: ${manifest.incremental.changes.added_files_count}`);
      report.push(`Modified Files: ${manifest.incremental.changes.modified_files_count}`);
      report.push(`Deleted Files: ${manifest.incremental.changes.deleted_files_count}`);
      report.push(`Size Difference: ${(manifest.incremental.changes.size_difference / 1024 / 1024).toFixed(2)} MB`);
    }
    
    report.push('\n--- Database Information ---');
    report.push(`Type: ${manifest.database.type}`);
    report.push(`Size: ${manifest.database.size ? (manifest.database.size / 1024 / 1024).toFixed(2) + ' MB' : 'N/A'}`);
    report.push(`Schema Version: ${manifest.database.schema_version}`);
    
    report.push('\n--- Content Statistics ---');
    report.push(`Active Events: ${manifest.metadata.active_events_count}`);
    report.push(`Archived Events: ${manifest.metadata.archived_events_count}`);
    report.push(`Total Photos: ${manifest.metadata.total_photos_count}`);
    
    report.push('\n--- Verification ---');
    report.push(`Manifest Checksum: ${manifest.verification.total_checksum}`);
    report.push(`Integrity Timestamp: ${manifest.verification.integrity_timestamp}`);
    
    return report.join('\n');
  }
}

// Export singleton instance
module.exports = new BackupManifestGenerator();
