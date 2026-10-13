/**
 * Migration 286: watched videos stored as images get media_type 'video';
 * nothing else changes.
 */
const knex = require('knex');
const migration = require('../../migrations/core/286_watched_videos_media_type');

describe('migration 286 on SQLite', () => {
  let db;

  beforeEach(async () => {
    db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await db.schema.createTable('photos', (t) => {
      t.increments('id').primary();
      t.string('type');
      t.string('media_type').defaultTo('image');
    });
    await db('photos').insert([
      { id: 1, type: 'video', media_type: 'image' },
      { id: 2, type: 'video', media_type: null },
      { id: 3, type: 'individual', media_type: 'image' },
      { id: 4, type: 'individual', media_type: 'video' },
      { id: 5, type: 'collage', media_type: 'image' },
    ]);
  });

  afterEach(async () => { await db.destroy(); });

  const mediaTypes = async () => (await db('photos').orderBy('id')).map(r => r.media_type);

  it('files watched videos as videos and leaves other rows alone, and runs again', async () => {
    await migration.up(db);
    expect(await mediaTypes()).toEqual(['video', 'video', 'image', 'video', 'image']);
    await migration.up(db);
    expect(await mediaTypes()).toEqual(['video', 'video', 'image', 'video', 'image']);
  });

  it('skips an install without the photos table', async () => {
    await db.schema.dropTable('photos');
    await expect(migration.up(db)).resolves.toBeUndefined();
  });
});
