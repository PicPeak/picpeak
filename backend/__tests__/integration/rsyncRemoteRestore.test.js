'use strict';

// A backup made to an rsync destination restores from the destination
// itself: the wizard lists the signed manifests in
// <backup_rsync_path>/manifests/, and the restore downloads what its type
// needs into a private staging directory, verifies it against the manifest
// and removes it afterwards. The remote is a local directory here, served by
// a stand-in for the rsync process that honours the arguments it is given.

process.env.DATABASE_CLIENT = 'sqlite3';
process.env.JWT_SECRET = 'rsync-remote-restore-test-secret';
process.env.BACKUP_MANIFEST_KEY = '6b'.repeat(32);

// The post-restore migrations run in a subprocess against the live file;
// the restore under test is the download, not the migration runner.
jest.mock('../../src/utils/safeExec', () => {
  const actual = jest.requireActual('../../src/utils/safeExec');
  return { ...actual, spawnAsync: (command, ...rest) => (command === 'node'
    ? Promise.resolve({ stdout: '', stderr: '' }) : actual.spawnAsync(command, ...rest)) };
});

const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { bootCrmDb } = require('./helpers/crmDb');

jest.setTimeout(120000);

const photo = 'events/active/party/individual/photo.jpg';
const remoteTarget = 'u1234.your-storagebox.de';
const remoteBase = '/home/picpeak';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

let db; let cleanup; let tmpDir; let backup; let storageModule; let app; let superToken;
let rsyncConnection; let rsyncRestore; let backupManifest; let RestoreService; let restoreService;
let remoteRoot; let manifestName; let manifest; let dumpRel;

async function settings(values) {
  for (const [key, value] of Object.entries(values)) {
    await db('app_settings').insert({ setting_key: key, setting_value: JSON.stringify(value),
      setting_type: key.startsWith('database_') ? 'database_backup' : 'backup' }).onConflict('setting_key').merge();
  }
}
const marker = async () => JSON.parse((await db('app_settings').where({ setting_key: 'restore_marker' }).first()).setting_value);

const connection = { rsyncShell: 'ssh -p 23', rsyncTarget: remoteTarget, target: remoteTarget, host: remoteTarget,
  port: 23, keyPath: null, knownHostsPath: null };

// rsync as seen from the client: the last two arguments are source and
// destination, --files-from names what to pull, --max-size skips bigger
// files, a missing source is exit 23 with rsync's own link_stat message.
function serveRemote(calls, { override } = {}) {
  return jest.spyOn(rsyncConnection, 'runRsync').mockImplementation(async (args, options = {}) => {
    const call = { args: [...args] };
    calls.push(call);
    if (override) {
      const result = await override(args, options);
      if (result) return result;
    }
    if (args.includes('--list-only')) {
      // GNU rsync's listing: mode, grouped size, date, time, name.
      const spec = args[args.length - 1];
      expect(spec).toBe(`${remoteTarget}:${remoteBase}/manifests/`);
      const dir = path.join(remoteRoot, 'manifests');
      const names = await fs.readdir(dir).catch(() => null);
      if (!names) return { code: 23, stderr: `rsync: [sender] change_dir "${remoteBase}/manifests" failed: No such file or directory (2)\n` };
      const stamp = date => date.toISOString().slice(0, 19).replace(/-/g, '/').replace('T', ' ');
      options.onStdoutLine(`drwxr-xr-x          4,096 ${stamp(new Date())} .`);
      for (const name of names) {
        const stats = await fs.lstat(path.join(dir, name));
        const mode = stats.isSymbolicLink() ? 'lrwxrwxrwx' : stats.isDirectory() ? 'drwxr-xr-x' : '-rw-r--r--';
        options.onStdoutLine(`${mode} ${stats.size.toLocaleString('en-US').padStart(14)} ${stamp(stats.mtime)} ${name}`);
      }
      return { code: 0, stderr: '' };
    }
    const dest = args[args.length - 1];
    const spec = args[args.length - 2];
    expect(spec.startsWith(`${remoteTarget}:${remoteBase}/`)).toBe(true);
    const remotePath = spec.slice(remoteTarget.length + 1);
    const local = path.join(remoteRoot, path.relative(remoteBase, remotePath));
    const maxArg = args.find(arg => arg.startsWith('--max-size='));
    const max = maxArg ? Number(maxArg.split('=')[1]) : Infinity;
    const missing = p => ({ code: 23, stderr: `rsync: [sender] link_stat "${p}" failed: No such file or directory (2)\n` });
    const filesFrom = args.find(arg => arg.startsWith('--files-from='));
    if (filesFrom) {
      call.list = (await fs.readFile(filesFrom.slice('--files-from='.length), 'utf8')).split('\0');
      let result = { code: 0, stderr: '' };
      for (const rel of call.list) {
        const stats = await fs.stat(path.join(local, rel)).catch(() => null);
        if (!stats) { result = missing(path.posix.join(remotePath, rel)); continue; }
        if (stats.size > max) continue;
        await fs.mkdir(path.dirname(path.join(dest, rel)), { recursive: true });
        await fs.copyFile(path.join(local, rel), path.join(dest, rel));
        if (options.onStdoutLine) options.onStdoutLine(rel);
      }
      return result;
    }
    if (spec.endsWith('/')) {
      const names = await fs.readdir(local).catch(() => null);
      if (!names) return missing(remotePath.replace(/\/$/, ''));
      for (const name of names) {
        if (name.startsWith('backup-manifest-')) await fs.copyFile(path.join(local, name), path.join(dest, name));
      }
      return { code: 0, stderr: '' };
    }
    if (!(await fs.stat(local).catch(() => null))) return missing(remotePath);
    await fs.copyFile(local, path.join(dest, path.basename(local)));
    return { code: 0, stderr: '' };
  });
}

