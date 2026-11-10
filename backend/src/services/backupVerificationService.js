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
const crypto = require('crypto');
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
  DRILL_PREFIX, DRILL_TEMP_PREFIX, drillDatabaseName, assertDrillDatabaseName,
} = require('../utils/drillDatabase');
const { RESULT_PREFIX } = require('./backupVerificationWorker');

const FLAG = 'backupRestoreTest';
const JOB_NAME = 'backup_verification';
const STALE_DAYS = 14;
const DEFAULTS = { enabled: true, cron: '0 4 * * 0', samplePercent: 5 };
const WORKER = path.join(__dirname, '../workers/backupVerificationWorker.js');
const WORKER_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const BUSY_RETRY_MS = 60 * 1000;
const BUSY_GIVE_UP_MS = 6 * 60 * 60 * 1000;
const SPACE_MARGIN_BYTES = 64 * 1024 * 1024;
// A gzip'd dump expands; without a recorded plain size, assume this ratio.
const ASSUMED_EXPANSION = 5;

let scheduleJob = null;
let activeId = null;
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
    samplePercent: Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : DEFAULTS.samplePercent,
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

/** Why a test cannot start right now, or null. */
async function busyReason() {
  if (activeId !== null) return 'verification';
  if (applicationWork.isClosed()) return 'restore';
  const backupService = require('./backupService');
  if (backupService.isBackupRunning && backupService.isBackupRunning()) return 'backup';
  const { databaseBackupService } = require('./databaseBackup');
  if (databaseBackupService.isRunning) return 'backup';
  const { restoreService } = require('./restoreService');
  if (restoreService.isRunning) return 'restore';
  if (await readMaintenanceMode()) return 'maintenance';
  await jobState.ensure(JOB_NAME);
  if ((await jobState.read(JOB_NAME)).isRunning) return 'verification';
  return null;
}

// ----------------------------------------------------------- persistence --

async function insertRow({ backupRunId = null, databaseBackupRunId = null, trigger, adminId = null, full = false, samplePercent = null }) {
  const inserted = await db('backup_verifications').insert({
    backup_run_id: backupRunId,
    database_backup_run_id: databaseBackupRunId,
    level: 'deep',
    status: 'running',
    checks: JSON.stringify([]),
    full: formatBoolean(Boolean(full)),
    sample_percent: samplePercent,
    triggered_by: trigger,
    triggered_by_admin_id: adminId,
    started_at: nowIso(),
  }).returning('id');
  return inserted[0]?.id ?? inserted[0];
}

async function finishRow(id, { status, level = 'deep', checks = [], skipReason = null }) {
  await db('backup_verifications').where({ id }).update({
    status,
    level,
    skip_reason: skipReason,
    checks: JSON.stringify(checks),
    completed_at: nowIso(),
  });
}

// --------------------------------------------------------------- worker --

