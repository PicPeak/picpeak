/**
 * Migration 363: the website embed columns and the `embed` feature flag
 * (issue 1112). Adds both columns and the flag off, keeps a second run a
 * no-op (an admin's flag value survives), enforces one gallery per token, and
 * down() removes all of it.
 */
const knex = require('knex');
const migration = require('../../migrations/core/363_event_embed');

describe('migration 363 on SQLite', () => {
  let db;

  beforeEach(async () => {
    db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await db.schema.createTable('events', (t) => {
      t.increments('id').primary();
      t.string('slug');
    });
    await db.schema.createTable('feature_flags', (t) => {
      t.string('key').primary();
      t.boolean('value');
    });
    await db('events').insert([{ slug: 'a' }, { slug: 'b' }]);
  });

  afterEach(async () => { await db.destroy(); });

  it('adds the columns empty and the flag off', async () => {
    await migration.up(db);
    expect(await db.schema.hasColumn('events', 'embed_token')).toBe(true);
    expect(await db.schema.hasColumn('events', 'embed_allowed_origins')).toBe(true);
    expect((await db('events').whereNotNull('embed_token')).length).toBe(0);
    expect(Number((await db('feature_flags').where({ key: 'embed' }).first()).value)).toBe(0);
  });

  it('keeps a turned-on flag on a second run', async () => {
    await migration.up(db);
    await db('feature_flags').where({ key: 'embed' }).update({ value: true });
    await migration.up(db);
    expect(Number((await db('feature_flags').where({ key: 'embed' }).first()).value)).toBe(1);
  });

  it('allows one gallery per token', async () => {
    await migration.up(db);
    await db('events').where({ slug: 'a' }).update({ embed_token: 'x'.repeat(64) });
    await expect(db('events').where({ slug: 'b' }).update({ embed_token: 'x'.repeat(64) })).rejects.toThrow(/UNIQUE/);
  });

  it('down() removes the columns and the flag', async () => {
    await migration.up(db);
    await migration.down(db);
    expect(await db.schema.hasColumn('events', 'embed_token')).toBe(false);
    expect(await db.schema.hasColumn('events', 'embed_allowed_origins')).toBe(false);
    expect(await db('feature_flags').where({ key: 'embed' }).first()).toBeUndefined();
  });
});
