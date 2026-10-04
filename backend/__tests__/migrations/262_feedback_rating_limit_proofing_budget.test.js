/**
 * Migration 262: the stored rating rate limit seeded by migration 033
 * (100/h) is lifted to the proofing budget (2000/h) — and only that value.
 * getRateLimitSettings() spreads the stored object over the defaults, so
 * without this a migrated install never saw the new default.
 */
const knex = require('knex');
const migration = require('../../migrations/core/262_feedback_rating_limit_proofing_budget');

const seeded = {
  rating: { max: 100, window: 3600 },
  comment: { max: 20, window: 3600 },
  like: { max: 200, window: 3600 },
};

describe('migration 262 on SQLite', () => {
  let db;

  const stored = async () => {
    const row = await db('app_settings').where({ setting_key: 'feedback_rate_limits' }).first();
    return JSON.parse(row.setting_value);
  };

  beforeEach(async () => {
    db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await db.schema.createTable('app_settings', (t) => {
      t.increments('id').primary();
      t.string('setting_key').unique();
      t.json('setting_value');
      t.string('setting_type');
      t.datetime('updated_at');
    });
  });

  afterEach(async () => { await db.destroy(); });

  it('lifts the seeded 100 to 2000 and leaves the other limits alone', async () => {
    await db('app_settings').insert({ setting_key: 'feedback_rate_limits', setting_value: JSON.stringify(seeded), setting_type: 'feedback' });
    await migration.up(db);
    expect(await stored()).toEqual({ ...seeded, rating: { max: 2000, window: 3600 } });
    // Idempotent.
    await migration.up(db);
    expect((await stored()).rating.max).toBe(2000);
  });

  it('does not touch a value an operator changed, a missing row or a missing table', async () => {
    await db('app_settings').insert({ setting_key: 'feedback_rate_limits', setting_value: JSON.stringify({ ...seeded, rating: { max: 50, window: 3600 } }) });
    await migration.up(db);
    expect((await stored()).rating.max).toBe(50);

    await db('app_settings').del();
    await expect(migration.up(db)).resolves.toBeUndefined();
    await db.schema.dropTable('app_settings');
    await expect(migration.up(db)).resolves.toBeUndefined();
  });

  it('down() restores the seed value, and only from 2000', async () => {
    await db('app_settings').insert({ setting_key: 'feedback_rate_limits', setting_value: JSON.stringify(seeded) });
    await migration.up(db);
    await migration.down(db);
    expect((await stored()).rating.max).toBe(100);
    await db('app_settings').update({ setting_value: JSON.stringify({ ...seeded, rating: { max: 1500, window: 3600 } }) });
    await migration.down(db);
    expect((await stored()).rating.max).toBe(1500);
  });
});
