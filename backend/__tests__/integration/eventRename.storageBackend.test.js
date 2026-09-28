/**
 * Renaming an event has to move its objects through the storage backend.
 *
 * eventRenameService moved the event folder with a local `fs.rename` and then
 * rewrote every photo's `path` to the new slug. On STORAGE_BACKEND=s3 the
 * rename found no local folder, logged "not found, skipping" and carried on,
 * so the rows pointed at keys under the new slug while every object stayed
 * under the old one: the renamed gallery loaded, and every image in it 404ed.
 *
 * These drive `renameEvent` against a backend that is not the local
 * filesystem: a LocalFsStorage rooted OUTSIDE STORAGE_PATH that reports
 * itself as 's3' and refuses to hand out local paths. Anything that bypasses
 * the storage interface lands in the wrong directory and the assertions
 * catch it.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'rename-test-secret';

const { bootCrmDb } = require('./helpers/crmDb');

describe('event rename through the storage backend', () => {
  let db; let cleanup; let tmpDir;
  let storage; let storageModule; let renameService;
  let resolvePhotoStorageKey;

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-rename-'));
    ({ db, cleanup } = await bootCrmDb());

    const LocalFsStorage = require('../../src/services/storage/LocalFsStorage');
    class RemoteStorage extends LocalFsStorage {
      kind() { return 's3'; }

      resolveLocalPath() { return null; }
    }
    storage = new RemoteStorage({ root: path.join(tmpDir, 'remote') });
    await storage.init();
    storageModule = require('../../src/services/storage');
    storageModule.setStorageForTesting(storage);

    renameService = require('../../src/services/eventRenameService');
    ({ resolvePhotoStorageKey } = require('../../src/services/photoResolver'));
  }, 120000);

  afterAll(async () => {
    storageModule.resetStorage();
    if (cleanup) await cleanup();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  let seq = 0;
  /** An event with `count` managed photos, each stored under its slug. */
  async function seedEvent(count = 3) {
    seq += 1;
    const slug = `wedding-old-name-2026-01-0${seq}`;
    const [e] = await db('events').insert({
      slug,
      event_type: 'wedding',
      event_name: 'Old Name',
      event_date: `2026-01-0${seq}`,
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: `${slug}/tok`,
      share_token: `tok-${seq}`,
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    }).returning('id');
    const eventId = typeof e === 'object' ? e.id : e;

    const photos = [];
    for (let i = 1; i <= count; i += 1) {
      const filename = `IMG_${seq}${String(i).padStart(3, '0')}.jpg`;
      const rel = path.posix.join(slug, filename);
      await storage.put(path.posix.join('events/active', rel), Buffer.from(`photo ${seq}/${i}`));
      const [p] = await db('photos').insert({
        event_id: eventId,
        filename,
        path: rel,
        type: 'individual',
        processing_status: 'complete',
        source_origin: 'managed',
      }).returning('id');
      photos.push(typeof p === 'object' ? p.id : p);
    }
    return { eventId, slug, photoIds: photos };
  }

  const localStorageIsUntouched = () => {
    const active = path.join(process.env.STORAGE_PATH, 'events');
    return !fs.existsSync(active) || fs.readdirSync(active).length === 0;
  };

  it('moves every object to the new slug and the rows keep resolving', async () => {
    const { eventId, slug: oldSlug, photoIds } = await seedEvent(3);

    const result = await renameService.renameEvent(eventId, 'New Name');
    expect(result).toMatchObject({ success: true });

    const event = await db('events').where({ id: eventId }).first();
    expect(event.slug).toBe(result.data.newSlug);
    expect(event.slug).not.toBe(oldSlug);

    for (const id of photoIds) {
      const photo = await db('photos').where({ id }).first();
      expect(photo.path.startsWith(`${event.slug}/`)).toBe(true);
      const key = resolvePhotoStorageKey(event, photo);
      expect(await storage.exists(key)).toBe(true);
      expect(await storage.exists(key.replace(event.slug, oldSlug))).toBe(false);
    }

    // Nothing under the old prefix survives, and nothing was written to
    // the local STORAGE_PATH on the way.
    expect(await storage.list(path.posix.join('events/active', oldSlug))).toEqual([]);
    expect(localStorageIsUntouched()).toBe(true);
  });

  it('leaves the old objects in place when the rename fails before commit', async () => {
    const { eventId, slug: oldSlug, photoIds } = await seedEvent(3);
    const before = await Promise.all(photoIds.map((id) => db('photos').where({ id }).first()));

    let copies = 0;
    const realCopy = storage.copy.bind(storage);
    storage.copy = async (src, dst) => {
      copies += 1;
      if (copies === 2) throw new Error('simulated S3 outage');
      return realCopy(src, dst);
    };
    try {
      const result = await renameService.renameEvent(eventId, 'New Name');
      expect(result).toEqual({ success: false, error: 'simulated S3 outage' });
    } finally {
      storage.copy = realCopy;
    }

    const event = await db('events').where({ id: eventId }).first();
    expect(event.slug).toBe(oldSlug);
    expect(event.event_name).toBe('Old Name');
    for (const row of before) {
      const after = await db('photos').where({ id: row.id }).first();
      expect(after.path).toBe(row.path);
      expect(after.filename).toBe(row.filename);
      expect(await storage.exists(resolvePhotoStorageKey(event, after))).toBe(true);
    }
    // The half-finished copy is cleaned up, so a retry is not refused for
    // finding the target occupied.
    const newPrefix = path.posix.join('events/active', renameService.generateSlug('wedding', 'New Name', event.event_date));
    expect(await storage.list(newPrefix)).toEqual([]);
  });

  it('refuses a target prefix that already holds objects', async () => {
    const { eventId } = await seedEvent(1);
    const event = await db('events').where({ id: eventId }).first();
    const occupied = path.posix.join('events/active', renameService.generateSlug('wedding', 'New Name', event.event_date), 'stray.jpg');
    await storage.put(occupied, Buffer.from('stray'));

    const result = await renameService.renameEvent(eventId, 'New Name');
    expect(result).toEqual({ success: false, error: 'Target folder already exists' });
    expect((await db('events').where({ id: eventId }).first()).slug).toBe(event.slug);
    expect(await storage.exists(occupied)).toBe(true);
  });

  describe('on local disk', () => {
    let local;
    beforeAll(async () => {
      const LocalFsStorage = require('../../src/services/storage/LocalFsStorage');
      local = new LocalFsStorage({ root: process.env.STORAGE_PATH });
      await local.init();
      storageModule.setStorageForTesting(local);
    });
    afterAll(() => storageModule.setStorageForTesting(storage));

    it('still renames the folder in one move and the rows keep resolving', async () => {
      // Pinned on the same harness because the service used to fail here
      // too, storage aside: renamePhotoFiles and the share-link builder
      // queried the pool while the open transaction held SQLite's only
      // connection, so every rename waited out the 60s acquire timeout.
      const putAt = storage;
      storage = local;
      let seeded;
      try {
        seeded = await seedEvent(2);
      } finally {
        storage = putAt;
      }
      const { eventId, slug: oldSlug, photoIds } = seeded;

      const result = await renameService.renameEvent(eventId, 'New Name');
      expect(result).toMatchObject({ success: true, data: { filesRenamed: 2 } });

      const event = await db('events').where({ id: eventId }).first();
      const active = path.join(process.env.STORAGE_PATH, 'events/active');
      expect(fs.existsSync(path.join(active, event.slug))).toBe(true);
      expect(fs.existsSync(path.join(active, oldSlug))).toBe(false);
      for (const id of photoIds) {
        const photo = await db('photos').where({ id }).first();
        expect(await local.exists(resolvePhotoStorageKey(event, photo))).toBe(true);
      }
    });
  });
});
