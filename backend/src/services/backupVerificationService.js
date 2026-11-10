'use strict';

/**
 * Backup restore tests: does a backup actually restore?
 *
 * A completed backup run with a valid manifest signature says nothing about
 * whether its bytes are still there and load. This service answers that, in
 * two levels, and keeps one `backup_verifications` row per test:
 *
 *   deep   Fetch the restore point back from its destination (local or S3),
 *          check the manifest signature, hash the database dump against the
 *          manifest, hash every business-docs/ file plus a rotating sample
 *          of the other files (all of them on a "full" run), and check the
 *          parent chain.
 *   drill  Load the dump into a throwaway database, never the live one: a
 *          private SQLite copy, or a `picpeak_drill_<id>` PostgreSQL
 *          database that is dropped afterwards. Check integrity, foreign
 *          keys and row counts, migrate it forward to this version, and
 *          check that an active super admin, roles, permissions and settings
 *          exist. Without CREATEDB the test stays at deep and says so.
 *
 * When it runs: right after every successful file backup and database-only
 * backup (never changing that run's own status), on a schedule that
 * re-checks every retained restore point (default Sunday 04:00), and on
 * demand. Only one test runs at a time, never alongside a backup, a restore
 * or maintenance, and the hashing and the drill run in child processes at
 * low priority (backupVerificationWorker). Everything is behind the
 * `backupRestoreTest` feature flag.
 */

const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
const cron = require('node-cron');
const knexLib = require('knex');
const { db } = require('../database/db');
const knexConfig = require('../../knexfile');
const logger = require('../utils/logger');
const applicationWork = require('./activeApplicationWork');
const jobState = require('./maintenanceJobState');
const { getStoragePath } = require('../config/storage');
const { formatBoolean } = require('../utils/dbCompat');
const { isFeatureEnabled } = require('../middleware/requireFeatureFlag');
const { standaloneSnapshotOfRun } = require('../utils/backupRestorePoint');
const { backupS3Access } = require('../utils/s3EndpointPolicy');
const {
  DRILL_TEMP_PREFIX, drillDatabaseName, drillPrefixFor, assertDrillDatabaseName,
} = require('../utils/drillDatabase');
const { RESULT_PREFIX } = require('./backupVerificationWorker');

const FLAG = 'backupRestoreTest';
const JOB_NAME = 'backup_verification';
const STALE_DAYS = 14;
const DEFAULTS = { enabled: true, cron: '0 4 * * 0', samplePercent: 5 };
const WORKER = path.join(__dirname, '../workers/backupVerificationWorker.js');
let workerPath = WORKER;
const WORKER_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const BUSY_RETRY_MS = 60 * 1000;
const BUSY_GIVE_UP_MS = 6 * 60 * 60 * 1000;
const SPACE_MARGIN_BYTES = 64 * 1024 * 1024;
// A gzip'd dump expands; without a recorded plain size, assume this ratio.
const ASSUMED_EXPANSION = 10;

let scheduleJob = null;
// The test running in this process: { id, aborted, children }.
let current = null;
let reserving = false;
const queue = [];
let draining = null;

// ------------------------------------------------------------- helpers --

const nowIso = () => new Date().toISOString();

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function isCron(value) {
  return typeof value === 'string' && /^\s*\S+(\s+\S+){4}\s*$/.test(value) && cron.validate(value.trim());
}

async function readSettings() {
  const config = await require('./backupService').getBackupConfig() || {};
  const percent = Number(config.backup_verify_sample_percent);
  return {
    enabled: toBool(config.backup_verify_enabled, DEFAULTS.enabled),
    cron: isCron(config.backup_verify_cron) ? config.backup_verify_cron.trim() : DEFAULTS.cron,
    samplePercent: Number.isFinite(percent) && percent >= 0 && percent <= 100 ? Math.round(percent) : DEFAULTS.samplePercent,
    config,
  };
}

function liveTarget() {
  const connection = knexConfig.connection || {};
  return knexConfig.client === 'pg'
    ? { engine: 'pg', database: connection.database }
    : { engine: 'sqlite', filename: connection.filename };
}

function dumpEngine(type) {
  const value = String(type || '').toLowerCase();
  if (value.startsWith('postgres') || value === 'pg') return 'pg';
  if (value.startsWith('sqlite')) return 'sqlite';
  return null;
}

function workRoot() {
  return path.join(getStoragePath(), 'tmp');
}

