/**
 * The steps run-migrations.js and run-migrations-safe.js share (issue 2615).
 * Pins what both runners did before the merge: which files a new and an
 * existing deployment consider, in what order, and that a PostgreSQL run
 * records the migration inside the migration's own transaction.
 */

const fs = require('fs');
const path = require('path');

const MIGRATIONS = path.join(__dirname, '../../migrations');

const mockInsert = jest.fn();
const mockTrxInsert = jest.fn();
const mockDb = Object.assign(jest.fn(() => ({ insert: mockInsert })), {
  client: { config: { client: 'sqlite3' } },
  transaction: jest.fn(async (fn) => fn(Object.assign(jest.fn(() => ({ insert: mockTrxInsert })), { isTrx: true }))),
});
jest.mock('../../src/database/db', () => ({ db: mockDb }));

const { listMigrationFiles, runMigrationFile } = require('../../migrations/run-migrations-shared');

const numbered = (dir) => fs.readdirSync(path.join(MIGRATIONS, dir))
  .filter((f) => /^\d{3}_.*\.js$/.test(f))
  .map((f) => path.join(dir, f));
const number = (f) => parseInt(path.basename(f).split('_')[0]);

describe('run-migrations-shared', () => {
  let log;
  beforeEach(() => {
    jest.clearAllMocks();
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => log.mockRestore());

  test('a new deployment considers core/ only, in number order', async () => {
    const files = await listMigrationFiles(true);
    expect(log).toHaveBeenCalledWith('New deployment detected - running core migrations only');
    expect(files.slice().sort()).toEqual(numbered('core').sort());
    expect(files.map(number)).toEqual(files.map(number).slice().sort((a, b) => a - b));
  });

  test('an existing deployment considers legacy/ and core/ together, in number order', async () => {
    const files = await listMigrationFiles(false);
    expect(log).toHaveBeenCalledWith('Existing deployment detected - checking all migrations');
    expect(files.slice().sort()).toEqual([...numbered('legacy'), ...numbered('core')].sort());
    expect(files.map(number)).toEqual(files.map(number).slice().sort((a, b) => a - b));
    // The sort is stable, so same-numbered legacy files stay ahead of core.
    const legacy009 = files.findIndex((f) => f.startsWith('legacy/009_'));
    const core009 = files.findIndex((f) => f.startsWith('core/009_'));
    if (legacy009 >= 0 && core009 >= 0) expect(legacy009).toBeLessThan(core009);
  });

  test('the runners and this module are never listed as migrations', async () => {
    const files = await listMigrationFiles(false);
    expect(files.some((f) => /run-migrations|helpers/.test(f))).toBe(false);
    // The updater counts /app/migrations/**.js minus `/run-migrations*`.
    expect(path.basename(require.resolve('../../migrations/run-migrations-shared'))).toMatch(/^run-migrations/);
  });

  describe('runMigrationFile', () => {
    const rel = 'core/999_shared_runner_fixture.js';
    const up = jest.fn();
    beforeAll(() => {
      jest.doMock(path.join(MIGRATIONS, rel), () => ({ up }), { virtual: true });
    });

    test('SQLite runs the migration on db, then records it, with the caller\'s log line', async () => {
      mockDb.client.config.client = 'sqlite3';
      await runMigrationFile(rel, 'completed successfully');
      expect(up).toHaveBeenCalledWith(mockDb);
      expect(mockDb.transaction).not.toHaveBeenCalled();
      expect(mockDb).toHaveBeenCalledWith('migrations');
      expect(mockInsert).toHaveBeenCalledWith({ filename: '999_shared_runner_fixture.js' });
      expect(log.mock.calls.map((c) => c[0])).toEqual([
        `Running migration: ${rel}`,
        `Migration ${rel} completed successfully`,
      ]);
    });

    test('PostgreSQL runs the migration and its record in one transaction', async () => {
      mockDb.client.config.client = 'pg';
      await runMigrationFile(rel, 'completed');
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(up.mock.calls[0][0].isTrx).toBe(true);
      expect(mockTrxInsert).toHaveBeenCalledWith({ filename: '999_shared_runner_fixture.js' });
      expect(mockInsert).not.toHaveBeenCalled();
      expect(log).toHaveBeenLastCalledWith(`Migration ${rel} completed`);
    });

    test('a failing migration propagates its error and records nothing', async () => {
      mockDb.client.config.client = 'sqlite3';
      up.mockRejectedValueOnce(Object.assign(new Error('table x already exists'), { code: 'SQLITE_ERROR' }));
      await expect(runMigrationFile(rel, 'completed')).rejects.toMatchObject({ code: 'SQLITE_ERROR' });
      expect(mockInsert).not.toHaveBeenCalled();
    });
  });
});
