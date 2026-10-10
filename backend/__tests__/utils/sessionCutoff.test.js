/**
 * Unit tests for the global session cutoff (utils/sessionCutoff.js). Uses a
 * real in-memory SQLite `app_settings` table so the read/write/parse path is
 * exercised exactly as in production.
 */
const knex = require('knex');

let db;
let cutoff;

beforeEach(async () => {
  db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await db.schema.createTable('app_settings', (t) => {
    t.increments('id');
    t.string('setting_key').notNullable().unique();
    t.text('setting_value');
    t.string('setting_type');
    t.timestamp('updated_at');
  });
  jest.resetModules();
  jest.doMock('../../src/database/db', () => ({ db }));
  cutoff = require('../../src/utils/sessionCutoff');
  cutoff._resetCache();
});

afterEach(async () => {
  jest.dontMock('../../src/database/db');
  await db.destroy();
});

test('no cutoff set → nothing is invalidated', async () => {
  expect(await cutoff.getSessionsValidAfter()).toBe(0);
  expect(await cutoff.isTokenBeforeCutoff({ iat: 1000 })).toBe(false);
});

test('token issued before the cutoff is rejected, at/after is accepted', async () => {
  await cutoff.setSessionsValidAfter(2000);
  expect(await cutoff.isTokenBeforeCutoff({ iat: 1999 })).toBe(true);   // pre-restore session
  expect(await cutoff.isTokenBeforeCutoff({ iat: 2000 })).toBe(false);  // same second → kept
  expect(await cutoff.isTokenBeforeCutoff({ iat: 2001 })).toBe(false);  // post-restore login
});

test('setSessionsValidAfter upserts a single row and refreshes the cache', async () => {
  await cutoff.setSessionsValidAfter(1000);
  await cutoff.setSessionsValidAfter(3000);
  const rows = await db('app_settings').where('setting_key', 'security_sessions_valid_after');
  expect(rows).toHaveLength(1);
  cutoff._resetCache();
  expect(await cutoff.getSessionsValidAfter()).toBe(3000);
});

test('a token without iat is never treated as before the cutoff', async () => {
  await cutoff.setSessionsValidAfter(2000);
  expect(await cutoff.isTokenBeforeCutoff({})).toBe(false);
  expect(await cutoff.isTokenBeforeCutoff(null)).toBe(false);
});

test('a maintenance transaction rollback neither persists nor publishes its cutoff', async () => {
  await cutoff.setSessionsValidAfter(1000);
  await expect(db.transaction(async trx => {
    await cutoff.setSessionsValidAfter(3000, { executor: trx, refreshCache: false });
    expect((await trx('app_settings').first()).setting_value).toBe('3000');
    throw new Error('restore failed before commit');
  })).rejects.toThrow('restore failed before commit');
  expect(await cutoff.getSessionsValidAfter()).toBe(1000);
  expect((await db('app_settings').first()).setting_value).toBe('1000');
});

test('a committed maintenance cutoff becomes authoritative after replica cache restart', async () => {
  await cutoff.setSessionsValidAfter(1000);
  await db.transaction(trx => cutoff.setSessionsValidAfter(3000, { executor: trx, refreshCache: false }));
  expect(await cutoff.getSessionsValidAfter()).toBe(1000);
  cutoff._resetCache();
  expect(await cutoff.getSessionsValidAfter()).toBe(3000);
  expect(await cutoff.isTokenBeforeCutoff({ iat: 2999 })).toBe(true);
});

test.each([-1, NaN, Infinity, 1.5])('invalid cutoff %p never writes', async value => {
  await expect(cutoff.setSessionsValidAfter(value)).rejects.toThrow('Invalid session cutoff');
  expect(await db('app_settings')).toEqual([]);
});
