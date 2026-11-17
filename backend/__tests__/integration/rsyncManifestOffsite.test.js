'use strict';

// An rsync backup is restorable from the remote alone: each run copies its
// signed manifest to <backup_rsync_path>/manifests/ over the mirror's own
// connection, the staged dump is never filtered by the media exclude
// patterns, and a mirror copied back into backup_destination_path is found
// and accepted by the restore wizard.

process.env.DATABASE_CLIENT = 'sqlite3';
process.env.JWT_SECRET = 'rsync-manifest-offsite-test-secret';
process.env.BACKUP_MANIFEST_KEY = '5a'.repeat(32);
const fs = require('fs').promises;
const path = require('path');
const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { bootCrmDb } = require('./helpers/crmDb');

jest.setTimeout(120000);

let db; let cleanup; let tmpDir; let backup; let storageModule; let app; let superToken; let remoteListing;
const photo = 'events/active/party/individual/photo.jpg';
const remoteTarget = 'backup.example.com';

async function settings(values) {
  for (const [key, value] of Object.entries(values)) {
    await db('app_settings').insert({ setting_key: key, setting_value: JSON.stringify(value),
      setting_type: key.startsWith('database_') ? 'database_backup' : 'backup' }).onConflict('setting_key').merge();
  }
}
async function configureRsync() {
  await settings({ backup_enabled: true, backup_destination_type: 'rsync',
    backup_destination_path: path.join(tmpDir, 'backups'), backup_manifest_path: path.join(tmpDir, 'manifests'),
    backup_incremental: false, backup_database_inline_dump: true,
    database_backup_destination_path: path.join(tmpDir, 'dumps'),
    backup_email_on_success: false, backup_email_on_failure: false,
    database_backup_email_on_success: false, database_backup_email_on_failure: false,
    backup_rsync_host: remoteTarget, backup_rsync_path: '/home/picpeak',
    // Media patterns: *.gz also matches the gzip dump name.
    backup_exclude_patterns: ['*.gz', '*.tmp'] });
}

// The spawned rsync calls, each with the files its source held at the time.
async function runWithRsync(onCall = async () => ({ stdout: 'Number of files transferred: 2\nTotal file size: 30 bytes' })) {
  const calls = [];
  const network = jest.spyOn(require('../../src/utils/rsyncConnection'), 'resolveRsyncConnection')
    .mockResolvedValue({ rsyncShell: 'ssh -p 23', rsyncTarget: remoteTarget });
  const safeExec = require('../../src/utils/safeExec');
  const realSpawn = safeExec.spawnAsync;
  const spawn = jest.spyOn(safeExec, 'spawnAsync').mockImplementation(async (command, args, ...rest) => {
    // The sqlite3 dump runs for real; only rsync is the remote.
    if (command !== 'rsync') return realSpawn(command, args, ...rest);
    const call = { command, args: [...args] };
    calls.push(call);
    if (calls.length === 2) {
      const source = args[args.length - 2];
      call.sourceFiles = (await fs.readdir(source)).sort();
    }
    return onCall(calls.length, args);
  });
  try {
    await backup.runBackup(true);
  } finally { spawn.mockRestore(); network.mockRestore(); }
  return { calls, run: await db('backup_runs').orderBy('id', 'desc').first() };
}

beforeAll(async () => {
  ({ db, cleanup, tmpDir } = await bootCrmDb());
  storageModule = require('../../src/services/storage');
  backup = require('../../src/services/backupService');
  // Loaded before any spy: it binds spawnAsync at require time.
  require('../../src/services/databaseBackup');
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
  for (const dir of ['backups', 'manifests', 'dumps', 'copyback']) await fs.rm(path.join(tmpDir, dir), { recursive: true, force: true });
  await fs.rm(process.env.STORAGE_PATH, { recursive: true, force: true });
  await fs.mkdir(path.dirname(path.join(process.env.STORAGE_PATH, photo)), { recursive: true });
  await fs.writeFile(path.join(process.env.STORAGE_PATH, photo), 'photo bytes');
  await fs.mkdir(path.join(tmpDir, 'dumps'), { recursive: true });
  await configureRsync();
  // The wizard also lists the destination's own manifests
  // (rsyncRemoteRestore.test.js); nothing here reaches a remote.
  remoteListing = jest.spyOn(require('../../src/utils/rsyncRestore'), 'listRemoteManifests').mockResolvedValue([]);
});
afterEach(() => remoteListing.mockRestore());
afterAll(async () => { storageModule.resetStorage(); await cleanup(); });

it('copies the manifest to <backup_rsync_path>/manifests after the mirror, which --delete leaves alone', async () => {
  const { calls, run } = await runWithRsync();
  expect(run.status).toBe('completed');
  expect(calls).toHaveLength(2);
  const [mirror, upload] = calls.map((call) => call.args);
  // The mirror protects the manifest directory from its --delete.
  expect(mirror).toContain('--delete');
  expect(mirror[mirror.indexOf('--filter') + 1]).toBe('P /manifests/');
  expect(mirror[mirror.length - 1]).toBe(`${remoteTarget}:/home/picpeak`);
  // The manifest goes over the same vetted transport, into manifests/, and
  // is the only one kept there.
  const manifestFile = path.basename(run.manifest_path);
  expect(upload[upload.indexOf('-e') + 1]).toBe('ssh -p 23');
  expect(upload).toEqual(expect.arrayContaining(['--delete', '--delete-excluded']));
  expect(upload.slice(upload.indexOf('--include'), upload.indexOf('--include') + 4))
    .toEqual(['--include', `/${manifestFile}`, '--exclude', '*']);
  expect(upload[upload.length - 2]).toBe(`${path.dirname(run.manifest_path)}/`);
  expect(upload[upload.length - 1]).toBe(`${remoteTarget}:/home/picpeak/manifests/`);
  expect(calls[1].sourceFiles).toContain(manifestFile);
});

