'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

// A genuine fresh Node process does not inherit jest.setup's unstarted-server
// fixture authority. The server, coordinator, ingress, native lease and restore
// body below are real. Linux is the supported lifetime-proof production target.
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
  const leaseService = require('./src/services/linuxKernelLease');
  let server;
  let listener;
  let phase = 'startup';
  let startupTuple;
  let faultCount = 0;
  let lateStartupChecks = 0;
  const startupReadiness = [];
  const replacementErrors = [];
  const originalReinit = database.reinitPool;
  const tuple = () => work.runControl(async () => ({
    control: await db('portable_restore_control').where({ id: 1 }).first(),
    instances: await db('portable_restore_instances').orderBy('instance_id'),
    commits: await db('portable_restore_commits').orderBy('attempt_id'),
  }));
  function observeRestoredPool(client) {
    client.on('query-response', (_result, query) => {
      if (phase === 'startup' && /^update .*restore_runs/i.test(query.sql)
        && query.bindings.includes('completed')) {
        // This real late native write is after target metadata replay but
        // before boot returns and startServer performs its explicit markReady.
        lateStartupChecks++;
        startupReadiness.push(assert.rejects(coordinator.admitUpload(), { code: 'RESTORE_MAINTENANCE' }));
      }
    });
  }
  function observeActualPoolDestruction(client) {
    const destroy = client.destroy;
    let armed = true;
    client.destroy = async function (...args) {
      if (armed && phase === 'startup') startupTuple = await tuple();
      const result = await destroy.apply(this, args);
      if (armed) {
        armed = false;
        // Forward the actual destroy first: no fabricated SQL rejection and
        // no replacement of restore/coordinator/ingress. Its real dead pool
        // forces the polling path's connection-acquisition error deterministically.
        await assert.rejects(db.raw('SELECT 1'), error => {
          replacementErrors.push(error.message);
          return /Unable to acquire a connection|destroyed/i.test(error.message);
        });
        await coordinator.tick();
        await coordinator.tick();
        assert.equal(work.isClosed(), true);
        await assert.rejects(coordinator.admitUpload(), { code: 'RESTORE_MAINTENANCE' });
        faultCount++;
      }
      return result;
    };
  }
  database.reinitPool = async function (...args) {
    const result = await originalReinit.apply(this, args);
    observeRestoredPool(db.client);
    return result;
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
    assert.equal(await db('portable_restore_control').first(), undefined);
    await assert.rejects(coordinator.admitUpload(), { code: 'RESTORE_MAINTENANCE' });
    observeActualPoolDestruction(db.client);
    server = require('./server');
    const listen = server.listen;
    server.listen = function (...args) { listener = listen.apply(this, args); return listener; };
    // Exact constructed production startup, including the trusted boot hook.
    await server.startServer();
    await Promise.all(startupReadiness);
    assert.equal(faultCount, 1);
    assert.equal(lateStartupChecks, 1);
    assert.equal(listener?.listening, true);
    await assert.rejects(fs.access(trigger), { code: 'ENOENT' });
    assert.deepEqual(await tuple(), startupTuple);
    assert.equal(JSON.parse((await db('app_settings').where({ setting_key: 'owned_native_restore_marker' }).first()).setting_value), 'backup');
    assert.equal(await fs.readFile(liveFile, 'utf8'), bytes.toString());
    const own = (await tuple()).instances.find(row => row.instance_id === coordinator.instanceId());
    const lease = JSON.parse(own.lease_json);
    assert.equal(await leaseService.probe(lease.path, lease), 'busy');
    assert.equal(work.isClosed(), false);
    await coordinator.admitUpload();
    const origin = `http://127.0.0.1:${listener.address().port}`;
    const health = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(3000) });
    assert.equal(health.status, 200);
    const login = await fetch(`${origin}/api/auth/admin/login`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin }, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ username: 'owned-native-admin', password: 'owned-native-password' }) });
    assert.equal(login.status, 200);
    assert.equal((await login.json()).user.id, adminId);
    // Repeat through ordinary ready native admission, not a boot capability.
    phase = 'ordinary';
    const before = await tuple();
    await work.track('owned native smoke current marker', async () => {
      await setting('owned_native_restore_marker', 'ordinary-current');
      await fs.writeFile(liveFile, 'ORDINARY CURRENT FILE');
    });
    observeActualPoolDestruction(db.client);
    const result = await require('./src/services/restoreService').restoreService.restore({ source: 'local',
      manifestPath, restoreType: 'full', force: true, skipPreBackup: true });
    assert.equal(result.success, true);
    assert.equal(faultCount, 2);
    assert.equal(replacementErrors.length, 2);
    assert.deepEqual(await tuple(), before);
    assert.equal(JSON.parse((await db('app_settings').where({ setting_key: 'owned_native_restore_marker' }).first()).setting_value), 'backup');
    assert.equal(await fs.readFile(liveFile, 'utf8'), bytes.toString());
    assert.equal(await leaseService.probe(lease.path, lease), 'busy');
    assert.equal(work.isClosed(), false);
    await coordinator.admitUpload();
    assert.equal((await fetch(`${origin}/health`, { signal: AbortSignal.timeout(3000) })).status, 200);
    process.stdout.write('OWNED_NATIVE_STARTUP_SMOKE_PASS\n');
  } finally {
    database.reinitPool = originalReinit;
    if (server) await server.stopServer();
    else await coordinator.stop();
    await fixture.cleanup();
    await fs.rm(outer, { recursive: true, force: true });
  }
}

linux('actual coordinated native install-from-backup startup', () => {
  it('preserves target runtime identity and recovers real pool-read pauses without granting early boot readiness', () => {
    const env = { ...process.env, NODE_ENV: 'test', DATABASE_CLIENT: 'sqlite3', SKIP_S3_TESTS: 'true',
      JWT_SECRET: 'owned-native-startup-secret-with-sufficient-length', PICPEAK_EVIDENCE_KEY: 'c'.repeat(64) };
    for (const key of Object.keys(env)) if (/^(SMTP_|EMAIL_|IMAP_|CLAMAV_|EXTERNAL_MEDIA_|STORAGE_AUTO_IMPORT|ADMIN_PASSWORD)/.test(key)) delete env[key];
    const output = execFileSync(process.execPath, ['-e', `(${actualNativeStartupSmoke.toString()})().catch(error => {
      console.error(error.stack); process.exitCode = 1;
    });`], { cwd: path.resolve(__dirname, '../..'), env, timeout: 180000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' });
    expect(output).toContain('OWNED_NATIVE_STARTUP_SMOKE_PASS');
  }, 190000);
});
