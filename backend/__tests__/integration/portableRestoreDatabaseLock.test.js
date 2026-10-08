'use strict';

const knex = require('knex');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { acquireRestoreDatabaseLock, LOCK_CLASS, LOCK_RESOURCE } = require('../../src/services/portableRestoreDatabaseLock');

const attemptId = crypto.randomUUID();
const epoch = crypto.randomUUID();
const identity = { attemptId, epoch };

async function schema(db) {
  await db.schema.createTable('portable_restore_control', table => {
    table.integer('id').primary(); table.string('attempt_id'); table.string('epoch'); table.string('state'); table.integer('revision');
  });
  await db.schema.createTable('owned_commit_marker', table => { table.string('attempt_id').primary(); });
  await db('portable_restore_control').insert({ id: 1, attempt_id: attemptId, epoch, state: 'restoring', revision: 7 });
}

describe('portable SQLite server-side recovery lock', () => {
  let fixture; let db; let other;
  beforeEach(async () => {
    fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-owned-db-lock-'));
    const config = { client: 'sqlite3', connection: { filename: path.join(fixture, 'owned.db') }, useNullAsDefault: true };
    db = knex(config); other = knex(config);
    await schema(db);
  });
  afterEach(async () => { await db.destroy(); await other.destroy(); await fs.rm(fixture, { recursive: true, force: true }); });

  test('requires a transaction and a current durable fenced epoch without changing its revision', async () => {
    await expect(acquireRestoreDatabaseLock(db, identity)).rejects.toThrow('transaction');
    await expect(db.transaction(trx => acquireRestoreDatabaseLock(trx, { ...identity, epoch: crypto.randomUUID() }))).rejects.toMatchObject({ code: 'RESTORE_EPOCH_CHANGED' });
    await db.transaction(trx => acquireRestoreDatabaseLock(trx, identity));
    expect((await db('portable_restore_control').first()).revision).toBe(7);
  });
  test('recovery observes the marker only after the actual previous transaction terminates', async () => {
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    let entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const previous = db.transaction(async trx => {
      await acquireRestoreDatabaseLock(trx, identity);
      await trx('owned_commit_marker').insert({ attempt_id: attemptId });
      entered();
      await barrier;
    });
    await ready;
    expect(await other('owned_commit_marker').first()).toBeUndefined();
    let acquired = false;
    const recovery = other.transaction(async trx => {
      await acquireRestoreDatabaseLock(trx, identity);
      acquired = true;
      return trx('owned_commit_marker').first();
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(acquired).toBe(false);
    release(); await previous;
    expect(await recovery).toEqual({ attempt_id: attemptId });
  });
});

const postgres = process.env.PICPEAK_PG_TEST_URL ? describe : describe.skip;
postgres('portable PostgreSQL remote COMMIT uncertainty', () => {
  let db; let other; let schemaName; let child;
  beforeEach(async () => {
    schemaName = `owned_restore_${crypto.randomBytes(8).toString('hex')}`;
    db = knex({ client: 'pg', connection: process.env.PICPEAK_PG_TEST_URL, searchPath: [schemaName] });
    other = knex({ client: 'pg', connection: process.env.PICPEAK_PG_TEST_URL, searchPath: [schemaName] });
    await db.schema.createSchema(schemaName);
    await schema(db);
  });
  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await db.schema.dropSchemaIfExists(schemaName, true);
    await db.destroy(); await other.destroy(); child = null;
  });
  test('SIGKILL after a sent COMMIT is not absence proof: recovery waits and reads its eventual marker', async () => {
    const script = `const {Client}=require(process.argv[1]);
      (async()=>{const c=new Client({connectionString:process.env.PICPEAK_PG_TEST_URL,application_name:process.env.OWNED_RESTORE_CLIENT});await c.connect();
        await c.query('SET search_path TO '+process.env.OWNED_RESTORE_SCHEMA);
        await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock($1,$2)',[${LOCK_CLASS},${LOCK_RESOURCE}]);
        await c.query('UPDATE portable_restore_control SET revision=revision WHERE id=1');
        await c.query('INSERT INTO owned_commit_marker(attempt_id) VALUES($1)',[process.env.OWNED_RESTORE_ATTEMPT]);
        console.log('ready');await c.query('SELECT pg_sleep(1); COMMIT');await c.end();})().catch(e=>{console.error(e);process.exit(1)});`;
    const name = `owned-restore-client-${crypto.randomUUID()}`;
    child = spawn(process.execPath, ['-e', script, require.resolve('pg')], {
      env: { ...process.env, OWNED_RESTORE_CLIENT: name, OWNED_RESTORE_SCHEMA: schemaName, OWNED_RESTORE_ATTEMPT: attemptId },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let errors = ''; child.stderr.on('data', bytes => { errors += bytes.toString(); });
    const exited = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
    let sleeping = false;
    for (let tries = 0; tries < 200; tries++) {
      const activity = await other('pg_stat_activity').where({ application_name: name }).first('wait_event', 'query');
      if (activity?.wait_event === 'PgSleep' && activity.query.includes('COMMIT')) { sleeping = true; break; }
      if (child.exitCode !== null || child.signalCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(sleeping).toBe(true);
    child.kill('SIGKILL');
    expect(await exited).toEqual({ code: null, signal: 'SIGKILL' });
    expect(errors).toBe('');
    // This is the old unsafe recovery decision: client is already dead but
    // the database has not yet completed the previously sent COMMIT.
    expect(await other('owned_commit_marker').first()).toBeUndefined();
    const started = Date.now();
    const marker = await other.transaction(async trx => {
      await acquireRestoreDatabaseLock(trx, identity);
      return trx('owned_commit_marker').first();
    });
    expect(Date.now() - started).toBeGreaterThan(100);
    expect(marker).toEqual({ attempt_id: attemptId });
    expect((await other('portable_restore_control').first()).revision).toBe(7);
  });
});
