/**
 * Shared pieces of the PostgreSQL lock-order suites (issue 2108): a migrated
 * schema of its own, waiting until a promise is parked on a row lock, and
 * transactions a test holds open between two statements.
 *
 * Call bootPgSchema before requiring any service: it points knexfile at the
 * schema and boots the db module there.
 */
const knex = require('knex');
const { randomUUID } = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

async function bootPgSchema(pgUrl, prefix) {
  const schema = `${prefix}_${randomUUID().replace(/-/g, '')}`;
  const owner = knex({ client: 'pg', connection: pgUrl });
  await owner.schema.createSchema(schema);
  const previousClient = process.env.DATABASE_CLIENT;
  process.env.DATABASE_CLIENT = 'pg';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'lock-order-pg-test-secret-at-least-32-characters';
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `picpeak-${prefix}-`));
  process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
  jest.doMock('../../../knexfile', () => ({ client: 'pg', connection: pgUrl, searchPath: [schema] }));
  const { db } = require('../../../src/database/db');
  const { cleanup } = await require('./crmDb').bootCrmDb();

  const teardown = async () => {
    await require('../../../src/services/serviceShutdown').stopServices().catch(() => {});
    if (cleanup) await cleanup(); else await db.destroy();
    await owner.schema.dropSchema(schema, true);
    await owner.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true });
    if (previousClient === undefined) delete process.env.DATABASE_CLIENT; else process.env.DATABASE_CLIENT = previousClient;
    jest.dontMock('../../../knexfile');
  };
  return { owner, db, schema, teardown };
}

/**
 * Resolves once `promise` is waiting on a lock (not merely slow), and fails
 * if it settles first. Counts lock waits across the database: these suites
 * expect a PostgreSQL of their own, as the other *.pg suites do.
 */
async function blockedOnLock(owner, promise) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < 100; i += 1) {
    if (settled) throw new Error('expected to wait on a lock, but it finished');
    const { rows } = await owner.raw(
      'select count(*)::int as n from pg_stat_activity where wait_event_type = \'Lock\' and datname = current_database()',
    );
    if (rows[0].n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('never observed a lock wait');
}

/**
 * A transaction that runs `first`, waits until the test releases it, then runs
 * `then` and commits. `locked` resolves once `first` is done. Every release is
 * pushed to `held`, so an afterEach can let go of a test that failed early.
 */
function heldTransaction(db, held, first, then) {
  let release;
  let markLocked;
  const gate = new Promise((resolve) => { release = resolve; held.push(resolve); });
  const locked = new Promise((resolve) => { markLocked = resolve; });
  const done = db.transaction(async (trx) => {
    await first(trx);
    markLocked();
    await gate;
    if (then) await then(trx);
  });
  // Surfaces a failure of `first` instead of a hang on `locked`.
  done.catch(() => markLocked());
  return { locked, release, done };
}

async function seedEvent(db, extra = {}) {
  const slug = `lock-${randomUUID().slice(0, 8)}`;
  const [row] = await db('events').insert({
    slug,
    event_type: 'wedding',
    event_name: slug,
    event_date: '2026-01-01',
    host_email: 'h@example.com',
    admin_email: 'a@example.com',
    password_hash: 'x',
    share_link: `${slug}-share`,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    ...extra,
  }).returning('id');
  return typeof row === 'object' ? row.id : row;
}

async function seedPhoto(db, eventId, extra = {}) {
  const [row] = await db('photos').insert({
    event_id: eventId,
    filename: `${randomUUID().slice(0, 8)}.jpg`,
    path: '/tmp/p.jpg',
    type: 'individual',
    width: 1920,
    height: 1440,
    processing_status: 'complete',
    ...extra,
  }).returning('id');
  return typeof row === 'object' ? row.id : row;
}

module.exports = { bootPgSchema, blockedOnLock, heldTransaction, seedEvent, seedPhoto };