it('never lets an exclude pattern drop the staged dump, and records the dump where the mirror holds it', async () => {
  const { calls, run } = await runWithRsync();
  expect(run.status).toBe('completed');
  const mirror = calls[0].args;
  const latestDump = path.basename((await backup.getDatabaseBackupInfo()).backupFile);
  const dumpInclude = mirror.indexOf(`/database/${latestDump}`);
  expect(mirror[dumpInclude - 1]).toBe('--include');
  expect(mirror[mirror.indexOf('/database/') - 1]).toBe('--include');
  // rsync filters are first-match: the includes precede every exclude.
  expect(dumpInclude).toBeLessThan(mirror.indexOf('*.gz'));
  expect(mirror.indexOf('/database/')).toBeLessThan(mirror.indexOf('*.gz'));
  // ...and the earlier runs' dumps stay open to --delete despite *.gz.
  expect(mirror[mirror.indexOf('R /database/*') - 1]).toBe('--filter');
  expect(mirror.indexOf('R /database/*')).toBeLessThan(mirror.indexOf('*.gz'));
  expect(latestDump).toMatch(/\.gz$/);
  const manifest = JSON.parse(await fs.readFile(run.manifest_path, 'utf8'));
  expect(manifest.database.backup_file).toBe(`database/${latestDump}`);
  // The signed marker that lets a copy in <mirror>/manifests name its mirror.
  expect(manifest.metadata.rsync_manifest_layout).toBe('mirror-v1');
});

it('fails the run visibly when the manifest cannot be copied to the remote', async () => {
  const { calls, run } = await runWithRsync(async (n) => {
    if (n === 2) throw Object.assign(new Error('rsync exited with code 12: connection reset'), { stderr: 'connection reset' });
    return { stdout: 'Number of files transferred: 2\nTotal file size: 30 bytes' };
  });
  expect(calls).toHaveLength(2);
  expect(run).toMatchObject({ status: 'failed',
    error_message: expect.stringMatching(/manifest could not be copied to the rsync destination \(\/home\/picpeak\/manifests\/\).*connection reset/) });
});

it('restores from a mirror copied back into backup_destination_path, manifest included', async () => {
  const { run } = await runWithRsync();
  expect(run.status).toBe('completed');
  const dump = await backup.getDatabaseBackupInfo();
  // What `rsync -a storagebox:/home/picpeak/ <destination>/` brings back.
  const destination = path.join(tmpDir, 'copyback', 'picpeak');
  const copied = path.join(destination, 'manifests', path.basename(run.manifest_path));
  await fs.mkdir(path.dirname(path.join(destination, photo)), { recursive: true });
  await fs.copyFile(path.join(process.env.STORAGE_PATH, photo), path.join(destination, photo));
  await fs.mkdir(path.join(destination, 'database'), { recursive: true });
  await fs.copyFile(dump.backupFile, path.join(destination, 'database', path.basename(dump.backupFile)));
  await fs.mkdir(path.dirname(copied), { recursive: true });
  await fs.copyFile(run.manifest_path, copied);
  // The new host: nothing left of the old one but the copy and the key.
  await db('backup_runs').del();
  await fs.rm(path.join(tmpDir, 'manifests'), { recursive: true, force: true });
  await fs.rm(path.join(tmpDir, 'dumps'), { recursive: true, force: true });
  await settings({ backup_destination_path: destination, backup_manifest_path: path.join(tmpDir, 'copyback', 'manifests') });

  const listed = await request(app).post('/api/admin/restore/list-backups')
    .set('Authorization', `Bearer ${superToken}`).send({ source: 'local' });
  expect(listed.status).toBe(200);
  expect(listed.body.data).toEqual([expect.objectContaining({ path: copied, database_included: true })]);

  const validated = await request(app).post('/api/admin/restore/validate')
    .set('Authorization', `Bearer ${superToken}`)
    .send({ source: 'local', manifestPath: copied, restoreType: 'full' });
  expect(validated.body).toMatchObject({ success: true });
  expect(validated.status).toBe(200);
});

it('still finds the dump where this host wrote it for a restore from the local manifest', async () => {
  // backup_destination_path=/backup with the dumps in /backup/dumps: the
  // relative database/<file> is not there, the recorded source file is.
  await settings({ backup_destination_path: tmpDir });
  const { run } = await runWithRsync();
  expect(run.status).toBe('completed');
  const dump = await backup.getDatabaseBackupInfo();
  const manifest = JSON.parse(await fs.readFile(run.manifest_path, 'utf8'));
  expect(manifest.database.source_file).toBe(dump.backupFile);
  const { _internal } = require('../../src/services/restoreService');
  const candidates = await _internal.resolveContainedDbBackupCandidates(tmpDir, manifest.database.backup_file,
    undefined, manifest.database.source_file);
  const present = [];
  for (const candidate of candidates) if (await fs.stat(candidate).catch(() => null)) present.push(candidate);
  expect(present).toEqual([dump.backupFile]);
});

it('lists a backup found on disk once, with its history row', async () => {
  const { run } = await runWithRsync();
  expect(run.status).toBe('completed');
  expect(run.files_backed_up).toBe(2);
  const listed = await request(app).post('/api/admin/restore/list-backups')
    .set('Authorization', `Bearer ${superToken}`).send({});
  expect(listed.status).toBe(200);
  expect(listed.body.data).toEqual([expect.objectContaining({ path: run.manifest_path, manifestId: run.manifest_id,
    filesCount: 2, database_included: true })]);
});
