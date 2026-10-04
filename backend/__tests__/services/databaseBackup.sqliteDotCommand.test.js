/**
 * createSQLiteBackup used to interpolate the configured destination into
 * `sqlite3 .backup '<path>'`. sqlite3 parses that argument with its own
 * tokenizer (spawn's shell:false does not help), so a quote or line break in
 * `database_backup_destination_path` ended the filename and ran whatever
 * followed as a second dot-command. The copy is now written to a
 * server-generated path in a conservative charset and moved afterwards.
 * Scanner finding d499ed38.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-sqlitedot-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'sqlitedot-test-secret';

jest.mock('../../src/database/db', () => ({ db: jest.fn() }));
jest.mock('../../src/services/emailProcessor', () => ({ queueEmail: jest.fn() }));
jest.mock('../../src/utils/safeExec', () => ({
  spawnAsync: jest.fn(),
  spawnToFile: jest.fn(),
}));

const { spawnAsync } = require('../../src/utils/safeExec');
const { DatabaseBackupService, destinationPathProblem } = require('../../src/services/databaseBackup');

const SAFE = /^\.backup '([A-Za-z0-9._/-]+)'$/;

describe('createSQLiteBackup — the .backup dot-command never carries the destination', () => {
  let service; let destDir;

  beforeEach(() => {
    spawnAsync.mockReset();
    spawnAsync.mockImplementation(async (cmd, args) => {
      // Emulate `.backup` by creating the target so the later rename works.
      if (cmd === 'sqlite3' && typeof args[1] === 'string' && args[1].startsWith('.backup ')) {
        const m = args[1].match(/^\.backup '(.*)'$/s);
        fs.writeFileSync(m[1], 'sqlite-copy');
      }
      return { stdout: 'ok', stderr: '' };
    });
    service = new DatabaseBackupService();
    service.dbType = 'sqlite';
  });

  afterEach(() => {
    if (destDir) fs.rmSync(destDir, { recursive: true, force: true });
    destDir = null;
  });

  it.each([
    ['single quote + dot-command', 'evil\' .shell id ; \''],
    ['newline + dot-command', 'evil\n.shell id'],
    ['double quote', 'evil"dir'],
  ])('%s in the destination directory', async (_label, dirName) => {
    destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-sqlitedot-dest-'));
    const outputDir = path.join(destDir, dirName);
    fs.mkdirSync(outputDir);
    const outputPath = path.join(outputDir, 'picpeak-db-sqlite-2026.sqlite');

    await service.createSQLiteBackup(outputPath);

    const backupCalls = spawnAsync.mock.calls.filter(([cmd, args]) => cmd === 'sqlite3' && String(args[1]).startsWith('.backup'));
    expect(backupCalls).toHaveLength(1);
    const dotCommand = backupCalls[0][1][1];
    expect(dotCommand).toMatch(SAFE);
    expect(dotCommand).not.toContain(dirName);
    // Every other sqlite3 call gets the copy as its own argv element.
    for (const [cmd, args] of spawnAsync.mock.calls) {
      if (cmd !== 'sqlite3') continue;
      expect(args[0]).toMatch(/^[A-Za-z0-9._/-]+$/);
    }
    // The finished copy still lands at the configured destination.
    expect(fs.readFileSync(outputPath, 'utf8')).toBe('sqlite-copy');
  });

  it('stages a copy that cannot sit beside the output in a private directory, 0600, and removes it', async () => {
    destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-sqlitedot-dest-'));
    const outputDir = path.join(destDir, 'with space');
    fs.mkdirSync(outputDir);
    const outputPath = path.join(outputDir, 'picpeak-db-sqlite-2026.sqlite');
    const seen = {};
    spawnAsync.mockImplementation(async (cmd, args) => {
      if (cmd === 'sqlite3' && typeof args[1] === 'string' && args[1].startsWith('.backup ')) {
        const m = args[1].match(/^\.backup '(.*)'$/s);
        fs.writeFileSync(m[1], 'sqlite-copy', { mode: 0o644 });
        seen.tempPath = m[1];
      } else if (cmd === 'sqlite3' && args[1] === 'VACUUM;') {
        // While the copy is being scrubbed: private dir, private file.
        seen.dirMode = fs.statSync(path.dirname(args[0])).mode & 0o777;
        seen.fileMode = fs.statSync(args[0]).mode & 0o777;
      }
      return { stdout: 'ok', stderr: '' };
    });

    await service.createSQLiteBackup(outputPath);

    expect(path.dirname(seen.tempPath)).not.toBe(os.tmpdir());
    expect(path.dirname(seen.tempPath).startsWith(os.tmpdir())).toBe(true);
    expect(seen.dirMode).toBe(0o700);
    expect(seen.fileMode).toBe(0o600);
    expect(fs.existsSync(path.dirname(seen.tempPath))).toBe(false);
    expect(fs.readFileSync(outputPath, 'utf8')).toBe('sqlite-copy');
  });

  it('writes the temp copy next to the output when that directory is already safe', async () => {
    destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-sqlitedot-safe-'));
    const outputPath = path.join(destDir, 'picpeak-db-sqlite-2026.sqlite');
    await service.createSQLiteBackup(outputPath);
    const dotCommand = spawnAsync.mock.calls.find(([cmd, args]) => cmd === 'sqlite3' && String(args[1]).startsWith('.backup'))[1][1];
    expect(dotCommand.match(SAFE)[1].startsWith(destDir + path.sep)).toBe(true);
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.readdirSync(destDir)).toEqual(['picpeak-db-sqlite-2026.sqlite']);
  });
});

describe('destinationPathProblem', () => {
  it('flags quotes, backslashes and control characters, nothing else', () => {
    expect(destinationPathProblem('/var/backups/picpeak db.v2-x')).toBeNull();
    expect(destinationPathProblem(undefined)).toBeNull();
    for (const bad of ['a\'b', 'a"b', 'a`b', 'a\\b', 'a\nb', 'a\rb', 'a\tb', 'a\u0000b', 'a\u007fb']) {
      expect(destinationPathProblem(bad)).toMatch(/quotes, backslashes or control characters/);
    }
  });
});
