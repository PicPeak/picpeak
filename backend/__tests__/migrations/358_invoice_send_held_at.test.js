/**
 * Migration 358: invoices.send_held_at, added once and dropped by down().
 * The backfill from the hold's history (markHeldInvoices) runs against the
 * accounting recorder; it is covered in integration/invoiceSendAtShape.test.js.
 */
const knex = require('knex');
const migration = require('../../migrations/core/358_invoice_send_held_at');

describe('migration 358 on SQLite', () => {
  let db;

  beforeEach(async () => {
    db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await db.schema.createTable('invoices', (t) => {
      t.increments('id').primary();
      t.string('status');
    });
    await db('invoices').insert({ status: 'scheduled' });
  });

  afterEach(async () => { await db.destroy(); });

  it('adds a nullable send_held_at, and a second run changes nothing', async () => {
    await migration.up(db);
    await migration.up(db);
    expect(await db.schema.hasColumn('invoices', 'send_held_at')).toBe(true);
    expect(await db('invoices').select('id', 'send_held_at')).toEqual([{ id: 1, send_held_at: null }]);
  });

  it('down() drops the column, twice, and both directions skip a database without invoices', async () => {
    await migration.up(db);
    await migration.down(db);
    await migration.down(db);
    expect(await db.schema.hasColumn('invoices', 'send_held_at')).toBe(false);
    expect(await db('invoices').count('* as n').first()).toEqual({ n: 1 });
    await db.schema.dropTable('invoices');
    await expect(migration.up(db)).resolves.toBeUndefined();
    await expect(migration.down(db)).resolves.toBeUndefined();
  });
});
