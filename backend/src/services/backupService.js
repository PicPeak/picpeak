const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const crypto = require('crypto');
const childProcess = require('child_process');
const os = require('os');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const cron = require('node-cron');
const cronParser = require('cron-parser');
const { db } = require('../database/db');
const { queueEmail } = require('./emailProcessor');
const logger = require('../utils/logger');
const { formatBytes } = require('../utils/formatBytes');
const { formatBoolean } = require('../utils/dbCompat');
const backupManifest = require('./backupManifest');
const backupManifestKey = require('../utils/backupManifestKey');
const { collectLegacyStoredFiles, storedPathMap, storedPathChecksums } = require('../utils/legacyStoredFiles');
const S3StorageAdapter = require('./storage/s3Storage');
const { backupS3Access } = require('../utils/s3EndpointPolicy');
const { standaloneSnapshotOfRun, removeLocalSnapshot, removeS3Snapshot } = require('../utils/backupRestorePoint');
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
const { localDestinationHint } = require('../utils/localBackupDestination');

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

/**
 * Run an inline database dump (default ON) and then verify a usable dump
 * is actually on disk before letting the file-backup proceed. Returns the
 * verified `databaseInfo` so the caller can pass it straight into the
 * manifest builder without re-querying.
 *
 * Why this lives here and not inline in `runBackupInternal`:
 *   - Encapsulates the "Run Backup Now must include DB" guarantee
 *     introduced when the silent files-only bug was discovered
 *     (2026-05-29 — admin lost CRM after `docker compose down -v`)
 *   - Lets the manifest path share the same `databaseInfo` object
 *     instead of doing a second `getDatabaseBackupInfo()` round-trip
 *   - Thrown errors bubble up to `runBackupInternal`'s catch, which
 *     marks the `backup_runs` row failed and queues the admin email
 *
 * Default-ON semantics: `backup_database_inline_dump` is only treated
 * as disabled when explicitly set to false. `undefined` (the case on
 * every existing install that predates the setting) falls through to
 * the safe-default ON branch. `normalizeBoolean(undefined)` returns
 * false, so a naive `!== false` check would silently disable the
 * inline dump for every upgrading install.
 */
