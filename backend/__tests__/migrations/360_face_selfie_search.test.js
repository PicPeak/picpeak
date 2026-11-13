/**
 * Migration 360: events.face_selfie_search_enabled (issue 2355). Off for
 * existing and new events, a second run is a no-op that keeps an event's
 * opt-in, and down() removes the column.
 */
const knex = require('knex');
const migration = require('../../migrations/core/360_face_selfie_search');

describe('migration 360 on SQLite', () => {
  let db;

  beforeEach(async () => {
    db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await db.schema.createTable('events', (t) => {
      t.increments('id').primary();
      t.string('slug');
    });
    await db('events').insert([{ slug: 'a' }, { slug: 'b' }]);
  });

  afterEach(async () => { await db.destroy(); });

  it('adds the column off for existing and new events', async () => {
    await migration.up(db);
    expect((await db('events').select('face_selfie_search_enabled')).map((r) => Number(r.face_selfie_search_enabled))).toEqual([0, 0]);
    await db('events').insert({ slug: 'c' });
    expect(Number((await db('events').where({ slug: 'c' }).first()).face_selfie_search_enabled)).toBe(0);
  });

  it('keeps an opt-in on a second run', async () => {
    await migration.up(db);
    await db('events').where({ slug: 'a' }).update({ face_selfie_search_enabled: true });
    await migration.up(db);
    expect(Number((await db('events').where({ slug: 'a' }).first()).face_selfie_search_enabled)).toBe(1);
  });

  it('down() removes the column and is safe to repeat', async () => {
    await migration.up(db);
    await migration.down(db);
    expect(await db.schema.hasColumn('events', 'face_selfie_search_enabled')).toBe(false);
    await expect(migration.down(db)).resolves.toBeUndefined();
  });
});
