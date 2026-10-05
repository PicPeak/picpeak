/**
 * expires_at text parsing agrees with how julianday() reads the stored rows:
 * a zone-less value is UTC, whatever the server's zone (issue 1733).
 */
const path = require('path');
const { execFileSync } = require('child_process');
const knex = require('knex');
const { parseExpiresAtText, canonicaliseSqliteExpiresAt } = require('../../src/utils/expiresAtText');

describe('parseExpiresAtText in a non-UTC server zone', () => {
  // The suite itself runs in whatever zone the host has (UTC on CI), where
  // reading a zone-less value as local and as UTC give the same answer, and
  // process.env.TZ does not re-bind inside a running process. So the zone the
  // bug needs is forced in a child process, which fails on any host.
  test('a zone-less date-time is read as UTC, not as local time', () => {
    const helper = path.resolve(__dirname, '../../src/utils/expiresAtText');
    const out = execFileSync(process.execPath, ['-e', `
      const { parseExpiresAtText } = require(${JSON.stringify(helper)});
      console.log(JSON.stringify({
        offset: new Date(2026, 0, 1).getTimezoneOffset(),
        naive: parseExpiresAtText('2026-10-06T12:00:00').toISOString(),
        spaced: parseExpiresAtText('2026-10-06 12:00:00').toISOString(),
        local: new Date('2026-10-06T12:00:00').toISOString(),
      }));
    `], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' });
    const seen = JSON.parse(out);
    expect(seen.offset).not.toBe(0); // the zone really applies in the child
    expect(seen.local).toBe('2026-10-06T16:00:00.000Z'); // what a bare new Date() makes of it
    expect(seen.naive).toBe('2026-10-06T12:00:00.000Z');
    expect(seen.spaced).toBe('2026-10-06T12:00:00.000Z');
  });

  test('the zone-less shapes, in the suite\'s own zone', () => {
    expect(parseExpiresAtText('2026-10-06T12:00:00').toISOString()).toBe('2026-10-06T12:00:00.000Z');
    expect(parseExpiresAtText('2026-10-06 12:00:00').toISOString()).toBe('2026-10-06T12:00:00.000Z');
    expect(parseExpiresAtText('2026-10-06T12:00').toISOString()).toBe('2026-10-06T12:00:00.000Z');
    expect(parseExpiresAtText('2026-10-06 12:00:00.250').toISOString()).toBe('2026-10-06T12:00:00.250Z');
  });

  test('an explicit zone wins, and a bare date is the UTC midnight it already was', () => {
    expect(parseExpiresAtText('2026-10-06T12:00:00+0200').toISOString()).toBe('2026-10-06T10:00:00.000Z');
    expect(parseExpiresAtText('2026-10-06T12:00:00Z').toISOString()).toBe('2026-10-06T12:00:00.000Z');
    expect(parseExpiresAtText('2026-10-06').toISOString()).toBe('2026-10-06T00:00:00.000Z');
  });

  test('what cannot be read is null', () => {
    for (const v of ['20261006T120000Z', '[object Object]', '', '  ', null, undefined, 42, 'tomorrow']) {
      expect(parseExpiresAtText(v)).toBeNull();
    }
  });
});

describe('canonicaliseSqliteExpiresAt', () => {
  let db;
  beforeEach(async () => {
    db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await db.schema.createTable('events', (t) => { t.increments('id').primary(); t.timestamp('expires_at'); });
  });
  afterEach(async () => { await db.destroy(); });

  test('rewrites every non-canonical text form, and reports what it cannot read', async () => {
    await db('events').insert([
      { id: 1, expires_at: '2026-10-06T12:00:00+0200' },
      { id: 2, expires_at: '[object Object]' },
      { id: 3, expires_at: '2026-10-02 12:00:00' },
    ]);
    await db('events').insert([
      { id: 4, expires_at: '2026-10-06T12:00:00.000Z' },
      { id: 5, expires_at: 1790000000000 },
    ]);
    expect(await canonicaliseSqliteExpiresAt(db)).toEqual({ rewritten: 2, unreadable: [2] });
    expect((await db('events').where({ id: 1 }).first()).expires_at).toBe('2026-10-06T10:00:00.000Z');
    // Zone-less: the UTC instant SQL already reads, under a non-UTC TZ.
    expect((await db('events').where({ id: 3 }).first()).expires_at).toBe('2026-10-02T12:00:00.000Z');
    expect((await db('events').where({ id: 4 }).first()).expires_at).toBe('2026-10-06T12:00:00.000Z');
    expect((await db('events').where({ id: 5 }).first()).expires_at).toBe(1790000000000);
    expect(await canonicaliseSqliteExpiresAt(db)).toEqual({ rewritten: 0, unreadable: [2] });
  });

  test('is a no-op on PostgreSQL and without the column', async () => {
    const pg = { client: { config: { client: 'pg' } }, schema: { hasTable: jest.fn() } };
    expect(await canonicaliseSqliteExpiresAt(pg)).toEqual({ rewritten: 0, unreadable: [] });
    expect(pg.schema.hasTable).not.toHaveBeenCalled();
    await db.schema.dropTable('events');
    expect(await canonicaliseSqliteExpiresAt(db)).toEqual({ rewritten: 0, unreadable: [] });
  });
});
