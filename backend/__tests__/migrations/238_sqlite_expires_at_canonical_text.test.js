/**
 * Migration 238: expires_at text SQLite's date parser cannot read is
 * rewritten in canonical ISO form once, so whereTimestamp's julianday()
 * expression keeps seeing the row (issue 1733).
 */
// A non-UTC server zone: the zone-less rows must keep the instant SQL reads.
// (Not forced here: process.env.TZ does not re-bind inside a running jest
// process. The non-UTC server zone is proven in a child process in
// __tests__/utils/expiresAtText.test.js; these cases hold in every zone.)

const knex = require('knex');
const migration = require('../../migrations/core/238_sqlite_expires_at_canonical_text');

describe('migration 238 on SQLite', () => {
  let db;
  const NOW = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  beforeEach(async () => {
    db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await db.schema.createTable('events', (t) => {
      t.increments('id').primary();
      t.string('slug');
      t.timestamp('expires_at');
    });
    await db('events').insert([
      { id: 1, slug: 'compact-offset', expires_at: '2026-10-06T12:00:00+0200' },
      { id: 2, slug: 'basic-format', expires_at: '20261006T120000Z' },
      { id: 3, slug: 'landmine', expires_at: '[object Object]' },
      { id: 4, slug: 'already-iso', expires_at: new Date(NOW + DAY).toISOString() },
      { id: 5, slug: 'epoch-ms', expires_at: NOW + DAY },
      { id: 6, slug: 'zone-less', expires_at: '2026-10-02 12:00:00' },
      { id: 7, slug: 'never', expires_at: null },
      { id: 8, slug: 'bare-date', expires_at: '2026-10-03' },
      { id: 9, slug: 'zone-less-t', expires_at: '2026-10-02T12:00:00' },
    ]);
  });

  afterEach(async () => { await db.destroy(); });

  const row = async (id) => (await db('events').where({ id }).first()).expires_at;

  it('rewrites every non-canonical text form and leaves the rest alone', async () => {
    // What SQL reads the zone-less rows as before the rewrite.
    const epochBefore = async (id) => (await db('events').where({ id })
      .first(db.raw('CAST(round((julianday(expires_at) - 2440587.5) * 86400000) AS INTEGER) AS ms'))).ms;
    const before = { 6: await epochBefore(6), 8: await epochBefore(8), 9: await epochBefore(9) };

    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await migration.up(db);
    } finally {
      log.mockRestore();
    }

    // Zone-less text becomes the UTC instant SQL already took it for, so
    // `new Date()` in the JS readers no longer reads it as local time.
    expect(await row(6)).toBe('2026-10-02T12:00:00.000Z');
    expect(await row(8)).toBe('2026-10-03T00:00:00.000Z');
    expect(await row(9)).toBe('2026-10-02T12:00:00.000Z');
    for (const id of [6, 8, 9]) {
      expect(new Date(await row(id)).getTime()).toBe(before[id]);
      expect(await epochBefore(id)).toBe(before[id]);
    }

    expect(await row(1)).toBe('2026-10-06T10:00:00.000Z');
    // Node cannot parse the basic format either: left as it was, named in the log.
    expect(await row(2)).toBe('20261006T120000Z');
    expect(await row(3)).toBe('[object Object]');
    expect(await row(4)).toBe(new Date(NOW + DAY).toISOString());
    expect(await row(5)).toBe(NOW + DAY);
    expect(await row(7)).toBeNull();

    // What the readers see afterwards: only the two unparsable rows are
    // still without an epoch.
    const unreadable = await db('events')
      .whereRaw("typeof(expires_at) = 'text' AND julianday(expires_at) IS NULL")
      .pluck('id');
    expect(Array.from(unreadable).sort()).toEqual([2, 3]);
  });

  it('names the rows it could not read', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await migration.up(db);
      expect(log.mock.calls.map((c) => c.join(' ')).join('\n'))
        .toMatch(/4 expires_at value\(s\) rewritten.*left unreadable on events 2, 3/);
    } finally {
      log.mockRestore();
    }
  });

  it('runs again without changing anything, and down() is a no-op', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await migration.up(db);
      const before = await db('events').orderBy('id');
      await migration.up(db);
      expect(await db('events').orderBy('id')).toEqual(before);
      await expect(migration.down(db)).resolves.toBeUndefined();
      expect(await db('events').orderBy('id')).toEqual(before);
    } finally {
      log.mockRestore();
    }
  });

  it('does nothing on PostgreSQL or without the table', async () => {
    const pg = { client: { config: { client: 'pg' } }, schema: { hasTable: jest.fn() } };
    await migration.up(pg);
    expect(pg.schema.hasTable).not.toHaveBeenCalled();

    await db.schema.dropTable('events');
    await expect(migration.up(db)).resolves.toBeUndefined();
  });
});
