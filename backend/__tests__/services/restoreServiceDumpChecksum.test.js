/**
 * A database restore replays the dump as SQL, so the dump must be the one the
 * backup manifest describes. The manifest has always recorded the dump's
 * SHA-256 (database.checksum), but the restore only ever checked per-file
 * checksums, so a dump that was swapped or truncated in the backup store was
 * still replayed.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-dumpsum-')), 'db.sqlite',
);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'dump-checksum-test-secret';

const { bootCrmDb, seedMinimal } = require('../integration/helpers/crmDb');

describe('restoreService — database dump checksum', () => {
  let db; let cleanup; let _internal; let RestoreService;
  let backupPath;
  const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    backupPath = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-dumpsum-root-'));
    fs.mkdirSync(path.join(backupPath, 'database'), { recursive: true });
    ({ _internal, RestoreService } = require('../../src/services/restoreService'));
  }, 120000);

  afterAll(async () => {
    fs.rmSync(backupPath, { recursive: true, force: true });
    if (cleanup) await cleanup();
  });

  afterEach(() => { delete process.env.BACKUP_MANIFEST_REQUIRE_KEYED; });

  function writeDump(name, content) {
    const file = path.join(backupPath, 'database', name);
    fs.writeFileSync(file, content);
    return file;
  }

  it('accepts a dump that matches the recorded checksum', async () => {
    const file = writeDump('match.sql', 'CREATE TABLE t (id int);');
    await expect(_internal.verifyDatabaseDumpChecksum(file, sha256('CREATE TABLE t (id int);')))
      .resolves.toEqual({ verified: true });
    await expect(_internal.verifyDatabaseDumpChecksum(file, sha256('CREATE TABLE t (id int);').toUpperCase()))
      .resolves.toEqual({ verified: true });
  });

  it('refuses a dump that differs from the recorded checksum', async () => {
    const file = writeDump('tampered.sql', 'INSERT INTO admin_users VALUES (1);');
    await expect(_internal.verifyDatabaseDumpChecksum(file, sha256('CREATE TABLE t (id int);')))
      .rejects.toThrow(/does not match the checksum recorded in the backup manifest/);
  });

  it('restores a manifest without a dump checksum with a warning', async () => {
    const file = writeDump('legacy.sql', 'SELECT 1;');
    const warn = jest.fn();
    await expect(_internal.verifyDatabaseDumpChecksum(file, null, warn)).resolves.toEqual({ verified: false });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no database dump checksum/));
  });

  it('refuses a manifest without a dump checksum when keyed manifests are required', async () => {
    process.env.BACKUP_MANIFEST_REQUIRE_KEYED = 'true';
    const file = writeDump('legacy-required.sql', 'SELECT 1;');
    await expect(_internal.verifyDatabaseDumpChecksum(file, undefined))
      .rejects.toThrow(/BACKUP_MANIFEST_REQUIRE_KEYED/);
  });

  it('stops a database restore before the dump is decompressed or replayed', async () => {
    // A gzip name, so a missing check would reach decompressFile first.
    writeDump('picpeak-db-sqlite-tampered.sql.gz', 'not what the manifest describes');
    const service = new RestoreService();
    const decompress = jest.spyOn(service, 'decompressFile');
    const manifest = {
      database: {
        backup_file: 'database/picpeak-db-sqlite-tampered.sql.gz',
        checksum: sha256('the original dump'),
      },
    };

    await expect(service.performDatabaseRestore(backupPath, manifest, {}))
      .rejects.toThrow(/does not match the checksum recorded in the backup manifest/);
    expect(decompress).not.toHaveBeenCalled();
    // The live database is untouched.
    expect(Number((await db('admin_users').count({ n: '*' }).first()).n)).toBeGreaterThan(0);
  });
});
