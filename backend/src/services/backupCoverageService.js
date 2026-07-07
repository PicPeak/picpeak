/**
 * Backup-coverage diagnostic — Stage C of the backup-hardening plan.
 *
 * **Why this is a separate service**
 *
 * Stage A (inline DB dump + fail-loud) and Stage B (config-driven
 * walker via `backup_paths`) close the data-loss footgun, but they
 * don't tell an admin *what* the next backup will actually cover.
 * That's a separate question — and a particularly important one,
 * because the whole reason Stage B exists is that the walker's
 * subdirectory list used to silently fall behind reality every time
 * a new feature dropped artefacts under STORAGE_PATH.
 *
 * This service answers two questions:
 *
 *   1. For every row in `backup_paths`, what will the next backup
 *      do with it? (scan / skip-via-feature-flag / skip-via-toggle /
 *      missing-on-disk)
 *   2. What subdirectories EXIST under STORAGE_PATH but have NO row
 *      in `backup_paths` — i.e. drift the admin should know about
 *      before they lose data on a restore?
 *
 * Plus a top-level database-dump status block: are we configured
 * for inline dump (default), or relying on the scheduled dump?
 * When was the last successful dump? Is it stale?
 *
 * **What this service does NOT do**
 *
 *   - Does not run the backup
 *   - Does not write anything (no DB mutations, no fs touches)
 *   - Does not auto-recover drift (it's a diagnostic — admins decide
 *     whether to add a `backup_paths` row, delete the orphan dir, etc.)
 *   - Does not walk file contents — only top-level directory entries
 *     under STORAGE_PATH are inspected (cheap; no recursion through
 *     potentially-millions of photos)
 *
 * Read-only. Returns a JSON report — same shape as
 * backupIntegrityService.verifyDocumentArtefacts.
 */

const fs = require('fs').promises;
const path = require('path');
const { db } = require('../database/db');
const logger = require('../utils/logger');
const backupService = require('./backupService');

const STORAGE_ROOT = () => process.env.STORAGE_PATH || path.join(process.cwd(), 'storage');

/**
 * Top-level subdirectories we expect to find under STORAGE_PATH but
 * which are intentionally NOT in `backup_paths` — they're generated
 * caches / runtime artefacts that the backup is supposed to skip.
 * Listing them here keeps the drift detector from flagging them.
 *
 * `backups`    — the destination directory the backup writer itself
 *                creates, plus the `database_backup_runs` dump files.
 *                Including it in the walker would create a recursive
 *                "backup of backups" feedback loop.
 *
 * `tmp`        — short-lived scratch space (e.g. PDF render staging,
 *                S3 multipart uploads). Re-created on demand, never
 *                holds the only copy of anything.
 */
const EXPECTED_NON_BACKUP_DIRS = new Set([
  'backups',
  'tmp',
]);

/**
 * How stale a database dump can be before we flag it. 26 hours so a
 * daily scheduled dump is still considered "fresh" if it ran a few
 * hours late.
 */
const DB_DUMP_STALE_AFTER_MS = 26 * 60 * 60 * 1000;

function parseSettingValue(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch (_) {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
}

async function readBackupConfig() {
  try {
    const rows = await db('app_settings')
      .where('setting_type', 'backup')
      .select('setting_key', 'setting_value');
    const cfg = {};
    for (const row of rows) {
      cfg[row.setting_key] = parseSettingValue(row.setting_value);
    }
    return cfg;
  } catch (err) {
    logger.warn(`backup-coverage: could not read backup config — ${err.message}`);
    return {};
  }
}

async function listConfiguredPaths() {
  try {
    if (!(await db.schema.hasTable('backup_paths'))) return null;
    return await db('backup_paths')
      .orderBy('display_order', 'asc')
      .select('path', 'include_in_default', 'feature_flag', 'display_order', 'description');
  } catch (err) {
    logger.warn(`backup-coverage: could not read backup_paths — ${err.message}`);
    return null;
  }
}

async function listTopLevelStorageDirs() {
  const root = STORAGE_ROOT();
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    logger.warn(`backup-coverage: could not read STORAGE_PATH (${root}) — ${err.message}`);
    return [];
  }
}

async function statPath(absPath) {
  try {
    const st = await fs.stat(absPath);
    return { exists: true, isDir: st.isDirectory() };
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, isDir: false };
    throw err;
  }
}

