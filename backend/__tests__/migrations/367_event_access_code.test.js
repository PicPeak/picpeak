/**
 * Migration 367: events.access_code (issue 2495). Adds the column with a
 * unique index and backfills nothing (event codes are opt-in), is safe to run
 * twice, and down() removes it.
 */
const knex = require('knex');
const migration = require('../../migrations/core/367_event_access_code');

describe('migration 367 on SQLite', () => {
  let db;

  beforeEach(async () => {
    db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await db.schema.createTable('events', (t) => {
      t.increments('id').primary();
      t.string('slug');
      t.boolean('is_archived').defaultTo(false);
    });
    await db('events').insert([
      { slug: 'live-a', is_archived: false },
      { slug: 'live-b', is_archived: false },
      { slug: 'archived', is_archived: true },
      { slug: 'legacy-null', is_archived: null },
    ]);
  });

  afterEach(async () => { await db.destroy(); });

  it('adds the column without giving any gallery a code', async () => {
    await migration.up(db);
    expect(await db.schema.hasColumn('events', 'access_code')).toBe(true);
    const rows = await db('events');
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.access_code).toBeNull();
  });

  it('is safe to run twice and keeps codes set in between', async () => {
    await migration.up(db);
    await db('events').where({ slug: 'live-a' }).update({ access_code: 'K7M4QX' });
    await migration.up(db);
    expect((await db('events').where({ slug: 'live-a' }).first()).access_code).toBe('K7M4QX');
    expect((await db('events').whereNull('access_code')).length).toBe(3);
  });

  it('allows one gallery per code, and many without one', async () => {
    await migration.up(db);
    await db('events').where({ slug: 'live-a' }).update({ access_code: 'K7M4QX' });
    await expect(db('events').where({ slug: 'live-b' }).update({ access_code: 'K7M4QX' })).rejects.toThrow(/UNIQUE/);
    await db('events').insert([{ slug: 'x', is_archived: true }, { slug: 'y', is_archived: true }]);
    expect((await db('events').whereNull('access_code')).length).toBe(5);
  });

  it('down() removes the column', async () => {
    await migration.up(db);
    await migration.down(db);
    expect(await db.schema.hasColumn('events', 'access_code')).toBe(false);
    await migration.down(db);
  });

  it('adds the index on a rerun after a run that stopped after the column', async () => {
    await db.schema.alterTable('events', (t) => { t.string('access_code', 12).nullable(); });
    await migration.up(db);
    await db('events').where({ slug: 'live-a' }).update({ access_code: 'K7M4QX' });
    await expect(db('events').where({ slug: 'live-b' }).update({ access_code: 'K7M4QX' })).rejects.toThrow(/UNIQUE/);
  });

  it('down() removes the column when the index is missing', async () => {
    await db.schema.alterTable('events', (t) => { t.string('access_code', 12).nullable(); });
    await migration.down(db);
    expect(await db.schema.hasColumn('events', 'access_code')).toBe(false);
  });
});
