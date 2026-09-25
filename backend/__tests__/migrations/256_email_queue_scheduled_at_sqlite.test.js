/**
 * Migration 256: the email queue's stuck rows come due on SQLite (issue 1670).
 *
 * The processor binds a Date, which the sqlite3 driver stores as epoch
 * milliseconds, and compares `scheduled_at <= ?`. A row left to the column
 * default holds CURRENT_TIMESTAMP's text, and SQLite orders every number
 * below every text — so it was never due. The due predicate is exercised
 * here with a plain number as the bind: a Date object would bind as the
 * literal "[object Object]" under Jest (see CLAUDE.md) and make TEXT <= TEXT
 * trivially true, which is exactly how this went unnoticed.
 */
const knex = require('knex');
const migration = require('../../migrations/core/256_email_queue_scheduled_at_sqlite');

const HOUR = 3600 * 1000;

// The table as db.js creates it on a fresh install: both columns default to
// CURRENT_TIMESTAMP.
async function createQueue(db) {
  await db.schema.createTable('email_queue', (t) => {
    t.increments('id').primary();
    t.string('recipient_email').notNullable();
    t.string('email_type').notNullable();
    t.string('status').defaultTo('pending');
    t.datetime('created_at').defaultTo(db.fn.now());
    t.datetime('scheduled_at').defaultTo(db.fn.now());
    t.datetime('sent_at');
    t.text('error_message');
    t.integer('retry_count').defaultTo(0);
  });
}

// emailProcessor.js:1277-1296, with the bind the driver produces in production.
const due = (db, nowMs) => db('email_queue')
  .where('status', 'pending').where('retry_count', '<', 3)
  .andWhere(function () { this.whereNull('scheduled_at').orWhere('scheduled_at', '<=', nowMs); })
  .orderByRaw('COALESCE(scheduled_at, created_at) ASC').orderBy('id', 'asc');

const shapes = (db) => db('email_queue')
  .select('email_type', 'status', 'error_message', 'scheduled_at', 'created_at',
    db.raw('typeof(scheduled_at) as scheduled_type'), db.raw('typeof(created_at) as created_type'))
  .orderBy('id');

const sqliteText = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

describe('migration 256 on SQLite', () => {
  let db;
  const now = Date.now();

  beforeEach(async () => {
    db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await createQueue(db);
    // One insert per row: a multi-row knex insert fills missing keys with
    // NULL on SQLite (useNullAsDefault), which would drop the status default.
    const pending = { recipient_email: 'a@b.c', status: 'pending', retry_count: 0 };
    for (const row of [
      // left to the default a minute ago: the shape every ordinary queueEmail
      // call produced. Stored as text.
      { ...pending, email_type: 'fresh_default', scheduled_at: sqliteText(now - 60e3), created_at: sqliteText(now - 60e3) },
      // the same, but waiting since last month
      { ...pending, email_type: 'stale_default', scheduled_at: sqliteText(now - 30 * 24 * HOUR), created_at: sqliteText(now - 30 * 24 * HOUR) },
      // an ISO string, the shape a manual message writes into created_at
      { ...pending, email_type: 'iso_sent', status: 'sent', scheduled_at: new Date(now - 2 * HOUR).toISOString(), created_at: new Date(now - 2 * HOUR).toISOString() },
      // a newsletter row: already milliseconds, an hour in the future
      { ...pending, email_type: 'ms_future', scheduled_at: now + HOUR, created_at: now },
      // a millisecond row that was due for a week and stayed pending — SMTP
      // was down. Not this migration's to touch.
      { ...pending, email_type: 'ms_stuck_elsewhere', scheduled_at: now - 7 * 24 * HOUR, created_at: now - 7 * 24 * HOUR },
      // a text value strftime cannot read
      { ...pending, email_type: 'garbage', scheduled_at: 'not a date', created_at: now },
      // NULL: the explicit shape the writers store now
      { ...pending, email_type: 'null_now', scheduled_at: null, created_at: now },
    ]) await db('email_queue').insert(row);
  });

  afterEach(() => db.destroy());

  test('the precondition: a default-shaped row is text and is not due, whatever its age', async () => {
    const before = await due(db, now);
    expect(before.map((r) => r.email_type)).toEqual(['ms_stuck_elsewhere', 'null_now']);
    const rows = await shapes(db);
    expect(rows.find((r) => r.email_type === 'fresh_default').scheduled_type).toBe('text');
  });

  test('turns every text timestamp into milliseconds and leaves numbers alone', async () => {
    await migration.up(db);
    const rows = await shapes(db);
    for (const row of rows) {
      expect(['integer', 'null']).toContain(row.scheduled_type);
      expect(row.created_type).toBe('integer');
    }
    const fresh = rows.find((r) => r.email_type === 'fresh_default');
    expect(Math.abs(fresh.scheduled_at - (now - 60e3))).toBeLessThan(1000);
    expect(rows.find((r) => r.email_type === 'ms_future').scheduled_at).toBe(now + HOUR);
    const iso = rows.find((r) => r.email_type === 'iso_sent');
    expect(Math.abs(iso.created_at - (now - 2 * HOUR))).toBeLessThan(1000);
  });

  test('a fresh stuck row goes out on the next run; a stale one is parked as failed, with a reason', async () => {
    await migration.up(db);
    const after = await due(db, now);
    // Oldest effective time first: a NULL schedule counts from created_at.
    expect(after.map((r) => r.email_type)).toEqual(['ms_stuck_elsewhere', 'fresh_default', 'garbage', 'null_now']);

    const stale = (await shapes(db)).find((r) => r.email_type === 'stale_default');
    expect(stale.status).toBe('failed');
    expect(stale.error_message).toBe(migration.STALE_MESSAGE);
    // The retry route (adminSystemHealth) sets status back to pending and
    // scheduled_at to NULL, so a parked row is one click from sending.
  });

  test('does not park a millisecond row that was due and unsent for another reason', async () => {
    await migration.up(db);
    const stuck = (await shapes(db)).find((r) => r.email_type === 'ms_stuck_elsewhere');
    expect(stuck.status).toBe('pending');
    expect(stuck.error_message).toBeNull();
  });

  test('an unreadable text value becomes NULL, which is due', async () => {
    await migration.up(db);
    const garbage = (await shapes(db)).find((r) => r.email_type === 'garbage');
    expect(garbage.scheduled_type).toBe('null');
  });

  test('is idempotent', async () => {
    await migration.up(db);
    const once = await shapes(db);
    await migration.up(db);
    expect(await shapes(db)).toEqual(once);
  });

  test('is a no-op without the table', async () => {
    const empty = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    try {
      await expect(migration.up(empty)).resolves.toBeUndefined();
    } finally {
      await empty.destroy();
    }
  });
});

test('is a no-op on PostgreSQL, whose default is a real timestamp', async () => {
  const calls = [];
  const fake = {
    client: { config: { client: 'pg' } },
    schema: { hasTable: async () => { calls.push('hasTable'); return true; } },
    raw: async () => { calls.push('raw'); },
  };
  await migration.up(fake);
  expect(calls).toEqual([]);
});
