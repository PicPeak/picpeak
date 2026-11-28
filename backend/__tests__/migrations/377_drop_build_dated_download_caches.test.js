/**
 * Migration 377: archives built before issue 2617 date every entry by the
 * build time. The cached gallery ZIP is dropped once and rebuilt on the next
 * download; ready download jobs keep their links.
 */
const knex = require('knex');

const migration = require('../../migrations/core/377_drop_build_dated_download_caches');

describe('migration 377 on SQLite', () => {
  let db;
  const future = new Date(Date.now() + 864e5).toISOString();

  beforeEach(async () => {
    db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await db.schema.createTable('events', (t) => {
      t.increments('id').primary();
      t.string('slug');
      t.text('download_zip_path');
      t.string('download_zip_generated_at');
    });
    await db.schema.createTable('download_jobs', (t) => {
      t.increments('id').primary();
      t.string('status');
      t.string('expires_at');
    });
    await db('events').insert([
      { slug: 'cached', download_zip_path: 'events/active/cached/.download-cache/all.zip', download_zip_generated_at: '2026-11-01T00:00:00.000Z' },
      { slug: 'none', download_zip_path: null, download_zip_generated_at: null },
    ]);
    await db('download_jobs').insert([
      { status: 'ready', expires_at: future },
      { status: 'building', expires_at: future },
    ]);
  });

  afterEach(async () => { await db.destroy(); });

  it('drops the cached gallery archive and leaves download jobs alone', async () => {
    await migration.up(db);
    for (const row of await db('events')) {
      expect(row.download_zip_path).toBeNull();
      expect(row.download_zip_generated_at).toBeNull();
    }
    const jobs = await db('download_jobs').orderBy('id');
    expect(jobs.map((j) => j.expires_at)).toEqual([future, future]);
  });

  it('is safe to run twice and on a database without the tables', async () => {
    await migration.up(db);
    await migration.up(db);
    const bare = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await expect(migration.up(bare)).resolves.toBeUndefined();
    await expect(migration.down(bare)).resolves.toBeUndefined();
    await bare.destroy();
  });
});