// FNV-1a: a stable bucket per path, so the sample rotates through the whole
// library run by run instead of re-checking the same files.
function bucketOf(relPath, buckets) {
  let h = 0x811c9dc5;
  for (const ch of String(relPath)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % buckets;
}

function selectFiles(entries, { full, samplePercent, rotation }) {
  const docs = [];
  const others = [];
  for (const entry of entries) {
    const rel = String(entry.path).split(path.sep).join('/');
    if (rel.startsWith('business-docs/')) docs.push(entry); else others.push(entry);
  }
  if (full || samplePercent >= 100) return { docs, sample: others, sampledOf: others.length };
  if (samplePercent <= 0) return { docs, sample: [], sampledOf: others.length };
  const buckets = Math.max(1, Math.round(100 / samplePercent));
  const pick = rotation % buckets;
  return { docs, sample: others.filter((entry) => bucketOf(entry.path, buckets) === pick), sampledOf: others.length };
}

function check(name, result, detail = null) {
  return { name, result, detail };
}

function overallStatus(checks) {
  if (checks.some((c) => c.result === 'failed')) return 'failed';
  if (checks.some((c) => c.result === 'warning')) return 'warning';
  return 'passed';
}

function serialize(row) {
  if (!row) return null;
  const toIso = (value) => (value == null ? null : new Date(value).toISOString());
  return {
    id: row.id,
    backup_run_id: row.backup_run_id ?? null,
    database_backup_run_id: row.database_backup_run_id ?? null,
    level: row.level,
    status: row.status,
    skip_reason: row.skip_reason || null,
    checks: parseJson(row.checks, []),
    full: row.full === true || row.full === 1,
    sample_percent: row.sample_percent == null ? null : Number(row.sample_percent),
    triggered_by: row.triggered_by,
    triggered_by_admin_id: row.triggered_by_admin_id ?? null,
    started_at: toIso(row.started_at),
    completed_at: toIso(row.completed_at),
  };
}

// --------------------------------------------------------- single flight --

async function readMaintenanceMode() {
  const row = await db('app_settings').where({ setting_key: 'general_maintenance_mode' }).first().catch(() => null);
  return Boolean(row && (row.setting_value === 'true' || row.setting_value === true));
}

// A backup or restore on ANY replica writes a 'running' row. Nothing clears
// the row of a process that died mid-run, so only rows started since this
// process booted count (a crash before the restart cannot have written
// one), and none older than RUNNING_ROW_WINDOW_MS. The cost: a backup that
// another replica started before this one booted is not seen.
const RUNNING_ROW_WINDOW_MS = 12 * 60 * 60 * 1000;
const BOOTED_AT = Date.now() - Math.round(process.uptime() * 1000);
let monitorIntervalMs = 30 * 1000;

/** 'backup' / 'restore' when another process (any replica) is running one. */
async function sharedWorkRunning() {
  const { toTimestamp } = require('../utils/dateNormalize');
  const since = Math.max(BOOTED_AT, Date.now() - RUNNING_ROW_WINDOW_MS);
  const live = (rows) => rows.some((row) => {
    const at = toTimestamp(row.started_at);
    return at !== null && at !== undefined && !Number.isNaN(at) && at >= since;
  });
  for (const [table, reason] of [['backup_runs', 'backup'], ['database_backup_runs', 'backup'], ['restore_runs', 'restore']]) {
    const rows = await db(table).where({ status: 'running' }).select('started_at').catch(() => []);
    if (live(rows)) return reason;
  }
  return null;
}

/** Why a test cannot start right now, or null. */
async function busyReason() {
  if (current !== null || reserving) return 'verification';
  if (applicationWork.isClosed()) return 'restore';
  const backupService = require('./backupService');
  if (backupService.isBackupRunning && backupService.isBackupRunning()) return 'backup';
  const { databaseBackupService } = require('./databaseBackup');
  if (databaseBackupService.isRunning) return 'backup';
  const { restoreService } = require('./restoreService');
  if (restoreService.isRunning) return 'restore';
  if (await readMaintenanceMode()) return 'maintenance';
  const shared = await sharedWorkRunning();
  if (shared) return shared;
  await jobState.ensure(JOB_NAME);
  if ((await jobState.read(JOB_NAME)).isRunning) return 'verification';
  return null;
}

/**
 * Take the single-flight slot: this process first (synchronously, so two
 * requests in the same tick cannot both pass), then the shared lease every
 * replica uses. Returns the lease token, or null when another test holds it.
 * Rows are only ever 'running' while their test holds the lease, so a holder
 * may treat any other running row as left behind by a dead process.
 */
async function reserve() {
  if (current !== null || reserving) return null;
  reserving = true;
  try {
    await jobState.ensure(JOB_NAME);
    return await jobState.claim(JOB_NAME);
  } finally {
    reserving = false;
  }
}

async function releaseLease(token, id) {
  await jobState.release(JOB_NAME, token, { id }).catch(() => {});
}

/**
 * Stop the test running in this process: a backup is starting (it may prune
 * the restore point under test), or the services are stopping (shutdown, a
 * portable restore). The test ends as skipped with `reason`.
 */
function yieldTo(reason) {
  if (!current) return;
  current.aborted = current.aborted || reason;
  for (const child of current.children) killTree(child);
}

// The worker runs in its own process group, so its psql goes with it.
function killTree(child) {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (_) {
    try { child.kill('SIGKILL'); } catch (__) { /* already gone */ }
  }
}

// ----------------------------------------------------------- persistence --

async function insertRow({ backupRunId = null, databaseBackupRunId = null, trigger, adminId = null, full = false, samplePercent = null, status = 'running', skipReason = null }) {
  const inserted = await db('backup_verifications').insert({
    backup_run_id: backupRunId,
    database_backup_run_id: databaseBackupRunId,
    level: 'deep',
    status,
    skip_reason: skipReason,
    checks: JSON.stringify([]),
    full: formatBoolean(Boolean(full)),
    sample_percent: samplePercent,
    triggered_by: trigger,
    triggered_by_admin_id: adminId,
    started_at: nowIso(),
    completed_at: status === 'running' ? null : nowIso(),
  }).returning('id');
  return inserted[0]?.id ?? inserted[0];
}

async function finishRow(id, { status, level = 'deep', checks = [], skipReason = null }) {
  const updated = await db('backup_verifications').where({ id }).update({
    status,
    level,
    skip_reason: skipReason,
    checks: JSON.stringify(checks),
    completed_at: nowIso(),
  });
  // Pruning the restore point removes its rows; that is the only way here.
  if (!updated) logger.warn(`Backup verification ${id} was removed before it finished (its restore point was pruned)`);
}

async function targetExists(target) {
  const row = target.backupRunId
    ? await db('backup_runs').where({ id: target.backupRunId, status: 'completed' }).first('id')
    : await db('database_backup_runs').where({ id: target.databaseBackupRunId, status: 'completed' }).first('id');
  return Boolean(row);
}

// --------------------------------------------------------------- worker --

function runWorker(mode, job, env = process.env) {
  return new Promise((resolve, reject) => {
    if (current && current.aborted) {
      reject(new Error('Restore test stopped'));
      return;
    }
    const child = spawn(process.execPath, [workerPath, mode], {
      cwd: path.join(__dirname, '../..'),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own process group: stopping the test also stops its psql.
      detached: true,
    });
    if (current) current.children.add(child);
    try { require('os').setPriority(child.pid, 19); } catch (_) { /* the worker lowers itself too */ }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => killTree(child), WORKER_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (current) current.children.delete(child);
      const line = stdout.split('\n').reverse().find((l) => l.startsWith(RESULT_PREFIX));
      if (!line) {
        reject(new Error(`Verification worker ended without a result (${signal || `exit ${code}`}): ${stderr.trim().split('\n').slice(-3).join(' ')}`));
        return;
      }
      // A worker killed halfway through writing leaves a cut-off line; that
      // must reject, never throw inside this listener.
      let result;
      try {
        result = JSON.parse(line.slice(RESULT_PREFIX.length));
      } catch (error) {
        reject(new Error(`Verification worker returned an unreadable result (${signal || `exit ${code}`})`));
        return;
      }
      if (!result || typeof result !== 'object') reject(new Error('Verification worker returned no result'));
      else if (result.error) reject(new Error(result.error));
      else resolve(result);
    });
    child.stdin.end(JSON.stringify(job));
  });
}

