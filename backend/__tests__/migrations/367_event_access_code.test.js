/**
 * Migration 367: events.access_code (issue 2495). Adds the column with a
 * unique index, backfills a distinct code for every gallery that is not
 * archived, keeps codes on a second run, and down() removes it.
 */
const knex = require('knex');
const migration = require('../../migrations/core/367_event_access_code');

const CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;

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

  it('backfills distinct codes for galleries that are not archived', async () => {
    await migration.up(db);
    const rows = await db('events').orderBy('id');
    const bySlug = Object.fromEntries(rows.map((r) => [r.slug, r.access_code]));
    expect(bySlug['live-a']).toMatch(CODE_RE);
    expect(bySlug['live-b']).toMatch(CODE_RE);
    expect(bySlug['legacy-null']).toMatch(CODE_RE);
    expect(bySlug['live-a']).not.toBe(bySlug['live-b']);
    expect(bySlug.archived).toBeNull();
  });

  it('keeps existing codes on a second run and fills only the gaps', async () => {
    await migration.up(db);
    const before = await db('events').orderBy('id');
    await db('events').insert({ slug: 'new', is_archived: false });
    await migration.up(db);
    const after = await db('events').orderBy('id');
    for (const row of before) {
      expect(after.find((r) => r.id === row.id).access_code).toBe(row.access_code);
    }
    expect(after.find((r) => r.slug === 'new').access_code).toMatch(CODE_RE);
  });

  it('allows one gallery per code, and many without one', async () => {
    await migration.up(db);
    const { access_code: taken } = await db('events').where({ slug: 'live-a' }).first();
    await expect(db('events').where({ slug: 'live-b' }).update({ access_code: taken })).rejects.toThrow(/UNIQUE/);
    await db('events').insert([{ slug: 'x', is_archived: true }, { slug: 'y', is_archived: true }]);
    expect((await db('events').whereNull('access_code')).length).toBe(3);
  });

  it('down() removes the column', async () => {
    await migration.up(db);
    await migration.down(db);
    expect(await db.schema.hasColumn('events', 'access_code')).toBe(false);
    await migration.down(db);
  });
});
