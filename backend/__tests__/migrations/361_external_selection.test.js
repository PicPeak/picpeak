/**
 * Migration 361: the curated selection (issue 2356). Adds the selection
 * folder and the full link to events and the flag to photos, with every
 * existing photo in the selection; a second run is a no-op that keeps the
 * values; one gallery per full link; down() removes all of it.
 */
const knex = require('knex');
const migration = require('../../migrations/core/361_external_selection');

describe('migration 361 on SQLite', () => {
  let db;

  beforeEach(async () => {
    db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await db.schema.createTable('events', (t) => { t.increments('id').primary(); t.string('slug'); });
    await db.schema.createTable('photos', (t) => { t.increments('id').primary(); t.integer('event_id'); });
    await db('events').insert([{ slug: 'a' }, { slug: 'b' }]);
    await db('photos').insert([{ event_id: 1 }, { event_id: 2 }]);
  });

  afterEach(async () => { await db.destroy(); });

  it('adds the columns empty, with every photo in the selection', async () => {
    await migration.up(db);
    expect(await db('events').whereNotNull('selection_path').orWhereNotNull('full_share_token')).toHaveLength(0);
    expect((await db('photos').select('selection_hidden')).map((r) => Number(r.selection_hidden))).toEqual([0, 0]);
  });

  it('keeps the values on a second run', async () => {
    await migration.up(db);
    await db('events').where({ slug: 'a' }).update({ selection_path: 'gallery', full_share_token: 'x'.repeat(64) });
    await db('photos').where({ id: 1 }).update({ selection_hidden: true });
    await migration.up(db);
    expect(await db('events').where({ slug: 'a' }).first()).toMatchObject({ selection_path: 'gallery', full_share_token: 'x'.repeat(64) });
    expect(Number((await db('photos').where({ id: 1 }).first()).selection_hidden)).toBe(1);
  });

  it('allows one gallery per full link', async () => {
    await migration.up(db);
    await db('events').where({ slug: 'a' }).update({ full_share_token: 'x'.repeat(64) });
    await expect(db('events').where({ slug: 'b' }).update({ full_share_token: 'x'.repeat(64) })).rejects.toThrow(/UNIQUE/);
  });

  it('down() removes the columns and is safe to repeat', async () => {
    await migration.up(db);
    await migration.down(db);
    for (const [table, column] of [['events', 'selection_path'], ['events', 'full_share_token'], ['photos', 'selection_hidden']]) {
      expect(await db.schema.hasColumn(table, column)).toBe(false);
    }
    await expect(migration.down(db)).resolves.toBeUndefined();
  });
});
