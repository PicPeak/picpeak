/**
 * Backup restore tests end to end: a real database dump, a real local file
 * backup, then the deep verify and the restore drill in their child
 * processes against a throwaway database.
 *
 * Runs on SQLite by default and on PostgreSQL with DATABASE_CLIENT=pg (the
 * drill then needs psql and the CREATEDB privilege).
 */

const fs = require('fs').promises;
const path = require('path');
const { bootCrmDb } = require('./helpers/crmDb');

jest.setTimeout(240000);

const isPg = process.env.DATABASE_CLIENT === 'pg';

describe('backup restore tests', () => {
  let db;
  let cleanup;
  let fixtureRoot;
  let storage;
  let destination;
  let dumpDir;
  let backupService;
  let databaseBackupService;
  let verification;
  let flags;

  async function setting(key, value, type = 'backup') {
    await db('app_settings').insert({
      setting_key: key, setting_value: JSON.stringify(value), setting_type: type,
    }).onConflict('setting_key').merge();
  }

  async function write(relativePath, bytes) {
    const file = path.join(storage, relativePath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
  }

  async function setFlag(on) {
    await db('feature_flags').where({ key: 'backupRestoreTest' }).update({ value: on });
    flags.invalidateFeatureFlagCache();
  }

  async function freshDumpAndBackup() {
    await databaseBackupService.backup({ destinationPath: dumpDir, inline: true });
    await backupService.runBackup(true);
    const run = await db('backup_runs').orderBy('id', 'desc').first();
    expect(run.status).toBe('completed');
    return run;
  }

  async function verify(target, options = {}) {
    const id = await verification.runOne(target, { trigger: 'admin', ...options });
    const row = await db('backup_verifications').where({ id }).first();
    return { ...row, checks: typeof row.checks === 'string' ? JSON.parse(row.checks) : row.checks };
  }

  // The automatic tests run detached; wait for their row to be final.
  async function finished(where) {
    for (let i = 0; i < 600; i += 1) {
      const row = await db('backup_verifications').where(where).first();
      if (row && row.status !== 'running') return row;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('restore test did not finish');
  }

  // jsonb comes back parsed on PostgreSQL, as text on SQLite.
  const stats = (run) => (typeof run.statistics === 'string' ? JSON.parse(run.statistics) : run.statistics);

  const resultOf = (row, name) => (row.checks.find((c) => c.name === name) || {}).result;

  // Everything the drill could plausibly write to by accident. The rows a
  // test writes on purpose (its own verification row, the lease) are left out.
  async function liveFingerprint() {
    const checksums = await databaseBackupService.getTableChecksums();
    delete checksums.backup_verifications;
    delete checksums.maintenance_jobs;
    delete checksums.email_queue;
    const migrations = (await db('migrations').select('filename')).map((r) => r.filename).sort();
    return { checksums, migrations };
  }

  beforeAll(async () => {
    ({ db, cleanup, tmpDir: fixtureRoot } = await bootCrmDb());
    storage = process.env.STORAGE_PATH;
    destination = path.join(fixtureRoot, 'backups');
    dumpDir = path.join(fixtureRoot, 'dumps');
    backupService = require('../../src/services/backupService');
    ({ databaseBackupService } = require('../../src/services/databaseBackup'));
    verification = require('../../src/services/backupVerificationService');
    flags = require('../../src/middleware/requireFeatureFlag');

    const role = await db('roles').where({ name: 'super_admin' }).first();
    await db('admin_users').insert({
      username: 'owner', email: 'owner@example.com', password_hash: 'x',
      role_id: role.id, is_active: true, must_change_password: false,
    });
    for (const [key, value] of Object.entries({
      backup_enabled: false, backup_destination_type: 'local',
      backup_destination_path: destination, backup_include_database: true,
      backup_database_inline_dump: false, backup_email_on_success: false,
      backup_email_on_failure: true, backup_verify_sample_percent: 100,
    })) await setting(key, value);
    await write('events/active/E1/photo.jpg', 'a photo');
    await write('business-docs/invoice/2026-001.pdf', 'an invoice');
  });

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  beforeEach(async () => {
    await setFlag(false);
    await db('backup_verifications').del();
    await db('email_queue').del();
  });

  it('passes a healthy backup through the deep verify and the restore drill, leaving the live database untouched', async () => {
    const run = await freshDumpAndBackup();
    const before = await liveFingerprint();

    const row = await verify({ backupRunId: run.id });

    expect({ status: row.status, notPassed: row.checks.filter((c) => c.result !== 'passed') })
      .toEqual({ status: 'passed', notPassed: [] });
    expect(row.level).toBe('drill');
    expect(row.checks.map((c) => c.name)).toEqual(expect.arrayContaining([
      'manifest_signature', 'parent_chain', 'dump_checksum', 'business_docs', 'files_sample',
      'drill_load', 'drill_integrity', 'drill_foreign_keys', 'drill_row_counts', 'drill_migrate', 'drill_invariants',
    ]));
    expect(row.checks.filter((c) => c.result !== 'passed')).toEqual([]);

    expect(await liveFingerprint()).toEqual(before);
    // No drill leftovers: the work directory and (PostgreSQL) the database.
    const tmp = await fs.readdir(path.join(storage, 'tmp')).catch(() => []);
    expect(tmp.filter((name) => name.startsWith('backup-verify-'))).toEqual([]);
    if (isPg) {
      const drills = await db.raw("SELECT datname FROM pg_database WHERE datname LIKE 'picpeak_drill_%'");
      expect(drills.rows).toEqual([]);
    }
  });

  (isPg ? it : it.skip)('falls back to the deep check with a warning when the database user may not create databases', async () => {
    const run = await freshDumpAndBackup();
    const privilege = jest.spyOn(verification._internal.privileges, 'canCreateDatabase').mockResolvedValue(false);
    try {
      const row = await verify({ backupRunId: run.id });
      expect(row).toMatchObject({ status: 'warning', level: 'deep' });
      expect(row.checks.find((c) => c.name === 'createdb_privilege').detail).toMatch(/Grant CREATEDB/);
      expect(resultOf(row, 'drill_load')).toBeUndefined();
    } finally {
      privilege.mockRestore();
    }
  });

  it('queues a test after a backup run when the flag is on, without touching the run', async () => {
    await setFlag(true);
    await databaseBackupService.backup({ destinationPath: dumpDir, inline: true });
    await backupService.runBackup(true);
    const run = await db('backup_runs').orderBy('id', 'desc').first();
    const row = await finished({ backup_run_id: run.id });
    expect(await db('backup_verifications').where({ backup_run_id: run.id })).toHaveLength(1);
    expect(row).toMatchObject({ status: 'passed', level: 'drill', triggered_by: 'backup' });
    expect((await db('backup_runs').where({ id: run.id }).first()).status).toBe('completed');
  });

  it('tests a database-only backup on its own after it completes', async () => {
    await setFlag(true);
    await databaseBackupService.backup({ destinationPath: dumpDir });
    const dbRun = await db('database_backup_runs').orderBy('id', 'desc').first();
    const row = await finished({ database_backup_run_id: dbRun.id });
    expect(row).toMatchObject({ status: 'passed', level: 'drill', triggered_by: 'backup' });
  });

  it('fails a backup whose business document changed at the destination, and emails the admins', async () => {
    const run = await freshDumpAndBackup();
    const snapshot = stats(run).snapshot_path;
    await fs.writeFile(path.join(snapshot, 'business-docs/invoice/2026-001.pdf'), 'bit rot');

    const row = await verify({ backupRunId: run.id });

    expect(row.status).toBe('failed');
    expect(resultOf(row, 'business_docs')).toBe('failed');
    expect(resultOf(row, 'dump_checksum')).toBe('passed');
    const mail = await db('email_queue').where({ email_type: 'backup_verification_failed' });
    expect(mail.length).toBeGreaterThan(0);
  });

  it('fails without a drill when the dump at the destination does not match the manifest', async () => {
    const run = await freshDumpAndBackup();
    const snapshot = stats(run).snapshot_path;
    const dumpDirInSnapshot = path.join(snapshot, 'database');
    const [dumpFile] = await fs.readdir(dumpDirInSnapshot);
    await fs.appendFile(path.join(dumpDirInSnapshot, dumpFile), 'x');

    const row = await verify({ backupRunId: run.id });

    expect(row.status).toBe('failed');
    expect(row.level).toBe('deep');
    expect(resultOf(row, 'dump_checksum')).toBe('failed');
    expect(resultOf(row, 'drill_load')).toBeUndefined();
  });

  it('fails a backup whose restore point was deleted at the destination', async () => {
    const run = await freshDumpAndBackup();
    await fs.rm(stats(run).snapshot_path, { recursive: true, force: true });

    const row = await verify({ backupRunId: run.id });

    expect(row.status).toBe('failed');
    expect(row.checks.some((c) => c.result === 'failed')).toBe(true);
  });

  it('skips rsync backups honestly instead of claiming they passed', async () => {
    const [id] = (await db('backup_runs').insert({
      started_at: new Date().toISOString(), completed_at: new Date().toISOString(), status: 'completed',
      backup_type: 'manual', manifest_path: '/nowhere/backup-manifest-x.json',
      statistics: JSON.stringify({ destination: 'rsync' }),
    }).returning('id')).map((r) => r.id ?? r);

    const row = await verify({ backupRunId: id });

    expect(row).toMatchObject({ status: 'skipped', skip_reason: 'not_verifiable_rsync' });
  });

  it('skips with insufficient_space when the dump would not fit', async () => {
    const run = await freshDumpAndBackup();
    const statfs = jest.spyOn(fs, 'statfs').mockResolvedValue({ bavail: 1, bsize: 1 });
    try {
      const row = await verify({ backupRunId: run.id });
      expect(row).toMatchObject({ status: 'skipped', skip_reason: 'insufficient_space' });
    } finally {
      statfs.mockRestore();
    }
  });

  it('hashes only business documents plus the rotating sample unless asked for a full run', async () => {
    await setting('backup_verify_sample_percent', 0);
    try {
      const run = await freshDumpAndBackup();
      const sampled = await verify({ backupRunId: run.id }, { drill: false });
      expect(sampled.checks.find((c) => c.name === 'files_sample')).toMatchObject({ result: 'skipped' });
      expect(resultOf(sampled, 'business_docs')).toBe('passed');

      const full = await verify({ backupRunId: run.id }, { drill: false, full: true });
      expect(resultOf(full, 'files_all')).toBe('passed');
    } finally {
      await setting('backup_verify_sample_percent', 100);
    }
  });

  it('refuses to start while a backup is running', async () => {
    await freshDumpAndBackup();
    const running = jest.spyOn(backupService, 'isBackupRunning').mockReturnValue(true);
    try {
      await expect(verification.startNow({})).rejects.toMatchObject({ code: 'VERIFICATION_BUSY' });
    } finally {
      running.mockRestore();
    }
  });

  it('reports health from the latest results: failed beats an older pass, and a failure makes the backup unhealthy', async () => {
    await setFlag(true);
    await db('backup_verifications').insert({
      level: 'drill', status: 'passed', checks: '[]', triggered_by: 'schedule',
      started_at: new Date().toISOString(), completed_at: new Date().toISOString(),
    });
    expect((await verification.getHealth()).health).toBe('ok');
    await db('backup_verifications').insert({
      level: 'deep', status: 'failed', checks: '[]', triggered_by: 'schedule',
      started_at: new Date().toISOString(), completed_at: new Date().toISOString(),
    });
    expect((await verification.getHealth()).health).toBe('failed');
    expect((await backupService.getBackupStatus()).isHealthy).toBe(false);

    await setFlag(false);
    expect(await verification.getHealth()).toBeNull();
  });

  it('reports a pass older than the stale window as stale', async () => {
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    await db('backup_verifications').insert({
      level: 'drill', status: 'passed', checks: '[]', triggered_by: 'schedule', started_at: old, completed_at: old,
    });
    expect((await verification.getSummary()).health).toBe('stale');
  });

  it('sweeps rows and work directories left by a crashed test on boot', async () => {
    await db('backup_verifications').insert({
      level: 'deep', status: 'running', checks: '[]', triggered_by: 'schedule', started_at: new Date().toISOString(),
    });
    await fs.mkdir(path.join(storage, 'tmp', 'backup-verify-999'), { recursive: true });

    await verification.sweepStale();

    expect(await db('backup_verifications').where({ status: 'running' })).toEqual([]);
    expect((await db('backup_verifications').first()).skip_reason).toBe('interrupted');
    await expect(fs.stat(path.join(storage, 'tmp', 'backup-verify-999'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
