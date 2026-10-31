const knex = require('knex');
const migration = require('../../migrations/core/328_events_temporarily_disabled');

it('defaults existing and new galleries to enabled and safely rolls back', async () => {
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  try {
    await db.schema.createTable('events', (table) => { table.increments('id'); table.string('slug'); });
    await db('events').insert({ slug: 'existing' });
    await migration.up(db);
    await migration.up(db);
    await db('events').insert({ slug: 'new' });
    expect((await db('events')).map((row) => row.temporarily_disabled)).toEqual([0, 0]);
    await migration.down(db);
    await migration.down(db);
    expect(await db.schema.hasColumn('events', 'temporarily_disabled')).toBe(false);
    expect(await db('events').count('* as count').first()).toEqual({ count: 2 });
  } finally { await db.destroy(); }
});
