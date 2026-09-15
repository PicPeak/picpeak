/**
 * Archive restore has to go through the storage backend, like the archive
 * writer does.
 *
 * archiveService uploads the zip with `storage.putFromFile()` and deletes the
 * originals through `storage.delete()`. The admin archive routes then look for
 * that zip with `fs.access()` under the local STORAGE_PATH. On a deployment
 * with STORAGE_BACKEND=s3 the local directory is empty, so every restore
 * answers 404 "Archive file not found on disk", the details view reports no
 * archive file, download 404s and delete leaves the zip in the bucket.
 *
 * Restore also wrote the extracted files to the local directory and never put
 * them back into storage, so even with the zip on local disk the photos would
 * come back as rows that point at objects the storage backend does not have.
 *
 * These drive the routes against a backend that is not the local filesystem:
 * a LocalFsStorage rooted OUTSIDE STORAGE_PATH that reports itself as 's3'
 * and refuses to hand out local paths. Anything that bypasses the storage
 * interface lands in the wrong directory and the assertions catch it.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const express = require('express');
const request = require('supertest');

/**
 * A stored (uncompressed) zip with the entry names written verbatim.
 * archiver strips `../` from entry names, so a slip archive has to be built
 * by hand: local headers, central directory, end record.
 */
function rawZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDir, end]);
}

