/**
 * Migration 352 (issue 2439): UK disclosure columns on business_profile, the
 * customer's business/consumer kind and an invoice's GBP rate. Nullable, so
 * existing rows keep rendering as before; re-running and rolling back are safe.
 */
const knex = require('knex');
const migration = require('../../migrations/core/352_uk_business_details');

const ADDED = {
  business_profile: ['legal_form', 'registered_name', 'company_number', 'registered_office', 'jurisdiction', 'proprietor_name'],
  customer_accounts: ['customer_kind'],
  invoices: ['vat_gbp_rate'],
};

let db;

beforeEach(async () => {
  db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  for (const table of Object.keys(ADDED)) {
    await db.schema.createTable(table, (t) => { t.increments('id'); });
  }
});

afterEach(() => db.destroy());

test('adds every column, nullable, and survives a second run', async () => {
  await migration.up(db);
  await migration.up(db);
  for (const [table, columns] of Object.entries(ADDED)) {
    for (const column of columns) expect(await db.schema.hasColumn(table, column)).toBe(true);
    await db(table).insert({});
    const row = await db(table).first();
    for (const column of columns) expect(row[column]).toBeNull();
  }
});

test('rolls back cleanly', async () => {
  await migration.up(db);
  await migration.down(db);
  await migration.down(db);
  for (const [table, columns] of Object.entries(ADDED)) {
    for (const column of columns) expect(await db.schema.hasColumn(table, column)).toBe(false);
  }
});

test('skips a table that does not exist', async () => {
  await db.schema.dropTable('invoices');
  await expect(migration.up(db)).resolves.not.toThrow();
});