function runWorker(mode, job, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, mode], {
      cwd: path.join(__dirname, '../..'),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try { require('os').setPriority(child.pid, 19); } catch (_) { /* the worker lowers itself too */ }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), WORKER_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const line = stdout.split('\n').reverse().find((l) => l.startsWith(RESULT_PREFIX));
      if (!line) {
        reject(new Error(`Verification worker ended without a result (${signal || `exit ${code}`}): ${stderr.trim().split('\n').slice(-3).join(' ')}`));
        return;
      }
      const result = JSON.parse(line.slice(RESULT_PREFIX.length));
      if (result.error) reject(new Error(result.error)); else resolve(result);
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
const privileges = { canCreateDatabase };

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
    const legacy = validation.authentication && validation.authentication.state === 'legacy';
    checks.push(check('manifest_signature', 'failed', legacy
      ? 'The manifest predates manifest signing, so its checksums cannot be trusted'
      : `The manifest could not be read or its signature does not match: ${validation.error || 'unknown error'}`));
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
    expectedRowCounts: (manifest.database && manifest.database.row_counts) || {},
    plainSize: null,
  };
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
  // the SQL psql reads).
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
    const name = drillDatabaseName(id);
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
    if (plan.skip) return finishRow(id, { status: 'skipped', skipReason: plan.skip, checks });

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
      checks.push(check('destination', 'failed', error.message));
      return finishRow(id, { status: 'failed', checks });
    }

    if (!plan.dump) {
      checks.push(check('dump_checksum', 'failed', 'The backup holds no database dump'));
    } else if (deep.dump.ok) {
      checks.push(check('dump_checksum', 'passed', 'Database dump matches its recorded SHA-256'));
    } else {
      checks.push(check('dump_checksum', 'failed', deep.dump.error ? `Database dump: ${deep.dump.error}` : 'Database dump does not match its recorded SHA-256'));
    }

    const fileCheck = (name, list, label) => {
      const results = deep.files.filter((r) => list.some((e) => e.path === r.path));
      const bad = results.filter((r) => !r.ok);
      if (list.length === 0) return check(name, 'skipped', label.none);
      return bad.length
        ? check(name, 'failed', `${bad.length} of ${list.length} ${label.what} failed: ${bad.slice(0, 5).map((r) => `${r.path} (${r.error})`).join(', ')}${bad.length > 5 ? ', …' : ''}`)
        : check(name, 'passed', `${list.length} ${label.what} match`);
    };
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
        level = 'drill';
        checks.push(check('drill_load', 'failed', String(error.message).slice(0, 500)));
      }
    }
    return finishRow(id, { status: overallStatus(checks), level, checks });
  } catch (error) {
    logger.error(`Backup verification ${id} failed`, { error: error.message });
    checks.push(check('destination', 'failed', error.message));
    return finishRow(id, { status: 'failed', level, checks });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function notifyFailure(id) {
  const row = await db('backup_verifications').where({ id }).first();
  if (!row || row.status !== 'failed') return;
  const { config } = await readSettings();
  if (!toBool(config.backup_email_on_failure, false)) return;
  const { queueEmail } = require('./emailProcessor');
  const checks = parseJson(row.checks, []);
  const failed = checks.filter((c) => c.result === 'failed')
    .map((c) => `${c.name}: ${c.detail || 'failed'}`).join('\n');
  const label = row.backup_run_id ? `Backup run ${row.backup_run_id}` : `Database backup run ${row.database_backup_run_id}`;
  const admins = await db('admin_users').where('is_active', formatBoolean(true));
  for (const admin of admins) {
    await queueEmail(null, admin.email, 'backup_verification_failed', {
      backup_label: label,
      checked_at: new Date(row.completed_at || Date.now()).toISOString(),
      verification_level: row.level === 'drill' ? 'Restore drill' : 'Deep verify',
      failed_checks: failed || 'unknown',
    });
  }
}

/**
 * Run one test now, in this process. Resolves when the row is final.
 * `id` is an already inserted running row (startNow) or null.
 */
async function runOne(target, options) {
  const settings = await readSettings();
  const samplePercent = options.samplePercent ?? settings.samplePercent;
  const id = options.id ?? await insertRow({
    backupRunId: target.backupRunId || null,
    databaseBackupRunId: target.databaseBackupRunId || null,
    trigger: options.trigger, adminId: options.adminId || null,
    full: Boolean(options.full), samplePercent,
  });

  await jobState.ensure(JOB_NAME);
  const token = await jobState.claim(JOB_NAME);
  if (!token) {
    await finishRow(id, { status: 'skipped', skipReason: 'busy' });
    return id;
  }
  const lease = jobState.startLeaseKeeper(JOB_NAME, token);
  activeId = id;
  try {
    await execute(id, target, { full: Boolean(options.full), samplePercent, drill: options.drill !== false });
  } finally {
    activeId = null;
    lease.stop();
    await jobState.release(JOB_NAME, token, { id }).catch(() => {});
  }
  await notifyFailure(id).catch((error) => logger.error(`Could not queue the verification failure email: ${error.message}`));
  return id;
}

// ---------------------------------------------------------------- queue --

async function waitUntilIdle() {
  const deadline = Date.now() + BUSY_GIVE_UP_MS;
  for (;;) {
    const reason = await busyReason();
    if (!reason) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => { const t = setTimeout(resolve, BUSY_RETRY_MS); t.unref?.(); });
  }
}

function drain() {
  if (draining) return draining;
  draining = applicationWork.defer('backup verification', async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        if (!(await waitUntilIdle())) {
          const id = await insertRow({ ...item.target, trigger: item.trigger });
          await finishRow(id, { status: 'skipped', skipReason: 'busy' });
          continue;
        }
        await runOne(item.target, item);
      } catch (error) {
        logger.error('Backup verification failed to run', { error: error.message });
      }
    }
  }).finally(() => { draining = null; });
  return draining;
}

async function automaticRunsEnabled() {
  if (!(await isFeatureEnabled(FLAG))) return false;
  return (await readSettings()).enabled;
}

/** After a successful file backup run. Never touches the run itself. */
async function queueAfterBackup(backupRunId) {
  try {
    if (!(await automaticRunsEnabled())) return;
    queue.push({ target: { backupRunId }, trigger: 'backup' });
    drain();
  } catch (error) {
    logger.warn(`Could not queue a restore test for backup run ${backupRunId}: ${error.message}`);
  }
}