// One real rsync backup run (its transfer mocked), then the destination as
// the run left it: the mirror of the storage root, database/<dump>, and the
// signed manifest in manifests/.
async function backupToRemote() {
  await settings({ restore_marker: 'backup' });
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
  manifestName = path.basename(run.manifest_path);
  manifest = JSON.parse(await fs.readFile(run.manifest_path, 'utf8'));
  dumpRel = manifest.database.backup_file;
  for (const entry of manifest.files.manifest) {
    await fs.mkdir(path.dirname(path.join(remoteRoot, entry.path)), { recursive: true });
    await fs.copyFile(path.join(process.env.STORAGE_PATH, entry.path), path.join(remoteRoot, entry.path));
  }
  await fs.mkdir(path.join(remoteRoot, 'database'), { recursive: true });
  await fs.copyFile(manifest.database.source_file, path.join(remoteRoot, dumpRel));
  await fs.mkdir(path.join(remoteRoot, 'manifests'), { recursive: true });
  await fs.copyFile(run.manifest_path, path.join(remoteRoot, 'manifests', manifestName));
  // The new host: no history, no local manifest, no dump, the photo gone.
  await db('backup_runs').del();
  for (const dir of ['manifests', 'dumps']) await fs.rm(path.join(tmpDir, dir), { recursive: true, force: true });
  await fs.rm(path.join(process.env.STORAGE_PATH, photo), { force: true });
  await settings({ restore_marker: 'changed after the backup' });
}

const ref = () => `rsync:manifests/${manifestName}`;
// The --files-from downloads of restore data, not of manifests.
const dataPulls = calls => calls.filter(call => call.list && !call.list.every(rel => rel.startsWith('manifests/')));
const post = (url, body) => request(app).post(`/api/admin/restore${url}`).set('Authorization', `Bearer ${superToken}`).send(body);

function newService() {
  const service = new RestoreService();
  service.sendRestoreNotification = jest.fn(async () => {});
  return service;
}

async function stagingLeft(service) {
  const names = await fs.readdir(service.tempDir).catch(() => []);
  return names.filter(name => name.startsWith('rsync-remote-'));
}

async function writeRemoteManifest(value) {
  await fs.writeFile(path.join(remoteRoot, 'manifests', manifestName), JSON.stringify(value));
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  storageModule = require('../../src/services/storage');
  backup = require('../../src/services/backupService');
  require('../../src/services/databaseBackup');
  rsyncConnection = require('../../src/utils/rsyncConnection');
  rsyncRestore = require('../../src/utils/rsyncRestore');
  backupManifest = require('../../src/services/backupManifest');
  ({ RestoreService, restoreService } = require('../../src/services/restoreService'));
  // The routes use the singleton: keep its temp dir (removed after every run)
  // away from the default one other suites share.
  restoreService.tempDir = path.join(tmpDir, 'restore-tmp');
  const role = await db('roles').where({ name: 'super_admin' }).first();
  const [inserted] = await db('admin_users').insert({ username: 'root-admin', email: 'root-admin@example.com',
    password_hash: await bcrypt.hash('Passw0rd!', 4), role_id: role.id, is_active: 1,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString() }).returning('id');
  superToken = jwt.sign({ id: inserted?.id ?? inserted, username: 'root-admin', type: 'admin', role: 'super_admin',
    loginTime: Date.now() }, process.env.JWT_SECRET, { expiresIn: '1h', issuer: 'picpeak-auth' });
  app = express();
  app.use(express.json());
  app.use('/api/admin/restore', require('../../src/routes/adminRestore'));
}, 120000);