// ------------------------------------------------------------- drill DB --

function pgMaintenanceKnex() {
  return knexLib({
    client: 'pg',
    // knex hides `password` from enumeration once a pool uses the config,
    // so a spread alone would drop it.
    connection: { ...knexConfig.connection, password: knexConfig.connection.password, database: process.env.DB_CHECK_DB || 'postgres' },
    pool: { min: 0, max: 1 },
  });
}

// On an object so a test can stand in for a role without CREATEDB.
const privileges = { canCreateDatabase, maintenanceReachable };

// CREATE/DROP DATABASE go through the maintenance database (DB_CHECK_DB,
// default "postgres"), as the restore path does. Where it is not reachable
// the drill cannot run; that is a setup limit, not a broken backup.
async function maintenanceReachable() {
  const admin = pgMaintenanceKnex();
  try {
    await admin.raw('SELECT 1');
    return true;
  } catch (error) {
    return false;
  } finally {
    await admin.destroy().catch(() => {});
  }
}

async function canCreateDatabase() {
  const result = await db.raw('SELECT (rolcreatedb OR rolsuper) AS ok FROM pg_roles WHERE rolname = current_user');
  return Boolean(result.rows[0] && result.rows[0].ok);
}

async function createDrillDatabase(name) {
  assertDrillDatabaseName(name, liveTarget().database);
  const admin = pgMaintenanceKnex();
  try {
    await admin.raw(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.raw(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.destroy();
  }
}

async function dropDrillDatabase(name) {
  assertDrillDatabaseName(name, liveTarget().database);
  const admin = pgMaintenanceKnex();
  try {
    await admin.raw('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ? AND pid <> pg_backend_pid()', [name]);
    await admin.raw(`DROP DATABASE IF EXISTS "${name}"`);
  } finally {
    await admin.destroy();
  }
}

// ---------------------------------------------------------------- plans --

function s3Settings(config) {
  return {
    bucket: config.backup_s3_bucket,
    region: config.backup_s3_region || 'us-east-1',
    endpoint: config.backup_s3_endpoint,
    accessKeyId: config.backup_s3_access_key,
    secretAccessKey: config.backup_s3_secret_key,
    forcePathStyle: toBool(config.backup_s3_force_path_style, false),
    sslEnabled: config.backup_s3_ssl_enabled === undefined ? true : toBool(config.backup_s3_ssl_enabled, true),
    ...backupS3Access(config),
  };
}

/**
 * What to fetch for a file backup run. Returns `{ skip }` or the plan.
 * Manifest and chain checks happen here; the hashing happens in the worker.
 */
async function planFileBackup(run, config, checks) {
  const stats = parseJson(run.statistics, {}) || {};
  const destination = String(stats.destination || config.backup_destination_type || '').toLowerCase();
  if (destination === 'rsync') return { skip: 'not_verifiable_rsync' };
  if (!run.manifest_path) return { skip: 'no_manifest' };

  const backupService = require('./backupService');
  const validation = await backupService.validateBackupManifest(run.manifest_path);
  if (!validation.valid || !validation.manifest) {
    // Written before manifests were signed: the backup status counts that
    // as healthy (the next backup signs a new one), so it is not a failure
    // here either. Its checksums cannot be trusted, so nothing is tested.
    if (validation.authentication && validation.authentication.state === 'legacy') {
      checks.push(check('manifest_signature', 'warning', 'The manifest predates manifest signing, so its checksums cannot be trusted and the backup was not tested'));
      return { skip: 'legacy_manifest' };
    }
    checks.push(check('manifest_signature', 'failed', `The manifest could not be read or its signature does not match: ${validation.error || 'unknown error'}`));
    return { stop: true };
  }
  const manifest = validation.manifest;
  checks.push(check('manifest_signature', 'passed', 'Manifest signature valid'));

  const parentId = manifest.backup && manifest.backup.parent_backup_id;
  if (!parentId) {
    checks.push(check('parent_chain', 'passed', 'Standalone restore point, no parent needed'));
  } else {
    const parent = await db('backup_runs').where({ manifest_id: parentId }).first();
    if (!parent || parent.status !== 'completed') {
      checks.push(check('parent_chain', 'failed', `Parent backup ${parentId} is missing`));
    } else {
      const parentValidation = await backupService.validateBackupManifest(parent.manifest_path);
      checks.push(parentValidation.valid
        ? check('parent_chain', 'passed', `Parent backup ${parentId} present and signed`)
        : check('parent_chain', 'failed', `Parent backup ${parentId} manifest is not intact`));
    }
  }

  const snapshot = standaloneSnapshotOfRun(config, run);
  if (!snapshot) return { skip: 'not_standalone' };
  const source = snapshot.type === 's3'
    ? { type: 's3', prefix: snapshot.prefix }
    : { type: 'local', root: snapshot.root };

  const dumpRel = manifest.database && manifest.database.backup_file;
  const dumpEntry = dumpRel ? {
    path: String(dumpRel).split(path.sep).join('/'),
    checksum: manifest.database.checksum,
    size: manifest.database.size,
  } : null;
  const fileEntries = ((manifest.files && manifest.files.manifest) || [])
    .filter((entry) => entry && entry.path && entry.checksum)
    .filter((entry) => !dumpEntry || String(entry.path).split(path.sep).join('/') !== dumpEntry.path);

  return {
    source,
    s3: snapshot.type === 's3' ? s3Settings(config) : null,
    dump: dumpEntry,
    files: fileEntries,
    engine: dumpEngine(manifest.database && manifest.database.type),
    // Made with backup_include_database off, as the signed manifest records:
    // a files-only restore point, not a broken one.
    withoutDatabase: !dumpEntry && toBool(manifest.metadata && manifest.metadata.backup_settings
      && manifest.metadata.backup_settings.backup_include_database, true) === false,
    expectedRowCounts: (manifest.database && manifest.database.row_counts) || {},
    plainSize: await recordedPlainSize(manifest.database && manifest.database.checksum),
  };
}

// The database size recorded when the dump was made: the run whose dump has
// this checksum. Without one, hasSpaceFor assumes a generous expansion.
async function recordedPlainSize(checksum) {
  if (!checksum) return null;
  const row = await db('database_backup_runs').where({ checksum }).first('original_size_bytes').catch(() => null);
  return row && Number(row.original_size_bytes) > 0 ? Number(row.original_size_bytes) : null;
}

async function planDatabaseBackup(run, checks) {
  if (!run.file_path || !run.checksum) return { skip: 'no_database_dump' };
  checks.push(check('manifest_signature', 'skipped', 'Database-only backups have no manifest; the dump is checked against the checksum recorded when it was made'));
  return {
    source: { type: 'local', root: path.dirname(run.file_path) },
    s3: null,
    dump: { path: path.basename(run.file_path), checksum: run.checksum, size: Number(run.file_size_bytes) || null },
    files: [],
    engine: dumpEngine(run.backup_type),
    expectedRowCounts: parseJson(run.table_checksums, {}) || {},
    plainSize: Number(run.original_size_bytes) || null,
  };
}

async function hasSpaceFor(dir, plan) {
  if (!plan.dump) return true;
  const dumpSize = Number(plan.dump.size) || 0;
  const plain = plan.plainSize || dumpSize * ASSUMED_EXPANSION;
  // The fetched dump plus its decompressed form (the SQLite drill copy, or
  // the SQL psql reads). On PostgreSQL the drill database itself lives on
  // the database server, whose free space is not visible from here.
  const needed = dumpSize + plain + SPACE_MARGIN_BYTES;
  try {
    const stat = await fs.statfs(dir);
    return Number(stat.bavail) * Number(stat.bsize) >= needed;
  } catch (error) {
    logger.warn(`Backup verification could not read free space: ${error.message}`);
    return true;
  }
}

// ------------------------------------------------------------ the test --

/**
 * One check over a list of hashed files. Matching goes through a Set: a
 * "hash every file" run over a large library must not do list × results
 * comparisons on the API process.
 */
function fileCheckResult(name, list, results, label) {
  if (list.length === 0) return check(name, 'skipped', label.none);
  const wanted = new Set(list.map((entry) => entry.path));
  const bad = [];
  for (const result of results) {
    if (wanted.has(result.path) && !result.ok) bad.push(result);
  }
  return bad.length
    ? check(name, 'failed', `${bad.length} of ${list.length} ${label.what} failed: ${bad.slice(0, 5).map((r) => `${r.path} (${r.error})`).join(', ')}${bad.length > 5 ? ', …' : ''}`)
    : check(name, 'passed', `${list.length} ${label.what} match`);
}

async function runDrill(id, plan, workDir, checks) {
  const live = liveTarget();
  if (!plan.engine || plan.engine !== live.engine) {
    checks.push(check('drill_load', 'skipped', `The dump was made on ${plan.engine || 'an unknown engine'}; this install runs ${live.engine}, so it cannot be loaded here`));
    return false;
  }
  const dumpPath = path.join(workDir, 'dump');
  if (live.engine === 'pg') {
    if (!(await privileges.canCreateDatabase())) {
      checks.push(check('createdb_privilege', 'warning', 'The database user may not create databases, so only the deep check ran. Grant CREATEDB to the PicPeak database user to run full restore tests.'));
      return false;
    }
    if (!(await privileges.maintenanceReachable())) {
      checks.push(check('createdb_privilege', 'warning', `The maintenance database "${process.env.DB_CHECK_DB || 'postgres'}" cannot be reached, so no test database could be created and only the deep check ran. Set DB_CHECK_DB to a database the PicPeak user may connect to.`));
      return false;
    }
    const name = drillDatabaseName(id, live.database);
    assertDrillDatabaseName(name, live.database);
    await createDrillDatabase(name);
    try {
      const result = await runWorker('drill', {
        engine: 'pg', dumpPath, workDir, liveTarget: live,
        drillTarget: { database: name }, expectedRowCounts: plan.expectedRowCounts,
      }, { ...process.env, DATABASE_CLIENT: 'pg', DB_NAME: name });
      checks.push(...result.checks);
    } finally {
      await dropDrillDatabase(name).catch((error) => logger.error(`Could not drop restore-drill database ${name}: ${error.message}`));
    }
    return true;
  }
  const filename = path.join(workDir, 'drill.sqlite');
  if (live.filename && path.resolve(filename) === path.resolve(live.filename)) {
    throw new Error('Refusing to use the live database as a restore-drill database');
  }
  const result = await runWorker('drill', {
    engine: 'sqlite', dumpPath, workDir, liveTarget: live,
    drillTarget: { filename }, expectedRowCounts: plan.expectedRowCounts,
  }, { ...process.env, DATABASE_CLIENT: knexConfig.client, DATABASE_PATH: filename, TEST_DATABASE_PATH: filename });
  checks.push(...result.checks);
  return true;
}

async function execute(id, target, { full, samplePercent, drill }) {
  const checks = [];
  const settings = await readSettings();
  const workDir = path.join(workRoot(), `${DRILL_TEMP_PREFIX}${id}`);
  let level = 'deep';
  // A test stopped for a backup or a shutdown says so; its half-done checks
  // are not a verdict on the backup.
  const stopped = () => (current && current.aborted
    ? finishRow(id, { status: 'skipped', skipReason: ['backup', 'restore'].includes(current.aborted) ? 'busy' : 'interrupted', level, checks })
    : null);
  try {
    let plan;
    if (target.backupRunId) {
      const run = await db('backup_runs').where({ id: target.backupRunId }).first();
      if (!run || run.status !== 'completed') return finishRow(id, { status: 'skipped', skipReason: 'no_backup' });
      plan = await planFileBackup(run, settings.config, checks);
    } else {
      const run = await db('database_backup_runs').where({ id: target.databaseBackupRunId }).first();
      if (!run || run.status !== 'completed') return finishRow(id, { status: 'skipped', skipReason: 'no_backup' });
      plan = await planDatabaseBackup(run, checks);
    }
    if (plan.stop) return finishRow(id, { status: 'failed', checks });
    // A check that already failed (the parent chain, say) is not hidden
    // behind the skip.
    if (plan.skip) {
      return finishRow(id, { status: checks.some((c) => c.result === 'failed') ? 'failed' : 'skipped', skipReason: plan.skip, checks });
    }

    await fs.mkdir(workDir, { recursive: true, mode: 0o700 });
    if (!(await hasSpaceFor(workDir, plan))) {
      return finishRow(id, { status: 'skipped', skipReason: 'insufficient_space', checks });
    }

    const { docs, sample, sampledOf } = selectFiles(plan.files, { full, samplePercent, rotation: id });
    let deep;
    try {
      deep = await runWorker('deep', {
        source: plan.source, s3: plan.s3, dump: plan.dump,
        dumpTarget: plan.dump ? path.join(workDir, 'dump') : null,
        files: [...docs, ...sample].map((entry) => ({ path: entry.path, checksum: entry.checksum, size: entry.size })),
      });
    } catch (error) {
      if (current && current.aborted) return stopped();
      checks.push(check('destination', 'failed', error.message));
      return finishRow(id, { status: 'failed', checks });
    }

    if (!plan.dump && plan.withoutDatabase) {
      checks.push(check('dump_checksum', 'skipped', 'This backup was made without the database (backup_include_database is off), so there is no dump to test'));
    } else if (!plan.dump) {
      checks.push(check('dump_checksum', 'failed', 'The backup holds no database dump'));
    } else if (deep.dump.ok) {
      checks.push(check('dump_checksum', 'passed', 'Database dump matches its recorded SHA-256'));
    } else {
      checks.push(check('dump_checksum', 'failed', deep.dump.error ? `Database dump: ${deep.dump.error}` : 'Database dump does not match its recorded SHA-256'));
    }

    const fileCheck = (name, list, label) => fileCheckResult(name, list, deep.files, label);
    if (plan.files.length || target.backupRunId) {
      checks.push(fileCheck('business_docs', docs, { what: 'business documents', none: 'No business documents in this backup' }));
      checks.push(fileCheck(full ? 'files_all' : 'files_sample', sample, {
        what: full ? 'files' : `sampled files (of ${sampledOf})`,
        none: full || samplePercent > 0 ? 'No other files in this backup' : 'File sampling is off',
      }));
    }

    if (drill && plan.dump && deep.dump.ok) {
      try {
        if (await runDrill(id, plan, workDir, checks)) level = 'drill';
      } catch (error) {
        if (current && current.aborted) return stopped();
        level = 'drill';
        checks.push(check('drill_load', 'failed', String(error.message).slice(0, 500)));
      }
    }
    if (plan.withoutDatabase && !checks.some((c) => c.result === 'failed')) {
      return stopped() || finishRow(id, { status: 'skipped', skipReason: 'no_database_in_backup', level, checks });
    }
    return stopped() || finishRow(id, { status: overallStatus(checks), level, checks });
  } catch (error) {
    if (current && current.aborted) return stopped();
    logger.error(`Backup verification ${id} failed`, { error: error.message });
    checks.push(check('destination', 'failed', error.message));
    return finishRow(id, { status: 'failed', level, checks });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * One mail per admin for a set of failed tests: a single test after a
 * backup, or the whole scheduled round, so an outage at the destination is
 * one message and not one per retained backup.
 */
async function notifyFailures(ids) {
  const rows = ids.length ? await db('backup_verifications').whereIn('id', ids).where({ status: 'failed' }).orderBy('id') : [];
  if (rows.length === 0) return;
  const { config } = await readSettings();
  if (!toBool(config.backup_email_on_failure, false)) return;
  const { queueEmail } = require('./emailProcessor');
  const labelOf = (row) => (row.backup_run_id ? `Backup run ${row.backup_run_id}` : `Database backup run ${row.database_backup_run_id}`);
  const failedChecks = rows.map((row) => {
    const lines = parseJson(row.checks, []).filter((c) => c.result === 'failed')
      .map((c) => `${c.name}: ${c.detail || 'failed'}`);
    return rows.length > 1 ? `${labelOf(row)}\n${lines.join('\n')}` : lines.join('\n');
  }).join('\n\n');
  const newest = rows[rows.length - 1];
  const admins = await db('admin_users').where('is_active', formatBoolean(true));
  for (const admin of admins) {
    await queueEmail(null, admin.email, 'backup_verification_failed', {
      backup_label: rows.length > 1 ? `${rows.length} backups` : labelOf(newest),
      checked_at: new Date(newest.completed_at || Date.now()).toISOString(),
      verification_level: rows.some((row) => row.level === 'drill') ? 'Restore drill' : 'Deep verify',
      failed_checks: failedChecks || 'unknown',
    });
  }
}

/**
 * Leftovers of a test that died with its process: rows stuck at running,
 * work directories and this install's drill databases. Only called while
 * holding the lease, so nothing else of this install is mid-test; `exceptId`
 * is the caller's own row.
 */
async function cleanupLeftovers(exceptId = null) {
  const stuck = await db('backup_verifications').where({ status: 'running' })
    .modify((q) => { if (exceptId !== null) q.whereNot({ id: exceptId }); })
    .update({ status: 'skipped', skip_reason: 'interrupted', completed_at: nowIso() });
  if (stuck) logger.warn(`Marked ${stuck} interrupted backup restore test(s)`);

  const keep = exceptId === null ? null : `${DRILL_TEMP_PREFIX}${exceptId}`;
  const entries = await fs.readdir(workRoot(), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(DRILL_TEMP_PREFIX) && entry.name !== keep) {
      await fs.rm(path.join(workRoot(), entry.name), { recursive: true, force: true }).catch(() => {});
    }
  }

  const live = liveTarget();
  if (live.engine !== 'pg') return;
  const prefix = drillPrefixFor(live.database);
  const own = exceptId === null ? null : drillDatabaseName(exceptId, live.database);
  const admin = pgMaintenanceKnex();
  try {
    const result = await admin.raw('SELECT datname FROM pg_database WHERE starts_with(datname, ?)', [prefix]);
    for (const { datname } of result.rows) {
      if (datname === own) continue;
      try {
        await dropDrillDatabase(assertDrillDatabaseName(datname, live.database));
        logger.warn(`Dropped stale restore-drill database ${datname}`);
      } catch (error) {
        logger.warn(`Could not drop stale restore-drill database ${datname}: ${error.message}`);
      }
    }
  } catch (error) {
    logger.warn(`Could not list restore-drill databases: ${error.message}`);
  } finally {
    await admin.destroy().catch(() => {});
  }
}

/**
 * Run one test in this process and resolve when its row is final.
 * `token` is a lease startNow already took; without it the lease is taken
 * here. The row is written only while the lease is held.
 */
async function runOne(target, options = {}) {
  const settings = await readSettings();
  const samplePercent = options.samplePercent ?? settings.samplePercent;
  const rowFields = {
    backupRunId: target.backupRunId || null,
    databaseBackupRunId: target.databaseBackupRunId || null,
    trigger: options.trigger, adminId: options.adminId || null,
    full: Boolean(options.full), samplePercent,
  };
  const token = options.token || await reserve();
  if (!token) {
    // Another replica is testing. A queued test for a run that still exists
    // says so; one whose run is gone leaves nothing behind.
    if (await targetExists(target)) return insertRow({ ...rowFields, status: 'skipped', skipReason: 'busy' });
    return null;
  }
  const state = { id: null, aborted: null, children: new Set() };
  current = state;
  const lease = jobState.startLeaseKeeper(JOB_NAME, token);
  // While the test runs: a lease that moved on means another process took
  // over (stop, never run two); a backup or restore started on another
  // replica gets the same yield as one started here.
  const monitor = setInterval(() => {
    if (lease.lost()) { yieldTo('lost'); return; }
    sharedWorkRunning().then((reason) => { if (reason) yieldTo(reason); }).catch(() => {});
  }, monitorIntervalMs);
  monitor.unref?.();
  try {
    if (!options.id && !(await targetExists(target))) return null;
    const id = options.id ?? await insertRow(rowFields);
    state.id = id;
    await cleanupLeftovers(id);
    await execute(id, target, { full: Boolean(options.full), samplePercent, drill: options.drill !== false });
    if (options.notify !== false) {
      await notifyFailures([id]).catch((error) => logger.error(`Could not queue the verification failure email: ${error.message}`));
    }
    return id;
  } finally {
    clearInterval(monitor);
    current = null;
    lease.stop();
    await releaseLease(token, state.id);
  }
}

// ---------------------------------------------------------------- queue --

async function automaticRunsEnabled() {
  if (!(await isFeatureEnabled(FLAG))) return false;
  return (await readSettings()).enabled;
}

// 'run', 'busy' (gave up waiting) or 'abandon' (a coordinated restore is
// under way: the queue is dropped so the restore can drain its work).
async function waitUntilIdle() {
  const deadline = Date.now() + BUSY_GIVE_UP_MS;
  for (;;) {
    if (applicationWork.isClosed()) return 'abandon';
    const reason = await busyReason();
    if (!reason) return 'run';
    if (Date.now() >= deadline) return 'busy';
    await new Promise((resolve) => { const t = setTimeout(resolve, BUSY_RETRY_MS); t.unref?.(); });
  }
}

/**
 * Work through the queue. The waiting is deliberately NOT application work:
 * a portable restore drains application work before it starts, and a queue
 * waiting for that restore to end must not hold it up. Only the test itself
 * is tracked, and admission being closed drops the queue.
 */
function drain() {
  if (draining) return draining;
  draining = (async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        // Switching the feature or the automatic runs off also stops what
        // was already queued.
        if (!(await automaticRunsEnabled())) { queue.length = 0; break; }
        const outcome = await waitUntilIdle();
        if (outcome === 'abandon') { queue.length = 0; break; }
        if (outcome === 'busy') {
          if (await targetExists(item.target)) {
            await insertRow({ ...item.target, trigger: item.trigger, status: 'skipped', skipReason: 'busy' });
          }
          continue;
        }
        const id = await applicationWork.track('backup verification', () => runOne(item.target, { ...item, notify: !item.batch }));
        if (item.batch && id) item.batch.push(id);
      } catch (error) {
        if (error && error.code === 'RESTORE_MAINTENANCE') { queue.length = 0; break; }
        logger.error('Backup verification failed to run', { error: error.message });
      }
    }
  })().finally(() => { draining = null; });
  return draining;
}

