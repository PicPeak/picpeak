const knex = require('knex');
const migration = require('../../migrations/core/330_gallery_pause_started_at');

it('starts tracking existing pauses once, leaves enabled galleries unset, and rolls back safely', async () => {
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  try {
    await db.schema.createTable('events', (table) => {
      table.increments('id'); table.boolean('temporarily_disabled').notNullable().defaultTo(false);
    });
    await db('events').insert([{ temporarily_disabled: true }, { temporarily_disabled: false }]);
    const before = Date.now();
    await migration.up(db);
    const first = await db('events').orderBy('id');
    expect(Date.parse(first[0].temporarily_disabled_at)).toBeGreaterThanOrEqual(before);
    expect(first[1].temporarily_disabled_at).toBeNull();
    await migration.up(db);
    expect((await db('events').orderBy('id'))[0].temporarily_disabled_at).toBe(first[0].temporarily_disabled_at);
    await db('events').insert({ temporarily_disabled: false });
    expect((await db('events').orderBy('id', 'desc').first()).temporarily_disabled_at).toBeNull();
    await migration.down(db);
    await migration.down(db);
    expect(await db.schema.hasColumn('events', 'temporarily_disabled_at')).toBe(false);
    expect((await db('events')).map((row) => row.temporarily_disabled)).toEqual([1, 0, 0]);
  } finally { await db.destroy(); }
});
