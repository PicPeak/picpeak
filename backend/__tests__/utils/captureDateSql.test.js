/**
 * The capture-date ORDER BY (utils/captureDateSql) on both engines.
 *
 * Its name tie-break has to come out the same on SQLite, on PostgreSQL and in
 * the browser, which sorts the loaded gallery itself (useGalleryFiltering).
 * PostgreSQL orders text by the column's collation, and under a glibc or ICU
 * locale that folds case. The name columns are declared with an ICU collation
 * here, so the default is not byte order on the alpine image either, whose
 * libc collates bytewise whatever the locale says.
 *
 * SQLite always; PostgreSQL, in a scratch schema, when PICPEAK_PG_TEST_URL is set.
 */
const crypto = require('crypto');
const knex = require('knex');
const { captureDateOrderSql, captureNameTieBreakSql } = require('../../src/utils/captureDateSql');

describe.each(['sqlite3', ...(process.env.PICPEAK_PG_TEST_URL ? ['pg'] : [])])('capture-date order on %s', (client) => {
  let db; let root; let schema;
  const BURST = '2026-06-03T13:15:42.000Z';

  beforeAll(async () => {
    if (client === 'pg') {
      root = knex({ client, connection: process.env.PICPEAK_PG_TEST_URL });
      schema = `capture_order_${crypto.randomBytes(8).toString('hex')}`;
      await root.raw(`CREATE SCHEMA "${schema}"`);
      db = knex({ client, connection: process.env.PICPEAK_PG_TEST_URL, searchPath: [schema] });
    } else {
      db = knex({ client, connection: { filename: ':memory:' }, useNullAsDefault: true });
    }
    await db.schema.createTable('photos', (t) => {
      t.increments('id').primary();
      t.string('filename');
      t.string('original_filename');
      t.timestamp('captured_at');
      t.timestamp('uploaded_at');
    });
    if (client === 'pg' && (await db.raw('select 1 from pg_collation where collname = \'und-x-icu\'')).rows.length) {
      await db.raw('ALTER TABLE photos ALTER COLUMN filename TYPE varchar(255) COLLATE "und-x-icu", '
        + 'ALTER COLUMN original_filename TYPE varchar(255) COLLATE "und-x-icu"');
    }
  });
  afterAll(async () => {
    if (db) await db.destroy();
    if (root) { await root.raw(`DROP SCHEMA "${schema}" CASCADE`); await root.destroy(); }
  });
  beforeEach(async () => { await db('photos').del(); });

  const add = (filename, original, fields = {}) => db('photos').insert({
    filename, original_filename: original, captured_at: BURST, uploaded_at: '2026-09-01T00:00:00.000Z', ...fields,
  });
  const ordered = async (direction, column = 'original_filename') => (await db('photos')
    .orderByRaw(`${captureDateOrderSql(client)} ${direction}`)
    .orderByRaw(`${captureNameTieBreakSql(client)} ${direction}`)
    .orderBy('photos.id', direction)).map((row) => row[column]);

  it('breaks a tie by name byte by byte, whatever the column collates as', async () => {
    for (const name of ['IMG_9.jpg', 'IMG_10.jpg', 'img_2.jpg', 'IMG_3.jpg']) await add(`stored-${name}`, name);
    expect(await ordered('asc')).toEqual(['IMG_10.jpg', 'IMG_3.jpg', 'IMG_9.jpg', 'img_2.jpg']);
    expect(await ordered('desc')).toEqual(['img_2.jpg', 'IMG_9.jpg', 'IMG_3.jpg', 'IMG_10.jpg']);
  });

  it('takes the stored name where the original name is missing or empty', async () => {
    await add('IMG_0003.jpg', null);
    await add('IMG_0002.jpg', '');
    await add('stored.jpg', 'IMG_0001.jpg');
    expect(await ordered('asc', 'filename')).toEqual(['stored.jpg', 'IMG_0002.jpg', 'IMG_0003.jpg']);
    expect(await ordered('desc', 'filename')).toEqual(['IMG_0003.jpg', 'IMG_0002.jpg', 'stored.jpg']);
  });

  it('keeps id as the last word between photos of one name', async () => {
    await add('a.jpg', 'IMG_0001.jpg');
    await add('b.jpg', 'IMG_0001.jpg');
    expect(await ordered('asc', 'filename')).toEqual(['a.jpg', 'b.jpg']);
    expect(await ordered('desc', 'filename')).toEqual(['b.jpg', 'a.jpg']);
  });
});