function enqueue(item) {
  const key = JSON.stringify(item.target);
  if (queue.some((queued) => JSON.stringify(queued.target) === key)) return;
  queue.push(item);
}

/** After a successful file backup run. Never touches the run itself. */
async function queueAfterBackup(backupRunId) {
  try {
    if (!(await automaticRunsEnabled())) return;
    enqueue({ target: { backupRunId }, trigger: 'backup' });
    drain();
  } catch (error) {
    logger.warn(`Could not queue a restore test for backup run ${backupRunId}: ${error.message}`);
  }
}

/** After a successful database-only backup run. */
async function queueAfterDatabaseBackup(databaseBackupRunId) {
  try {
    if (!(await automaticRunsEnabled())) return;
    enqueue({ target: { databaseBackupRunId }, trigger: 'backup' });
    drain();
  } catch (error) {
    logger.warn(`Could not queue a restore test for database backup run ${databaseBackupRunId}: ${error.message}`);
  }
}

/** Newest successful backup: a file backup first, else a database-only dump. */
async function defaultTarget() {
  const run = await db('backup_runs').where('status', 'completed').whereNotNull('manifest_path').orderBy('id', 'desc').first();
  if (run) return { backupRunId: run.id };
  const dbRun = await db('database_backup_runs').where('status', 'completed').orderBy('id', 'desc').first();
  return dbRun ? { databaseBackupRunId: dbRun.id } : null;
}

