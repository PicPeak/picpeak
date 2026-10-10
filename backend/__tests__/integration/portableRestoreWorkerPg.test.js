'use strict';

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const knex = require('knex');
const bcrypt = require('bcrypt');

// Explicit opt-in, Linux, and a newly created EMPTY disposable database only.
// The runner owns createdb/dropdb; this suite never drops a database or an
// existing table and must not be aimed at an installation or shared fixture.
const PG_URL = process.env.PICPEAK_PG_WORKER_TEST_URL;
const enabled = process.platform === 'linux' && Boolean(PG_URL);
const postgres = enabled ? describe : describe.skip;
const executeFile = promisify(execFile);

postgres('portable restore actual hard-limited PostgreSQL worker', () => {
  let db; let observer; let fixture; let operator; let exported; let operatorPermissions;
  let originalEnvironment; let importFromPicpeak; let migrationFixture;
  const changedEnvironment = ['DATABASE_CLIENT', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'STORAGE_PATH', 'TEST_DATABASE_PATH'];
  const marker = value => db('app_settings').insert({ setting_key: 'owned_pg_worker_marker',
    setting_value: JSON.stringify(value), setting_type: 'string' }).onConflict('setting_key').merge();
  const readMarker = async () => {
    const { decodeSettingValue } = require('../helpers/settingValue');
    return decodeSettingValue(db, (await db('app_settings').where({ setting_key: 'owned_pg_worker_marker' }).first()).setting_value);
  };
  const file = name => path.join(process.env.STORAGE_PATH, 'business-docs', name);

  beforeAll(async () => {
    const target = new URL(PG_URL);
    const name = decodeURIComponent(target.pathname.slice(1));
    if (!/^picpeak_owned_worker_[a-f0-9]{16}_(main|stable)$/.test(name)) {
      throw new Error('PostgreSQL worker proof requires a new picpeak_owned_worker_<16hex>_<channel> database');
    }
    originalEnvironment = Object.fromEntries(changedEnvironment.map(key => [key, process.env[key]]));
    Object.assign(process.env, { DATABASE_CLIENT: 'pg', DB_HOST: target.hostname,
      DB_PORT: target.port || '5432', DB_USER: decodeURIComponent(target.username),
      DB_PASSWORD: decodeURIComponent(target.password), DB_NAME: name });
    fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-owned-pg-worker-'));
    await fs.chmod(fixture, 0o700);
    process.env.STORAGE_PATH = path.join(fixture, 'storage');
    await fs.mkdir(process.env.STORAGE_PATH, { mode: 0o700 });
    observer = knex({ client: 'pg', connection: PG_URL });
    const actual = await observer.raw('SELECT current_database() AS name');
    expect(actual.rows[0].name).toBe(name);
    const existing = await observer('information_schema.tables').where({ table_schema: 'public' });
    if (existing.length) throw new Error('PostgreSQL worker proof refuses a nonempty public schema');
    ({ db } = require('../../src/database/db'));
    expect(db.client.config.client).toBe('pg');
    expect(db.client.config.connection.database).toBe(name);
    const { bootCrmDb, seedMinimal, assignAdminRole } = require('./helpers/crmDb');
    // Both channels expose this fixture entry point. With DATABASE_CLIENT=pg
    // it runs the actual core migration chain on the already verified PG pool.
    migrationFixture = await bootCrmDb();
    expect(migrationFixture.db).toBe(db);
    process.env.STORAGE_PATH = path.join(fixture, 'storage');
    const { adminId } = await seedMinimal(db);
    await assignAdminRole(db, adminId);
    await db.schema.createTable('owned_worker_values', table => {
      table.increments('id'); table.boolean('flag'); table.timestamp('created_at'); table.jsonb('payload');
    });
    await db('owned_worker_values').insert({ id: 41, flag: true,
      created_at: '2024-08-11T18:13:20.000Z', payload: { origin: 'pg', nested: { intact: true } } });
    await fs.mkdir(path.dirname(file('a-first.dat')), { recursive: true });
    await fs.writeFile(file('a-first.dat'), 'PG-BACKUP-FIRST');
    await fs.writeFile(file('z-second.dat'), 'PG-BACKUP-SECOND');
    await marker('pg-backup');
    exported = await require('../../src/services/picpeakExportService').createPicpeak({ includePhotos: false });
    await db('admin_users').where({ id: adminId }).update({ password_hash: await bcrypt.hash('current-operator', 4) });
    operator = await db('admin_users').where({ id: adminId }).first();
    operatorPermissions = await db('role_permissions').join('permissions', 'permissions.id', 'role_permissions.permission_id')
      .where('role_permissions.role_id', operator.role_id).pluck('permissions.name');
    ({ importFromPicpeak } = require('../../src/services/picpeakImportService'));
    expect(require('../../src/services/portableRestoreWorker').workerConfiguration()).toMatchObject({
      memoryBytes: 768 * 1024 * 1024, heap: 384,
    });
  }, 120000);

  afterAll(async () => {
    const native = require.cache[require.resolve('../../src/services/nativeProcessRunner')];
    if (native) await native.exports.stop();
    if (db) await db.destroy();
    if (observer) await observer.destroy();
    if (migrationFixture) await migrationFixture.cleanup();
    if (exported) await fs.rm(path.dirname(exported.filePath), { recursive: true, force: true });
    if (fixture) await fs.rm(fixture, { recursive: true, force: true });
    if (originalEnvironment) for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  async function assertCommitted(result, expectedFiles = 2) {
    expect(result).toMatchObject({ restored: true, outcome: 'committed', restartRequired: true, filesRestored: expectedFiles });
    const control = await observer('portable_restore_control').where({ id: 1 }).first();
    const commit = await observer('portable_restore_commits').where({ attempt_id: control.attempt_id }).first();
    expect(control.state).toBe('restart_required');
    expect(commit).toMatchObject({ attempt_id: control.attempt_id, format_version: 1 });
    expect(control.epoch).toMatch(/^[a-f0-9-]{36}$/);
    expect(commit.local_plan_checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(commit.options_digest).toMatch(/^[a-f0-9]{64}$/);
    const restoredOperator = await observer('admin_users').where({ email: operator.email }).first();
    expect(restoredOperator.password_hash).toBe(operator.password_hash);
    expect(await observer('roles').where({ id: restoredOperator.role_id }).first()).toMatchObject({ name: 'super_admin' });
    const restoredPermissions = await observer('role_permissions').join('permissions', 'permissions.id', 'role_permissions.permission_id')
      .where('role_permissions.role_id', restoredOperator.role_id).pluck('permissions.name');
    expect(restoredPermissions).toEqual(expect.arrayContaining(operatorPermissions));
    expect(restoredPermissions).not.toHaveLength(0);
    const cutoff = await observer('app_settings').where({ setting_key: 'security_sessions_valid_after' }).first();
    expect(Number(cutoff.setting_value)).toBeGreaterThan(0);
  }

  test('genuine PG export restores rows/files/operator/sequences and waits for the actual database lock', async () => {
    expect(exported.manifest.database.engine).toBe('pg');
    await marker('current-pg');
    await db('owned_worker_values').where({ id: 41 }).update({ flag: false, payload: { origin: 'current' } });
    await db.raw('SELECT setval(pg_get_serial_sequence(?, ?), 1, false)', ['owned_worker_values', 'id']);
    await fs.writeFile(file('a-first.dat'), 'PG-CURRENT-FIRST');
    await fs.writeFile(file('z-second.dat'), 'PG-CURRENT-SECOND');
    const { LOCK_CLASS, LOCK_RESOURCE } = require('../../src/services/portableRestoreDatabaseLock');
    const lock = await observer.transaction();
    await lock.raw('SELECT pg_advisory_xact_lock(?, ?)', [LOCK_CLASS, LOCK_RESOURCE]);
    let terminal;
    const restoring = importFromPicpeak({ picpeakPath: exported.filePath, currentAdminId: operator.id });
    restoring.then(value => { terminal = { value }; }, error => { terminal = { error }; });
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const pending = await observer('pg_locks').where({ locktype: 'advisory', classid: LOCK_CLASS,
          objid: LOCK_RESOURCE, objsubid: 2, granted: false }).first();
        if (pending) { waiting = true; break; }
        if (terminal) throw terminal.error || new Error('Restore finished without acquiring its database lock');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
      expect(await readMarker()).toBe('current-pg');
      expect(await fs.readFile(file('a-first.dat'), 'utf8')).toBe('PG-CURRENT-FIRST');
      expect(await fs.readFile(file('z-second.dat'), 'utf8')).toBe('PG-CURRENT-SECOND');
    } finally { await lock.commit(); }
    const result = await restoring;
    await assertCommitted(result);
    expect(result.crossEngine).toBe(false);
    expect(await readMarker()).toBe('pg-backup');
    expect(await observer('owned_worker_values').where({ id: 41 }).first()).toMatchObject({
      flag: true, payload: { origin: 'pg', nested: { intact: true } },
    });
    expect(await fs.readFile(file('a-first.dat'), 'utf8')).toBe('PG-BACKUP-FIRST');
    expect(await fs.readFile(file('z-second.dat'), 'utf8')).toBe('PG-BACKUP-SECOND');
    const [next] = await db('owned_worker_values').insert({ flag: false, payload: { natural: true } }).returning('id');
    expect(next.id).toBe(42);
  }, 120000);

  test('a pending ordinary credential and role update is preserved only after the table barrier', async () => {
    const passwordHash = await bcrypt.hash('latest-ordinary-operator', 4);
    const updating = await observer.transaction();
    let restoring;
    try {
      const previousRole = await updating('roles').where({ id: operator.role_id }).first();
      const role = { ...previousRole, name: 'owned_latest_operator' };
      delete role.id;
      const [created] = await updating('roles').insert(role).returning('id');
      const permissions = await updating('permissions').whereIn('name', operatorPermissions.slice(0, 2)).select('id', 'name');
      expect(permissions.length).toBeGreaterThan(0);
      await updating('role_permissions').insert(permissions.map(permission => ({ role_id: created.id, permission_id: permission.id })));
      await updating('admin_users').where({ id: operator.id }).update({ password_hash: passwordHash, role_id: created.id });
      const pid = (await updating.raw('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      restoring = importFromPicpeak({ picpeakPath: exported.filePath, currentAdminId: operator.id });
      let failure;
      restoring.catch(error => { failure = error; });
      let waiting = false;
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if (failure) throw failure;
        const pending = await observer.raw('SELECT pid FROM pg_stat_activity WHERE ? = ANY(pg_blocking_pids(pid))', [pid]);
        if (pending.rows.length) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
      await updating.commit();
      const result = await restoring;
      expect(result).toMatchObject({ restored: true, outcome: 'committed', restartRequired: true });
      const preserved = await observer('admin_users').where({ email: operator.email }).first();
      expect(preserved.password_hash).toBe(passwordHash);
      expect(await observer('roles').where({ id: preserved.role_id }).first()).toMatchObject({ name: 'owned_latest_operator' });
      const granted = await observer('role_permissions').join('permissions', 'permissions.id', 'role_permissions.permission_id')
        .where('role_permissions.role_id', preserved.role_id).pluck('permissions.name');
      expect(granted.sort()).toEqual(permissions.map(permission => permission.name).sort());
      // Subsequent cross-engine controls intentionally exercise the original
      // super-admin contract again, without relying on this new role fixture.
      const originalRole = await observer('roles').where({ name: 'super_admin' }).first();
      await observer('admin_users').where({ id: preserved.id }).update({ role_id: originalRole.id, password_hash: operator.password_hash });
    } finally {
      if (!updating.isCompleted()) await updating.rollback();
      if (restoring) await restoring.catch(() => {});
    }
  }, 120000);

  test('a genuine SQLite portable export traverses the same worker and preserves PG value semantics', async () => {
    const outputDirectory = path.join(fixture, 'sqlite-export');
    const source = `const fs=require('fs').promises,path=require('path');
      (async()=>{const context=await require('./__tests__/integration/helpers/crmDb').bootCrmDb();try{
        await require('./__tests__/integration/helpers/crmDb').seedMinimal(context.db);
        await context.db.schema.createTable('owned_worker_values',t=>{t.increments('id');t.boolean('flag');t.timestamp('created_at');t.json('payload')});
        await context.db('owned_worker_values').insert({id:71,flag:0,created_at:1723400000000,payload:JSON.stringify({origin:'sqlite',nested:{intact:true}})});
        await context.db('app_settings').insert({setting_key:'owned_pg_worker_marker',setting_value:JSON.stringify('sqlite-backup'),setting_type:'string'}).onConflict('setting_key').merge();
        const directory=path.join(process.env.STORAGE_PATH,'business-docs');await fs.mkdir(directory,{recursive:true});
        await fs.writeFile(path.join(directory,'a-first.dat'),'SQLITE-BACKUP-FIRST');await fs.writeFile(path.join(directory,'z-second.dat'),'SQLITE-BACKUP-SECOND');
        const exported=await require('./src/services/picpeakExportService').createPicpeak({includePhotos:false,outDir:process.argv[1]});
        process.stdout.write('OWNED_SQLITE_EXPORT:'+JSON.stringify({filePath:exported.filePath,engine:exported.manifest.database.engine})+'\\n');
      }finally{await context.cleanup()}})().catch(error=>{console.error(error);process.exitCode=1});`;
    const { stdout } = await executeFile(process.execPath, ['-e', source, outputDirectory], {
      cwd: path.resolve(__dirname, '../..'), timeout: 120000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, DATABASE_CLIENT: 'sqlite3', PICPEAK_TEST_TEMPLATE_DIR: '',
        TEST_DATABASE_PATH: path.join(fixture, 'source.db'), STORAGE_PATH: path.join(fixture, 'source-storage') },
    });
    const line = stdout.split('\n').find(value => value.startsWith('OWNED_SQLITE_EXPORT:'));
    const sourceExport = JSON.parse(line.slice('OWNED_SQLITE_EXPORT:'.length));
    expect(sourceExport.engine).toBe('sqlite');
    await marker('before-sqlite');
    await fs.writeFile(file('a-first.dat'), 'PG-BEFORE-SQLITE');
    const result = await importFromPicpeak({ picpeakPath: sourceExport.filePath, currentAdminId: operator.id });
    await assertCommitted(result);
    expect(result.crossEngine).toBe(true);
    expect(await readMarker()).toBe('sqlite-backup');
    const restored = await observer('owned_worker_values').where({ id: 71 }).first();
    expect(restored.flag).toBe(false);
    expect(restored.created_at.getTime()).toBe(1723400000000);
    expect(restored.payload).toEqual({ origin: 'sqlite', nested: { intact: true } });
    expect(await fs.readFile(file('a-first.dat'), 'utf8')).toBe('SQLITE-BACKUP-FIRST');
    expect(await fs.readFile(file('z-second.dat'), 'utf8')).toBe('SQLITE-BACKUP-SECOND');
    const [next] = await db('owned_worker_values').insert({ flag: true }).returning('id');
    expect(next.id).toBe(72);
  }, 120000);
});
