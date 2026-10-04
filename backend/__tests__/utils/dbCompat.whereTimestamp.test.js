/**
 * whereTimestamp compares a timestamp column by value on SQLite whatever
 * shape it was stored in (issue 1733).
 *
 * events.expires_at is written three ways: ISO text by event creation and
 * duplication, a Date (epoch ms on SQLite) by the extend endpoint, and
 * whatever ISO-8601 the edit form sends, which may be a bare date. A bound
 * Date is a number on SQLite and every number sorts below every text, so the
 * plain `expires_at <= ?` skipped every text row.
 */
const knexFactory = require('knex');

const { whereTimestamp } = require('../../src/utils/dbCompat');

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

// Every shape a writer produces, once a day in the past and once a day ahead.
const ROWS = [
  { id: 1, expires_at: new Date(NOW - DAY).toISOString() },           // past, ISO text
  { id: 2, expires_at: new Date(NOW + DAY).toISOString() },           // future, ISO text
  { id: 3, expires_at: NOW - DAY },                                   // past, epoch ms
  { id: 4, expires_at: NOW + DAY },                                   // future, epoch ms
  { id: 5, expires_at: '2026-09-30 12:00:00' },                       // past, zone-less (CURRENT_TIMESTAMP shape)
  { id: 6, expires_at: '2026-10-02 12:00:00' },                       // future, zone-less
  { id: 7, expires_at: '2026-09-30' },                                // past, bare date (edit form)
  { id: 8, expires_at: '2026-10-03' },                                // future, bare date
  { id: 9, expires_at: '[object Object]' },                           // the jest/sqlite3 landmine: unreadable
  { id: 10, expires_at: null },
];
const PAST = [1, 3, 5, 7];
const FUTURE = [2, 4, 6, 8];

describe('whereTimestamp on SQLite', () => {
  let knex;
  const originalClient = process.env.DATABASE_CLIENT;

  beforeAll(async () => {
    process.env.DATABASE_CLIENT = 'sqlite3';
    knex = knexFactory({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await knex.schema.createTable('events', (t) => {
      t.integer('id').primary();
      t.timestamp('expires_at');
    });
    await knex('events').insert(ROWS);
  });

  afterAll(async () => {
    process.env.DATABASE_CLIENT = originalClient;
    await knex.destroy();
  });

  const ids = async (operator) => (await knex('events')
    .whereNotNull('expires_at')
    .modify(whereTimestamp, 'expires_at', operator, new Date(NOW))
    .orderBy('id')).map((r) => r.id);

  test('the rows really are stored in the three shapes', async () => {
    const types = await knex('events').select('id', knex.raw('typeof(expires_at) as t')).orderBy('id');
    expect(types.map((r) => r.t)).toEqual([
      'text', 'text', 'integer', 'integer', 'text', 'text', 'text', 'text', 'text', 'null',
    ]);
  });

  test('`<=` picks exactly the past rows, whatever their shape', async () => {
    expect(await ids('<=')).toEqual(PAST);
  });

  test('`>` picks exactly the future rows, whatever their shape', async () => {
    expect(await ids('>')).toEqual(FUTURE);
  });

  test('an unreadable value matches neither side rather than one of them', async () => {
    expect(await ids('<')).not.toContain(9);
    expect(await ids('>=')).not.toContain(9);
  });

  test('a window combines two clauses the way the expiry checker does', async () => {
    const rows = await knex('events')
      .whereNotNull('expires_at')
      .modify(whereTimestamp, 'expires_at', '<=', new Date(NOW + 7 * DAY))
      .modify(whereTimestamp, 'expires_at', '>', new Date(NOW))
      .orderBy('id');
    expect(rows.map((r) => r.id)).toEqual(FUTURE);
  });

  test('works inside an OR group', async () => {
    const rows = await knex('events')
      .where((q) => q.whereNull('expires_at').orWhere((o) => o.modify(whereTimestamp, 'expires_at', '>', new Date(NOW))))
      .orderBy('id');
    expect(rows.map((r) => r.id)).toEqual([...FUTURE, 10]);
  });

  test('keeps the milliseconds of an ISO value, like the epoch-ms rows do', async () => {
    // strftime('%s') would truncate .900 to the second and read it as past.
    const point = new Date('2026-10-06T12:00:00.500Z');
    await knex('events').insert([
      { id: 11, expires_at: '2026-10-06T12:00:00.900Z' },
      { id: 12, expires_at: '2026-10-06T12:00:00.100Z' },
      { id: 13, expires_at: new Date('2026-10-06T12:00:00.900Z').getTime() },
    ]);
    const after = (await knex('events').whereIn('id', [11, 12, 13])
      .modify(whereTimestamp, 'expires_at', '>', point).orderBy('id')).map((r) => r.id);
    expect(after).toEqual([11, 13]);
    await knex('events').whereIn('id', [11, 12, 13]).del();
  });

  test('refuses an operator it would otherwise splice into SQL', () => {
    expect(() => whereTimestamp(knex('events'), 'expires_at', '= 1 OR 1', new Date(NOW)))
      .toThrow(/operator/);
  });
});

describe('whereTimestamp on PostgreSQL', () => {
  const originalClient = process.env.DATABASE_CLIENT;
  beforeAll(() => { process.env.DATABASE_CLIENT = 'pg'; });
  afterAll(() => { process.env.DATABASE_CLIENT = originalClient; });

  test('emits the plain comparison and binds the Date itself', () => {
    const query = { where: jest.fn().mockReturnThis(), whereRaw: jest.fn().mockReturnThis() };
    const at = new Date(NOW);
    expect(whereTimestamp(query, 'expires_at', '<=', at)).toBe(query);
    expect(query.where).toHaveBeenCalledWith('expires_at', '<=', at);
    expect(query.whereRaw).not.toHaveBeenCalled();
  });
});
