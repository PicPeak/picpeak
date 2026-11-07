/**
 * File sizes over 2 GiB on PostgreSQL (issue 2426).
 *
 * photos.size_bytes was an int4, so the insert for a 7.9 GB video threw
 * "out of range for type integer" and the upload was dropped. SQLite's
 * INTEGER is 64-bit already, so only the real-Postgres case reproduces.
 */
const knex = require('knex');
const { randomUUID } = require('crypto');
const migration = require('../../migrations/core/351_size_bytes_bigint');

const TABLES = ['photos', 'transfer_uploads', 'transfer_extra_files', 'customer_documents'];
const BIG = 7965616086;

test('is a no-op on SQLite', async () => {
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  try {
    await migration.up(db);
    await db.schema.createTable('photos', (t) => { t.increments('id'); t.integer('size_bytes'); });
    await migration.up(db);
    await db('photos').insert({ size_bytes: BIG });
    expect(Number((await db('photos').first()).size_bytes)).toBe(BIG);
  } finally {
    await db.destroy();
  }
});

const pgUrl = process.env.PICPEAK_PG_TEST_URL;
(pgUrl ? describe : describe.skip)('PostgreSQL size_bytes columns', () => {
  let owner; let db; let schema;

  const columnType = async (table) => (await db('information_schema.columns')
    .where({ table_schema: schema, table_name: table, column_name: 'size_bytes' })
    .first('data_type')).data_type;

  beforeAll(async () => {
    schema = `size_bytes_${randomUUID().replace(/-/g, '')}`;
    owner = knex({ client: 'pg', connection: pgUrl });
    await owner.schema.createSchema(schema);
    db = knex({ client: 'pg', connection: pgUrl, searchPath: [schema] });
    for (const table of TABLES) {
      // eslint-disable-next-line no-await-in-loop
      await db.schema.createTable(table, (t) => { t.increments('id'); t.integer('size_bytes'); });
    }
  });

  afterAll(async () => {
    if (db) await db.destroy();
    if (owner) {
      await owner.schema.dropSchemaIfExists(schema, true);
      await owner.destroy();
    }
  });

  it('starts as int4 and refuses a size over 2 GiB', async () => {
    expect(await columnType('photos')).toBe('integer');
    await expect(db('photos').insert({ size_bytes: BIG })).rejects.toThrow(/out of range/);
  });

  it('widens every column to bigint, and a re-run changes nothing', async () => {
    await migration.up(db);
    await migration.up(db);
    for (const table of TABLES) {
      // eslint-disable-next-line no-await-in-loop
      expect(await columnType(table)).toBe('bigint');
      // eslint-disable-next-line no-await-in-loop
      await db(table).insert({ size_bytes: BIG });
      // eslint-disable-next-line no-await-in-loop
      expect(Number((await db(table).orderBy('id', 'desc').first()).size_bytes)).toBe(BIG);
    }
  });

  it('narrows back only while every value fits', async () => {
    await expect(migration.down(db)).rejects.toThrow(/out of range/);
    for (const table of TABLES) {
      // eslint-disable-next-line no-await-in-loop
      await db(table).where('size_bytes', '>', 2147483647).del();
    }
    await migration.down(db);
    expect(await columnType('photos')).toBe('integer');
  });
});