function busyError(reason) {
  const error = new Error(`A ${reason} is running; try the restore test again when it has finished`);
  error.code = 'VERIFICATION_BUSY';
  return error;
}

/**
 * An admin's "Run restore test now". Takes the lease, inserts the running
 * row and returns its id; the test continues in the background. Throws with
 * code VERIFICATION_BUSY / NO_BACKUP for the route to map.
 */
async function startNow({ backupRunId, databaseBackupRunId, full = false, adminId }) {
  const reason = await busyReason();
  if (reason) throw busyError(reason);
  let target;
  if (backupRunId) target = { backupRunId };
  else if (databaseBackupRunId) target = { databaseBackupRunId };
  else target = await defaultTarget();
  if (!target || !(await targetExists(target))) {
    const error = new Error('There is no completed backup to test');
    error.code = 'NO_BACKUP';
    throw error;
  }
  const token = await reserve();
  if (!token) throw busyError('verification');
  let id;
  try {
    const { samplePercent } = await readSettings();
    id = await insertRow({ ...target, trigger: 'admin', adminId, full, samplePercent });
    applicationWork.defer('backup verification', () => runOne(target, { id, token, full, samplePercent, trigger: 'admin', adminId }))
      .catch(async (error) => {
        // Never started (admission closed for a restore in between): the
        // row and the lease must not stay behind as "running".
        if (current && current.id === id) return;
        logger.warn(`Restore test ${id} did not start: ${error.message}`);
        await finishRow(id, { status: 'skipped', skipReason: 'interrupted' }).catch(() => {});
        await releaseLease(token, id);
      });
  } catch (error) {
    await releaseLease(token, id);
    throw error;
  }
  return id;
}

