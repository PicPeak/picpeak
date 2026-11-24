/**
 * Issue 2482: a PostgreSQL restore loaded its dump with plain psql, which
 * reports a failing statement, carries on and exits 0, so a partial load
 * counted as a successful restore. The restore and its rollback now load in
 * one transaction with ON_ERROR_STOP, after commenting out the header
 * settings the server does not have.
 *
 * psql itself is stubbed: every call is recorded, the load (`-f`) succeeds or
 * fails as each test says. The database underneath is the SQLite test
 * database, which only serves the bookkeeping around the load.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-restore-onerror-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'restore-onerror-test-secret';

// What each psql `-f` load does, in call order: 'ok' or an Error to throw.
const mockLoads = [];
// The file each load was given, read at the moment of the call.
const mockLoaded = [];
// The role may not drop the database: every DROP DATABASE fails.
const mockDrop = { refused: false };
const mockSafetyDump = [
  '--', '-- PostgreSQL database dump', '--', '',
  'SET statement_timeout = 0;', 'SET transaction_timeout = 0;', 'SET client_encoding = \'UTF8\';', '',
  'CREATE TABLE public.safety_probe (id integer);', '',
].join('\n');

jest.mock('../../src/utils/safeExec', () => {
  const actual = jest.requireActual('../../src/utils/safeExec');
  const fsSync = require('fs');
  return {
    ...actual,
    spawnFromFile: jest.fn(async () => ({ stdout: '', stderr: '' })),
    spawnToFile: jest.fn(async (cmd, args, outputPath) => {
      if (cmd !== 'pg_dump') throw new Error(`unexpected spawnToFile ${cmd}`);
      fsSync.writeFileSync(outputPath, mockSafetyDump);
      return { stderr: '' };
    }),
    spawnAsync: jest.fn(async (cmd, args) => {
      if (cmd === 'node') return { stdout: '', stderr: '' };
      if (cmd !== 'psql') return actual.spawnAsync(cmd, args);
      const command = args[args.indexOf('-c') + 1];
      if (args.includes('-c') && command.startsWith('DROP DATABASE') && mockDrop.refused) {
        throw new Error('psql exited with code 1: ERROR:  must be owner of database picpeak_live');
      }
      if (args.includes('-c') && command.includes('current_setting')) {
        return { stdout: 'transaction_timeout\n', stderr: '' };
      }
      if (args.includes('-f')) {
        mockLoaded.push(fsSync.readFileSync(args[args.indexOf('-f') + 1], 'utf8'));
        const outcome = mockLoads.shift() || 'ok';
        if (outcome instanceof Error) throw outcome;
      }
      return { stdout: '', stderr: '' };
    }),
  };
});
jest.mock('../../src/services/emailProcessor', () => ({ queueEmail: jest.fn() }));
jest.mock('../../src/services/portableRestoreCoordinator', () => {
  const actual = jest.requireActual('../../src/services/portableRestoreCoordinator');
  return { admitUpload: async () => {}, isRegistered: () => false, pendingCoreMigrations: actual.pendingCoreMigrations };
});

const { bootCrmDb } = require('../integration/helpers/crmDb');

// The way psql 18 fails a statement under ON_ERROR_STOP when reading a file.
const psqlFailure = (file, statement) => Object.assign(
  new Error(`psql exited with code 3: psql:${file}:42: ERROR:  syntax error at or near "${statement}"\n`),
  { code: 3, stderr: `psql:${file}:42: ERROR:  syntax error at or near "${statement}"\nLINE 1: ${statement}\n        ^\n` },
);

describe('restoreService — PostgreSQL load stops at the first failing statement', () => {
  let cleanup; let RestoreService; let spawnAsync; let backupRoot;

  const psqlCalls = () => spawnAsync.mock.calls.filter(([cmd]) => cmd === 'psql').map(([, args]) => args);
  const loadCalls = () => psqlCalls().filter(args => args.includes('-f'));
  const indexOfCall = (match) => psqlCalls().findIndex(args => args.some(a => String(a).includes(match)));

  const writeDump = () => {
    const fixture = fs.readFileSync(path.join(__dirname, '../fixtures/pgDumpPlainLedger.sql'), 'utf8');
    const header = 'SET statement_timeout = 0;\nSET transaction_timeout = 0;\n';
    const dump = path.join(backupRoot, 'database', `picpeak-db-postgresql-${crypto.randomUUID()}.sql.gz`);
    fs.writeFileSync(dump, zlib.gzipSync(header + fixture));
    return dump;
  };
  const manifestFor = (dump) => ({ database: {
    backup_file: path.relative(backupRoot, dump),
    checksum: crypto.createHash('sha256').update(fs.readFileSync(dump)).digest('hex'),
  } });
  const newService = () => {
    const svc = new RestoreService();
    svc.dbType = 'postgresql';
    svc.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-restore-onerror-tmp-'));
    return svc;
  };

  beforeAll(async () => {
    ({ cleanup } = await bootCrmDb());
    // The PostgreSQL connection the psql arguments are built from; SQLite
    // ignores these fields.
    Object.assign(require('../../knexfile').connection,
      { host: 'pg.test', port: 5432, user: 'picpeak', password: 'secret', database: 'picpeak_live' });
    ({ RestoreService } = require('../../src/services/restoreService'));
    ({ spawnAsync } = require('../../src/utils/safeExec'));
    backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-restore-onerror-root-'));
    fs.mkdirSync(path.join(backupRoot, 'database'));
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(async () => {
    spawnAsync.mockClear(); mockLoads.length = 0; mockLoaded.length = 0; mockDrop.refused = false;
    // A failed rollback leaves the pool closed (the database would be empty).
    await require('../../src/database/db').reinitPool();
  });

  it('loads the dump with -f in one transaction with ON_ERROR_STOP, after the drop/create, header settings skipped', async () => {
    const svc = newService();
    const result = await svc.performDatabaseRestore(backupRoot, manifestFor(writeDump()), {});

    expect(result).toEqual({ success: true });
    expect(loadCalls()).toHaveLength(1);
    const args = loadCalls()[0];
    expect(args.slice(0, 5)).toEqual(['-X', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction']);
    expect(args.at(-2)).toBe('-f');
    expect(args.at(-1).startsWith(svc.tempDir)).toBe(true);
    // Drop, create, then load, then the sequence resync.
    const create = indexOfCall('CREATE DATABASE');
    const load = psqlCalls().indexOf(args);
    expect(indexOfCall('DROP DATABASE')).toBeLessThan(create);
    expect(create).toBeLessThan(load);
    expect(indexOfCall('setval')).toBeGreaterThan(load);
    // The header setting the server lacks was commented out before psql read the file.
    expect(mockLoaded[0]).toContain('\n--  transaction_timeout = 0;\n');
    expect(mockLoaded[0]).toContain('SET statement_timeout = 0;\n');
    expect(svc.restoreLog.map(e => e.message)).toContain('Skipped dump settings this server does not have: transaction_timeout');
  });

  it('a failing statement fails the restore with psql\'s error, and nothing runs after the load', async () => {
    const svc = newService();
    mockLoads.push(psqlFailure('/tmp/dump.db', 'BROKEN'));

    await expect(svc.performDatabaseRestore(backupRoot, manifestFor(writeDump()), {}))
      .rejects.toThrow(/^The database dump did not load, nothing of it was kept: psql:\/tmp\/dump\.db:42: ERROR: {2}syntax error at or near "BROKEN"$/);
    expect(indexOfCall('setval')).toBe(-1);
  });

  describe('rollback to the pre-restore safety backup', () => {
    const safetyBackup = (svc) => {
      const dir = fs.mkdtempSync(path.join(svc.tempDir, 'pre-restore-test-'));
      fs.writeFileSync(path.join(dir, 'backup-manifest.json'), JSON.stringify({ type: 'pre-restore-safety-backup' }));
      fs.writeFileSync(path.join(dir, 'database.sql.gz'), zlib.gzipSync(mockSafetyDump));
      return dir;
    };
    const rollbackService = () => {
      const svc = newService();
      svc.generationIndexSnapshot = [];
      svc.portableRuntimeSnapshot = { schema: false };
      svc.restoreLog = [];
      return svc;
    };

    it('drops and recreates the database, then loads the safety dump the same way', async () => {
      const svc = rollbackService();
      const portableRuntime = require('../../src/services/portableRestoreRuntimeState');
      const restoreRuntime = jest.spyOn(portableRuntime, 'restore').mockResolvedValue();
      const dir = safetyBackup(svc);
      try {
        await svc.attemptRollback(dir);
      } finally { restoreRuntime.mockRestore(); }

      expect(loadCalls()).toHaveLength(1);
      const args = loadCalls()[0];
      expect(args).toEqual(expect.arrayContaining(['-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', path.join(dir, 'database.sql')]));
      expect(indexOfCall('CREATE DATABASE')).toBeLessThan(psqlCalls().indexOf(args));
      expect(mockLoaded[0]).toContain('\n--  transaction_timeout = 0;\n');
    });

    it('a failing load fails the rollback and names the safety backup', async () => {
      const svc = rollbackService();
      const dir = safetyBackup(svc);
      mockLoads.push(psqlFailure(path.join(dir, 'database.sql'), 'OOPS'));

      const failure = svc.attemptRollback(dir);
      await expect(failure).rejects.toThrow('Rollback failed: The safety backup did not load, the database is left empty: ');
      await expect(failure).rejects.toThrow('ERROR:  syntax error at or near "OOPS"');
      await expect(failure).rejects.toThrow(`the pre-restore safety backup is kept in ${dir}`);
    });

    it('a refused DROP fails the rollback but leaves this process a working pool', async () => {
      const svc = rollbackService();
      const dir = safetyBackup(svc);
      mockDrop.refused = true;

      await expect(svc.attemptRollback(dir)).rejects.toThrow('must be owner of database');
      expect(loadCalls()).toHaveLength(0);
      // The database was never touched; the app must still reach it.
      const { db } = require('../../src/database/db');
      await expect(db.raw('select 1 as ok')).resolves.toBeDefined();
    });
  });

  describe('a whole restore run', () => {
    const run = (svc, dump) => {
      svc.loadAndValidateManifest = async () => require('../../src/services/backupManifest').signManifest({
        manifest: { version: '3.0' }, system: {}, application: {}, verification: {},
        backup: { id: 'b1', type: 'full', timestamp: new Date().toISOString() },
        files: { count: 0, total_size: 0, manifest: [] },
        database: { type: 'postgresql', ...manifestFor(dump).database },
        metadata: {},
      });
      svc.performPreRestoreValidation = async () => ({ isValid: true, errors: [], warnings: [] });
      svc.checkDiskSpace = async () => ({ hasEnoughSpace: true });
      svc.sendRestoreNotification = jest.fn(async () => {});
      return svc.restore({ source: backupRoot, manifestPath: path.join(backupRoot, 'm.json'), restoreType: 'database' });
    };
    let restoreRuntime;
    beforeEach(() => {
      restoreRuntime = jest.spyOn(require('../../src/services/portableRestoreRuntimeState'), 'restore').mockResolvedValue();
    });
    afterEach(() => restoreRuntime.mockRestore());

    it('a dump that does not load rolls back to the safety backup and reports psql\'s error', async () => {
      const svc = newService();
      mockLoads.push(psqlFailure('/tmp/dump.db', 'BROKEN'));

      await expect(run(svc, writeDump())).rejects.toThrow(/did not load.*ERROR: {2}syntax error at or near "BROKEN"/);

      expect(loadCalls()).toHaveLength(2); // the dump, then the safety backup
      expect(svc.sendRestoreNotification).toHaveBeenCalledWith('failure', expect.objectContaining({
        rollbackAttempted: true, rollbackSucceeded: true, error: expect.stringContaining('syntax error at or near "BROKEN"'),
      }));
      expect(fs.existsSync(svc.tempDir)).toBe(false);
      const { db } = require('../../src/database/db');
      const row = await db('restore_runs').orderBy('id', 'desc').first();
      expect(row.status).toBe('failed');
      expect(row.error_message).toMatch(/did not load.*syntax error at or near "BROKEN".*\(rolled back successfully to pre-restore state\)$/);
    });

    it('when the rollback fails too, the safety backup is kept and named', async () => {
      const svc = newService();
      mockLoads.push(psqlFailure('/tmp/dump.db', 'BROKEN'), psqlFailure('/tmp/database.sql', 'OOPS'));

      await expect(run(svc, writeDump())).rejects.toThrow(/did not load.*BROKEN/);

      expect(svc.sendRestoreNotification).toHaveBeenCalledWith('failure', expect.objectContaining({
        rollbackAttempted: true, rollbackSucceeded: false,
      }));
      const rollbackFailure = svc.restoreLog.find(e => e.message.startsWith('Rollback FAILED'));
      expect(rollbackFailure.details.error).toContain('syntax error at or near "OOPS"');
      const kept = rollbackFailure.details.error.match(/safety backup is kept in (\S+) /)[1];
      expect(path.dirname(kept)).toBe(svc.tempDir);
      expect(fs.readdirSync(svc.tempDir)).toEqual([path.basename(kept)]);
      expect(fs.existsSync(path.join(kept, 'database.sql.gz'))).toBe(true);
      fs.rmSync(svc.tempDir, { recursive: true, force: true });
    });
  });
});
