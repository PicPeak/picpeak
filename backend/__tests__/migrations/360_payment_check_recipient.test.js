/**
 * Migration 360: invoice_payment_check_tokens.recipient_admin_id, added once,
 * left empty on existing links, and dropped by down().
 */
const knex = require('knex');
const migration = require('../../migrations/core/360_payment_check_recipient');

describe('migration 360 on SQLite', () => {
  let db;

  beforeEach(async () => {
    db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await db.schema.createTable('invoice_payment_check_tokens', (t) => {
      t.increments('id').primary();
      t.integer('invoice_id');
      t.string('token', 64);
    });
    await db('invoice_payment_check_tokens').insert({ invoice_id: 1, token: 'a'.repeat(64) });
  });

  afterEach(async () => { await db.destroy(); });

  it('adds a nullable recipient_admin_id, and a second run changes nothing', async () => {
    await migration.up(db);
    await migration.up(db);
    expect(await db.schema.hasColumn('invoice_payment_check_tokens', 'recipient_admin_id')).toBe(true);
    expect(await db('invoice_payment_check_tokens').select('id', 'recipient_admin_id'))
      .toEqual([{ id: 1, recipient_admin_id: null }]);
  });

  it('down() drops the column, twice, and both directions skip a database without the table', async () => {
    await migration.up(db);
    await migration.down(db);
    await migration.down(db);
    expect(await db.schema.hasColumn('invoice_payment_check_tokens', 'recipient_admin_id')).toBe(false);
    expect(await db('invoice_payment_check_tokens').count('* as n').first()).toEqual({ n: 1 });
    await db.schema.dropTable('invoice_payment_check_tokens');
    await expect(migration.up(db)).resolves.toBeUndefined();
    await expect(migration.down(db)).resolves.toBeUndefined();
  });
});