beforeEach(async () => {
  storageModule.setStorageForTesting({ kind: () => 'local' });
  await db('backup_runs').del(); await db('backup_file_states').del(); await db('database_backup_runs').del();
  remoteRoot = path.join(tmpDir, 'remote');
  for (const dir of ['manifests', 'dumps', 'remote']) await fs.rm(path.join(tmpDir, dir), { recursive: true, force: true });
  await fs.rm(process.env.STORAGE_PATH, { recursive: true, force: true });
  await fs.mkdir(path.dirname(path.join(process.env.STORAGE_PATH, photo)), { recursive: true });
  await fs.writeFile(path.join(process.env.STORAGE_PATH, photo), 'photo bytes');
  await fs.mkdir(path.join(tmpDir, 'dumps'), { recursive: true });
  await fs.mkdir(remoteRoot, { recursive: true });
  await settings({ backup_enabled: true, backup_destination_type: 'rsync',
    backup_destination_path: path.join(tmpDir, 'backups'), backup_manifest_path: path.join(tmpDir, 'manifests'),
    backup_incremental: false, backup_database_inline_dump: true,
    database_backup_destination_path: path.join(tmpDir, 'dumps'),
    backup_email_on_success: false, backup_email_on_failure: false,
    database_backup_email_on_success: false, database_backup_email_on_failure: false,
    backup_rsync_host: remoteTarget, backup_rsync_path: remoteBase, backup_rsync_port: 23 });
  jest.spyOn(rsyncConnection, 'resolveRsyncConnection').mockResolvedValue(connection);
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => { storageModule.resetStorage(); await cleanup(); });

describe('listing restore points on the rsync destination', () => {
  it('lists the remote mirror manifest, downloaded without following links and bounded in size', async () => {
    await backupToRemote();
    const calls = [];
    serveRemote(calls);
    const listed = await post('/list-backups', { source: 'local' });
    expect(listed.status).toBe(200);
    expect(listed.body.remoteError).toBeNull();
    expect(listed.body.data).toEqual([expect.objectContaining({ id: ref(), type: 'rsync', restore_source: 'rsync',
      path: ref(), manifest_path: ref(), manifestId: manifest.backup.id, database_included: true, corrupt: false,
      filesCount: manifest.files.count })]);
    // First a listing that downloads nothing, then only the selected names.
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toEqual(expect.arrayContaining(['--list-only']));
    expect(calls[0].args[calls[0].args.indexOf('-e') + 1]).toBe('ssh -p 23');
    const args = calls[1].args;
    expect(calls[1].list).toEqual([`manifests/${manifestName}`]);
    expect(args).toEqual(expect.arrayContaining(['--times', `--max-size=${16 * 1024 * 1024}`]));
    expect(args).not.toEqual(expect.arrayContaining(['-a']));
    expect(args.some(arg => /^--links$|^-[a-z]*[al]/.test(arg))).toBe(false);
    expect(args[args.indexOf('-e') + 1]).toBe('ssh -p 23');
    expect(args[args.length - 2]).toBe(`${remoteTarget}:${remoteBase}/`);
    // The listing directory is gone again.
    expect(args[args.length - 1]).toMatch(/picpeak-rsync-manifests-/);
    await expect(fs.access(path.dirname(args[args.length - 1]))).rejects.toThrow();
  });

  it('downloads at most the newest 20 manifest names within the byte cap, whatever the destination holds', async () => {
    await backupToRemote();
    const dir = path.join(remoteRoot, 'manifests');
    const old = new Date(Date.now() - 86400000);
    // 60 junk names, older than the real manifest, and two oversized ones.
    for (let i = 0; i < 60; i += 1) {
      const junk = path.join(dir, `backup-manifest-junk-${String(i).padStart(2, '0')}.json`);
      await fs.writeFile(junk, '{"not":"a manifest"}');
      await fs.utimes(junk, old, old);
    }
    for (const name of ['backup-manifest-huge-a.json', 'backup-manifest-huge-b.json']) {
      const handle = await fs.open(path.join(dir, name), 'w');
      await handle.truncate(17 * 1024 * 1024);
      await handle.close();
    }
    await fs.writeFile(path.join(dir, 'not-a-manifest.json'), '{}');
    await fs.symlink('/etc/passwd', path.join(dir, 'backup-manifest-link.json'));
    const calls = [];
    serveRemote(calls);
    const listed = await post('/list-backups', { source: 'local' });
    expect(listed.body.data).toEqual([expect.objectContaining({ path: ref() })]);
    const fetched = calls.find(call => call.list).list;
    expect(fetched).toHaveLength(rsyncRestore.MAX_LISTED_MANIFESTS);
    expect(fetched).toContain(`manifests/${manifestName}`);
    expect(fetched.filter(rel => /huge|link|not-a-manifest/.test(rel))).toEqual([]);
    expect(calls.find(call => call.list).args).toContain(`--max-size=${16 * 1024 * 1024}`);
  });

  it('stops a manifest download that writes more than the listing announced', async () => {
    await backupToRemote();
    rsyncRestore.BUDGET_POLL_MS = 20;
    let signal;
    serveRemote([], { override: async (args, options) => {
      if (!args.some(arg => arg.startsWith('--files-from='))) return null;
      signal = options.signal;
      const dest = path.join(args[args.length - 1], 'manifests', manifestName);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, Buffer.alloc(3 * 1024 * 1024));
      await new Promise((resolve) => {
        if (signal.aborted) resolve();
        signal.addEventListener('abort', resolve);
        setTimeout(resolve, 5000);
      });
      return { code: 20, stderr: '', aborted: signal.aborted };
    } });
    try {
      const listed = await post('/list-backups', { source: 'local' });
      expect(listed.body.remoteError).toMatchObject({ code: 'RESTORE_REMOTE_DOWNLOAD_TOO_LARGE' });
    } finally { rsyncRestore.BUDGET_POLL_MS = 1000; }
    expect(signal.aborted).toBe(true);
  });

  it.each([['not a date'], [{ toString: null }]])('marks a remote manifest that fails authentication (timestamp %p) and leaves out manifests of other layouts', async (timestamp) => {
    await backupToRemote();
    await writeRemoteManifest({ ...manifest, backup: { ...manifest.backup, timestamp }, files: { ...manifest.files, total_size: 1 } });
    const foreign = { ...manifest, metadata: { ...manifest.metadata, rsync_manifest_layout: undefined } };
    await fs.writeFile(path.join(remoteRoot, 'manifests', 'backup-manifest-other.json'), JSON.stringify(foreign));
    serveRemote([]);
    const listed = await post('/list-backups', { source: 'local' });
    expect(listed.body.data).toEqual([expect.objectContaining({ path: ref(), corrupt: true,
      error: expect.stringMatching(/checksum verification failed/) })]);
    // Its unparseable timestamp is replaced by the file's, so the wizard can format it.
    expect(Number.isNaN(Date.parse(listed.body.data[0].created_at))).toBe(false);
  });

  it('reports an unreachable or refusing destination with its rsync code and still lists local points', async () => {
    serveRemote([], { override: async () => ({ code: 255, stderr: 'u1234@u1234.your-storagebox.de: Permission denied (publickey).\n' }) });
    const listed = await post('/list-backups', { source: 'local' });
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual([]);
    expect(listed.body.remoteError).toMatchObject({ code: 'RSYNC_AUTH_FAILED' });
  });

  it('reports a destination without a manifests directory', async () => {
    serveRemote([]);
    const listed = await post('/list-backups', { source: 'local' });
    expect(listed.body.remoteError).toMatchObject({ code: 'RESTORE_REMOTE_MANIFEST_NOT_FOUND' });
  });
});