/** After a successful database-only backup run. */
async function queueAfterDatabaseBackup(databaseBackupRunId) {
  try {
    if (!(await automaticRunsEnabled())) return;
    queue.push({ target: { databaseBackupRunId }, trigger: 'backup' });
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

/**
 * An admin's "Run restore test now". Inserts the running row and returns its
 * id; the test continues in the background. Throws with code
 * VERIFICATION_BUSY / NO_BACKUP for the route to map.
 */
async function startNow({ backupRunId, databaseBackupRunId, full = false, adminId }) {
  const reason = await busyReason();
  if (reason) {
    const error = new Error(`A ${reason} is running; try the restore test again when it has finished`);
    error.code = 'VERIFICATION_BUSY';
    throw error;
  }
  let target;
  if (backupRunId) {
    const run = await db('backup_runs').where({ id: backupRunId, status: 'completed' }).first();
    target = run ? { backupRunId: run.id } : null;
  } else if (databaseBackupRunId) {
    const run = await db('database_backup_runs').where({ id: databaseBackupRunId, status: 'completed' }).first();
    target = run ? { databaseBackupRunId: run.id } : null;
  } else {
    target = await defaultTarget();
  }
  if (!target) {
    const error = new Error('There is no completed backup to test');
    error.code = 'NO_BACKUP';
    throw error;
  }
  const { samplePercent } = await readSettings();
  const id = await insertRow({ ...target, trigger: 'admin', adminId, full, samplePercent });
  applicationWork.defer('backup verification', () => runOne(target, { id, full, samplePercent, trigger: 'admin', adminId }))
    .catch(() => {});
  return id;
}

/**
 * The periodic re-check: every retained file restore point gets a deep
 * verify (bit rot, deletion at the destination); the newest also gets the
 * restore drill. With no file backups, the newest database-only dump.
 */
async function runScheduled() {
  if (!(await automaticRunsEnabled())) return;
  const runs = await db('backup_runs').where('status', 'completed').whereNotNull('manifest_path').orderBy('id', 'desc').select('id');
  if (runs.length === 0) {
    const target = await defaultTarget();
    if (target) queue.push({ target, trigger: 'schedule' });
  }
  runs.forEach((run, index) => queue.push({ target: { backupRunId: run.id }, trigger: 'schedule', drill: index === 0 }));
  await drain();
}

// ------------------------------------------------------------- reading --

async function getSummary({ limit = 20 } = {}) {
  const rows = await db('backup_verifications').orderBy('id', 'desc').limit(Math.min(Math.max(Number(limit) || 20, 1), 200));
  const items = rows.map(serialize);
  const latest = items[0] || null;
  const decisive = await db('backup_verifications').whereIn('status', ['passed', 'warning', 'failed']).orderBy('id', 'desc').first();
  const lastPass = await db('backup_verifications').whereIn('status', ['passed', 'warning']).orderBy('id', 'desc').first();
  const running = items.some((item) => item.status === 'running');
  const lastPassedAt = lastPass && lastPass.completed_at ? new Date(lastPass.completed_at).toISOString() : null;
  const staleBefore = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000;

  let health;
  if (decisive && decisive.status === 'failed') health = 'failed';
  else if (lastPassedAt && new Date(lastPassedAt).getTime() >= staleBefore) health = 'ok';
  else if (items.length === 0) health = 'none';
  else if (!decisive && running) health = 'running';
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
  if (!(await db.schema.hasTable('backup_verifications'))) return null;
  const { health, lastPassedAt, latest, staleDays } = await getSummary({ limit: 1 });
  return { health, lastPassedAt, latest, staleDays };
}

// ------------------------------------------------------ schedule + boot --

async function startVerificationSchedule() {
  stopVerificationSchedule();
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

function stopVerificationSchedule() {
  if (scheduleJob) {
    scheduleJob.stop();
    scheduleJob = null;
  }
}

/**
 * Leftovers of a test that died with its process: temp directories, drill
 * databases and rows stuck at running. Only when no replica holds the lease.
 */
async function sweepStale() {
  try {
    if (!(await db.schema.hasTable('backup_verifications'))) return;
    await jobState.ensure(JOB_NAME);
    if ((await jobState.read(JOB_NAME)).isRunning) return;

    const entries = await fs.readdir(workRoot(), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith(DRILL_TEMP_PREFIX)) {
        await fs.rm(path.join(workRoot(), entry.name), { recursive: true, force: true }).catch(() => {});
      }
    }

    const stuck = await db('backup_verifications').where({ status: 'running' }).update({
      status: 'skipped', skip_reason: 'interrupted', completed_at: nowIso(),
    });
    if (stuck) logger.warn(`Marked ${stuck} interrupted backup restore test(s)`);

    const live = liveTarget();
    if (live.engine === 'pg') {
      const admin = pgMaintenanceKnex();
      try {
        const result = await admin.raw('SELECT datname FROM pg_database WHERE datname LIKE ?', [`${DRILL_PREFIX}%`]);
        for (const { datname } of result.rows) {
          try {
            await dropDrillDatabase(assertDrillDatabaseName(datname, live.database));
            logger.warn(`Dropped stale restore-drill database ${datname}`);
          } catch (error) {
            logger.warn(`Could not drop stale restore-drill database ${datname}: ${error.message}`);
          }
        }
      } finally {
        await admin.destroy();
      }
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
  _internal: { privileges, selectFiles, bucketOf, overallStatus, planFileBackup, planDatabaseBackup, liveTarget, drain: () => draining, queue },
};
