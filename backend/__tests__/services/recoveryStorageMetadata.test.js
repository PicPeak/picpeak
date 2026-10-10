'use strict';
const { Readable } = require('stream');
jest.mock('../../src/services/storage/s3Storage');
const RawAdapter = require('../../src/services/storage/s3Storage');
const S3Backend = require('../../src/services/storage/S3StorageBackend');
const knex = require('knex');
const migration = require('../../migrations/core/283_storage_s3_generation_index');
let database;
let raw; let storage;
beforeEach(async () => {
  raw = { upload: jest.fn(), uploadStream: jest.fn(), downloadStream: jest.fn(), list: jest.fn(),
    s3Client: { send: jest.fn() }, testConnection: jest.fn() };
  RawAdapter.mockImplementation(() => raw);
  database = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  await migration.up(database);
  storage = new S3Backend({ bucket: 'fixture', prefix: 'tenant-one', indexDatabase: database });
  await storage.init();
});
afterEach(async () => { await database.destroy(); });
const options = { contentType: 'image/jpeg', contentDisposition: 'attachment', cacheControl: 'private', metadata: { fixture: 'preserved' } };
it('preserves full object metadata through stat and all upload entry points', async () => {
  raw.s3Client.send.mockResolvedValue({ ContentLength: 3, LastModified: new Date(0), ContentType: options.contentType,
    ContentDisposition: options.contentDisposition, CacheControl: options.cacheControl, Metadata: options.metadata,
    ETag: 'fixture-etag', VersionId: 'fixture-version' });
  expect(await storage.stat('events/active/photo.jpg')).toMatchObject({ size: 3, ...options, etag: 'fixture-etag', versionId: 'fixture-version' });
  await storage.put('events/active/photo.jpg', Buffer.from('abc'), options);
  expect(raw.uploadStream).toHaveBeenLastCalledWith(expect.anything(), 'tenant-one/events/active/photo.jpg', options);
  await storage.put('events/active/photo.jpg', Readable.from('abc'), options);
  expect(raw.uploadStream).toHaveBeenLastCalledWith(expect.anything(), 'tenant-one/events/active/photo.jpg', options);
  await storage.putFromFile('events/active/photo.jpg', '/owned/fixture', options);
  expect(raw.upload).toHaveBeenLastCalledWith('/owned/fixture', 'tenant-one/events/active/photo.jpg', options);
  await storage.get('events/active/photo.jpg', { ifMatch: 'etag', versionId: 'version' });
  expect(raw.downloadStream).toHaveBeenLastCalledWith('tenant-one/events/active/photo.jpg', { ifMatch: 'etag', versionId: 'version' });
});
it('lists the exact namespace root, paginates, and strips the deployment prefix once', async () => {
  raw.list.mockResolvedValueOnce({ Contents: [{ Key: 'tenant-one/events/active/a', Size: 1 },
    { Key: 'tenant-other/events/active/leak', Size: 3 }], IsTruncated: true, NextContinuationToken: 'second' })
    .mockResolvedValueOnce({ Contents: [{ Key: 'tenant-one/transfers/1/files/b', Size: 2 }] });
  expect((await storage.list('')).map(file => file.key)).toEqual(['events/active/a', 'transfers/1/files/b']);
  expect(raw.list.mock.calls.map(call => call[0])).toEqual(['tenant-one/', 'tenant-one/']);
  expect(raw.list.mock.calls[1][1]).toEqual({ continuationToken: 'second' });
  raw.list.mockResolvedValue({ Contents: [] });
  await storage.list('.'); expect(raw.list).toHaveBeenLastCalledWith('tenant-one/', expect.anything());
  storage.prefix = ''; await storage.list(''); expect(raw.list).toHaveBeenLastCalledWith('', expect.anything());
});
it('fails incomplete/repeated-token provider listings instead of completing a partial inventory', async () => {
  raw.list.mockResolvedValue({ Contents: [], IsTruncated: true });
  await expect(storage.list('events/active/')).rejects.toThrow(/truncated/);
  raw.list.mockResolvedValue({ Contents: [], IsTruncated: true, NextContinuationToken: 'same' });
  await expect(storage.list('events/active/')).rejects.toThrow(/repeated/);
});
