/**
 * Migration 312: photos.unavailable_reason (issue 2121). Guarded on the
 * column, so it is a no-op on a second run; existing rows stay servable
 * (NULL); down() removes exactly what up() added.
 */
const knex = require('knex');
const migration = require('../../migrations/core/312_photos_unavailable_reason');

describe('migration 312 on SQLite', () => {
  let db;

  beforeEach(async () => {
    db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await db.schema.createTable('photos', (t) => {
      t.increments('id').primary();
      t.integer('event_id');
      t.string('filename');
    });
    await db('photos').insert({ event_id: 1, filename: 'before.jpg' });
  });

  afterEach(async () => { await db.destroy(); });

  it('adds the column, leaves existing rows servable, and runs again without complaint', async () => {
    await migration.up(db);
    expect(await db.schema.hasColumn('photos', 'unavailable_reason')).toBe(true);
    await expect(migration.up(db)).resolves.toBeUndefined();
    expect(await db('photos').first('unavailable_reason')).toEqual({ unavailable_reason: null });
  });

  it('down() removes it and keeps the rest, and is a no-op without it', async () => {
    await migration.up(db);
    await migration.down(db);
    expect(await db.schema.hasColumn('photos', 'unavailable_reason')).toBe(false);
    expect(await db('photos').first('filename')).toEqual({ filename: 'before.jpg' });
    await expect(migration.down(db)).resolves.toBeUndefined();
  });

  it('does nothing without a photos table', async () => {
    await db.schema.dropTable('photos');
    await expect(migration.up(db)).resolves.toBeUndefined();
    await expect(migration.down(db)).resolves.toBeUndefined();
  });
});