describe('restoring from the rsync destination', () => {
  it('validates a remote point through the wizard route and refuses mixed source/manifest forms', async () => {
    await backupToRemote();
    serveRemote([]);
    const validated = await post('/validate', { source: 'rsync', manifestPath: ref(), restoreType: 'database' });
    expect(validated.body).toMatchObject({ success: true });
    expect(validated.status).toBe(200);
    const mixed = await post('/validate', { source: 'local', manifestPath: ref(), restoreType: 'database' });
    expect(mixed.status).toBe(400);
    const pathed = await post('/validate', { source: 'rsync', manifestPath: '/etc/passwd', restoreType: 'database' });
    expect(pathed.status).toBe(400);
    const traversal = await post('/validate', { source: 'rsync', manifestPath: 'rsync:manifests/../x.json', restoreType: 'database' });
    expect(traversal.status).toBe(400);
  });

  it('refuses a tampered or unsigned remote manifest before anything is downloaded', async () => {
    await backupToRemote();
    const calls = [];
    serveRemote(calls);
    await writeRemoteManifest({ ...manifest, database: { ...manifest.database, checksum: sha('other dump') } });
    const service = newService();
    service.tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-rsync-restore-tmp-'));
    await expect(service.restore({ source: 'rsync', manifestPath: ref(), restoreType: 'full', force: true, skipPreBackup: true }))
      .rejects.toThrow(/checksum verification failed/);
    const unsigned = JSON.parse(JSON.stringify(manifest));
    delete unsigned.verification.total_checksum;
    await writeRemoteManifest(unsigned);
    await expect(service.restore({ source: 'rsync', manifestPath: ref(), restoreType: 'full', force: true, skipPreBackup: true }))
      .rejects.toThrow(/no checksum or an invalid signature/);
    expect(dataPulls(calls)).toEqual([]);
    expect(await marker()).toBe('changed after the backup');
    expect(await stagingLeft(service)).toEqual([]);
  });

  it('refuses a signed manifest that is not an rsync mirror manifest', async () => {
    await backupToRemote();
    serveRemote([]);
    const other = JSON.parse(JSON.stringify(manifest));
    delete other.metadata.rsync_manifest_layout;
    delete other.verification.total_checksum;
    await writeRemoteManifest(backupManifest.signManifest(other));
    await expect(newService().restore({ source: 'rsync', manifestPath: ref(), restoreType: 'database', force: true, skipPreBackup: true }))
      .rejects.toThrow(/RESTORE_REMOTE_MANIFEST_UNSUPPORTED/);
  });

  it.each([
    ['a file path climbing out of the mirror', m => { m.files.manifest[0].path = '../../etc/cron.d/x'; }],
    ['an absolute file path', m => { m.files.manifest[0].path = '/etc/passwd'; }],
    ['a dump path climbing out of the mirror', m => { m.database.backup_file = 'database/../../secret.db'; }],
    ['an absolute dump path', m => { m.database.backup_file = '/var/lib/picpeak/other.db'; }],
  ])('refuses %s even in a correctly signed manifest', async (_label, mutate) => {
    await backupToRemote();
    const calls = [];
    serveRemote(calls);
    const crafted = JSON.parse(JSON.stringify(manifest));
    mutate(crafted);
    delete crafted.verification.total_checksum;
    await writeRemoteManifest(backupManifest.signManifest(crafted));
    const service = newService();
    service.tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-rsync-restore-tmp-'));
    await expect(service.restore({ source: 'rsync', manifestPath: ref(), restoreType: 'full', force: true, skipPreBackup: true }))
      .rejects.toThrow(/RESTORE_REMOTE_PATH_UNSAFE/);
    expect(dataPulls(calls)).toEqual([]);
    expect(await stagingLeft(service)).toEqual([]);
  });

  it('refuses a download larger than the free space of the staging volume', async () => {
    await backupToRemote();
    const calls = [];
    serveRemote(calls);
    jest.spyOn(require('fs').promises, 'statfs').mockResolvedValue({ bavail: 4, bsize: 1 });
    const validated = await post('/validate', { source: 'rsync', manifestPath: ref(), restoreType: 'full' });
    expect(validated.status).toBe(400);
    expect(validated.body.error).toMatch(/^RESTORE_INSUFFICIENT_SPACE: .*needs .* but only 4 Bytes are free/);
    const service = newService();
    service.tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-rsync-restore-tmp-'));
    await expect(service.restore({ source: 'rsync', manifestPath: ref(), restoreType: 'full', force: true, skipPreBackup: true }))
      .rejects.toThrow(/RESTORE_INSUFFICIENT_SPACE/);
    expect(dataPulls(calls)).toEqual([]);
    expect(await stagingLeft(service)).toEqual([]);
    expect(await marker()).toBe('changed after the backup');
  });

  it('names the files missing on the destination, changes nothing and removes staging', async () => {
    await backupToRemote();
    await fs.rm(path.join(remoteRoot, photo));
    serveRemote([]);
    const service = newService();
    service.tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-rsync-restore-tmp-'));
    await expect(service.restore({ source: 'rsync', manifestPath: ref(), restoreType: 'full', force: true, skipPreBackup: true }))
      .rejects.toThrow(new RegExp(`RESTORE_REMOTE_FILE_MISSING: 1 of 1 file\\(s\\).*${photo}`));
    expect(await marker()).toBe('changed after the backup');
    expect((await db('restore_runs').orderBy('id', 'desc').first()).status).toBe('blocked');
    expect(await stagingLeft(service)).toEqual([]);
  });

  it('reports a manifest that is no longer on the destination', async () => {
    await backupToRemote();
    await fs.rm(path.join(remoteRoot, 'manifests', manifestName));
    serveRemote([]);
    await expect(newService().restore({ source: 'rsync', manifestPath: ref(), restoreType: 'database', force: true, skipPreBackup: true }))
      .rejects.toThrow(/RESTORE_REMOTE_MANIFEST_NOT_FOUND/);
  });

  it('refuses a dump swapped on the destination by its manifest checksum', async () => {
    await backupToRemote();
    await fs.writeFile(path.join(remoteRoot, dumpRel), 'not the dump');
    serveRemote([]);
    const service = newService();
    service.tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-rsync-restore-tmp-'));
    await expect(service.restore({ source: 'rsync', manifestPath: ref(), restoreType: 'database', force: true, skipPreBackup: true }))
      .rejects.toThrow(/does not match the checksum recorded in the backup manifest/);
    expect(await stagingLeft(service)).toEqual([]);
    expect(await marker()).toBe('changed after the backup');
    expect((await db('restore_runs').orderBy('id', 'desc').first()).status).toBe('blocked');
  });

  it('verifies every downloaded media file before the database is replaced', async () => {
    await backupToRemote();
    // Same length, different bytes: only the checksum can tell.
    await fs.writeFile(path.join(remoteRoot, photo), 'PHOTO BYTES');
    serveRemote([]);
    const service = newService();
    service.tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-rsync-restore-tmp-'));
    const replay = jest.spyOn(service, 'performFullRestore');
    await expect(service.restore({ source: 'rsync', manifestPath: ref(), restoreType: 'full', force: true, skipPreBackup: true }))
      .rejects.toThrow(new RegExp(`RESTORE_REMOTE_CHECKSUM_MISMATCH: 1 of 1 file\\(s\\).*${photo}`));
    expect(replay).not.toHaveBeenCalled();
    expect(await marker()).toBe('changed after the backup');
    await expect(fs.access(path.join(process.env.STORAGE_PATH, photo))).rejects.toThrow();
    expect((await db('restore_runs').orderBy('id', 'desc').first()).status).toBe('blocked');
    expect(await stagingLeft(service)).toEqual([]);
  });

  it('refuses a media file recorded above restore_max_file_size_mb before downloading anything', async () => {
    await backupToRemote();
    const calls = [];
    serveRemote(calls);
    // About one byte; the photo is recorded at eleven.
    await db('app_settings').insert({ setting_key: 'restore_max_file_size_mb', setting_value: '0.000001', setting_type: 'restore' })
      .onConflict('setting_key').merge();
    try {
      await expect(newService().restore({ source: 'rsync', manifestPath: ref(), restoreType: 'files', force: true, skipPreBackup: true }))
        .rejects.toThrow(/Refusing events\/active\/party\/individual\/photo\.jpg: recorded at 11 bytes, above the restore size limit/);
    } finally {
      await db('app_settings').where({ setting_key: 'restore_max_file_size_mb' }).update({ setting_value: '5000' });
    }
    expect(dataPulls(calls)).toEqual([]);
  });

  it('stops a transfer that writes more than the manifest records, before any checksum runs', async () => {
    await backupToRemote();
    rsyncRestore.BUDGET_POLL_MS = 20;
    let signal;
    serveRemote([], { override: async (args, options) => {
      const filesFrom = args.find(arg => arg.startsWith('--files-from='));
      if (!filesFrom) return null;
      const list = (await fs.readFile(filesFrom.slice('--files-from='.length), 'utf8')).split('\0');
      if (!list.includes(photo)) return null;
      // A sender ignoring --max-size: far more bytes than the eleven recorded.
      signal = options.signal;
      const dest = path.join(args[args.length - 1], photo);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, Buffer.alloc(3 * 1024 * 1024));
      await new Promise((resolve) => {
        if (signal.aborted) resolve();
        signal.addEventListener('abort', resolve);
        setTimeout(resolve, 5000);
      });
      return { code: 20, stderr: 'rsync error: received SIGINT, SIGTERM, or SIGHUP (code 20)', aborted: signal.aborted };
    } });
    const service = newService();
    service.tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-rsync-restore-tmp-'));
    try {
      await expect(service.restore({ source: 'rsync', manifestPath: ref(), restoreType: 'full', force: true, skipPreBackup: true }))
        .rejects.toThrow(/RESTORE_REMOTE_DOWNLOAD_TOO_LARGE/);
    } finally { rsyncRestore.BUDGET_POLL_MS = 1000; }
    expect(signal.aborted).toBe(true);
    expect(await marker()).toBe('changed after the backup');
    expect(await stagingLeft(service)).toEqual([]);
  });

  it('reserves the per-file verified copy of the largest file, and only the dump for a database restore', async () => {
    await backupToRemote();
    serveRemote([]);
    jest.spyOn(rsyncRestore, 'sameDevice').mockResolvedValue(false);
    const sizes = manifest.files.manifest.map(entry => entry.size);
    const download = manifest.database.size + sizes.reduce((a, b) => a + b, 0);
    const statfs = jest.spyOn(require('fs').promises, 'statfs');
    statfs.mockResolvedValue({ bavail: download + Math.max(...sizes) - 1, bsize: 1 });
    const short = await post('/validate', { source: 'rsync', manifestPath: ref(), restoreType: 'full' });
    expect(short.body.error).toMatch(/^RESTORE_INSUFFICIENT_SPACE/);
    statfs.mockResolvedValue({ bavail: download + Math.max(...sizes), bsize: 1 });
    expect((await post('/validate', { source: 'rsync', manifestPath: ref(), restoreType: 'full' })).body).toMatchObject({ success: true });
    // The dump alone: replayed from the download, never copied a second time.
    statfs.mockResolvedValue({ bavail: manifest.database.size, bsize: 1 });
    expect((await post('/validate', { source: 'rsync', manifestPath: ref(), restoreType: 'database' })).body).toMatchObject({ success: true });
  });

  it('measures the space again after the safety backup, before the download starts', async () => {
    await backupToRemote();
    const calls = [];
    serveRemote(calls);
    const service = newService();
    service.tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-rsync-restore-tmp-'));
    let safetyWritten = false;
    service.createPreRestoreBackup = jest.fn(async () => {
      safetyWritten = true;
      return fs.mkdtemp(path.join(service.tempDir, 'pre-restore-'));
    });
    // Plenty of room until the safety backup has taken it.
    jest.spyOn(require('fs').promises, 'statfs').mockImplementation(async () => (safetyWritten
      ? { bavail: 4, bsize: 1 } : { bavail: 1024 * 1024 * 1024, bsize: 1 }));
    await expect(service.restore({ source: 'rsync', manifestPath: ref(), restoreType: 'full', force: true }))
      .rejects.toThrow(/RESTORE_INSUFFICIENT_SPACE/);
    expect(service.createPreRestoreBackup).toHaveBeenCalled();
    expect(dataPulls(calls)).toEqual([]);
    expect(await marker()).toBe('changed after the backup');
    expect((await db('restore_runs').orderBy('id', 'desc').first()).status).toBe('blocked');
    expect(await stagingLeft(service)).toEqual([]);
  });

  it('on an S3 primary reserves no local copy of files the adapter uploads', async () => {
    await backupToRemote();
    serveRemote([]);
    const sizes = manifest.files.manifest.map(entry => entry.size);
    const media = sizes.reduce((a, b) => a + b, 0);
    // The download plus one per-file capture, but no room for a local copy.
    jest.spyOn(require('fs').promises, 'statfs').mockResolvedValue({
      bavail: manifest.database.size + media + Math.max(...sizes), bsize: 1 });
    expect(await rsyncRestore.sameDevice(os.tmpdir(), process.env.STORAGE_PATH)).toBe(true);
    const local = await post('/validate', { source: 'rsync', manifestPath: ref(), restoreType: 'full' });
    expect(local.body.error).toMatch(/^RESTORE_INSUFFICIENT_SPACE: .*share one volume/);
    storageModule.setStorageForTesting({ kind: () => 's3' });
    expect(require('../../src/services/recoveryFiles').remoteDestination(photo)).toBe(true);
    const s3 = await post('/validate', { source: 'rsync', manifestPath: ref(), restoreType: 'full' });
    expect(s3.body).toMatchObject({ success: true });
  });

  it('needs room for the download and the restored copy when staging and storage share a volume', async () => {
    await backupToRemote();
    const calls = [];
    serveRemote(calls);
    const media = manifest.files.manifest.reduce((total, entry) => total + entry.size, 0);
    // Enough for the download alone, not for the restored files beside it.
    jest.spyOn(require('fs').promises, 'statfs').mockResolvedValue({ bavail: manifest.database.size + media + 1, bsize: 1 });
    expect(await rsyncRestore.sameDevice(os.tmpdir(), process.env.STORAGE_PATH)).toBe(true);
    const validated = await post('/validate', { source: 'rsync', manifestPath: ref(), restoreType: 'full' });
    expect(validated.status).toBe(400);
    expect(validated.body.error).toMatch(/^RESTORE_INSUFFICIENT_SPACE: .*the download plus the restored copy.*share one volume/);
    // A database restore writes no files into storage: it fits.
    const database = await post('/validate', { source: 'rsync', manifestPath: ref(), restoreType: 'database' });
    expect(database.body).toMatchObject({ success: true });
    expect(dataPulls(calls)).toEqual([]);
  });

  it('keeps restoring from a complete local copy as before', async () => {
    await backupToRemote();
    // The whole mirror copied back by hand into backup_destination_path.
    const destination = path.join(tmpDir, 'backups');
    await fs.rm(destination, { recursive: true, force: true });
    await fs.cp(remoteRoot, destination, { recursive: true });
    const calls = [];
    serveRemote(calls);
    const validated = await post('/validate', { source: 'local',
      manifestPath: path.join(destination, 'manifests', manifestName), restoreType: 'full' });
    expect(validated.body).toMatchObject({ success: true });
    expect(calls).toEqual([]);
    expect(restoreService.isRunning).toBe(false);
  });
});

