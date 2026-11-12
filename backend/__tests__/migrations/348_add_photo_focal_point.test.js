/**
 * Migration 348: a photo's focal point (issue 2377). Guarded per column, so a
 * second run is a no-op; down() removes exactly what up() added; fractions
 * survive the round trip and existing rows stay NULL (the centre crop).
 */
const knex = require('knex');
const migration = require('../../migrations/core/348_add_photo_focal_point');

describe('migration 348 on SQLite', () => {
  let db;

  beforeEach(async () => {
    db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await db.schema.createTable('photos', (t) => {
      t.increments('id').primary();
      t.string('filename');
    });
    await db('photos').insert({ filename: 'old.jpg' });
  });

  afterEach(async () => { await db.destroy(); });

  it('adds nullable columns, keeps fractions, and runs again without complaint', async () => {
    await migration.up(db);
    await expect(migration.up(db)).resolves.toBeUndefined();

    await db('photos').insert({ filename: 'new.jpg', focal_x: 0.8125, focal_y: 0.25, focal_source: 'manual' });
    const rows = await db('photos').orderBy('id').select('focal_x', 'focal_y', 'focal_source');
    expect(rows).toEqual([
      { focal_x: null, focal_y: null, focal_source: null },
      { focal_x: 0.8125, focal_y: 0.25, focal_source: 'manual' },
    ]);
  });

  it('down() removes them and keeps the rows, and is a no-op without them', async () => {
    await migration.up(db);
    await migration.down(db);
    for (const column of ['focal_x', 'focal_y', 'focal_source']) {
      expect(await db.schema.hasColumn('photos', column)).toBe(false);
    }
    await expect(migration.down(db)).resolves.toBeUndefined();
    expect(await db('photos').count('* as n').first()).toEqual({ n: 1 });
  });

  it('does nothing on a database without photos', async () => {
    await db.schema.dropTable('photos');
    await expect(migration.up(db)).resolves.toBeUndefined();
    await expect(migration.down(db)).resolves.toBeUndefined();
  });
});