/**
 * Build the database-dump status block. Tells the admin whether
 * "Run Backup Now" will inline-dump (default) or rely on the
 * scheduled-dump path, plus how fresh the most recent dump is.
 */
async function buildDatabaseStatus(config) {
  // normalizeBoolean(undefined) === false, so we have to gate on
  // explicit-false the same way ensureDatabaseDumpForBackup does.
  const inlineExplicitlyOff = config.backup_database_inline_dump !== undefined
    && config.backup_database_inline_dump !== null
    && config.backup_database_inline_dump === false;
  const mode = inlineExplicitlyOff ? 'scheduled-only' : 'inline';

  let recent = null;
  try {
    if (await db.schema.hasTable('database_backup_runs')) {
      recent = await db('database_backup_runs')
        .where('status', 'completed')
        .orderBy('completed_at', 'desc')
        .first();
    }
  } catch (err) {
    logger.warn(`backup-coverage: could not read database_backup_runs — ${err.message}`);
  }

  const status = {
    mode,
    inlineDumpExplicitlyDisabled: inlineExplicitlyOff,
    lastDumpAt: recent ? recent.completed_at : null,
    lastDumpType: recent ? recent.backup_type : null,
    lastDumpSizeBytes: recent ? Number(recent.file_size_bytes || 0) : 0,
    lastDumpFilePath: recent ? recent.file_path : null,
    lastDumpAgeMs: null,
    lastDumpStale: null,
    ok: null,
  };

  if (recent && recent.completed_at) {
    const completedAt = recent.completed_at instanceof Date
      ? recent.completed_at
      : new Date(recent.completed_at);
    status.lastDumpAgeMs = Date.now() - completedAt.getTime();
    status.lastDumpStale = status.lastDumpAgeMs > DB_DUMP_STALE_AFTER_MS;
  }

  // ok semantics:
  //   - inline mode: always ok=true (next backup will produce a fresh
  //     dump on demand, staleness is irrelevant)
  //   - scheduled-only: ok=true iff a recent non-stale dump exists,
  //     because the file-backup guard will fail-loud otherwise
  if (mode === 'inline') {
    status.ok = true;
  } else {
    status.ok = Boolean(recent && recent.file_path && status.lastDumpStale === false);
  }

  return status;
}

/**
 * Per-path coverage:
 *   - configured + include_in_default + (no feature_flag OR flag truthy) → 'will-scan'
 *   - configured + include_in_default + flag falsey → 'skipped-by-feature-flag'
 *   - configured + include_in_default = false → 'skipped-by-toggle'
 *   - configured but missing on disk → 'missing-on-disk'
 *
 * Returns one entry per `backup_paths` row.
 */
async function buildConfiguredPathReport(configuredRows, config) {
  const root = STORAGE_ROOT();
  const result = [];

  for (const row of configuredRows) {
    const absPath = path.join(root, row.path);
    const stat = await statPath(absPath);
    const includedInDefault = Boolean(row.include_in_default);
    let featureFlagValue = null;
    if (row.feature_flag) {
      const v = config[row.feature_flag];
      featureFlagValue = v === undefined ? null : Boolean(v);
    }

    let coverage;
    if (!includedInDefault) {
      coverage = 'skipped-by-toggle';
    } else if (row.feature_flag && featureFlagValue !== true) {
      // null (unset) and explicit false both gate the path off — matches
      // the walker's normalizeBoolean semantics
      coverage = 'skipped-by-feature-flag';
    } else if (!stat.exists) {
      coverage = 'missing-on-disk';
    } else {
      coverage = 'will-scan';
    }

    result.push({
      path: row.path,
      includeInDefault: includedInDefault,
      featureFlag: row.feature_flag || null,
      featureFlagValue,
      displayOrder: row.display_order,
      description: row.description || null,
      existsOnDisk: stat.exists,
      coverage,
    });
  }

  return result;
}

/**
 * Drift detection: top-level subdirs under STORAGE_PATH that are not
 * in `backup_paths` AND not in the `EXPECTED_NON_BACKUP_DIRS` allow-list.
 *
 * These are the directories that will be missed by "Run Backup Now"
 * — either intentionally (a new feature drops cache files there and
 * the admin doesn't want them backed up — they should add them to the
 * allow-list) or accidentally (a feature shipped without a matching
 * `backup_paths` row — the data-loss footgun this whole effort is
 * designed to catch).
 */
