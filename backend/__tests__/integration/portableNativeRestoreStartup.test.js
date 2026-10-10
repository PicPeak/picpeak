'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

// A genuine fresh Node process: the server, the coordinator, the capability
// probe and the native restore below are real. It shows that a boot which
// restores from a backup, and an ordinary native restore afterwards, run as
// they did before coordinated portable restore existed: nothing registers,
// nothing is fenced, no restore workspace appears.
const linux = process.platform === 'linux' ? describe : describe.skip;

async function actualNativeStartupSmoke() {
  const assert = require('assert/strict');
  const fs = require('fs').promises;
  const os = require('os');
  const path = require('path');
  const crypto = require('crypto');
  const bcrypt = require('bcrypt');
  const { execFileSync } = require('child_process');
  const outer = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-native-startup-')));
  process.env.LOG_DIR = path.join(outer, 'logs');
  process.env.PORT = '0';
  process.env.SERVE_FRONTEND = 'false';
  process.env.STORAGE_BACKEND = 'local';
  delete process.env.INSTALL_FROM_BACKUP_FORCE;
  const { bootCrmDb } = require('./__tests__/integration/helpers/crmDb');
  const fixture = await bootCrmDb();
  const database = require('./src/database/db');
  const { db } = database;
  const work = require('./src/services/activeApplicationWork');
  const coordinator = require('./src/services/portableRestoreCoordinator');
  let server;
  let listener;
  const tuple = async () => ({
    control: await db('portable_restore_control').first(),
    instances: await db('portable_restore_instances'),
    commits: await db('portable_restore_commits'),
  });
  const untouched = async () => {
    assert.deepEqual(await tuple(), { control: undefined, instances: [], commits: [] });
    assert.equal(coordinator.isRegistered(), false);
    assert.equal(coordinator.isFenced(), false);
    assert.equal(work.isClosed(), false);
    await assert.rejects(fs.access(path.join(process.env.STORAGE_PATH, '.picpeak-maintenance')), { code: 'ENOENT' });
  };
  try {
    const backupRoot = path.join(fixture.tmpDir, 'backup');
    process.env.BACKUP_ROOT = backupRoot;
    await fs.mkdir(path.join(backupRoot, 'database'), { recursive: true });
    await fs.mkdir(path.join(backupRoot, 'manifests'), { recursive: true });
    await fs.mkdir(path.join(backupRoot, 'business-docs'), { recursive: true });
    await fs.mkdir(path.join(process.env.STORAGE_PATH, 'business-docs'), { recursive: true });
    // No SMTP/IMAP/webhook transport is configured in this owned fixture.
    await db('email_configs').delete();
    const role = await db('roles').where({ name: 'super_admin' }).first();
    const inserted = await db('admin_users').insert({ username: 'owned-native-admin',
      email: 'owned-native@example.invalid', password_hash: await bcrypt.hash('owned-native-password', 4),
      is_active: 1, must_change_password: 0, role_id: role.id }).returning('id');
    const adminId = inserted[0]?.id ?? inserted[0];
    const setting = (key, value) => db('app_settings').insert({ setting_key: key,
      setting_value: JSON.stringify(value), setting_type: 'backup' }).onConflict('setting_key').merge();
    await setting('backup_destination_path', backupRoot);
    await setting('owned_native_restore_marker', 'backup');
    const bytes = Buffer.from('ORIGINAL NATIVE BACKUP FILE');
    const liveFile = path.join(process.env.STORAGE_PATH, 'business-docs', 'native-smoke.txt');
    await fs.writeFile(liveFile, bytes);
    await fs.writeFile(path.join(backupRoot, 'business-docs', 'native-smoke.txt'), bytes);
    const dump = path.join(backupRoot, 'database', 'owned-native.db');
    execFileSync('sqlite3', [process.env.TEST_DATABASE_PATH, `.backup '${dump}'`], { timeout: 10000 });
    const manifestService = require('./src/services/backupManifest');
    const manifest = await manifestService.generateManifest({ backupType: 'full', backupPath: backupRoot,
      files: [{ path: liveFile, relativePath: 'business-docs/native-smoke.txt', size: bytes.length,
        checksum: crypto.createHash('sha256').update(bytes).digest('hex') }],
      databaseInfo: { type: 'sqlite', backupFile: dump, size: (await fs.stat(dump)).size,
        checksum: crypto.createHash('sha256').update(await fs.readFile(dump)).digest('hex'),
        rowCounts: { admin_users: { rowCount: 1 } } } });
    const manifestPath = path.join(backupRoot, 'manifests', 'backup-manifest-native-smoke.json');
    await manifestService.saveManifest(manifest, manifestPath);
    // A genuinely empty installation, not the force override, admits boot.
    await db('admin_users').where({ id: adminId }).delete();
    assert.equal(Number((await db('admin_users').count('* as n').first()).n), 0);
    await setting('owned_native_restore_marker', 'fresh-target');
    await fs.writeFile(liveFile, 'FRESH TARGET FILE');
    const trigger = path.join(backupRoot, 'RESTORE_ON_INSTALL');
    await fs.writeFile(trigger, manifestPath, { mode: 0o600 });
    await untouched();
    await coordinator.admitUpload();
    server = require('./server');
    const listen = server.listen;
    server.listen = function (...args) { listener = listen.apply(this, args); return listener; };
    // Exact constructed production startup, including the trusted boot hook.
    await server.startServer();
    assert.equal(listener?.listening, true);
    await assert.rejects(fs.access(trigger), { code: 'ENOENT' });
    assert.equal(JSON.parse((await db('app_settings').where({ setting_key: 'owned_native_restore_marker' }).first()).setting_value), 'backup');
    assert.equal(await fs.readFile(liveFile, 'utf8'), bytes.toString());
    // The boot restored a backup and registered nothing for portable restore.
    await untouched();
    await coordinator.admitUpload();
    // This Linux host can run a coordinated restore; that alone costs nothing.
    assert.deepEqual(await coordinator.capability(), { available: true, reason: null, message: null, maintenance: false, restartRequired: false });
    await untouched();
    const origin = `http://127.0.0.1:${listener.address().port}`;
    const health = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(3000) });
    assert.equal(health.status, 200);
    assert.equal('maintenance' in await health.json(), false);
    const login = await fetch(`${origin}/api/auth/admin/login`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin }, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ username: 'owned-native-admin', password: 'owned-native-password' }) });
    assert.equal(login.status, 200);
    assert.equal((await login.json()).user.id, adminId);
    // An ordinary native restore on the running server, through tracked work.
    await work.track('owned native smoke current marker', async () => {
      await setting('owned_native_restore_marker', 'ordinary-current');
      await fs.writeFile(liveFile, 'ORDINARY CURRENT FILE');
    });
    const result = await require('./src/services/restoreService').restoreService.restore({ source: 'local',
      manifestPath, restoreType: 'full', force: true, skipPreBackup: true });
    assert.equal(result.success, true);
    assert.equal(JSON.parse((await db('app_settings').where({ setting_key: 'owned_native_restore_marker' }).first()).setting_value), 'backup');
    assert.equal(await fs.readFile(liveFile, 'utf8'), bytes.toString());
    await untouched();
    await coordinator.admitUpload();
    assert.equal((await fetch(`${origin}/health`, { signal: AbortSignal.timeout(3000) })).status, 200);
    process.stdout.write('OWNED_NATIVE_STARTUP_SMOKE_PASS\n');
  } finally {
    if (server) await server.stopServer();
    else await coordinator.stop();
    await fixture.cleanup();
    await fs.rm(outer, { recursive: true, force: true });
  }
}

linux('actual coordinated native install-from-backup startup', () => {
  it('boots from a backup and restores natively exactly as before: nothing registered, fenced or created', () => {
    const env = { ...process.env, NODE_ENV: 'test', DATABASE_CLIENT: 'sqlite3', SKIP_S3_TESTS: 'true',
      JWT_SECRET: 'owned-native-startup-secret-with-sufficient-length', PICPEAK_EVIDENCE_KEY: 'c'.repeat(64) };
    for (const key of Object.keys(env)) if (/^(SMTP_|EMAIL_|IMAP_|CLAMAV_|EXTERNAL_MEDIA_|STORAGE_AUTO_IMPORT|ADMIN_PASSWORD)/.test(key)) delete env[key];
    const output = execFileSync(process.execPath, ['-e', `(${actualNativeStartupSmoke.toString()})().catch(error => {
      console.error(error.stack); process.exitCode = 1;
    });`], { cwd: path.resolve(__dirname, '../..'), env, timeout: 180000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' });
    expect(output).toContain('OWNED_NATIVE_STARTUP_SMOKE_PASS');
  }, 190000);
});
