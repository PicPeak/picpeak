/**
 * Migration 331: the camera's own capture clock (issue 2305). Guarded on the
 * column, so a second run is a no-op; down() removes exactly what up() added.
 * The camera digits and offset survive the round trip untouched.
 */
const knex = require('knex');
const migration = require('../../migrations/core/331_add_photo_captured_at_wall');

describe('migration 331 on SQLite', () => {
  let db;

  beforeEach(async () => {
    db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await db.schema.createTable('photos', (t) => {
      t.increments('id').primary();
      t.string('filename');
    });
  });

  afterEach(async () => { await db.destroy(); });

  it('adds a nullable column and runs again without complaint', async () => {
    await migration.up(db);
    await expect(migration.up(db)).resolves.toBeUndefined();

    await db('photos').insert([
      { filename: 'a.jpg' },
      { filename: 'b.jpg', captured_at_wall: '2026-03-29T02:30:00+01:00' },
      { filename: 'c.jpg', captured_at_wall: '' },
    ]);
    const rows = await db('photos').orderBy('id').select('captured_at_wall');
    expect(rows.map((r) => r.captured_at_wall)).toEqual([null, '2026-03-29T02:30:00+01:00', '']);
  });

  it('down() removes it, and is a no-op without it', async () => {
    await migration.up(db);
    await migration.down(db);
    expect(await db.schema.hasColumn('photos', 'captured_at_wall')).toBe(false);
    await expect(migration.down(db)).resolves.toBeUndefined();
  });
});