function detectDrift(diskDirs, configuredPaths) {
  // configured paths can be nested ('events/active'); we only diff the
  // top-level segment ('events') because that's the granularity admins
  // see in the storage tree. A path like 'events/active' implies the
  // 'events' top-level is "known to the backup config".
  const configuredTopLevels = new Set(
    configuredPaths.map((p) => p.path.split('/')[0]),
  );

  return diskDirs
    .filter((d) => !configuredTopLevels.has(d))
    .filter((d) => !EXPECTED_NON_BACKUP_DIRS.has(d))
    .sort();
}

/**
 * Public entry point.
 *
 * @returns {Promise<{
 *   database: object,
 *   paths: Array<object>,
 *   drift: { unconfiguredOnDisk: string[], expectedNonBackupDirs: string[] },
 *   summary: object,
 *   generatedAt: string,
 * }>}
 */
async function getCoverageReport() {
  const config = await readBackupConfig();
  const configuredRows = await listConfiguredPaths();
  const diskDirs = await listTopLevelStorageDirs();

  // Fallback when the table doesn't exist yet (migration 108 hasn't
  // run for some reason). Mirrors the walker's LEGACY_BACKUP_PATHS
  // contract — every other layer of this system uses the same
  // belt-and-suspenders fallback.
  const fallback = configuredRows === null;
  const effectiveRows = configuredRows || [
    { path: 'events/active',    include_in_default: true,  feature_flag: null,                       display_order: 10, description: 'Legacy fallback (backup_paths missing)' },
    { path: 'events/archived',  include_in_default: true,  feature_flag: 'backup_include_archived', display_order: 20, description: 'Legacy fallback (backup_paths missing)' },
    { path: 'thumbnails',       include_in_default: true,  feature_flag: null,                       display_order: 30, description: 'Legacy fallback (backup_paths missing)' },
    { path: 'previews',         include_in_default: true,  feature_flag: null,                       display_order: 40, description: 'Legacy fallback (backup_paths missing)' },
    { path: 'heroes',           include_in_default: true,  feature_flag: null,                       display_order: 50, description: 'Legacy fallback (backup_paths missing)' },
    { path: 'uploads',          include_in_default: true,  feature_flag: null,                       display_order: 60, description: 'Legacy fallback (backup_paths missing)' },
    { path: 'business-docs',    include_in_default: true,  feature_flag: null,                       display_order: 70, description: 'Legacy fallback (backup_paths missing)' },
  ];

  const [database, paths] = await Promise.all([
    buildDatabaseStatus(config),
    buildConfiguredPathReport(effectiveRows, config),
  ]);

  const unconfiguredOnDisk = detectDrift(diskDirs, effectiveRows);

  const summary = {
    configuredCount: effectiveRows.length,
    willScanCount:           paths.filter((p) => p.coverage === 'will-scan').length,
    skippedByToggleCount:    paths.filter((p) => p.coverage === 'skipped-by-toggle').length,
    skippedByFeatureFlagCount: paths.filter((p) => p.coverage === 'skipped-by-feature-flag').length,
    missingOnDiskCount:      paths.filter((p) => p.coverage === 'missing-on-disk').length,
    driftCount: unconfiguredOnDisk.length,
    tableMissingFallbackInUse: fallback,
    databaseOk: database.ok,
    // overall: green only when DB is ok AND there's at least one path
    // that will actually be scanned AND no drift was found
    overallOk: Boolean(
      database.ok
      && paths.some((p) => p.coverage === 'will-scan')
      && unconfiguredOnDisk.length === 0,
    ),
  };

  return {
    database,
    paths,
    drift: {
      unconfiguredOnDisk,
      expectedNonBackupDirs: Array.from(EXPECTED_NON_BACKUP_DIRS).sort(),
    },
    summary,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  getCoverageReport,
  // Exported for test introspection — the route doesn't use these.
  EXPECTED_NON_BACKUP_DIRS,
  DB_DUMP_STALE_AFTER_MS,
};

// Silence unused import lint warning — backupService is required so
// the module-graph cache primes (some tests jest.mock it before
// requiring this service).
void backupService;
