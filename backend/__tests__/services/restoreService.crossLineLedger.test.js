/**
 * Issue 2480, native restore: a SQLite dump carries the runner's ledger
 * (`migrations`), and the restore put it in place verbatim. stable backports
 * main's migrations under its own numbers, so a dump from the other line
 * recorded foreign filenames, and the target's runner skipped its own
 * counterparts. The restore now reads the dump's ledger before replacing
 * anything (unknown names are refused) and drops the other line's twins
 * after the swap so this code's counterparts run.
 *
 * Real SQLite end to end: the dump is a copy of the booted test database,
 * replayed with the sqlite3 CLI. Only the migration runner subprocess is
 * stubbed; it records the ledger it would have started from.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-restore-ledger-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'restore-ledger-test-secret';

const runnerLedgers = [];
jest.mock('../../src/utils/safeExec', () => {
  const actual = jest.requireActual('../../src/utils/safeExec');
  return {
    ...actual,
    spawnFromFile: jest.fn(actual.spawnFromFile),
    spawnAsync: jest.fn(async (cmd, args, opts) => {
      if (cmd === 'node') {
        const { db } = require('../../src/database/db');
        runnerLedgers.push(Array.from(await db('migrations').pluck('filename')));
        return { stdout: '', stderr: '' };
      }
      return actual.spawnAsync(cmd, args, opts);
    }),
  };
});
jest.mock('../../src/services/emailProcessor', () => ({ queueEmail: jest.fn() }));
jest.mock('../../src/services/portableRestoreCoordinator', () => {
  const actual = jest.requireActual('../../src/services/portableRestoreCoordinator');
  return { admitUpload: async () => {}, isRegistered: () => false, pendingCoreMigrations: actual.pendingCoreMigrations };
});

const knex = require('knex');
const { bootCrmDb } = require('../integration/helpers/crmDb');

const native = spawnSync('sqlite3', ['-version']).status === 0;
const nativeIt = native ? it : it.skip;

describe('restoreService — migration ledger of another release line', () => {
  let cleanup; let RestoreService; let db; let spawnAsync; let backupRoot; let shipped;

  const MARKER = 'native_ledger_test_marker';
  const marker = async () => {
    const row = await db('app_settings').where({ setting_key: MARKER }).first();
    return row && row.setting_value;
  };
  const setMarker = value => db('app_settings')
    .insert({ setting_key: MARKER, setting_value: value, setting_type: 'test', updated_at: new Date().toISOString() })
    .onConflict('setting_key').merge({ setting_value: value });
  const ledger = async () => Array.from(await db('migrations').pluck('filename')).sort();
  const latestRun = () => db('restore_runs').orderBy('id', 'desc').first();

  // A dump of the live test database whose ledger `edit` rewrites, and whose
  // marker says "dump", so a replay is visible.
  let dumpCount = 0;
  const makeDump = async (edit, { gzip = false } = {}) => {
    dumpCount += 1;
    const file = path.join(backupRoot, 'database', `picpeak-db-sqlite-${dumpCount}.sql`);
    await setMarker('dump');
    await db.raw('VACUUM INTO ?', [file]);
    await setMarker('target');
    const copy = knex({ client: 'sqlite3', connection: { filename: file }, useNullAsDefault: true });
    try { await edit(copy); } finally { await copy.destroy(); }
    if (!gzip) return file;
    fs.writeFileSync(`${file}.gz`, require('zlib').gzipSync(fs.readFileSync(file)));
    fs.rmSync(file);
    return `${file}.gz`;
  };

  const restore = async (dumpFile, restoreType = 'database') => {
    const svc = new RestoreService();
    svc.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-restore-ledger-tmp-'));
    svc.loadAndValidateManifest = async () => require('../../src/services/backupManifest').signManifest({
      manifest: { version: '3.0' }, system: {}, application: {}, verification: {},
      backup: { id: 'b1', type: 'full', timestamp: new Date().toISOString() },
      files: { count: 0, total_size: 0, manifest: [] },
      database: {
        type: 'sqlite',
        backup_file: path.relative(backupRoot, dumpFile),
        checksum: crypto.createHash('sha256').update(fs.readFileSync(dumpFile)).digest('hex'),
      },
      metadata: {},
    });
    svc.performPreRestoreValidation = async () => ({ isValid: true, errors: [], warnings: [] });
    svc.checkDiskSpace = async () => ({ hasEnoughSpace: true });
    svc.performFilesRestore = async () => ({ filesRestored: 0 });
    svc.requeueFaceScans = async () => {};
    svc.sendRestoreNotification = jest.fn(async () => {});
    return svc.restore({ source: backupRoot, manifestPath: path.join(backupRoot, 'm.json'), restoreType, skipPreBackup: true });
  };
  const sqliteRestoreCalls = () => spawnAsync.mock.calls.filter(([cmd, args]) => cmd === 'sqlite3' && String(args.at(-1)).startsWith('.restore'));

  beforeAll(async () => {
    ({ cleanup } = await bootCrmDb());
    ({ RestoreService } = require('../../src/services/restoreService'));
    ({ db } = require('../../src/database/db'));
    ({ spawnAsync } = require('../../src/utils/safeExec'));
    backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-restore-ledger-root-'));
    fs.mkdirSync(path.join(backupRoot, 'database'));
    shipped = await ledger();
  }, 120000);

  afterAll(async () => { if (cleanup) await cleanup(); });

  beforeEach(() => { spawnAsync.mockClear(); runnerLedgers.length = 0; });

  it.each([['database', false], ['full', true]])('refuses a %s restore of a dump with an unknown migration before anything is changed (gzip: %s)', async (restoreType, gzip) => {
    const dump = await makeDump(copy => copy('migrations').insert({ filename: '999_a_migration_from_the_future.js' }), { gzip });

    await expect(restore(dump, restoreType)).rejects.toMatchObject({
      code: 'RESTORE_LEDGER_UNKNOWN_MIGRATIONS',
      message: expect.stringMatching(/^(Full restore failed: )?RESTORE_LEDGER_UNKNOWN_MIGRATIONS: .*999_a_migration_from_the_future\.js/),
    });

    expect(sqliteRestoreCalls()).toHaveLength(0);
    expect(runnerLedgers).toHaveLength(0);
    expect(await marker()).toBe('target');
    expect(await ledger()).toEqual(shipped);
    const run = await latestRun();
    expect(run.status).toBe('blocked');
    expect(run.error_message).toContain('RESTORE_LEDGER_UNKNOWN_MIGRATIONS: ');
    expect(run.error_message).toContain('this install was not modified');
  });

  it('refuses a gzipped dump that expands past RESTORE_MAX_DECOMPRESSED_BYTES before anything is changed', async () => {
    const dump = await makeDump(async () => {}, { gzip: true });
    process.env.RESTORE_MAX_DECOMPRESSED_BYTES = String(64 * 1024);
    try {
      await expect(restore(dump)).rejects.toThrow(/Decompressed size exceeds limit of 65536 bytes/);
    } finally { delete process.env.RESTORE_MAX_DECOMPRESSED_BYTES; }

    expect(sqliteRestoreCalls()).toHaveLength(0);
    expect(await marker()).toBe('target');
    const run = await latestRun();
    expect(run.status).toBe('blocked');
  });

  it('refuses a PostgreSQL dump with an unknown migration before the first psql call', async () => {
    const fixture = fs.readFileSync(path.join(__dirname, '../fixtures/pgDumpPlainLedger.sql'), 'utf8');
    const dump = path.join(backupRoot, 'database', 'picpeak-db-postgresql-1.sql.gz');
    fs.writeFileSync(dump, require('zlib').gzipSync(fixture.replace(
      /(\n2\t366_[^\n]*)/, '$1\n3\t999_a_migration_from_the_future.js\t2026-11-22 21:15:04+00',
    )));
    const svc = new RestoreService();
    svc.dbType = 'postgresql';
    svc.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-restore-ledger-tmp-'));
    const { spawnFromFile } = require('../../src/utils/safeExec');
    spawnFromFile.mockClear();

    await expect(svc.performDatabaseRestore(backupRoot, { database: {
      backup_file: path.relative(backupRoot, dump),
      checksum: crypto.createHash('sha256').update(fs.readFileSync(dump)).digest('hex'),
    } }, {})).rejects.toMatchObject({ code: 'RESTORE_LEDGER_UNKNOWN_MIGRATIONS', beforeDestinationChange: true });

    expect(spawnAsync.mock.calls.filter(([cmd]) => cmd === 'psql')).toHaveLength(0);
    expect(spawnFromFile).not.toHaveBeenCalled();
    expect(svc.preservedMetaSnapshot).toEqual([]);
    expect(fs.readdirSync(svc.tempDir)).toEqual([]);
  });

  nativeIt('drops the other line\'s twins after the swap, before the migration runner starts', async () => {
    const counterpart = shipped.filter(name => /^\d+_/.test(name)).pop();
    const twin = counterpart.replace(/^\d+_/, '9876_');
    const dump = await makeDump(copy => copy('migrations').where({ filename: counterpart }).update({ filename: twin }));

    const result = await restore(dump);

    expect(result.success).toBe(true);
    expect(sqliteRestoreCalls()).toHaveLength(1);
    expect(await marker()).toBe('dump');
    // The runner starts from a ledger without the twin, so it applies this
    // line's own counterpart.
    expect(runnerLedgers).toHaveLength(1);
    expect(runnerLedgers[0]).not.toContain(twin);
    expect(runnerLedgers[0]).not.toContain(counterpart);
    expect(await ledger()).toEqual(shipped.filter(name => name !== counterpart));

    await db('migrations').insert({ filename: counterpart });
  });

  nativeIt('a same-line dump restores its ledger unchanged', async () => {
    const dump = await makeDump(async () => {});

    const result = await restore(dump);

    expect(result.success).toBe(true);
    expect(await marker()).toBe('dump');
    expect(runnerLedgers).toEqual([shipped]);
    expect(await ledger()).toEqual(shipped);
  });

  nativeIt('an unknown name only the restored table shows is refused before the runner starts', async () => {
    // The dump check reads the ledger and finds it clean; an unknown name in
    // the restored table (here put there behind the check's back) still
    // stops the run before the runner starts.
    const dump = await makeDump(async () => {});
    const svcProto = RestoreService.prototype;
    const original = svcProto.reconcileRestoredLedger;
    svcProto.reconcileRestoredLedger = async function reconcile() {
      await db('migrations').insert({ filename: '999_slipped_through.js' });
      return original.call(this);
    };
    try {
      await expect(restore(dump)).rejects.toMatchObject({ code: 'RESTORE_LEDGER_UNKNOWN_MIGRATIONS' });
    } finally {
      svcProto.reconcileRestoredLedger = original;
      await db('migrations').where({ filename: '999_slipped_through.js' }).del();
    }
    expect(runnerLedgers).toHaveLength(0);
    const run = await latestRun();
    expect(run.status).toBe('failed');
  });
});