/**
 * The periodic re-check: every retained file restore point gets a deep
 * verify (bit rot, deletion at the destination); the newest also gets the
 * restore drill. With no file backups, the newest database-only dump.
 * Failures of the round go out as one mail.
 */
const ROUND_JOB = 'backup_verification_round';
const ROUND_STALE_MS = 24 * 60 * 60 * 1000;
const ROUND_REPEAT_GUARD_MS = 60 * 60 * 1000;

async function runScheduled() {
  if (!(await automaticRunsEnabled())) return;
  // Every replica's cron fires; one round runs. The round lease decides
  // who, and a round that finished within the last hour is not repeated
  // by a replica whose tick came late.
  await jobState.ensure(ROUND_JOB);
  const last = await jobState.read(ROUND_JOB, { staleAfterMs: ROUND_STALE_MS });
  if (last.finishedAt && Date.now() - new Date(last.finishedAt).getTime() < ROUND_REPEAT_GUARD_MS) return;
  const roundToken = await jobState.claim(ROUND_JOB, { staleAfterMs: ROUND_STALE_MS });
  if (!roundToken) return;
  try {
    await runRound();
  } finally {
    await jobState.release(ROUND_JOB, roundToken, { at: nowIso() }).catch(() => {});
  }
}

async function runRound() {
  const batch = [];
  const runs = await db('backup_runs').where('status', 'completed').whereNotNull('manifest_path').orderBy('id', 'desc').select('id');
  if (runs.length === 0) {
    const target = await defaultTarget();
    if (target) enqueue({ target, trigger: 'schedule', batch });
  }
  runs.forEach((run, index) => enqueue({ target: { backupRunId: run.id }, trigger: 'schedule', drill: index === 0, batch }));
  await drain();
  await notifyFailures(batch).catch((error) => logger.error(`Could not queue the verification failure email: ${error.message}`));
}

