/**
 * Migration 326: the frame picked as a video's preview image (issue 2263,
 * item 4). Guarded on the column, so a second run is a no-op; down() removes
 * exactly what up() added. A fraction of a second survives the round trip.
 */
const knex = require('knex');
const migration = require('../../migrations/core/326_add_photo_poster_offset');

describe('migration 326 on SQLite', () => {
  let db;

  beforeEach(async () => {
    db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await db.schema.createTable('photos', (t) => {
      t.increments('id').primary();
      t.string('filename');
    });
  });

  afterEach(async () => { await db.destroy(); });

  it('adds a nullable column, keeps fractions, and runs again without complaint', async () => {
    await migration.up(db);
    await expect(migration.up(db)).resolves.toBeUndefined();

    await db('photos').insert([{ filename: 'a.mp4' }, { filename: 'b.mp4', poster_offset_seconds: 4.25 }]);
    const rows = await db('photos').orderBy('id').select('poster_offset_seconds');
    expect(rows.map((r) => r.poster_offset_seconds)).toEqual([null, 4.25]);
  });

  it('down() removes it, and is a no-op without it', async () => {
    await migration.up(db);
    await migration.down(db);
    expect(await db.schema.hasColumn('photos', 'poster_offset_seconds')).toBe(false);
    await expect(migration.down(db)).resolves.toBeUndefined();
  });
});