describe('rsyncRestore helpers', () => {
  it.each(['events/a.jpg', 'database/picpeak-db.sqlite.gz', 'a b/ü.jpg'])('accepts the mirror path %s', (value) => {
    expect(rsyncRestore.assertMirrorRelativePath(value, 'x')).toBe(value);
  });
  it.each(['', '/etc/passwd', '../x', 'a/../b', 'a//b', './a', 'a/', 'a\nb', 7, null])('refuses the mirror path %p', (value) => {
    expect(() => rsyncRestore.assertMirrorRelativePath(value, 'x')).toThrow(/RESTORE_REMOTE_PATH_UNSAFE/);
  });
  it.each(['rsync:manifests/x.json', 'rsync:manifests/backup-manifest-../a.json', 'rsync:manifests/backup-manifest-a.json/b',
    'rsync:backup-manifest-a.json', 'rsync:manifests/backup-manifest-a.sh'])('refuses the reference %s', (value) => {
    expect(() => rsyncRestore.parseRemoteManifestRef(value)).toThrow(/RESTORE_REMOTE_MANIFEST_INVALID/);
  });
  it('refuses to decompress a dump whose expanded size exceeds the free space of the temp volume', async () => {
    const { assertDecompressSpace } = require('../../src/services/restoreService')._internal;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-decompress-space-'));
    const gz = path.join(dir, 'dump.gz');
    await fs.writeFile(gz, require('zlib').gzipSync(Buffer.alloc(64 * 1024, 'a')));
    const { size } = await fs.stat(gz);
    const statfs = jest.spyOn(require('fs').promises, 'statfs');
    // Room for the compressed file, not for what it expands to.
    statfs.mockResolvedValue({ bavail: size * 2, bsize: 1 });
    await expect(assertDecompressSpace(gz)).rejects.toThrow(/^RESTORE_INSUFFICIENT_SPACE: Decompressing the database dump needs at least 65536/);
    statfs.mockResolvedValue({ bavail: 64 * 1024, bsize: 1 });
    await expect(assertDecompressSpace(gz)).resolves.toBeUndefined();
    await fs.rm(dir, { recursive: true, force: true });
  });
  it('keeps a size the manifest does not record as unknown, so the download is bounded by the size limit instead', () => {
    const { rsyncDownloadPlan } = require('../../src/services/restoreService')._internal;
    const plan = rsyncDownloadPlan({ files: { manifest: [
      { path: 'events/a.jpg', size: null, checksum: 'a' },
      { path: 'events/b.jpg', size: 7, checksum: 'b' },
      { path: 'events/c.jpg', size: '', checksum: 'c' },
    ] } }, { restoreType: 'files' }, 100);
    expect(plan.files.map(file => file.size)).toEqual([null, 7, null]);
  });

  it('runRsync stops the child when its signal aborts and reports it', async () => {
    const { EventEmitter } = require('events');
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(),
      kill: jest.fn(() => setImmediate(() => child.emit('close', 20, null))) });
    jest.spyOn(require('child_process'), 'spawn').mockReturnValue(child);
    const controller = new AbortController();
    const running = rsyncConnection.runRsync(['--version'], { timeoutMs: 0, signal: controller.signal });
    controller.abort();
    await expect(running).resolves.toMatchObject({ code: 20, aborted: true, timedOut: false });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
  it('reads rsync settings for a boot restore from the environment only when host and path are set', () => {
    expect(rsyncRestore.rsyncConfigFromEnv({ BACKUP_RSYNC_HOST: 'h.example.com' })).toBeNull();
    expect(rsyncRestore.rsyncConfigFromEnv({ BACKUP_RSYNC_HOST: 'h.example.com', BACKUP_RSYNC_PATH: '/p',
      BACKUP_RSYNC_PORT: '23', BACKUP_RSYNC_USER: 'u1', BACKUP_RSYNC_SSH_KEY: '/keys/id' })).toEqual({
      backup_rsync_host: 'h.example.com', backup_rsync_path: '/p', backup_rsync_port: '23',
      backup_rsync_user: 'u1', backup_rsync_ssh_key: '/keys/id' });
  });
});

