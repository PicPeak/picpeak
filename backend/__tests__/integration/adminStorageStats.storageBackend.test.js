/**
 * The storage accounting in Settings and System joined events.archive_path
 * onto the local STORAGE_PATH and stat'ed the result. archiveService writes
 * the zip through the storage backend, so on S3 every archive counted as
 * "not found", and a row carrying `../` was stat'ed outside storage. Both
 * routes now ask the backend, which refuses a key that climbs out.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const request = require('supertest');

describe('storage accounting reads archives through the storage backend', () => {
  let tmpDir; let db; let cleanup; let app; let storagePath; let storage; let storageModule;

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-storage-stats-'));
    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'data', 'test.db');
    await fs.promises.mkdir(path.dirname(process.env.TEST_DATABASE_PATH), { recursive: true });

    jest.resetModules();
    jest.doMock('../../src/middleware/auth', () => ({
      adminAuth: (req, _res, next) => { req.admin = { id: 1, username: 'tester' }; next(); },
    }));
    jest.doMock('../../src/middleware/permissions', () => ({
      requirePermission: () => (_req, _res, next) => next(),
    }));

    ({ db, cleanup } = await require('./helpers/crmDb').bootCrmDb());
    storagePath = process.env.STORAGE_PATH;

    const LocalFsStorage = require('../../src/services/storage/LocalFsStorage');
    class RemoteStorage extends LocalFsStorage {
      kind() { return 's3'; }

      resolveLocalPath() { return null; }
    }
    storage = new RemoteStorage({ root: path.join(tmpDir, 'remote') });
    await storage.init();
    storageModule = require('../../src/services/storage');
    storageModule.setStorageForTesting(storage);

    app = express();
    app.use(express.json());
    app.use('/admin/settings', require('../../src/routes/adminSettings'));
    app.use('/admin/system', require('../../src/routes/adminSystem'));
  }, 180000);

  afterAll(async () => {
    if (storageModule) storageModule.resetStorage();
    if (cleanup) await cleanup();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    await db('photos').del();
    await db('events').del();
  });

  const ZIP = Buffer.alloc(4321, 1);

  async function seedArchivedEvent(archiveKey, slug) {
    await db('events').insert({
      slug, event_type: 'wedding', event_name: slug, event_date: '2026-06-27',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `${slug}-share`, expires_at: new Date().toISOString(),
      is_archived: 1, archive_path: archiveKey,
    });
  }

  async function putRemoteArchive(slug) {
    const scratch = path.join(tmpDir, 'scratch', `${slug}.zip`);
    await fs.promises.mkdir(path.dirname(scratch), { recursive: true });
    await fs.promises.writeFile(scratch, ZIP);
    const key = path.posix.join('events/archived', `${slug}.zip`);
    await storage.putFromFile(key, scratch, { contentType: 'application/zip' });
    return key;
  }

  it('counts an archive that only the storage backend holds, in both places', async () => {
    await seedArchivedEvent(await putRemoteArchive('remote-only'), 'remote-only');
    expect(fs.existsSync(path.join(storagePath, 'events/archived/remote-only.zip'))).toBe(false);

    const settings = await request(app).get('/admin/settings/storage/info');
    expect(settings.status).toBe(200);
    expect(settings.body.archive_storage).toBe(ZIP.length);

    const system = await request(app).get('/admin/system/status');
    expect(system.status).toBe(200);
    expect(system.body.storage.archiveStorage).toBe(ZIP.length);
  });

  it('never stats a file outside storage for a row whose key climbs out', async () => {
    // A file just outside STORAGE_PATH; a raw path.join would reach it.
    const outside = path.join(storagePath, '..', 'outside-stats.zip');
    await fs.promises.writeFile(outside, Buffer.alloc(999, 2));
    await seedArchivedEvent('../outside-stats.zip', 'climbing');
    try {
      const settings = await request(app).get('/admin/settings/storage/info');
      expect(settings.status).toBe(200);
      expect(settings.body.archive_storage).toBe(0);

      const system = await request(app).get('/admin/system/status');
      expect(system.status).toBe(200);
      expect(system.body.storage.archiveStorage).toBe(0);
    } finally {
      await fs.promises.rm(outside, { force: true });
    }
  });
});