async function ensureDatabaseDumpForBackup(config) {
  const inlineDumpExplicitlyOff = config.backup_database_inline_dump !== undefined
    && config.backup_database_inline_dump !== null
    && normalizeBoolean(config.backup_database_inline_dump) === false;

  if (!inlineDumpExplicitlyOff) {
    logger.info('Running inline database dump before file backup...');
    const { databaseBackupService } = require('./databaseBackup');
    const dumpResult = await databaseBackupService.backup({});
    logger.info(`Inline database dump completed: ${dumpResult.path} ` +
      `(${(dumpResult.size / 1024 / 1024).toFixed(2)} MB)`);
  }

  const databaseInfo = await service.getDatabaseBackupInfo();
  if (!databaseInfo.backupFile) {
    throw new Error(
      'No database backup available to include in this file backup. ' +
      'Either keep backup_database_inline_dump enabled (default) or configure ' +
      'backup_database_schedule and let it run at least once first.'
    );
  }

  let dumpStat;
  try {
    dumpStat = await fs.stat(databaseInfo.backupFile);
  } catch (statErr) {
    if (statErr.code === 'ENOENT') {
      throw new Error(
        `Database backup file at ${databaseInfo.backupFile} is missing from disk. ` +
        'Refusing to proceed with file backup; configure backup_database_schedule or ' +
        'keep backup_database_inline_dump enabled.'
      );
    }
    throw statErr;
  }
  if (!dumpStat.size) {
    throw new Error(
      `Database backup file at ${databaseInfo.backupFile} is empty (0 bytes). ` +
      'Refusing to proceed with file backup to avoid shipping a manifest with no DB content.'
    );
  }

  // The dump lives in mutable backup storage. Its independently recorded
  // creation digest is the authority; rehashing and replacing that digest
  // would launder changed store bytes into a newly authenticated manifest.
  const expected = typeof databaseInfo.checksum === 'string' ? databaseInfo.checksum.trim().toLowerCase() : '';
  if (!/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error('Database backup has no valid recorded checksum. Create a fresh database dump before signing a file backup.');
  }
  if (await calculateChecksum(databaseInfo.backupFile) !== expected) {
    throw new Error('Database backup does not match its recorded checksum; refusing to sign changed dump bytes.');
  }
  databaseInfo.size = dumpStat.size;
  databaseInfo.checksum = expected;

  return databaseInfo;
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
        // file_size_bytes is a bigInteger column — node-postgres returns int8
        // as a STRING, and `backedUpSize += size` then concatenates instead of
        // adding (issue #871: "167.6 TB" dashboard size). Coerce at the source.
        size: Number(recent.file_size_bytes) || 0,
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

function isExcludedName(name, excludePatterns) {
  return excludePatterns.some(pattern => {
    if (pattern.includes('*')) {
      // Escape regex metacharacters before expanding the glob star — the
      // raw replace turned '.nfs*' into /^.nfs.*$/ whose leading dot
      // matched any character (e.g. 'anfs-photo.jpg' was excluded too).
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      const regex = new RegExp(`^${escaped}$`);
      return regex.test(name);
    }
    return name === pattern;
  });
}

/**
 * The directories below the storage root that a local backup writes into, as
 * the walker will meet them (issue 1780).
 *
 * A local destination inside a backed-up folder (say <storage>/uploads/backups)
 * made every run copy the previous run's output: one more nested copy of the
 * tree per backup, until the volume was full. The walker skips these instead.
 * Saving such a path is not refused, because installs that already have one
 * could no longer save their backup form. A destination that IS a backed-up
 * folder cannot be skipped; see backedUpFolderAtDestination.
 *
 * Only for a local destination: with S3 or rsync selected, a leftover local
 * path is not written to, and skipping it would drop real files.
 *
 * `paths` are matched by name, `ids` by what the directory is on disk.
 */
// A directory as the filesystem knows it, whatever path led there. Docker can
// show one host folder at two container paths (the /backup mount placed below
// the storage mount), and no path comparison sees that. Null when the
// directory is missing or the filesystem reports no inode.
const dirIdentity = (dir) => fs.stat(dir, { bigint: true })
  .then((stats) => (stats.ino ? `${stats.dev}:${stats.ino}` : null), () => null);

const NO_OWN_OUTPUT = { paths: [], ids: [], atStorageRoot: false };

async function ownOutputDirs(config, storagePath) {
  if ((config.backup_destination_type || 'local').toLowerCase() !== 'local') return NO_OWN_OUTPUT;
  // The same defaults performLocalBackup and saveManifestToLocal apply.
  const destination = config.backup_destination_path || path.join(storagePath, 'backups');
  const candidates = [destination, config.backup_manifest_path].filter(Boolean);
  // Through symlinks, so a destination reached by another name is still
  // recognised. A path that does not exist yet (the backup creates it) is
  // resolved from its nearest existing ancestor, or it would not compare
  // with a storage root that is itself reached through a link.
  const real = async (p) => {
    let current = path.resolve(p);
    const missing = [];
    for (;;) {
      try {
        return path.join(await fs.realpath(current), ...missing);
      } catch (error) {
        const parent = path.dirname(current);
        if (parent === current) return path.resolve(p);
        missing.unshift(path.basename(current));
        current = parent;
      }
    }
  };
  const root = await real(storagePath);
  const rootId = await dirIdentity(storagePath);
  const paths = [];
  const ids = [];
  let atStorageRoot = false;
  for (const candidate of candidates) {
    const rel = path.relative(root, await real(candidate));
    const id = await dirIdentity(candidate);
    // Only the destination: files are copied there under their storage-
    // relative path, so with the storage root as destination every file
    // would be copied onto itself. A manifest folder there harms nothing.
    if (candidate === destination && (rel === '' || (id && id === rootId))) atStorageRoot = true;
    const inside = rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
    if (inside) paths.push(path.join(storagePath, rel));
    if (id && id !== rootId) ids.push(id);
  }
  return { paths, ids, atStorageRoot };
}

/**
 * The backed-up folder a local destination (or manifest folder) IS, '.' for
 * the storage root, or null.
 *
 * Skipping cannot help here: with the destination set to <storage>/uploads
 * itself, that folder's own files and the backup's output share one
 * directory and cannot be told apart, so the walker would either keep
 * nesting copies or drop the folder from the backup. The run refuses
 * instead, and the connection test says so.
 */
async function backedUpFolderAtDestination(config, { everyPath = false } = {}) {
  const storagePath = getStoragePath();
  const own = await ownOutputDirs(config, storagePath);
  if (own.atStorageRoot) return '.';
  if (own.paths.length === 0 && own.ids.length === 0) return null;
  // everyPath: also the folders that are switched off. The connection test
  // probes a form that is not saved yet, so the "what to back up" toggles it
  // would be judged by are not the ones the next run uses.
  const targets = everyPath ? await loadBackupPathRows({ includeDisabled: true }) : await resolveBackupPaths(config);
  for (const target of targets) {
    const dir = path.join(storagePath, target.path);
    if (own.paths.includes(dir)) return target.path;
    const id = own.ids.length > 0 ? await dirIdentity(dir) : null;
    if (id && own.ids.includes(id)) return target.path;
  }
  return null;
}

function destinationIsBackedUpFolderMessage(folder) {
  if (folder === '.') {
    return 'The backup destination is the storage folder itself, so every file would be copied onto itself. '
      + 'Use a folder of its own, for example a subfolder such as "backups" or a directory outside the storage folder.';
  }
  return `The backup destination is the backed-up folder "${folder}" itself, so every run would copy the previous one. `
    + 'Use a folder of its own, for example a subfolder of it or a directory outside the storage folder.';
}

async function scanDirectory(dirPath, fileList, basePath, excludePatterns = [], skip = NO_OWN_OUTPUT, strict = false, allowMissing = true) {
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    // A feature never used has no top-level directory. A directory already
    // enumerated below it disappearing, or any unreadable directory, is not
    // a complete catalogue for a standalone point.
    if (error.code === 'ENOENT' && allowMissing) return;
    logger.error(`Failed to scan directory ${dirPath}:`, error);
    if (strict) throw error;
    return;
  }
  try {
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const relativePath = path.relative(basePath, fullPath);

      if (isExcludedName(entry.name, excludePatterns)) {
        continue;
      }

      if (entry.isDirectory()) {
        if (skip.paths.includes(fullPath)) continue;
        if (skip.ids.length > 0 && skip.ids.includes(await dirIdentity(fullPath))) continue;
        await scanDirectory(fullPath, fileList, basePath, excludePatterns, skip, strict, false);
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
    logger.error(`Failed to scan directory ${dirPath}:`, error);
    if (strict) throw error;
  }
}

/**
 * Hard-coded fallback when `backup_paths` is missing/empty. Mirrors
 * the canonical seed in migration 109 — kept here as defense in depth
 * so the walker can never silently degrade to "no directories scanned"
 * because of a seed problem.
 *
 * Order matches the legacy behavior of the inlined sequence this
 * function used to contain.
 */
const LEGACY_BACKUP_PATHS = [
  { path: 'events/active',    feature_flag: null },
  { path: 'events/archived',  feature_flag: 'backup_include_archived' },
  { path: 'thumbnails',       feature_flag: null },
  { path: 'previews',         feature_flag: null },
  { path: 'heroes',           feature_flag: null },
  { path: 'uploads',          feature_flag: null },
  { path: 'business-docs',    feature_flag: null },
];

// "What to Backup" opt-OUT toggles written by BackupConfiguration.tsx.
// Default-ON semantics: only an explicit false excludes the path, so
// installs that never saved the backup form keep backing up everything
// (issue #871: unchecking Thumbnails had no effect because these keys
// were stored but never read).
const OPT_OUT_FLAGS = {
  'events/active': 'backup_include_photos',
  'thumbnails': 'backup_include_thumbnails',
};

// The UI "Archives" checkbox writes backup_include_archives (plural) while
// the feature_flag rows use backup_include_archived — accept both.
const FLAG_ALIASES = {
  backup_include_archived: 'backup_include_archives',
};

// Filesystem noise that must never land in a backup: NFS silly-rename
// artifacts (issue #871 showed .nfs* files uploaded to S3) and OS metadata.
const DEFAULT_EXCLUDE_PATTERNS = ['.nfs*', '.DS_Store', 'Thumbs.db'];

/**
 * Resolve the walker's target subdirectories from `backup_paths`.
 *
 * Layered fallback (defense in depth — no scenario where the walker
 * silently scans nothing):
 *   1. Read `backup_paths` rows where include_in_default = true,
 *      ordered by display_order.
 *   2. If the table is missing OR returns zero rows, fall back to
 *      LEGACY_BACKUP_PATHS. Logged loudly so the admin sees it.
 *
 * Per-row gating: when `feature_flag` is set, the corresponding
 * config key in `app_settings` must resolve truthy for that path to
 * be included. Mirrors the historical `includeArchived` parameter,
 * but now driven by data instead of a hard-coded boolean.
 *
 * @param {object} config  resolved backup config (parseSettingValue'd).
 *                         Used to evaluate feature_flag gates.
 * @returns {Promise<Array<{ path: string, feature_flag: string|null }>>}
 */
async function loadBackupPathRows({ includeDisabled = false } = {}) {
  try {
    if (!(await db.schema.hasTable('backup_paths'))) {
      logger.warn('backup_paths table missing — falling back to LEGACY_BACKUP_PATHS');
      return LEGACY_BACKUP_PATHS;
    }
    let query = db('backup_paths')
      .orderBy('display_order', 'asc')
      .select('path', 'feature_flag', 'include_in_default');
    if (!includeDisabled) {
      query = query.where('include_in_default', formatBoolean(true));
    }
    const rows = await query;
    if (!rows.filter((r) => normalizeBoolean(r.include_in_default)).length) {
      logger.warn('backup_paths has no rows with include_in_default=true — falling back to LEGACY_BACKUP_PATHS');
      return LEGACY_BACKUP_PATHS;
    }
    return rows;
  } catch (err) {
    logger.warn(`Failed to query backup_paths (${err.message}) — falling back to LEGACY_BACKUP_PATHS`);
    return LEGACY_BACKUP_PATHS;
  }
}

// Per-row gate. Applies the UI opt-out toggles first, then feature_flag
// gating: a row with feature_flag='backup_include_archived' requires the
// corresponding config key to be truthy (same semantics as the historical
// `includeArchived` parameter).
function backupPathIncluded(row, config) {
  const optOutKey = OPT_OUT_FLAGS[row.path];
  if (optOutKey && config) {
    const optOutValue = config[optOutKey];
    if (optOutValue !== undefined && optOutValue !== null && normalizeBoolean(optOutValue) === false) {
      return false;
    }
  }
  if (!row.feature_flag) return true;
  let flagValue;
  if (config) {
    // The alias (backup_include_archives) is what the current UI writes;
    // the canonical singular key is seeded true by migration on every
    // install, so the UI value must take precedence or the checkbox can
    // never turn the flag off.
    const alias = FLAG_ALIASES[row.feature_flag];
    if (alias && config[alias] !== undefined && config[alias] !== null) {
      flagValue = config[alias];
    } else {
      flagValue = config[row.feature_flag];
    }
  }
  return normalizeBoolean(flagValue);
}

// The raw config value the gate actually consulted for a row's feature
// flag (alias-aware) — the coverage report shows it next to the status,
// so it must not display the shadowed seeded key.
function effectiveFlagValue(row, config) {
  if (!row.feature_flag || !config) return undefined;
  const alias = FLAG_ALIASES[row.feature_flag];
  if (alias && config[alias] !== undefined && config[alias] !== null) {
    return config[alias];
  }
  return config[row.feature_flag];
}

async function resolveBackupPaths(config) {
  return (await loadBackupPathRows()).filter((row) => backupPathIncluded(row, config));
}

// The rows the admin de-selected — the rsync destination needs them as
// --exclude filters because it syncs the whole storage root rather than
// the walker's file list. Includes rows with include_in_default=false,
// which the enabled-only loader would otherwise hide from rsync entirely.
async function resolveExcludedBackupPaths(config) {
  const rows = await loadBackupPathRows({ includeDisabled: true });
  return rows.filter((row) => {
    const disabled = row.include_in_default !== undefined && !normalizeBoolean(row.include_in_default);
    return disabled || !backupPathIncluded(row, config);
  });
}

/**
 * Bucket actually-backed-up files into their owning `backup_paths` row.
 *
 * Uses longest-prefix match — e.g. `events/active/E1/photo.jpg` matches
 * `events/active` (length 13) rather than `events` (length 6, if that
 * row existed). This handles the case where a future feature ships a
 * nested backup_paths row that overlaps an existing one.
 *
 * @param {string[]} backedUpRelativePaths — paths that actually got
 *        copied / uploaded (post-incremental-filter). The exact list
 *        the destination implementation reports back.
 * @param {Array<{relativePath, size}>} allFiles — the full file
 *        catalogue from the walker, used as a size lookup table.
 * @returns {Promise<Record<string, { count: number, size: number }>>}
 *        keyed by `backup_paths.path` (e.g. 'events/active'). Paths
 *        with zero matches are omitted to keep the manifest compact.
 */
async function computePerPathStats(backedUpRelativePaths, allFiles) {
  if (!backedUpRelativePaths || backedUpRelativePaths.length === 0) {
    return {};
  }

  // Reuse the same source of truth the walker uses, so a row toggled
  // off by include_in_default doesn't appear in the breakdown either.
  let configuredPaths;
  try {
    if (await db.schema.hasTable('backup_paths')) {
      configuredPaths = await db('backup_paths')
        .where('include_in_default', formatBoolean(true))
        .orderBy('display_order', 'asc')
        .select('path');
    }
  } catch (err) {
    logger.warn(`Could not load backup_paths for per-path stats — falling back to legacy: ${err.message}`);
  }
  if (!configuredPaths || configuredPaths.length === 0) {
    configuredPaths = LEGACY_BACKUP_PATHS.map((p) => ({ path: p.path }));
  }

  // Longest-prefix-first so nested paths win over their parents.
  const sortedPaths = configuredPaths
    .map((row) => row.path)
    .sort((a, b) => b.length - a.length);

  // Size lookup. relativePath uses OS path separators in `allFiles`
  // (whatever scanDirectory built); the backup_paths rows always use
  // forward slashes. Normalize the lookup key once.
  const sizeByPath = new Map();
  for (const f of allFiles || []) {
    sizeByPath.set(f.relativePath.split(path.sep).join('/'), f.size || 0);
  }

  const stats = {};
  for (const relativePath of backedUpRelativePaths) {
    const norm = relativePath.split(path.sep).join('/');
    // Find the longest configured path that this file's relativePath starts with.
    const match = sortedPaths.find(
      (p) => norm === p || norm.startsWith(`${p}/`)
    );
    if (!match) continue; // file outside any configured path (shouldn't happen)
    if (!stats[match]) stats[match] = { count: 0, size: 0 };
    stats[match].count += 1;
    stats[match].size += sizeByPath.get(norm) || 0;
  }

  return stats;
}

async function getFilesToBackupInternal(configOrIncludeArchived = true) {
  const files = [];
  const storagePath = getStoragePath();

  // Backward-compatible call signature:
  //   - Boolean `true|false` → legacy `includeArchived` argument. We
  //     forge a config-shaped object so the feature-flag gating
  //     resolves the same way the old code path did.
  //   - Object             → full resolved backup config (preferred).
  //   - Anything else      → treated as "include archived" (truthy).
  let config;
  if (typeof configOrIncludeArchived === 'object' && configOrIncludeArchived !== null) {
    config = configOrIncludeArchived;
  } else {
    config = { backup_include_archived: normalizeBoolean(configOrIncludeArchived) };
  }

  const targets = await resolveBackupPaths(config);

  // backup_exclude_patterns was only honored by the rsync destination
  // (as --exclude args); the local/S3 walker ignored it. Merge it with
  // the always-on noise filters here so every destination agrees.
  const configuredExcludes = Array.isArray(config.backup_exclude_patterns)
    ? config.backup_exclude_patterns
    : [];
  const excludePatterns = [...new Set([...DEFAULT_EXCLUDE_PATTERNS, ...configuredExcludes])];

  // Never the backup's own output (issue 1780).
  const ownOutput = await ownOutputDirs(config, storagePath);
  const strictCatalogue = ['local', 's3'].includes(String(config.backup_destination_type || 'local').toLowerCase());

  for (const target of targets) {
    // CRM document estate is special-cased in the comment block below
    // because it's the most expensive omission to recover from:
    //   - business-docs/quote/<year>/*.pdf
    //   - business-docs/contract/<year>/*.pdf  (system-rendered + wet uploads)
    //   - business-docs/contract/signatures/<contract_id>/*.{png,jpg}
    //     (drawn signatures, forensic-preserved per Date.now() filename)
    //   - business-docs/invoice/<year>/*.pdf  (issued invoices + Storno)
    //   - business-docs/invoice-imports/<year>/*.pdf  (admin-imported
    //     historical invoices — irrecoverable if not backed up)
    // Without this scan, the audit trail (signed_pdf_sha256, signed_*
    // _ip, accepted_at, etc.) survives the restore but the documents
    // those values refer to do not, leaving every CRM *_path column a
    // broken FK. scanDirectory short-circuits on ENOENT so installs
    // that never used CRM features won't error.
    await scanDirectory(path.join(storagePath, target.path), files, storagePath, excludePatterns, ownOutput, strictCatalogue);
  }

  // Documents a row names in the legacy root (<cwd>/storage) when that is not
  // the storage root: the walk above never sees them. Each is backed up under
  // the storage-relative path the manifest's stored_path_map points its rows
  // at, when a selected backup path covers that path.
  // A failure here must not cost the rest of the backup.
  let legacyFiles = [];
  try {
    legacyFiles = await collectLegacyStoredFiles(db);
  } catch (error) {
    logger.warn(`Could not list documents stored outside the storage root: ${error.message}`);
    if (strictCatalogue) throw error;
  }
  for (const legacy of legacyFiles) {
    const target = targets.find((t) => legacy.rel === t.path || legacy.rel.startsWith(`${t.path}/`));
    if (!target) continue;
    // The walker's exclusions apply to every name below the backup path.
    const below = legacy.rel.slice(target.path.length).split('/').filter(Boolean);
    if (below.some((name) => isExcludedName(name, excludePatterns))) continue;
    let stats;
    try {
      stats = await fs.stat(legacy.abs);
    } catch (error) {
      logger.warn(`Skipping a document stored outside the storage root that is no longer readable: ${error.code || error.message}`);
      if (strictCatalogue) throw error;
      continue;
    }
    files.push({
      path: legacy.abs,
      relativePath: legacy.rel.split('/').join(path.sep),
      size: stats.size,
      modified: stats.mtime,
      legacyValues: legacy.values,
      legacySha256: legacy.sha256,
    });
  }

  return files;
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

// A run that fails before its manifest is written leaves no restore point,
// only a partial copy as large as the estate. Take it away again; a failure
// to do so must not hide why the run failed.
async function discardPartialSnapshot(remove, location) {
  try {
    await remove();
    logger.info(`Removed the partial backup snapshot ${location}`);
  } catch (cleanupError) {
    logger.error(`Could not remove the partial backup snapshot ${location}: ${cleanupError.message}`);
  }
}

async function performLocalBackup(config, files, verifiedDatabaseInfo) {
  const destinationRoot = config.backup_destination_path || path.join(getStoragePath(), 'backups');
  // A bare "EACCES ... mkdir '/home/ubuntu'" did not say that the configured
  // path is looked up inside the container (issue 1365). Resolved first, so
  // a ".." in it means here what path.join makes of it for the files below,
  // and what the connection test probed.
  try {
    await fs.mkdir(path.resolve(destinationRoot), { recursive: true });
  } catch (mkdirError) {
    throw new Error(
      `Cannot create the backup directory ${destinationRoot}: ${mkdirError.code || mkdirError.message}. ` +
      localDestinationHint()
    );
  }

  const backedUpFiles = [];
  let backedUpSize = 0;
  // Never overwrite another restore point, even after history is removed.
  const backupPath = path.resolve(destinationRoot, `backup-${crypto.randomUUID()}`);
  await fs.mkdir(backupPath);

  let databaseInfo;
  try {
    for (const file of files) {
      try {
        const maxSizeMb = config.backup_max_file_size_mb || 5000;
        if (file.size > maxSizeMb * 1024 * 1024) {
          logger.warn(`Skipping large file: ${file.relativePath} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
          continue;
        }

        const checksum = await calculateChecksum(file.path);
        file.checksum = checksum;

        const destinationFile = path.join(backupPath, file.relativePath);
        await fs.mkdir(path.dirname(destinationFile), { recursive: true });
        await fs.copyFile(file.path, destinationFile, fs.constants.COPYFILE_FICLONE);
        if (await calculateChecksum(destinationFile) !== checksum) {
          throw new Error('File changed while its restore point was being created');
        }
        file.size = (await fs.stat(destinationFile)).size;
        if (file.size > maxSizeMb * 1024 * 1024) {
          throw new Error('File grew beyond the configured backup size limit');
        }

        await updateFileState(file.relativePath, checksum, file.size, file.modified);

        backedUpFiles.push(file.relativePath);
        backedUpSize += file.size;
      } catch (error) {
        logger.error(`Failed to backup file ${file.relativePath}:`, error);
        throw error;
      }
    }

    databaseInfo = { ...verifiedDatabaseInfo, backupFile: null, size: 0, checksum: null };
    if (config.backup_include_database == null || normalizeBoolean(config.backup_include_database) !== false) {
      const relativeDump = path.join('database', path.basename(verifiedDatabaseInfo.backupFile));
      const snapshotDump = path.join(backupPath, relativeDump);
      await fs.mkdir(path.dirname(snapshotDump), { recursive: true });
      await fs.copyFile(verifiedDatabaseInfo.backupFile, snapshotDump, fs.constants.COPYFILE_FICLONE);
      const checksum = await calculateChecksum(snapshotDump);
      if (checksum !== verifiedDatabaseInfo.checksum) {
        throw new Error('Database dump changed while its restore point was being created');
      }
      databaseInfo = { ...verifiedDatabaseInfo, backupFile: relativeDump,
        size: (await fs.stat(snapshotDump)).size, checksum };
    }
  } catch (error) {
    await discardPartialSnapshot(() => fs.rm(backupPath, { recursive: true, force: true }), backupPath);
    throw error;
  }

  return {
    backedUpCount: backedUpFiles.length,
    backedUpSize,
    backedUpFiles,
    backupPath,
    databaseInfo
  };
}

function validateRsyncParam(value, label) {
  if (!value || typeof value !== 'string') return null;
  if (!/^[a-zA-Z0-9._/@:-]+$/.test(value)) {
    throw new Error(`Invalid ${label}: contains disallowed characters`);
  }
  if (value.length > 1024) {
    throw new Error(`Invalid ${label}: too long`);
  }
  return value;
}

async function buildRsyncArgs(config, extraExcludes = []) {
  const storagePath = getStoragePath();
  const remotePath = validateRsyncParam(config.backup_rsync_path, 'remote path');

  if (!config.backup_rsync_host || !remotePath) {
    throw new Error('Rsync configuration incomplete');
  }

  const args = ['-avz', '--delete', '--stats'];

  // Same noise filters as the walker, plus the de-selected backup paths
  // (extraExcludes) — rsync syncs the whole storage root, so this is the
  // only place the What-to-Backup selection can take effect for rsync.
  const excludePatterns = [...new Set([
    ...DEFAULT_EXCLUDE_PATTERNS,
    ...(Array.isArray(config.backup_exclude_patterns) ? config.backup_exclude_patterns : []),
    ...extraExcludes,
  ])];
  excludePatterns.forEach(pattern => args.push('--exclude', pattern));

  const source = `${storagePath}/`;

  // Last awaited operation before spawning: the returned literal, not an
  // independently resolved hostname, controls the actual SSH socket.
  const { resolveRsyncConnection } = require('../utils/rsyncConnection');
  const connection = await resolveRsyncConnection({ host: config.backup_rsync_host,
    user: config.backup_rsync_user, sshKey: config.backup_rsync_ssh_key, port: config.backup_rsync_port });
  args.push('-e', connection.rsyncShell);
  args.push(source, `${connection.rsyncTarget}:${remotePath}`);
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
  // Anchored excludes for the de-selected What-to-Backup paths; rsync
  // otherwise transfers the whole storage root regardless of the walker's
  // file list (which only feeds manifests and file state).
  // rsync transfers the storage root itself, so a legacy-root document (see
  // getFilesToBackupInternal) is not in it: leave it out of the manifest
  // rather than record a file the destination never received.
  const legacyCount = files.filter((file) => file.legacyValues).length;
  if (legacyCount) {
    logger.warn(`rsync backup: ${legacyCount} document(s) stored outside the storage root are not transferred; use a local or S3 destination, or a .picpeak export, to include them`);
    files = files.filter((file) => !file.legacyValues);
  }
  const excludedPaths = await resolveExcludedBackupPaths(config);
  const rsyncArgs = await buildRsyncArgs(config, excludedPaths.map((row) => `/${row.path}/`));
  const { stdout } = await spawnAsync('rsync', rsyncArgs).catch((error) => {
    // The run's error_message, failure email and System Health then name
    // the refused host key instead of a bare "rsync exited with code 255".
    throw require('../utils/rsyncConnection').hostKeyFailure(error.stderr || error.message) || error;
  });
  const stats = parseRsyncStats(stdout);

  const totalSize = typeof stats.totalSize === 'number'
    ? stats.totalSize
    : files.reduce((acc, file) => acc + file.size, 0);

  const backedUpFiles = [];
  for (const file of files) {
    try {
      const checksum = await calculateChecksum(file.path);
      file.checksum = checksum;
      await updateFileState(file.relativePath, checksum, file.size, file.modified);
      backedUpFiles.push(file.relativePath);
    } catch (error) {
      // Deleted between the walk and this hash (a photo removed mid-backup):
      // leave it out of the manifest rather than fail the whole run.
      if (error.code === 'ENOENT') {
        logger.warn(`rsync backup: ${file.relativePath} disappeared before it could be hashed; left out of the manifest`);
        continue;
      }
      throw new Error(`Cannot authenticate rsync file ${file.relativePath}: ${error.message}`);
    }
  }

  return {
    backedUpCount: typeof stats.filesTransferred === 'number' ? stats.filesTransferred : backedUpFiles.length,
    backedUpSize: totalSize,
    backedUpFiles,
    backupPath: `${config.backup_rsync_host}:${config.backup_rsync_path}`
  };
}

// Upload only captured bytes: hashing a live source and opening it later for
// upload can publish an object whose bytes disagree with its manifest. Stage
// one file at a time, not the whole estate, and discard it even on failure.
async function uploadCapturedBackupFile(client, source, key, options, maxBytes, expectedChecksum) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-backup-upload-'));
  try {
    const captured = path.join(directory, path.basename(source));
    await fs.copyFile(source, captured, fs.constants.COPYFILE_FICLONE);
    const size = (await fs.stat(captured)).size;
    if (size > maxBytes) throw new Error('File grew beyond the configured backup size limit');
    const checksum = await calculateChecksum(captured);
    if (expectedChecksum && checksum !== expectedChecksum) {
      throw new Error('Database dump changed while its restore point was being created');
    }
    await client.upload(captured, key, {
      ...options, metadata: { ...options.metadata, checksum }
    });
    return { size, checksum };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function performS3Backup(config, files, verifiedDatabaseInfo) {
  let s3Client;
  let s3Prefix;
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
      retryDelay: config.backup_s3_retry_delay || 1000,
      ...backupS3Access(config)
    };

    s3Client = new S3StorageAdapter(s3Config);
    await s3Client.testConnection();

    const now = new Date();
    const datePrefix = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
    const backupId = `backup-${crypto.randomUUID()}`;
    const basePrefix = config.backup_s3_prefix ? config.backup_s3_prefix : 'backups';
    s3Prefix = path.posix.join(basePrefix, datePrefix, backupId);

    const backedUpFiles = [];
    let backedUpSize = 0;

    for (const file of files) {
      try {
        const maxSizeMb = config.backup_max_file_size_mb || 5000;
        if (file.size > maxSizeMb * 1024 * 1024) {
          logger.warn(`Skipping large file: ${file.relativePath} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
          continue;
        }

        const s3Key = path.posix.join(s3Prefix, file.relativePath);
        const captured = await uploadCapturedBackupFile(s3Client, file.path, s3Key, {
          metadata: {
            'original-path': file.relativePath,
            'backup-id': backupId,
            'backup-time': now.toISOString()
          }
        }, maxSizeMb * 1024 * 1024);
        const { checksum } = captured;
        file.checksum = checksum;
        file.size = captured.size;

        await updateFileState(file.relativePath, checksum, file.size, file.modified);

        backedUpFiles.push(file.relativePath);
        backedUpSize += file.size;
      } catch (error) {
        logger.error(`Failed to backup file ${file.relativePath} to S3:`, error);
        throw error;
      }
    }

    let databaseInfo = { ...verifiedDatabaseInfo, backupFile: null, size: 0, checksum: null };
    if (config.backup_include_database == null || normalizeBoolean(config.backup_include_database) !== false) {
      try {
        databaseInfo = verifiedDatabaseInfo;
        if (databaseInfo.backupFile && await fs.stat(databaseInfo.backupFile).catch(() => null)) {
          const dbKey = path.posix.join(s3Prefix, 'database', path.basename(databaseInfo.backupFile));
          const captured = await uploadCapturedBackupFile(s3Client, databaseInfo.backupFile, dbKey, {
            metadata: {
              'backup-id': backupId,
              'backup-type': 'database',
              'database-type': databaseInfo.type
            }
          }, Infinity, databaseInfo.checksum);
          const relativeDump = path.posix.join('database', path.basename(databaseInfo.backupFile));
          databaseInfo = { ...databaseInfo, ...captured, backupFile: relativeDump };
          backedUpFiles.push(relativeDump);
          backedUpSize += databaseInfo.size || 0;
        } else {
          throw new Error('No verified database dump is available for this S3 restore point');
        }
      } catch (error) {
        logger.error('Failed to include database backup in S3:', error);
        throw error;
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
    if (s3Prefix) {
      await discardPartialSnapshot(() => removeS3Snapshot(s3Client, s3Prefix), s3Prefix);
    }
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

function buildManifestFiles(backedUpFiles, allFiles, databaseInfo) {
  const fileMap = new Map();
  allFiles.forEach(file => {
    fileMap.set(file.relativePath, file);
  });
  if (databaseInfo?.backupFile) {
    fileMap.set(path.posix.join('database', path.basename(databaseInfo.backupFile)), {
      size: databaseInfo.size, checksum: databaseInfo.checksum,
    });
  }

  return backedUpFiles.map(relativePath => {
    const source = fileMap.get(relativePath) || {};
    return {
      path: relativePath,
      size: source.size ?? null,
      checksum: source.checksum || null
    };
  });
}

// Errors that mean "this directory cannot be used", as opposed to a failed
// write into a usable one.
const UNUSABLE_DIRECTORY_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'EROFS']);

async function saveManifestToLocal(manifest, manifestFileName, config) {
  const defaultDir = path.join(config.backup_destination_path || path.join(getStoragePath(), 'backups'), 'manifests');
  const writeTo = async (manifestDir) => {
    await fs.mkdir(manifestDir, { recursive: true });
    const manifestPath = path.join(manifestDir, manifestFileName);
    await backupManifest.saveManifest(manifest, manifestPath, config.backup_manifest_format || 'json');
    return manifestPath;
  };
  let manifestPath;
  try {
    manifestPath = await writeTo(config.backup_manifest_path || defaultDir);
  } catch (error) {
    // backup_manifest_path is seeded as /backup/manifests on every install
    // (migration 031). Where that is not writable and the backup goes
    // elsewhere, the manifest belongs with the backup rather than nowhere.
    if (!config.backup_manifest_path || path.resolve(config.backup_manifest_path) === path.resolve(defaultDir)
        || !UNUSABLE_DIRECTORY_CODES.has(error.code)) {
      throw error;
    }
    logger.warn(`Backup manifest directory ${config.backup_manifest_path} is not usable (${error.code}); writing the manifest to ${defaultDir} instead`);
    try {
      manifestPath = await writeTo(defaultDir);
    } catch (fallbackError) {
      throw new Error(`Cannot write the backup manifest: ${config.backup_manifest_path} is not usable (${error.code}) `
        + `and neither is ${defaultDir} (${fallbackError.code || fallbackError.message})`);
    }
  }
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

const DEFAULT_RETENTION_COUNT = 7;

// Every local and S3 run is a complete copy, so without a limit the
// destination grows by one estate per run. Keep the newest
// backup_retention_count standalone snapshots of the current destination and
// remove the older ones whole, with their history rows. 0 keeps everything.
// Legacy trees and anything not shaped like a standalone snapshot are never
// candidates, and a failure here never fails the backup that just succeeded.
async function pruneStandaloneSnapshots(config, destinationType, currentRunId, s3Client) {
  try {
    const raw = config.backup_retention_count;
    const keep = raw === undefined || raw === null || raw === '' ? DEFAULT_RETENTION_COUNT : Number(raw);
    if (!Number.isInteger(keep) || keep <= 0) return;

    const runs = await db('backup_runs')
      .where('status', 'completed')
      .whereNotNull('manifest_path')
      .orderBy('id', 'desc')
      .select('id', 'manifest_path', 'statistics');
    let kept = 0;
    for (const run of runs) {
      const snapshot = standaloneSnapshotOfRun(config, run);
      if (!snapshot || snapshot.type !== destinationType) continue;
      if (run.id === currentRunId || kept < keep) {
        kept += 1;
        continue;
      }
      try {
        if (snapshot.type === 's3') {
          await removeS3Snapshot(s3Client, snapshot.prefix);
        } else {
          await removeLocalSnapshot(snapshot.destinationRoot, snapshot.root);
          if (snapshot.manifestFile) await fs.rm(snapshot.manifestFile, { force: true });
        }
        await db.transaction(async (trx) => {
          await trx('backup_manifest').where('backup_run_id', run.id).del();
          await trx('backup_runs').where('parent_backup_id', run.id).update({ parent_backup_id: null });
          await trx('backup_runs').where('id', run.id).del();
        });
        logger.info(`Backup retention removed the restore point of run ${run.id} (${snapshot.root || snapshot.prefix})`);
      } catch (error) {
        logger.error(`Backup retention could not remove the restore point of run ${run.id}: ${error.message}`);
      }
    }
  } catch (error) {
    logger.error('Backup retention failed:', error);
  }
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

    // A destination that is itself a backed-up folder nests one more copy
    // of the tree per run (issue 1780). Before the dump, which is written
    // there too.
    const clashingFolder = await backedUpFolderAtDestination(config);
    if (clashingFolder) {
      throw new Error(destinationIsBackedUpFolderMessage(clashingFolder));
    }
    backupManifestKey.loadKey({ create: true });

    // Inline DB dump + fail-loud verification. The returned `databaseInfo`
    // is reused at manifest-build time below so we don't pay a second
    // `getDatabaseBackupInfo()` round-trip — see `ensureDatabaseDumpForBackup`
    // for the full rationale.
    const verifiedDatabaseInfo = await ensureDatabaseDumpForBackup(config);

    // Pass the full config so the walker can evaluate any feature_flag
    // gates declared in the backup_paths table (e.g. `events/archived`
    // gated by `backup_include_archived`). Boolean signature is still
    // supported for legacy callers and tests — see getFilesToBackupInternal.
    const files = await service.getFilesToBackup(config);
    logger.info(`Found ${files.length} files to check for backup`);

    let result;
    const destinationType = (config.backup_destination_type || 'local').toLowerCase();

    if (destinationType === 'local') {
      result = await performLocalBackup(config, files, verifiedDatabaseInfo);
    } else if (destinationType === 'rsync') {
      result = await performRsyncBackup(config, files);
    } else if (destinationType === 's3') {
      result = await performS3Backup(config, files, verifiedDatabaseInfo);
    } else {
      throw new Error(`Unknown backup destination type: ${config.backup_destination_type}`);
    }

    const endTime = new Date();
    const durationSeconds = Math.round((endTime - startTime) / 1000);

    let manifestPath = null;
    let manifestSummary = null;

    try {
      logger.info('Generating backup manifest...');

      const previousBackup = destinationType === 'rsync'
        ? await getPreviousSuccessfulBackup(runId) : null;
      // `verifiedDatabaseInfo` came from ensureDatabaseDumpForBackup at the
      // top of this run — reuse it so manifest building doesn't pay a
      // second `getDatabaseBackupInfo()` round-trip. The
      // `result.databaseInfo` branch is kept for destination implementations
      // (S3, future destinations) that override the local info on the result
      // object; falls back to the verified copy otherwise.
      const databaseInfo = result.databaseInfo || verifiedDatabaseInfo;
      const manifestFiles = buildManifestFiles(result.backedUpFiles, files, databaseInfo);

      // Rows naming a legacy-root document are pointed at its backed-up path
      // on restore (restoreService). rsync leaves those documents out.
      // `file.checksum` (set by performLocalBackup/performS3Backup right
      // before the copy/upload) reflects the bytes actually archived; prefer
      // it over `legacySha256`, which collectLegacyStoredFiles computed
      // earlier during the collection walk and can go stale if the source
      // file changes between collection and the archive write.
      const legacyBacked = (destinationType === 'rsync' ? [] : files.filter((file) => file.legacyValues))
        .map((file) => ({
          rel: file.relativePath.split(path.sep).join('/'),
          values: file.legacyValues,
          sha256: file.checksum || file.legacySha256,
        }));
      const legacyMap = storedPathMap(legacyBacked);
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
          ...(destinationType === 'local' || destinationType === 's3'
            ? { restore_point: 'standalone-v1',
              restore_point_manifest_layout: destinationType === 'local' && config.backup_manifest_path
                ? 'external' : 'nested' } : {}),
          retentionDays: config.backup_retention_days || 30,
          ...(Object.keys(legacyMap).length
            ? { stored_path_map: legacyMap, stored_path_sha256: storedPathChecksums(legacyBacked) }
            : {})
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
        const manifestConfig = destinationType === 'local'
          ? { ...config, backup_destination_path: result.backupPath } : config;
        manifestPath = await saveManifestToLocal(manifest, `backup-manifest-${manifest.backup.id}.${manifestOptions.format}`, manifestConfig);
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
      // Without a manifest the copy is not a restore point. manifestPath is
      // only set once the manifest is in place, and then the snapshot stays.
      if (!manifestPath && destinationType === 'local') {
        await discardPartialSnapshot(() => fs.rm(result.backupPath, { recursive: true, force: true }), result.backupPath);
      } else if (!manifestPath && destinationType === 's3') {
        await discardPartialSnapshot(() => removeS3Snapshot(result.s3Client, result.s3Prefix), result.s3Prefix);
      }
      throw error;
    }

    // Per-Stage-B-path stats — bucket the actually-backed-up files
    // into their owning backup_paths row by longest-prefix match. Lets
    // the Backup History detail pane render a true breakdown
    //   events/active: 142 files (3.2 GB)
    //   business-docs: 17 files (4.5 MB)
    //   thumbnails: 142 files (12.4 MB)
    // instead of the legacy "Photos + Archives + Other" categorization
    // that didn't reflect Stage B's data-driven walker. Falls back to
    // an empty map if backup_paths is missing (defense in depth — the
    // walker has the same fallback).
    const perPath = await computePerPathStats(result.backedUpFiles, files);

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
          // Where this run's standalone snapshot lives; retention needs it
          // when the manifest is kept elsewhere.
          ...(destinationType === 'local' || destinationType === 's3' ? { snapshot_path: result.backupPath } : {}),
          // Per-Stage-B-path breakdown — { [pathKey]: { count, size } }
          per_path: perPath,
          // Keep camelCase for backward compatibility
          totalFilesChecked: files.length,
          filesBackedUp: result.backedUpCount,
          totalSize: result.backedUpSize,
          averageFileSize: result.backedUpCount ? Math.round(result.backedUpSize / result.backedUpCount) : 0,
          perPath
        })
      });

    logger.info(`Backup completed: ${result.backedUpCount} files, ${(result.backedUpSize / 1024 / 1024).toFixed(2)} MB in ${durationSeconds}s`);

    if (destinationType === 'local' || destinationType === 's3') {
      await pruneStandaloneSnapshots(config, destinationType, runId, result.s3Client);
    }

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

// Two settings cooperate here:
//   - backup_schedule           — UI label like "daily" / "weekly" / "custom"
//   - backup_schedule_cron      — actual cron expression (custom schedules)
// Older startup code read backup_schedule and crashed when it found a label
// instead of a cron expression. Resolution order: explicit cron field, then
// map known labels, then fall back to default.
const NAMED_SCHEDULES = {
  hourly: '0 * * * *',
  daily: '0 2 * * *',
  weekly: '0 3 * * 0',  // Sunday 03:00
  monthly: '0 4 1 * *',
};

function resolveScheduleCron(config) {
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
  // A named label wins over the cron field: the UI always used to send its
  // default cron ('0 3 * * *') alongside e.g. backup_schedule='weekly', which
  // silently turned weekly schedules into daily ones (issue #871). The cron
  // field only applies for 'custom' (or when no known label is set).
  if (labelCandidate && labelCandidate.toLowerCase() !== 'custom' && NAMED_SCHEDULES[labelCandidate.toLowerCase()]) {
    schedule = NAMED_SCHEDULES[labelCandidate.toLowerCase()];
  } else if (cronCandidate && isCronExpression(cronCandidate)) {
    schedule = cronCandidate;
  } else if (labelCandidate && isCronExpression(labelCandidate)) {
    // Back-compat: a deployment that wrote a cron expression directly into
    // backup_schedule (no _cron field) still works.
    schedule = labelCandidate;
  }
  return schedule;
}

async function startBackupService() {
  try {
    const config = await resolveConfigWithFallback();
    const trustWarning = require('../utils/rsyncConnection').missingKnownHostsWarning(config);
    if (trustWarning) logger.warn(trustWarning);
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

    const schedule = resolveScheduleCron(config);

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
    let manifestAuthentication = { authenticated: false, state: 'unavailable' };

    if (lastRun && lastRun.manifest_path) {
      try {
        // Use validateBackupManifest which handles both local and S3 paths
        const result = await validateBackupManifest(lastRun.manifest_path);
        manifestValid = result.valid;
        manifestAuthentication = result.authentication || { authenticated: false, state: 'unverified' };
        if (!result.valid && manifestAuthentication.state !== 'legacy') {
          logger.warn('Manifest validation failed:', result.error);
        }
      } catch (error) {
        logger.warn('Manifest validation failed:', error.message);
      }
    }

    const signingKey = backupManifestKey.keyStatus();
    const lastRunWithManifest = lastRun ? { ...lastRun, manifestValid, authentication: manifestAuthentication } : null;

    // Separate "most recent attempt" from "most recent SUCCESS" so the
    // dashboard widget can distinguish:
    //   - last attempt failed → red, "Last attempt failed at X"
    //   - last attempt running → blue spinner, "In progress since X"
    //   - never succeeded → critical, "No successful backup yet"
    //   - last attempt succeeded → green tick, "Last backup X ago"
    // Previously the widget showed the most-recent row with a generic
    // green tick regardless of status, so a crashed run from 5 minutes
    // ago looked identical to a successful one. Same "silent failure
    // not surfaced" class Stage A was designed to fight.
    const lastSuccessful = runs.find(r => r.status === 'completed') || null;
    const config = await getBackupConfigInternal();
    const nextRun = getNextScheduledRun(config);
    // Detect zombie running rows (started >30min ago, never updated)
    // — these are processes that died without writing a completed_at.
    // Surface them so the admin can tell at a glance vs a live run.
    const ZOMBIE_THRESHOLD_MS = 30 * 60 * 1000;
    const zombieRuns = runs.filter(r =>
      r.status === 'running'
      && r.started_at
      && (Date.now() - new Date(r.started_at).getTime()) > ZOMBIE_THRESHOLD_MS
    );

    return {
      isRunning,
      // A latest manifest that merely predates authentication is not a fault:
      // the next backup signs a new one. It still cannot be restored as-is.
      isHealthy: Boolean(lastRun && lastRun.status === 'completed' && signingKey.ready
        && (manifestAuthentication.state === 'legacy' || (manifestValid && manifestAuthentication.authenticated))),
      signingKey,
      manifestAuthentication,
      lastRun: lastRunWithManifest,
      lastBackup: lastRunWithManifest, // Alias for frontend compatibility
      lastSuccessfulBackup: lastSuccessful, // NEW — see comment above
      zombieRuns,                           // NEW — running >30min, likely crashed
      recentRuns: runs,
      recentBackups: runs, // Alias for frontend compatibility
      totalBackups: runs.filter(r => r.status === 'completed').length,
      nextScheduledRun: nextRun,
      nextBackup: nextRun // BackupManagement.tsx reads this name
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

function getNextScheduledRun(config) {
  // null → the UI shows "Not scheduled". Only a real, enabled schedule
  // produces a date (issue #871: this used to be a hardcoded "tomorrow
  // 02:00" that ignored the configured schedule entirely).
  if (!config || !normalizeBoolean(config.backup_enabled)) {
    return null;
  }
  try {
    return cronParser.parseExpression(resolveScheduleCron(config)).next().toISOString();
  } catch (error) {
    logger.warn(`Could not compute next backup run: ${error.message}`);
    return null;
  }
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

  const match = manifestPath.match(/^s3:\/\/([^/]+)\/(.+)$/);
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
    ...backupS3Access(cfg),
  });

  try {
    await s3Client.download(key, tempPath);
    return await backupManifest.loadManifest(tempPath);
  } finally {
    await fs.unlink(tempPath).catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// A manifest stored in S3 is fetched into a temp dir for every status
// request and read whole into memory by loadManifest(). Bound it: HeadObject
// first, then a byte counter on the body, and remove whatever landed on
// disk whether or not the download or the parse succeeded.
const MAX_S3_MANIFEST_BYTES = 16 * 1024 * 1024;

async function loadManifestFromS3Bounded(s3Client, key, backupRunLabel, options = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-manifest-'));
  const tempPath = path.join(tempDir, `manifest-${backupRunLabel}.json`);
  try {
    const head = await s3Client.getMetadata(key);
    const contentLength = Number(head && head.ContentLength);
    if (Number.isFinite(contentLength) && contentLength > MAX_S3_MANIFEST_BYTES) {
      throw new Error(`Backup manifest is ${contentLength} bytes, above the ${MAX_S3_MANIFEST_BYTES}-byte limit`);
    }
    let seen = 0;
    const limiter = new Transform({
      transform(chunk, _enc, cb) {
        seen += chunk.length;
        if (seen > MAX_S3_MANIFEST_BYTES) {
          return cb(new Error(`Backup manifest exceeds the ${MAX_S3_MANIFEST_BYTES}-byte limit`));
        }
        cb(null, chunk);
      },
    });
    const body = await s3Client.downloadStream(key);
    await pipeline(body, limiter, fsSync.createWriteStream(tempPath));
    return await backupManifest.loadManifest(tempPath, options);
  } finally {
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
    // Reading is not restoring: a manifest from before authentication is
    // still shown, flagged, instead of answering 404.
    const manifest = await backupManifest.loadManifest(run.manifest_path, { inspect: true });
    return {
      manifest,
      authenticated: backupManifest.getAuthentication(manifest).authenticated === true,
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

  const match = run.manifest_path.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    throw new Error('Invalid S3 manifest path');
  }

  const [, bucket, key] = match;

  const s3Client = new S3StorageAdapter({
    bucket,
    region: (config && config.backup_s3_region) || 'us-east-1',
    endpoint: config && config.backup_s3_endpoint,
    accessKeyId: accessKey,
    secretAccessKey: secretKey,
    forcePathStyle: config ? normalizeBoolean(config.backup_s3_force_path_style) : false,
    sslEnabled: config && config.backup_s3_ssl_enabled !== undefined
      ? normalizeBoolean(config.backup_s3_ssl_enabled)
      : true,
    ...backupS3Access(config)
  });

  const manifest = await loadManifestFromS3Bounded(s3Client, key, backupRunId, { inspect: true });

  return {
    manifest,
    authenticated: backupManifest.getAuthentication(manifest).authenticated === true,
    summary: backupManifest.generateSummaryReport
      ? backupManifest.generateSummaryReport(manifest)
      : null
  };
}

async function validateBackupManifest(manifestPath) {
  try {
    let manifest;

    if (manifestPath.startsWith('s3://')) {
      const match = manifestPath.match(/^s3:\/\/([^/]+)\/(.+)$/);
      if (!match) {
        throw new Error('Invalid S3 manifest path');
      }
      const [, bucket, key] = match;

      const config = await service.getBackupConfig();
      if (!config || !config.backup_s3_access_key || !config.backup_s3_secret_key) {
        throw new Error('S3 credentials not configured for manifest validation');
      }

      const s3Client = new S3StorageAdapter({
        bucket,
        region: config.backup_s3_region || 'us-east-1',
        endpoint: config.backup_s3_endpoint,
        accessKeyId: config.backup_s3_access_key,
        secretAccessKey: config.backup_s3_secret_key,
        forcePathStyle: normalizeBoolean(config.backup_s3_force_path_style),
        sslEnabled: config.backup_s3_ssl_enabled === undefined ? true : normalizeBoolean(config.backup_s3_ssl_enabled),
        ...backupS3Access(config)
      });

      manifest = await loadManifestFromS3Bounded(s3Client, key, `validate-${Date.now()}`, { inspect: true });
    } else {
      manifest = await backupManifest.loadManifest(manifestPath, { inspect: true });
    }

    if (backupManifest.validateManifest) {
      backupManifest.validateManifest(manifest, { inspect: true });
    }

    const authentication = backupManifest.getAuthentication(manifest);
    // Intact but written before manifests were authenticated: still not
    // valid, and named as its own state so health can tell it from damage.
    if (!authentication.valid) {
      return { valid: false, error: authentication.error, authentication: { authenticated: false, state: 'legacy' } };
    }
    return { valid: true, manifest, authentication };
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
service.loadManifestFromS3Bounded = loadManifestFromS3Bounded;
service.MAX_S3_MANIFEST_BYTES = MAX_S3_MANIFEST_BYTES;
service.resolveBackupPaths = resolveBackupPaths;
service.backedUpFolderAtDestination = backedUpFolderAtDestination;
service.destinationIsBackedUpFolderMessage = destinationIsBackedUpFolderMessage;
service.resolveExcludedBackupPaths = resolveExcludedBackupPaths;
service.backupPathIncluded = backupPathIncluded;
service.effectiveFlagValue = effectiveFlagValue;
service.normalizeBoolean = normalizeBoolean;
service.buildRsyncArgs = buildRsyncArgs;
service.resolveScheduleCron = resolveScheduleCron;
service.getNextScheduledRun = getNextScheduledRun;

module.exports = service;