describe('install-from-backup boot hook', () => {
  let saved;
  beforeEach(() => { saved = { ...process.env }; });
  afterEach(() => { process.env = saved; });

  async function trigger(payload) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-boot-rsync-'));
    await fs.writeFile(path.join(root, 'RESTORE_ON_INSTALL'), payload);
    process.env.BACKUP_ROOT = root;
    return root;
  }

  it('with an `rsync` trigger pulls the newest authenticated manifest from the destination named in the environment', async () => {
    await backupToRemote();
    const calls = [];
    serveRemote(calls);
    const root = await trigger('rsync\n');
    Object.assign(process.env, { BACKUP_RSYNC_HOST: remoteTarget, BACKUP_RSYNC_PATH: remoteBase, BACKUP_RSYNC_PORT: '23' });
    process.env.INSTALL_FROM_BACKUP_FORCE = 'true';
    const startup = jest.spyOn(restoreService, 'restoreDuringStartup').mockResolvedValue({ success: true });
    const { tryInstallFromBackup } = require('../../src/services/_installFromBackupBoot');
    const result = await tryInstallFromBackup(db);
    expect(result).toEqual({ ran: true, manifestPath: ref() });
    expect(startup).toHaveBeenCalledWith(expect.objectContaining({ source: 'rsync', manifestPath: ref(), restoreType: 'full',
      rsyncConfig: expect.objectContaining({ backup_rsync_host: remoteTarget, backup_rsync_path: remoteBase, backup_rsync_port: '23' }) }));
    await expect(fs.access(path.join(root, 'RESTORE_ON_INSTALL'))).rejects.toThrow();
  });

  it('keeps the trigger and restores nothing when the environment names no destination', async () => {
    const root = await trigger('rsync');
    delete process.env.BACKUP_RSYNC_HOST;
    process.env.INSTALL_FROM_BACKUP_FORCE = 'true';
    const startup = jest.spyOn(restoreService, 'restoreDuringStartup');
    const { tryInstallFromBackup } = require('../../src/services/_installFromBackupBoot');
    const result = await tryInstallFromBackup(db);
    expect(result).toMatchObject({ ran: false, error: expect.stringMatching(/BACKUP_RSYNC_HOST/) });
    expect(startup).not.toHaveBeenCalled();
    await expect(fs.access(path.join(root, 'RESTORE_ON_INSTALL'))).resolves.toBeUndefined();
  });
});

