/**
 * Migration 259: the browser-playable copy columns (issue 1430, item 8).
 * Guarded on the column, so it is a no-op on a second run and on a photos
 * table that already carries it; down() removes exactly what up() added.
 */
const knex = require('knex');
const migration = require('../../migrations/core/259_photos_web_rendition');

describe('migration 259 on SQLite', () => {
  let db;

  beforeEach(async () => {
    db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await db.schema.createTable('photos', (t) => {
      t.increments('id').primary();
      t.integer('event_id');
      t.string('filename');
      t.string('media_type');
    });
  });

  afterEach(async () => { await db.destroy(); });

  it('adds the four columns and runs again without complaint', async () => {
    await migration.up(db);
    for (const column of ['web_path', 'web_status', 'web_started_at', 'web_error']) {
      expect(await db.schema.hasColumn('photos', column)).toBe(true);
    }
    await expect(migration.up(db)).resolves.toBeUndefined();

    await db('photos').insert({ event_id: 1, filename: 'a.mp4', media_type: 'video', web_status: 'pending' });
    expect(await db('photos').where('web_status', 'pending').count({ c: '*' }).first()).toEqual({ c: 1 });
  });

  it('down() removes them, and is a no-op without them', async () => {
    await migration.up(db);
    await migration.down(db);
    expect(await db.schema.hasColumn('photos', 'web_path')).toBe(false);
    expect(await db.schema.hasColumn('photos', 'web_status')).toBe(false);
    await expect(migration.down(db)).resolves.toBeUndefined();
  });

  it('does nothing without a photos table', async () => {
    await db.schema.dropTable('photos');
    await expect(migration.up(db)).resolves.toBeUndefined();
  });
});
