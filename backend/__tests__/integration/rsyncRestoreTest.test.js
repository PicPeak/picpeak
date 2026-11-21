'use strict';

// The restore test of a backup made to an rsync destination: the signed
// manifest is read from <backup_rsync_path>/manifests/, the dump and the
// sample are pulled into the test's work directory and hashed, and the dump
// is loaded into a throwaway database. The destination is a mirror, so only
// the newest run can be tested; an older one is skipped as rsync_superseded.
// The remote is a local directory here, served by a stand-in for the rsync
// process (as in rsyncRemoteRestore.test.js).

process.env.DATABASE_CLIENT = 'sqlite3';
process.env.BACKUP_MANIFEST_KEY = '6c'.repeat(32);

const fs = require('fs').promises;
const path = require('path');
const { bootCrmDb } = require('./helpers/crmDb');

jest.setTimeout(240000);

const photo = 'events/active/party/individual/photo.jpg';
const invoice = 'business-docs/invoice/2026-001.pdf';
const remoteTarget = 'u1234.your-storagebox.de';
const remoteBase = '/home/picpeak';
const connection = { rsyncShell: 'ssh -p 23', rsyncTarget: remoteTarget, target: remoteTarget, host: remoteTarget,
  port: 23, keyPath: null, knownHostsPath: null };

let db; let cleanup; let tmpDir; let backup; let verification; let rsyncConnection; let backupManifest;
let remoteRoot;

async function settings(values) {
  for (const [key, value] of Object.entries(values)) {
    await db('app_settings').insert({ setting_key: key, setting_value: JSON.stringify(value),
      setting_type: key.startsWith('database_') ? 'database_backup' : 'backup' }).onConflict('setting_key').merge();
  }
}

// rsync as the client sees it: --list-only lists manifests/, --files-from
// pulls the named files (skipping those above --max-size), a missing path is
// exit 23 with rsync's own message.
function serveRemote(calls) {
  return jest.spyOn(rsyncConnection, 'runRsync').mockImplementation(async (args, options = {}) => {
    const call = { args: [...args] };
    calls.push(call);
    const missing = p => ({ code: 23, stderr: `rsync: [sender] link_stat "${p}" failed: No such file or directory (2)\n` });
    if (args.includes('--list-only')) {
      const dir = path.join(remoteRoot, 'manifests');
      const names = await fs.readdir(dir).catch(() => null);
      if (!names) return { code: 23, stderr: `rsync: [sender] change_dir "${remoteBase}/manifests" failed: No such file or directory (2)\n` };
      const stamp = date => date.toISOString().slice(0, 19).replace(/-/g, '/').replace('T', ' ');
      for (const name of names) {
        const stats = await fs.lstat(path.join(dir, name));
        options.onStdoutLine(`-rw-r--r-- ${stats.size.toLocaleString('en-US').padStart(14)} ${stamp(stats.mtime)} ${name}`);
      }
      return { code: 0, stderr: '' };
    }
    const dest = args[args.length - 1];
    const spec = args[args.length - 2];
    expect(spec).toBe(`${remoteTarget}:${remoteBase}/`);
    const maxArg = args.find(arg => arg.startsWith('--max-size='));
    const max = maxArg ? Number(maxArg.split('=')[1]) : Infinity;
    const filesFrom = args.find(arg => arg.startsWith('--files-from='));
    call.list = (await fs.readFile(filesFrom.slice('--files-from='.length), 'utf8')).split('\0');
    call.dest = dest;
    let result = { code: 0, stderr: '' };
    for (const rel of call.list) {
      const stats = await fs.stat(path.join(remoteRoot, rel)).catch(() => null);
      if (!stats) { result = missing(path.posix.join(remoteBase, rel)); continue; }
      if (stats.size > max) continue;
      await fs.mkdir(path.dirname(path.join(dest, rel)), { recursive: true });
      await fs.copyFile(path.join(remoteRoot, rel), path.join(dest, rel));
      if (options.onStdoutLine) options.onStdoutLine(rel);
    }
    return result;
  });
}