// A real restore replaces the database and invalidates every session issued
// before it, so these run last.
describe('replaying a restore point pulled from the rsync destination', () => {
  it('database restore downloads only the dump into staging, verifies and replays it, then removes staging', async () => {
    await backupToRemote();
    const calls = [];
    serveRemote(calls);
    const service = newService();
    service.tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-rsync-restore-tmp-'));
    const realTemp = await fs.realpath(service.tempDir);
    const progress = [];
    const update = service.updateProgress.bind(service);
    service.updateProgress = (message, details) => { progress.push(message); update(message, details); };
    let stagedRoot;
    const mkdtemp = jest.spyOn(require('fs').promises, 'mkdtemp');
    const original = service.performDatabaseRestore.bind(service);
    service.performDatabaseRestore = async (backupPath, ...rest) => {
      stagedRoot = backupPath;
      expect(await fs.readFile(path.join(backupPath, dumpRel))).toBeTruthy();
      return original(backupPath, ...rest);
    };
    const result = await service.restore({ source: 'rsync', manifestPath: ref(), restoreType: 'database',
      force: true, skipPreBackup: true });
    expect(result.success).toBe(true);
    expect(await marker()).toBe('backup');
    const [pull] = dataPulls(calls);
    expect(pull.list).toEqual([dumpRel]);
    expect(pull.args[pull.args.length - 2]).toBe(`${remoteTarget}:${remoteBase}/`);
    expect(pull.args).toEqual(expect.arrayContaining(['--from0', '--times']));
    expect(stagedRoot.startsWith(`${realTemp}${path.sep}rsync-remote-`)).toBe(true);
    // The verified download is replayed in place: no second copy of the dump.
    expect(mkdtemp.mock.calls.map(([prefix]) => path.basename(prefix))).not.toContain('verified-dump-');
    expect(progress).toEqual(expect.arrayContaining([expect.stringMatching(/Downloading 1 file\(s\).*from the rsync destination/),
      'Downloading from the rsync destination: 1/1 file(s)']));
    expect(await stagingLeft(service)).toEqual([]);
    await expect(fs.access(stagedRoot)).rejects.toThrow();
  });

  it('full restore pulls the dump and the manifest files with one --files-from list and restores both', async () => {
    await backupToRemote();
    const calls = [];
    serveRemote(calls);
    const service = newService();
    service.tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-rsync-restore-tmp-'));
    const result = await service.restore({ source: 'rsync', manifestPath: ref(), restoreType: 'full',
      force: true, skipPreBackup: true });
    expect(result.success).toBe(true);
    // The dump on its own, bounded by its recorded size; then the media,
    // bounded by the largest recorded media size (under the restore limit).
    const [dumpPull, mediaPull, ...rest] = dataPulls(calls);
    expect(rest).toEqual([]);
    expect(dumpPull.list).toEqual([dumpRel]);
    expect(dumpPull.args).toContain(`--max-size=${manifest.database.size}`);
    expect(mediaPull.list).toEqual(manifest.files.manifest.map(entry => entry.path));
    expect(mediaPull.list).toContain(photo);
    expect(mediaPull.args).toContain(`--max-size=${Math.max(...manifest.files.manifest.map(entry => entry.size))}`);
    expect(await fs.readFile(path.join(process.env.STORAGE_PATH, photo), 'utf8')).toBe('photo bytes');
    expect(await marker()).toBe('backup');
    expect(await stagingLeft(service)).toEqual([]);
  });
});
