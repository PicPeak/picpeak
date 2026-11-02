const knex = require('knex');
const migration = require('../../migrations/core/344_email_queue_deferred_since');

it('adds an empty deferred_since to queued mail, runs twice, and rolls back safely', async () => {
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  try {
    await db.schema.createTable('email_queue', (table) => {
      table.increments('id'); table.string('status'); table.integer('retry_count').notNullable().defaultTo(0);
    });
    await db('email_queue').insert({ status: 'pending' });
    await migration.up(db);
    await migration.up(db);
    expect((await db('email_queue').first()).deferred_since).toBeNull();
    await migration.down(db);
    await migration.down(db);
    expect(await db.schema.hasColumn('email_queue', 'deferred_since')).toBe(false);
    expect(await db('email_queue').count('* as n').first()).toEqual({ n: 1 });
  } finally { await db.destroy(); }
});

it('does nothing on a database without the mail queue', async () => {
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  try {
    await migration.up(db);
    await migration.down(db);
    expect(await db.schema.hasTable('email_queue')).toBe(false);
  } finally { await db.destroy(); }
});