// One real rsync backup run (its transfers mocked), then the destination as
// that run leaves it: the mirror, database/<dump>, and only this run's
// manifest in manifests/ (--delete-excluded).
async function backupToRemote() {
  const safeExec = require('../../src/utils/safeExec');
  const realSpawn = jest.requireActual('../../src/utils/safeExec').spawnAsync;
  const spawn = jest.spyOn(safeExec, 'spawnAsync').mockImplementation(async (command, args, ...rest) => (command === 'rsync'
    ? { stdout: 'Number of files transferred: 2\nTotal file size: 30 bytes', stderr: '' }
    : realSpawn(command, args, ...rest)));
  try {
    await backup.runBackup(true);
  } finally { spawn.mockRestore(); }
  const run = await db('backup_runs').orderBy('id', 'desc').first();
  expect(run.status).toBe('completed');
  const manifest = JSON.parse(await fs.readFile(run.manifest_path, 'utf8'));
  await fs.rm(remoteRoot, { recursive: true, force: true });
  for (const entry of manifest.files.manifest) {
    await fs.mkdir(path.dirname(path.join(remoteRoot, entry.path)), { recursive: true });
    await fs.copyFile(path.join(process.env.STORAGE_PATH, entry.path), path.join(remoteRoot, entry.path));
  }
  await fs.mkdir(path.join(remoteRoot, 'database'), { recursive: true });
  await fs.copyFile(manifest.database.source_file, path.join(remoteRoot, manifest.database.backup_file));
  await fs.mkdir(path.join(remoteRoot, 'manifests'), { recursive: true });
  await fs.copyFile(run.manifest_path, path.join(remoteRoot, 'manifests', path.basename(run.manifest_path)));
  return { run, manifest };
}

async function verify(runId) {
  const id = await verification.runOne({ backupRunId: runId }, { trigger: 'admin' });
  const row = await db('backup_verifications').where({ id }).first();
  return { ...row, checks: typeof row.checks === 'string' ? JSON.parse(row.checks) : row.checks };
}

const resultOf = (row, name) => (row.checks.find(c => c.name === name) || {}).result;
const detailOf = (row, name) => (row.checks.find(c => c.name === name) || {}).detail;
const dataPulls = calls => calls.filter(call => call.list && !call.list.every(rel => rel.startsWith('manifests/')));
const workDirsLeft = async () => (await fs.readdir(path.join(process.env.STORAGE_PATH, 'tmp')).catch(() => []))
  .filter(name => name.startsWith('backup-verify-'));

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  backup = require('../../src/services/backupService');
  require('../../src/services/databaseBackup');
  verification = require('../../src/services/backupVerificationService');
  rsyncConnection = require('../../src/utils/rsyncConnection');
  backupManifest = require('../../src/services/backupManifest');
  const role = await db('roles').where({ name: 'super_admin' }).first();
  await db('admin_users').insert({ username: 'owner', email: 'owner@example.com', password_hash: 'x',
    role_id: role.id, is_active: true, must_change_password: false });
  remoteRoot = path.join(tmpDir, 'remote');
});

