'use strict';
/**
 * Storage list() treats its prefix as a directory on every backend.
 *
 * The local backend walks the directory, so list('events/active/x') never
 * sees 'events/active/x-1/...'. The S3 backend passed the same prefix to
 * ListObjectsV2 unchanged, a plain string prefix, so it also returned every
 * gallery whose slug starts with 'x' (slug collisions mint 'x-1', 'x-2'...).
 * Archive, auto-import and transfer cleanup all list one directory and act on
 * every key they get back. The S3 listing now stops at the '/' boundary, in
 * both the plain and the restore-mapping branch.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../../src/services/storage/s3Storage');
const RawAdapter = require('../../src/services/storage/s3Storage');
const S3Backend = require('../../src/services/storage/S3StorageBackend');
const LocalFsStorage = require('../../src/services/storage/LocalFsStorage');
const knex = require('knex');
const migration = require('../../migrations/core/283_storage_s3_generation_index');

const OBJECTS = [
  'events/active/x/a.jpg',
  'events/active/x/private/b.jpg',
  'events/active/x-1/c.jpg',
  'events/active/x-1/private/d.jpg',
  'events/active/xy/e.jpg',
  'events/active/y/f.jpg',
  'transfers/7/files/g.bin',
  'transfers/70/files/h.bin',
];

describe.each([['no deployment prefix', ''], ['deployment prefix', 'tenant-one']])('S3 list boundary (%s)', (_label, deploymentPrefix) => {
  let database; let storage; let bucket;
  const physical = (key) => (deploymentPrefix ? `${deploymentPrefix}/${key}` : key);

  beforeEach(async () => {
    bucket = new Map(OBJECTS.map((key) => [physical(key), 1]));
    const raw = {
      // ListObjectsV2 semantics: plain string prefix, one page.
      list: jest.fn(async (prefix) => ({
        Contents: [...bucket.keys()].filter((k) => k.startsWith(prefix)).sort().map((Key) => ({ Key, Size: bucket.get(Key) })),
      })),
      delete: jest.fn(async (key) => { bucket.delete(key); }),
      s3Client: { send: jest.fn(async () => ({ ContentLength: 1, LastModified: new Date(0) })) },
      testConnection: jest.fn(),
    };
    RawAdapter.mockImplementation(() => raw);
    database = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
    await migration.up(database);
    storage = new S3Backend({ bucket: 'fixture', prefix: deploymentPrefix, indexDatabase: database });
    await storage.init();
  });
  afterEach(async () => { await database.destroy(); });

  it('lists only the named directory', async () => {
    expect((await storage.list('events/active/x')).map((e) => e.key).sort())
      .toEqual(['events/active/x/a.jpg', 'events/active/x/private/b.jpg']);
    expect((await storage.list('transfers/7')).map((e) => e.key)).toEqual(['transfers/7/files/g.bin']);
  });

  it('accepts a prefix that already ends in a slash', async () => {
    expect((await storage.list('events/active/x/')).map((e) => e.key).sort())
      .toEqual(['events/active/x/a.jpg', 'events/active/x/private/b.jpg']);
  });

  it('still lists everything from the root', async () => {
    expect((await storage.list('')).map((e) => e.key).sort()).toEqual([...OBJECTS].sort());
  });

  it('deleting what one directory lists leaves its siblings alone', async () => {
    for (const entry of await storage.list('events/active/x')) await storage.delete(entry.key);
    expect([...bucket.keys()].map((k) => (deploymentPrefix ? k.slice(deploymentPrefix.length + 1) : k)).sort())
      .toEqual(OBJECTS.filter((k) => !k.startsWith('events/active/x/')).sort());
  });

  it('keeps restored objects of a sibling directory out of the listing', async () => {
    storage.mapping.set('events/active/x/restored.jpg', '.picpeak-generations/g1/events/active/x/restored.jpg');
    storage.mapping.set('events/active/x-1/restored.jpg', '.picpeak-generations/g1/events/active/x-1/restored.jpg');
    const keys = (await storage.list('events/active/x')).map((e) => e.key).sort();
    expect(keys).toContain('events/active/x/restored.jpg');
    expect(keys.filter((k) => !k.startsWith('events/active/x/'))).toEqual([]);
  });
});

describe('local list boundary', () => {
  it('lists only the named directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-listdir-'));
    try {
      const storage = new LocalFsStorage({ root });
      for (const key of OBJECTS) {
        fs.mkdirSync(path.join(root, path.dirname(key)), { recursive: true });
        fs.writeFileSync(path.join(root, key), 'x');
      }
      expect((await storage.list('events/active/x')).map((e) => e.key).sort())
        .toEqual(['events/active/x/a.jpg', 'events/active/x/private/b.jpg']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