// ------------------------------------------------------------- reading --

let tableKnown = false;
async function hasVerificationTable() {
  if (!tableKnown) tableKnown = await db.schema.hasTable('backup_verifications');
  return tableKnown;
}

/**
 * Health follows the newest restore point: its latest finished test decides
 * failed vs not. An older retained backup failing its re-check is reported
 * (row, history badge, mail) but does not override a newer backup that
 * restores. "Stale" means no pass in STALE_DAYS.
 */
async function getSummary({ limit = 20 } = {}) {
  const rows = await db('backup_verifications').orderBy('id', 'desc').limit(Math.min(Math.max(Number(limit) || 20, 1), 200));
  const items = rows.map(serialize);
  const latest = items[0] || null;
  const newest = await defaultTarget();
  const decisive = newest
    ? await db('backup_verifications').where(newest.backupRunId
      ? { backup_run_id: newest.backupRunId } : { database_backup_run_id: newest.databaseBackupRunId })
      .whereIn('status', ['passed', 'warning', 'failed']).orderBy('id', 'desc').first()
    : null;
  const lastPass = await db('backup_verifications').whereIn('status', ['passed', 'warning']).orderBy('id', 'desc').first();
  const running = (await db('backup_verifications').where({ status: 'running' }).first('id')) !== undefined;
  const lastPassedAt = lastPass && lastPass.completed_at ? new Date(lastPass.completed_at).toISOString() : null;
  const staleBefore = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000;

  let health;
  if (decisive && decisive.status === 'failed') health = 'failed';
  else if (lastPassedAt && new Date(lastPassedAt).getTime() >= staleBefore) health = 'ok';
  else if (items.length === 0) health = running ? 'running' : 'none';
  else if (!lastPassedAt && running) health = 'running';
  else health = 'stale';

  const byBackupRun = {};
  const perRun = await db('backup_verifications').whereNotNull('backup_run_id').orderBy('id', 'desc').limit(1000)
    .select('backup_run_id', 'status');
  for (const row of perRun) {
    const key = String(row.backup_run_id);
    const seen = byBackupRun[key];
    // A later "skipped: busy" must not hide an earlier result.
    if (!seen || (seen === 'skipped' && row.status !== 'skipped')) byBackupRun[key] = row.status;
  }

  const settings = await readSettings();
  return {
    items,
    latest,
    lastPassedAt,
    health,
    staleDays: STALE_DAYS,
    running,
    byBackupRun,
    settings: { enabled: settings.enabled, cron: settings.cron, samplePercent: settings.samplePercent },
  };
}

