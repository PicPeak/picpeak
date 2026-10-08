'use strict';

const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const knex = require('knex');
const lease = require('../../src/services/linuxKernelLease');
const { acquireRestoreDatabaseLock, acquireRestoreTableLocks } = require('../../src/services/portableRestoreDatabaseLock');

// Explicit opt-in to a NEW empty database created by the fixture runner. Never
// aim this proof at an installation or the existing shared lock fixture.
const PG_URL = process.env.PICPEAK_PG_BARRIER_TEST_URL;
const postgres = process.platform === 'linux' && PG_URL ? describe : describe.skip;

postgres('portable PostgreSQL ordinary-transaction terminal barrier', () => {
  let db; let observer; let fixture; let child; let initialized = false;
  const identity = { attemptId: crypto.randomUUID(), epoch: crypto.randomUUID() };
  const tables = ['owned_business_rows', 'storage_s3_generation_index', 'media_process_attempts'];
  const pause = () => new Promise(resolve => setTimeout(resolve, 10));

  async function eventually(check, description) {
    for (let tries = 0; tries < 600; tries++) {
      const result = await check();
      if (result) return result;
      await pause();
    }
    throw new Error(`Owned PostgreSQL proof did not observe ${description}`);
  }

  beforeAll(async () => {
    const name = decodeURIComponent(new URL(PG_URL).pathname.slice(1));
    if (!/^picpeak_owned_barrier_[a-f0-9]{16}_(main|stable)$/.test(name)) {
      throw new Error('PostgreSQL barrier proof requires a new picpeak_owned_barrier_<16hex>_<channel> database');
    }
    db = knex({ client: 'pg', connection: PG_URL });
    observer = knex({ client: 'pg', connection: PG_URL });
    expect((await observer.raw('SELECT current_database() AS name')).rows[0].name).toBe(name);
    if ((await observer('information_schema.tables').where({ table_schema: 'public' })).length) {
      throw new Error('PostgreSQL barrier proof refuses a nonempty public schema');
    }
    fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-owned-pg-barrier-'));
    await fs.chmod(fixture, 0o700);
    await db.schema.createTable('portable_restore_control', table => {
      table.integer('id').primary(); table.string('attempt_id'); table.string('epoch'); table.string('state'); table.integer('revision');
    });
    for (const tableName of tables) await db.schema.createTable(tableName, table => { table.integer('id').primary(); table.string('value'); });
    await db('portable_restore_control').insert({ id: 1, attempt_id: identity.attemptId, epoch: identity.epoch, state: 'restoring', revision: 7 });
    initialized = true;
  });

  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    child = null;
    // This can wait for the real server-side transaction; do not mistake the
    // already-dead client for its terminal outcome even in fixture cleanup.
    if (initialized) for (const tableName of tables) await db(tableName).del();
  });

  afterAll(async () => {
    if (db) await db.destroy();
    if (observer) await observer.destroy();
    if (fixture) await fs.rm(fixture, { recursive: true, force: true });
  });

  async function killOrdinaryClientDuringSentCommit(tableName) {
    const name = `owned-ordinary-client-${crypto.randomUUID()}`;
    const leasePath = path.join(fixture, `${crypto.randomUUID()}.lease`);
    // No restore advisory/control lock: this is an ordinary application
    // transaction. The real kernel lease models its runtime lifetime.
    const script = `const {Client}=require(process.argv[1]); const lease=require(process.argv[2]);
      (async()=>{const lifetime=await lease.acquire(process.env.OWNED_BARRIER_LEASE);
        const c=new Client({connectionString:process.env.PICPEAK_PG_BARRIER_TEST_URL,application_name:process.env.OWNED_BARRIER_CLIENT});await c.connect();
        await c.query('BEGIN');await c.query('INSERT INTO "'+process.env.OWNED_BARRIER_TABLE+'"(id,value) VALUES(1,$1)',['old-runtime']);
        process.stdout.write(JSON.stringify(lifetime)+'\\n');await c.query('SELECT pg_sleep(3); COMMIT');
        await lifetime.release();await c.end();})().catch(e=>{console.error(e);process.exit(1)});`;
    child = spawn(process.execPath, ['-e', script, require.resolve('pg'), require.resolve('../../src/services/linuxKernelLease')], {
      env: { ...process.env, OWNED_BARRIER_CLIENT: name, OWNED_BARRIER_LEASE: leasePath, OWNED_BARRIER_TABLE: tableName },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = ''; let errors = '';
    child.stdout.on('data', bytes => { output += bytes.toString(); });
    child.stderr.on('data', bytes => { errors += bytes.toString(); });
    const exited = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
    const activity = await eventually(async () => {
      const row = await observer('pg_stat_activity').where({ application_name: name }).first('pid', 'wait_event', 'query');
      return row?.wait_event === 'PgSleep' && row.query.includes('COMMIT') ? row : false;
    }, 'an actual active sleep+COMMIT request');
    const descriptor = JSON.parse(output.trim());
    expect(await lease.probe(leasePath, descriptor)).toBe('busy');
    child.kill('SIGKILL');
    expect(await exited).toEqual({ code: null, signal: 'SIGKILL' });
    expect(errors).toBe('');
    expect(await lease.probe(leasePath, descriptor)).toBe('free');
    expect(await observer(tableName).first()).toBeUndefined();
    return { name, pid: activity.pid, descriptor };
  }

  test('unprotected READ COMMITTED deletion can finish before the dead ordinary client commits', async () => {
    const { name } = await killOrdinaryClientDuringSentCommit('owned_business_rows');
    const removed = await db.transaction(async trx => {
      await acquireRestoreDatabaseLock(trx, identity);
      return trx('owned_business_rows').del();
    });
    expect(removed).toBe(0);
    expect((await observer('pg_stat_activity').where({ application_name: name }).first()).wait_event).toBe('PgSleep');
    await eventually(async () => (await observer('owned_business_rows').first())?.value === 'old-runtime', 'the old server COMMIT resurrecting its row');
    expect(await observer('owned_business_rows').first()).toEqual({ id: 1, value: 'old-runtime' });
  });

  test.each(tables)('the table barrier waits for an ordinary remote COMMIT touching %s before replacement or recovery', async tableName => {
    const { pid } = await killOrdinaryClientDuringSentCommit(tableName);
    let acquired = false;
    const replacing = db.transaction(async trx => {
      await acquireRestoreDatabaseLock(trx, identity);
      await acquireRestoreTableLocks(trx);
      acquired = true;
      // The post-lock READ COMMITTED statement sees the previous transaction's
      // eventual row. Recovery marker/file decisions likewise start only now.
      const previous = await trx(tableName).first();
      expect(previous).toEqual({ id: 1, value: 'old-runtime' });
      await trx(tableName).del();
      await trx(tableName).insert({ id: 2, value: 'restored' });
    });
    // Consume errors immediately so a failed helper cannot be an unhandled
    // rejection while the independent observer checks the real blocking lock.
    let failure;
    replacing.catch(error => { failure = error; });
    try {
      await eventually(async () => {
        if (failure) throw failure;
        const result = await observer.raw('SELECT pid FROM pg_stat_activity WHERE ? = ANY(pg_blocking_pids(pid))', [pid]);
        return result.rows.length > 0;
      }, 'the barrier waiting on the dead client\'s actual database transaction');
      expect(acquired).toBe(false);
      await replacing;
      expect(acquired).toBe(true);
      expect(await observer(tableName).select('*')).toEqual([{ id: 2, value: 'restored' }]);
    } finally { await replacing; }
  });

  test('the lock census includes all target tables and keeps every lock until the held transaction ends', async () => {
    const trx = await db.transaction();
    try {
      await acquireRestoreDatabaseLock(trx, identity);
      const locked = await acquireRestoreTableLocks(trx);
      expect(locked).toEqual(['media_process_attempts', 'owned_business_rows', 'portable_restore_control', 'storage_s3_generation_index']);
      const ownLocks = await trx.raw(`SELECT c.relname FROM pg_locks l
        JOIN pg_class c ON c.oid=l.relation JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE l.pid=pg_backend_pid() AND n.nspname=? AND l.mode=? AND l.granted ORDER BY c.relname`, ['public', 'AccessExclusiveLock']);
      expect(ownLocks.rows.map(row => row.relname)).toEqual(locked);
      // No lock is released on helper return, and no runtime table is omitted.
      const access = observer('storage_s3_generation_index').insert({ id: 9, value: 'after-release' });
      let finished = false;
      const inserting = access.then(() => { finished = true; });
      const pid = (await trx.raw('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await eventually(async () => (await trx.raw('SELECT pid FROM pg_stat_activity WHERE ? = ANY(pg_blocking_pids(pid))', [pid])).rows.length > 0, 'an ordinary runtime write blocked by the held barrier');
      expect(finished).toBe(false);
      await trx.commit();
      await inserting;
      expect(await observer('storage_s3_generation_index').first()).toEqual({ id: 9, value: 'after-release' });
    } finally { if (!trx.isCompleted()) await trx.rollback(); }
  });

  test('stale-snapshot isolation is refused while explicit READ COMMITTED remains supported', async () => {
    await expect(db.transaction(async trx => {
      await acquireRestoreDatabaseLock(trx, identity);
      await acquireRestoreTableLocks(trx);
    }, { isolationLevel: 'repeatable read' })).rejects.toMatchObject({ code: 'RESTORE_ISOLATION_UNSUPPORTED' });
    await expect(db.transaction(async trx => {
      await acquireRestoreDatabaseLock(trx, identity);
      return acquireRestoreTableLocks(trx);
    }, { isolationLevel: 'read committed' })).resolves.toContain('storage_s3_generation_index');
  });

  test('table names containing quotes are identifiers rather than executable SQL', async () => {
    const tableName = 'owned_quoted"table';
    await db.schema.createTable(tableName, table => { table.integer('id').primary(); });
    try {
      await db.transaction(async trx => {
        await acquireRestoreDatabaseLock(trx, identity);
        expect(await acquireRestoreTableLocks(trx)).toContain(tableName);
        await trx(tableName).insert({ id: 1 });
      });
      expect(await observer(tableName).first()).toEqual({ id: 1 });
    } finally { await db.schema.dropTable(tableName); }
  });
});
