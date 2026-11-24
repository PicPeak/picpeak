/**
 * A scheduled SQLite backup failed in production with
 *   "sqlite3 exited with code 1: Error: database is locked"
 * The sqlite3 CLI's busy timeout defaults to 0, so `.backup` gave up the
 * instant the running app held a write lock instead of waiting for the
 * commit. Real sqlite3 CLI against a real file: another connection holds an
 * EXCLUSIVE lock while the backup starts, then commits.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync, execFileSync } = require('child_process');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-sqlitebusy-'));
const dbPath = path.join(workDir, 'db.sqlite');
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = dbPath;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'sqlitebusy-test-secret';

jest.mock('../../src/database/db', () => ({ db: jest.fn() }));
jest.mock('../../src/services/emailProcessor', () => ({ queueEmail: jest.fn() }));

const { DatabaseBackupService } = require('../../src/services/databaseBackup');

const native = spawnSync('sqlite3', ['-version']).status === 0;
const nativeIt = native ? it : it.skip;

// Opens a second connection, takes an EXCLUSIVE lock and resolves once the
// lock is held. release() commits and closes it.
function holdExclusiveLock() {
  const child = spawn('sqlite3', [dbPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise((resolve) => child.on('close', resolve));
  const held = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('locked-now')) resolve(); });
    child.on('error', reject);
  });
  child.stdin.write('BEGIN EXCLUSIVE; INSERT INTO t VALUES (2);\n.print locked-now\n');
  return {
    held,
    release: async () => {
      child.stdin.end('COMMIT;\n.quit\n');
      await closed;
    },
  };
}

afterAll(() => fs.rmSync(workDir, { recursive: true, force: true }));

describe('createSQLiteBackup waits for a write lock held by another connection', () => {
  nativeIt('succeeds once the lock is released instead of failing with "database is locked"', async () => {
    execFileSync('sqlite3', [dbPath, 'CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);']);
    const outputPath = path.join(workDir, 'backup.sqlite');
    const service = new DatabaseBackupService();
    service.dbType = 'sqlite';

    const lock = holdExclusiveLock();
    await lock.held;
    const backup = service.createSQLiteBackup(outputPath);
    // Without a busy timeout the backup has already failed by now.
    const released = new Promise((resolve) => setTimeout(resolve, 1000)).then(lock.release);

    await expect(backup).resolves.toEqual({ success: true });
    await released;
    // The copy was taken after the commit, so it carries the locked write.
    expect(execFileSync('sqlite3', [outputPath, 'SELECT count(*) FROM t;']).toString().trim()).toBe('2');
  }, 20000);
});