/** The health part for backup status / System health; null when the flag is off. */
async function getHealth() {
  if (!(await isFeatureEnabled(FLAG))) return null;
  if (!(await hasVerificationTable())) return null;
  const { health, lastPassedAt, latest, staleDays } = await getSummary({ limit: 1 });
  return { health, lastPassedAt, latest, staleDays };
}

/** Restore points with a test running right now; retention leaves them. */
async function runsUnderTest() {
  // With the feature off nothing runs, and a row a crash left at 'running'
  // (the boot sweep is off too) must not hold a restore point forever.
  if (!(await isFeatureEnabled(FLAG))) return new Set();
  if (!(await hasVerificationTable())) return new Set();
  const rows = await db('backup_verifications').where({ status: 'running' }).whereNotNull('backup_run_id').select('backup_run_id');
  return new Set(rows.map((row) => Number(row.backup_run_id)));
}

// ------------------------------------------------------ schedule + boot --

async function startVerificationSchedule() {
  if (scheduleJob) {
    scheduleJob.stop();
    scheduleJob = null;
  }
  try {
    const settings = await readSettings();
    if (!settings.enabled) return;
    scheduleJob = cron.schedule(settings.cron, () => {
      require('../database/crmAccess').withTrustedCrmAccess('scheduled backup verification', () => runScheduled())
        .catch((error) => logger.error('Scheduled backup verification failed', { error: error.message }));
    });
    logger.info(`Backup restore test schedule: ${settings.cron}`);
  } catch (error) {
    logger.error('Could not start the backup restore test schedule', { error: error.message });
  }
}

/**
 * Service stop (shutdown, or a portable restore pausing the services): the
 * schedule stops, the queue is dropped and a running test is stopped, so
 * nothing holds up the drain that follows.
 */
async function stopVerificationSchedule() {
  if (scheduleJob) {
    scheduleJob.stop();
    scheduleJob = null;
  }
  queue.length = 0;
  yieldTo('shutdown');
}

/**
 * Whether a lease row belongs to a process of this host that cannot be
 * holding it: this very pid (a fresh process holds nothing yet; in Docker a
 * restarted node usually gets the same pid), or a pid that no longer runs.
 * A live other pid on this host (PM2 cluster, host networking) keeps it.
 */
function leftByDeadProcess(row, { hostname = require('os').hostname(), pid = process.pid } = {}) {
  if (!row || !(row.is_running === true || row.is_running === 1) || typeof row.owner !== 'string') return false;
  const at = row.owner.lastIndexOf(':');
  if (at < 0 || row.owner.slice(0, at) !== hostname) return false;
  const ownerPid = Number(row.owner.slice(at + 1));
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) return false;
  if (ownerPid === pid) return true;
  try {
    process.kill(ownerPid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

/**
 * Boot: clean what a test that died with the previous process left. Only
 * with the feature on (with it off, boot does nothing new). Takes the lease
 * for it, so a test another process is running is never touched.
 */
async function sweepStale() {
  try {
    if (!(await isFeatureEnabled(FLAG))) return;
    if (!(await hasVerificationTable())) return;
    await jobState.ensure(JOB_NAME);
    const row = await db('maintenance_jobs').where({ job_name: JOB_NAME }).first();
    if (leftByDeadProcess(row)) {
      await db('maintenance_jobs').where({ job_name: JOB_NAME, claim_token: row.claim_token })
        .update({ is_running: formatBoolean(false), finished_at: nowIso() });
    }
    const token = await reserve();
    if (!token) return;
    try {
      await cleanupLeftovers(null);
    } finally {
      await releaseLease(token, null);
    }
  } catch (error) {
    logger.warn(`Backup verification boot sweep failed: ${error.message}`);
  }
}

module.exports = {
  FLAG,
  STALE_DAYS,
  DEFAULTS,
  isCron,
  readSettings,
  busyReason,
  startNow,
  runOne,
  runScheduled,
  queueAfterBackup,
  queueAfterDatabaseBackup,
  getSummary,
  getHealth,
  startVerificationSchedule,
  stopVerificationSchedule,
  sweepStale,
  yieldTo,
  runsUnderTest,
  _internal: { current: () => current, setMonitorInterval: (ms) => { monitorIntervalMs = ms; }, leftByDeadProcess, fileCheckResult, runWorker, setWorkerPath: (p) => { workerPath = p || WORKER; }, privileges, selectFiles, bucketOf, overallStatus, planFileBackup, planDatabaseBackup, liveTarget, drain: () => draining, drainNow: () => drain(), queue },
};
