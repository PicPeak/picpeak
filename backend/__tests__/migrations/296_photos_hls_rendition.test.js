/**
 * Migration 296: the adaptive streaming columns (issue 1733, D4). Guarded on
 * the column, so it is a no-op on a second run; down() removes exactly what
 * up() added.
 */
const knex = require('knex');
const migration = require('../../migrations/core/296_photos_hls_rendition');

const COLUMNS = ['hls_path', 'hls_status', 'hls_started_at', 'hls_error', 'hls_attempt_id', 'hls_attempts', 'hls_retry_at'];

describe('migration 296 on SQLite', () => {
  let db;

  beforeEach(async () => {
    db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await db.schema.createTable('photos', (t) => {
      t.increments('id').primary();
      t.integer('event_id');
      t.string('filename');
      t.string('media_type');
    });
    await db('photos').insert({ event_id: 1, filename: 'before.mp4', media_type: 'video' });
  });

  afterEach(async () => { await db.destroy(); });

  it('adds the columns, leaves existing rows unqueued, and runs again without complaint', async () => {
    await migration.up(db);
    for (const column of COLUMNS) expect(await db.schema.hasColumn('photos', column)).toBe(true);
    await expect(migration.up(db)).resolves.toBeUndefined();

    expect(await db('photos').first('hls_status', 'hls_attempts', 'hls_path')).toEqual({ hls_status: null, hls_attempts: 0, hls_path: null });
    await db('photos').insert({ event_id: 1, filename: 'a.mp4', media_type: 'video', hls_status: 'pending' });
    expect(await db('photos').where('hls_status', 'pending').count({ c: '*' }).first()).toEqual({ c: 1 });
  });

  it('down() removes them and keeps the rest, and is a no-op without them', async () => {
    await migration.up(db);
    await migration.down(db);
    for (const column of COLUMNS) expect(await db.schema.hasColumn('photos', column)).toBe(false);
    expect(await db('photos').first('filename')).toEqual({ filename: 'before.mp4' });
    await expect(migration.down(db)).resolves.toBeUndefined();
  });

  it('does nothing without a photos table', async () => {
    await db.schema.dropTable('photos');
    await expect(migration.up(db)).resolves.toBeUndefined();
    await expect(migration.down(db)).resolves.toBeUndefined();
  });
});