describe('archive routes read and write through the storage backend', () => {
  let tmpDir; let db; let cleanup; let app; let storagePath; let storage; let storageModule;

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-restore-storage-'));
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
    jest.doMock('../../src/middleware/ownership', () => ({
      requireEventOwnership: (_req, _res, next) => next(),
    }));

    ({ db, cleanup } = await require('./helpers/crmDb').bootCrmDb());
    // bootCrmDb sets STORAGE_PATH to its own tmp dir. The route must never
    // touch it: nothing is ever written there by this suite.
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
    app.use('/admin/archives', require('../../src/routes/adminArchives'));
  }, 180000);

  afterAll(async () => {
    if (storageModule) storageModule.resetStorage();
    if (cleanup) await cleanup();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    await db('photos').del();
    await db('photo_categories').del();
    await db('events').del();
    await db('activity_logs').del();
  });

  const BYTES = Buffer.from('not really a media file, and it does not need to be');

  /** Builds the zip in scratch space and uploads it the way archiveService does. */
  async function putArchive(slug, entries) {
    const archiver = require('archiver');
    const scratch = path.join(tmpDir, 'scratch', `${slug}.zip`);
    await fs.promises.mkdir(path.dirname(scratch), { recursive: true });
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(scratch);
      const zip = archiver('zip', { zlib: { level: 0 } });
      output.on('close', resolve);
      zip.on('error', reject);
      zip.pipe(output);
      for (const [entryName, buffer] of Object.entries(entries)) {
        zip.append(buffer, { name: entryName });
      }
      zip.finalize();
    });
    const key = path.posix.join('events/archived', `${slug}.zip`);
    await storage.putFromFile(key, scratch, { contentType: 'application/zip' });
    return { key, bytes: await fs.promises.readFile(scratch) };
  }

  async function seedArchivedEvent(archiveKey, slug) {
    const [row] = await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: slug,
      event_date: '2026-06-27',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: `${slug}-share`,
      expires_at: new Date().toISOString(),
      is_archived: 1,
      archive_path: archiveKey,
    }).returning('id');
    return typeof row === 'object' ? row.id : row;
  }

  const manifestOf = (rows) => Buffer.from(JSON.stringify(rows), 'utf8');

  const localEventsDir = () => path.join(storagePath, 'events');

  it('restores from a zip that only the storage backend holds', async () => {
    const { key } = await putArchive('remote-event', {
      'individual/one.jpg': BYTES,
      'collages/two.jpg': BYTES,
      'photos_manifest.json': manifestOf([
        { filename: 'one.jpg', original_filename: 'DSC_0001.jpg', type: 'individual' },
        { filename: 'two.jpg', original_filename: 'DSC_0002.jpg', type: 'collage' },
      ]),
    });
    const eventId = await seedArchivedEvent(key, 'remote-event');

    const res = await request(app).post(`/admin/archives/${eventId}/restore`).send({});
    expect(res.status).toBe(200);

    const rows = await db('photos').where('event_id', eventId).orderBy('filename');
    expect(rows.map((r) => [r.filename, r.path, r.type, r.size_bytes])).toEqual([
      ['one.jpg', 'events/active/remote-event/individual/one.jpg', 'individual', BYTES.length],
      ['two.jpg', 'events/active/remote-event/collages/two.jpg', 'collage', BYTES.length],
    ]);

    // The bytes went back through the backend, not onto the local disk.
    for (const row of rows) {
      expect(await storage.exists(row.path)).toBe(true);
    }
    await expect(fs.promises.access(localEventsDir())).rejects.toMatchObject({ code: 'ENOENT' });

    const event = await db('events').where('id', eventId).first();
    expect(Boolean(event.is_archived)).toBe(false);
    expect(event.archive_path).toBeNull();
  });

  it('restores a pre-manifest archive from the backend too', async () => {
    const { key } = await putArchive('legacy-remote', {
      'individual/old.jpg': BYTES,
    });
    const eventId = await seedArchivedEvent(key, 'legacy-remote');

    const res = await request(app).post(`/admin/archives/${eventId}/restore`).send({});
    expect(res.status).toBe(200);

    const photo = await db('photos').where('event_id', eventId).first();
    expect(photo.path).toBe('events/active/legacy-remote/individual/old.jpg');
    expect(await storage.exists(photo.path)).toBe(true);
  });

  it('refuses an archive whose entry escapes the event prefix before writing anything', async () => {
    const key = 'events/archived/slip-event.zip';
    await storage.put(key, rawZip({
      'individual/fine.jpg': BYTES,
      '../../uploads/logos/evil.svg': BYTES,
    }));
    const eventId = await seedArchivedEvent(key, 'slip-event');

    const res = await request(app).post(`/admin/archives/${eventId}/restore`).send({});
    // node-stream-zip refuses the entry list itself (500 through the
    // extraction catch); the route's own guard answers 400 if that ever
    // stops. Either way nothing reaches storage.
    expect([400, 500]).toContain(res.status);

    expect(await storage.list('events/active/slip-event')).toEqual([]);
    expect(await storage.exists('uploads/logos/evil.svg')).toBe(false);
    expect(await db('photos').where('event_id', eventId)).toEqual([]);
    const event = await db('events').where('id', eventId).first();
    expect(Boolean(event.is_archived)).toBe(true);
  });

  it('answers 404 when the backend has no zip for the event', async () => {
    const eventId = await seedArchivedEvent('events/archived/missing.zip', 'missing-event');

    const res = await request(app).post(`/admin/archives/${eventId}/restore`).send({});
    expect(res.status).toBe(404);

    const event = await db('events').where('id', eventId).first();
    expect(Boolean(event.is_archived)).toBe(true);
  });

  it('reports the zip size from the backend on the details view', async () => {
    const { key, bytes } = await putArchive('details-event', { 'individual/a.jpg': BYTES });
    const eventId = await seedArchivedEvent(key, 'details-event');

    const res = await request(app).get(`/admin/archives/${eventId}`);
    expect(res.status).toBe(200);
    expect(res.body.archiveFile).toMatchObject({ size: bytes.length, path: key });
  });

  it('streams the download from the backend', async () => {
    const { key, bytes } = await putArchive('download-event', { 'individual/a.jpg': BYTES });
    const eventId = await seedArchivedEvent(key, 'download-event');

    const res = await request(app)
      .get(`/admin/archives/${eventId}/download`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(Buffer.compare(res.body, bytes)).toBe(0);
  });

  it('deletes the zip from the backend on permanent delete', async () => {
    const { key } = await putArchive('delete-event', { 'individual/a.jpg': BYTES });
    const eventId = await seedArchivedEvent(key, 'delete-event');
    expect(await storage.exists(key)).toBe(true);

    const res = await request(app).delete(`/admin/archives/${eventId}`);
    expect(res.status).toBe(200);

    expect(await storage.exists(key)).toBe(false);
    expect(await db('events').where('id', eventId)).toEqual([]);
  });
});