beforeEach(async () => {
  await db('backup_runs').del(); await db('backup_file_states').del(); await db('database_backup_runs').del();
  await db('backup_verifications').del();
  for (const dir of ['manifests', 'dumps', 'remote']) await fs.rm(path.join(tmpDir, dir), { recursive: true, force: true });
  for (const [rel, bytes] of [[photo, 'photo bytes'], [invoice, 'an invoice']]) {
    await fs.mkdir(path.dirname(path.join(process.env.STORAGE_PATH, rel)), { recursive: true });
    await fs.writeFile(path.join(process.env.STORAGE_PATH, rel), bytes);
  }
  await fs.mkdir(path.join(tmpDir, 'dumps'), { recursive: true });
  await settings({ backup_enabled: true, backup_destination_type: 'rsync',
    backup_destination_path: path.join(tmpDir, 'backups'), backup_manifest_path: path.join(tmpDir, 'manifests'),
    backup_incremental: false, backup_database_inline_dump: true, backup_include_database: true,
    database_backup_destination_path: path.join(tmpDir, 'dumps'),
    backup_email_on_success: false, backup_email_on_failure: false,
    database_backup_email_on_success: false, database_backup_email_on_failure: false,
    backup_verify_sample_percent: 100,
    backup_rsync_host: remoteTarget, backup_rsync_path: remoteBase, backup_rsync_port: 23 });
  jest.spyOn(rsyncConnection, 'resolveRsyncConnection').mockResolvedValue(connection);
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => { await cleanup(); });

describe('restore test of an rsync backup', () => {
  it('verifies the newest rsync backup deep and drills it, over the backup connection, leaving nothing behind', async () => {
    const { run, manifest } = await backupToRemote();
    const calls = [];
    serveRemote(calls);

    const row = await verify(run.id);

    expect({ status: row.status, notPassed: row.checks.filter(c => c.result !== 'passed') })
      .toEqual({ status: 'passed', notPassed: [] });
    expect(row.skip_reason).toBeNull();
    expect(row.level).toBe('drill');
    expect(row.checks.map(c => c.name)).toEqual(expect.arrayContaining([
      'manifest_signature', 'parent_chain', 'dump_checksum', 'business_docs', 'files_sample',
      'drill_load', 'drill_integrity', 'drill_row_counts', 'drill_migrate',
    ]));
    // Manifest listing first, then the dump on its own, then the sample.
    const pulls = dataPulls(calls);
    expect(pulls.map(call => call.list)).toEqual([
      [manifest.database.backup_file],
      expect.arrayContaining([photo, invoice]),
    ]);
    for (const call of calls) {
      expect(call.args[call.args.indexOf('-e') + 1]).toBe('ssh -p 23');
      expect(call.args.some(arg => /^--links$|^-[a-z]*[al]/.test(arg))).toBe(false);
    }
    expect(pulls[0].args).toContain(`--max-size=${manifest.database.size}`);
    // Into the test's own work directory, which is gone again.
    expect(pulls[0].dest).toContain(`${path.sep}backup-verify-`);
    expect(await workDirsLeft()).toEqual([]);
  });

  it('fails when a file on the destination was changed, and when the dump was', async () => {
    const { run, manifest } = await backupToRemote();
    serveRemote([]);
    await fs.writeFile(path.join(remoteRoot, photo), 'other bytes');

    const changedFile = await verify(run.id);
    expect(changedFile.status).toBe('failed');
    expect(resultOf(changedFile, 'files_sample')).toBe('failed');
    expect(detailOf(changedFile, 'files_sample')).toContain(`${photo} (checksum mismatch)`);
    expect(resultOf(changedFile, 'dump_checksum')).toBe('passed');

    await fs.copyFile(path.join(process.env.STORAGE_PATH, photo), path.join(remoteRoot, photo));
    const dump = path.join(remoteRoot, manifest.database.backup_file);
    const bytes = await fs.readFile(dump);
    bytes[bytes.length - 1] ^= 0xff;
    await fs.writeFile(dump, bytes);

    const changedDump = await verify(run.id);
    expect(changedDump.status).toBe('failed');
    expect(resultOf(changedDump, 'dump_checksum')).toBe('failed');
    expect(resultOf(changedDump, 'drill_load')).toBeUndefined();
    expect(changedDump.level).toBe('deep');
    expect(await workDirsLeft()).toEqual([]);
  });

  it('fails when a file is missing on the destination', async () => {
    const { run } = await backupToRemote();
    serveRemote([]);
    await fs.rm(path.join(remoteRoot, invoice));

    const row = await verify(run.id);
    expect(row.status).toBe('failed');
    expect(detailOf(row, 'business_docs')).toContain(`${invoice} (missing)`);
  });

  it('skips an older run as rsync_superseded, without contacting the destination', async () => {
    const first = await backupToRemote();
    const second = await backupToRemote();
    const calls = [];
    serveRemote(calls);

    const older = await verify(first.run.id);
    expect(older).toMatchObject({ status: 'skipped', skip_reason: 'rsync_superseded' });
    expect(calls).toEqual([]);

    const newest = await verify(second.run.id);
    expect(newest.status).toBe('passed');

    const summary = await verification.getSummary();
    expect(summary.byBackupRun).toMatchObject({ [first.run.id]: 'skipped', [second.run.id]: 'passed' });
    expect(summary.skipReasonByBackupRun).toEqual({ [first.run.id]: 'rsync_superseded' });
  });

  it('shows a run verified earlier as superseded once a newer backup replaced the mirror', async () => {
    const first = await backupToRemote();
    const calls = [];
    serveRemote(calls);
    expect((await verify(first.run.id)).status).toBe('passed');
    await backupToRemote();
    expect(await verify(first.run.id)).toMatchObject({ status: 'skipped', skip_reason: 'rsync_superseded' });
    // A later busy skip does not hide it either.
    await db('backup_verifications').insert({ backup_run_id: first.run.id, status: 'skipped', skip_reason: 'busy',
      triggered_by: 'schedule', started_at: new Date().toISOString(), completed_at: new Date().toISOString() });

    const summary = await verification.getSummary();
    expect(summary.byBackupRun[first.run.id]).toBe('skipped');
    expect(summary.skipReasonByBackupRun[first.run.id]).toBe('rsync_superseded');
  });

  it('stops the manifest listing when a backup starts during it, ending as skipped, not failed', async () => {
    const { run } = await backupToRemote();
    const calls = [];
    serveRemote(calls);
    const real = rsyncConnection.runRsync.getMockImplementation();
    rsyncConnection.runRsync.mockImplementation(async (args, options = {}) => {
      if (args.includes('--list-only')) {
        verification.yieldTo('backup');
        expect(options.signal && options.signal.aborted).toBe(true);
        return { code: 20, stderr: 'rsync error: received SIGINT, SIGTERM, or SIGHUP (code 20)', aborted: true };
      }
      return real(args, options);
    });

    const row = await verify(run.id);
    expect(row).toMatchObject({ status: 'skipped', skip_reason: 'busy' });
  });

  it('records a manifest download that fails after the test was cancelled as skipped', async () => {
    const { run } = await backupToRemote();
    const calls = [];
    serveRemote(calls);
    const real = rsyncConnection.runRsync.getMockImplementation();
    rsyncConnection.runRsync.mockImplementation(async (args, options = {}) => {
      if (args.includes(`--max-size=${16 * 1024 * 1024}`)) {
        verification.yieldTo('backup');
        // The new backup rotated the manifest away mid-download.
        return { code: 23, stderr: `rsync: [sender] link_stat "${remoteBase}/manifests/x" failed: No such file or directory (2)\n` };
      }
      return real(args, options);
    });

    const row = await verify(run.id);
    expect(row).toMatchObject({ status: 'skipped', skip_reason: 'busy' });
  });

  it('tells superseded from the destination itself when this host does not know the newer run', async () => {
    const first = await backupToRemote();
    await backupToRemote();
    // A host restored from a dump taken before the newer run completed.
    await db('backup_runs').whereNot({ id: first.run.id }).del();
    const calls = [];
    serveRemote(calls);

    const row = await verify(first.run.id);
    expect(row).toMatchObject({ status: 'skipped', skip_reason: 'rsync_superseded' });
    expect(calls.some(call => call.args.includes('--list-only'))).toBe(true);
    expect(dataPulls(calls)).toEqual([]);
  });

  it('fails the newest run when the destination still holds an older run\'s manifest', async () => {
    const first = await backupToRemote();
    const keep = path.join(tmpDir, 'first-manifest.json');
    await fs.copyFile(path.join(remoteRoot, 'manifests', path.basename(first.run.manifest_path)), keep);
    const second = await backupToRemote();
    // The newer run's manifest upload never arrived.
    await fs.rm(path.join(remoteRoot, 'manifests'), { recursive: true, force: true });
    await fs.mkdir(path.join(remoteRoot, 'manifests'));
    await fs.copyFile(keep, path.join(remoteRoot, 'manifests', path.basename(first.run.manifest_path)));
    serveRemote([]);

    const row = await verify(second.run.id);
    expect(row.status).toBe('failed');
    expect(detailOf(row, 'destination')).toMatch(/manifest of an earlier backup/);
  });

  it('fails when the manifest on the destination was tampered with', async () => {
    const { run, manifest } = await backupToRemote();
    serveRemote([]);
    manifest.files.manifest[0].checksum = 'a'.repeat(64);
    await fs.writeFile(path.join(remoteRoot, 'manifests', path.basename(run.manifest_path)), JSON.stringify(manifest));

    const row = await verify(run.id);
    expect(row.status).toBe('failed');
    expect(resultOf(row, 'manifest_signature')).toBe('failed');
  });

  it('keeps a run from before the manifest was copied to the destination skipped as not_verifiable_rsync', async () => {
    const { run, manifest } = await backupToRemote();
    // Its local manifest has no mirror-v1 marker: nothing on the remote names it.
    delete manifest.metadata.rsync_manifest_layout;
    backupManifest.signManifest(manifest);
    await fs.writeFile(run.manifest_path, JSON.stringify(manifest));
    await fs.rm(path.join(remoteRoot, 'manifests'), { recursive: true, force: true });
    const calls = [];
    serveRemote(calls);

    const row = await verify(run.id);
    expect(row).toMatchObject({ status: 'skipped', skip_reason: 'not_verifiable_rsync' });
    expect(calls).toEqual([]);
  });

  it('keeps a legacy-layout remote (no manifests/ directory) skipped when the local manifest is gone too', async () => {
    const { run } = await backupToRemote();
    await fs.rm(run.manifest_path);
    await fs.rm(path.join(remoteRoot, 'manifests'), { recursive: true, force: true });
    const calls = [];
    serveRemote(calls);

    const row = await verify(run.id);
    expect(row).toMatchObject({ status: 'skipped', skip_reason: 'not_verifiable_rsync' });
    expect(calls.some(call => call.args.includes('--list-only'))).toBe(true);
  });

  it('fails a mirror-v1 run whose manifest is gone from the destination', async () => {
    const { run } = await backupToRemote();
    await fs.rm(path.join(remoteRoot, 'manifests'), { recursive: true, force: true });
    serveRemote([]);

    const row = await verify(run.id);
    expect(row.status).toBe('failed');
    expect(resultOf(row, 'destination')).toBe('failed');
  });

  it('skips with insufficient_space when the download would not fit', async () => {
    const { run } = await backupToRemote();
    const calls = [];
    serveRemote(calls);
    const statfs = jest.spyOn(fs, 'statfs').mockResolvedValue({ bavail: 1, bsize: 1 });

    const row = await verify(run.id);
    statfs.mockRestore();
    expect(row).toMatchObject({ status: 'skipped', skip_reason: 'insufficient_space' });
    expect(dataPulls(calls)).toEqual([]);
  });

  it('stops the download when a backup starts mid-test, ending as skipped', async () => {
    const { run } = await backupToRemote();
    const calls = [];
    serveRemote(calls);
    const real = rsyncConnection.runRsync.getMockImplementation();
    rsyncConnection.runRsync.mockImplementation(async (args, options = {}) => {
      if (args.some(arg => arg.startsWith('--files-from=')) && !args.includes(`--max-size=${16 * 1024 * 1024}`)) {
        verification.yieldTo('backup');
        expect(options.signal.aborted).toBe(true);
        return { code: 20, stderr: 'rsync error: received SIGINT, SIGTERM, or SIGHUP (code 20)', aborted: true };
      }
      return real(args, options);
    });

    const row = await verify(run.id);
    expect(row).toMatchObject({ status: 'skipped', skip_reason: 'busy' });
    expect(await workDirsLeft()).toEqual([]);
  });
});
