/**
 * Migration 310: the face-scan claim id (issue 2069). Guarded on the column,
 * so it is a no-op on a second run; down() removes exactly what up() added.
 */
const knex = require('knex');
const migration = require('../../migrations/core/310_photos_face_attempt_id');

describe('migration 310 on SQLite', () => {
  let db;

  beforeEach(async () => {
    db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await db.schema.createTable('photos', (t) => {
      t.increments('id').primary();
      t.string('filename');
      t.string('face_status', 16);
    });
    await db('photos').insert({ filename: 'before.jpg', face_status: 'processing' });
  });

  afterEach(async () => { await db.destroy(); });

  it('adds the column, leaves existing rows without an id, and runs again without complaint', async () => {
    await migration.up(db);
    expect(await db.schema.hasColumn('photos', 'face_attempt_id')).toBe(true);
    await expect(migration.up(db)).resolves.toBeUndefined();
    expect(await db('photos').first('face_status', 'face_attempt_id'))
      .toEqual({ face_status: 'processing', face_attempt_id: null });
  });

  it('down() removes it and keeps the rest, and is a no-op without it', async () => {
    await migration.up(db);
    await migration.down(db);
    expect(await db.schema.hasColumn('photos', 'face_attempt_id')).toBe(false);
    expect(await db('photos').first('filename')).toEqual({ filename: 'before.jpg' });
    await expect(migration.down(db)).resolves.toBeUndefined();
  });

  it('does nothing without a photos table', async () => {
    await db.schema.dropTable('photos');
    await expect(migration.up(db)).resolves.toBeUndefined();
    await expect(migration.down(db)).resolves.toBeUndefined();
  });
});
