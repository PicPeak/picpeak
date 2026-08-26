/**
 * Importing a second folder must not move the photos already in the event (#1163).
 *
 * events.external_path is overwritten by every import, and external_relpath
 * used to be stored relative to it — so a second import silently rebased every
 * existing row onto the new folder. The reporter had 7547 of 8004 originals
 * pointing at files that do not exist, and nothing said so: thumbnails are
 * written to local storage during the import while the base path is still
 * correct, so the grid carries on rendering.
 *
 * Driven through the real route and the real resolver, against a real
 * directory tree — the failure is entirely about whether a file is where the
 * app looks for it.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const request = require('supertest');

describe('a second external import (#1163)', () => {
  let tmpDir; let db; let app; let mediaRoot; let resolvePhotoFilePath;

  const touch = async (rel) => {
    const full = path.join(mediaRoot, rel);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, 'not-a-real-jpeg');
  };

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-ext2nd-'));
    mediaRoot = path.join(tmpDir, 'media');
    await fs.promises.mkdir(mediaRoot, { recursive: true });

    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'data', 'db.sqlite');
    await fs.promises.mkdir(path.dirname(process.env.TEST_DATABASE_PATH), { recursive: true });
    process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
    process.env.EXTERNAL_MEDIA_ROOT = mediaRoot;
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'ext2nd-secret';

    jest.resetModules();

    jest.doMock('../../src/middleware/auth', () => ({
      adminAuth: (req, _res, next) => { req.admin = { id: 1, username: 'tester', roleName: 'admin' }; next(); },
    }));
    jest.doMock('../../src/middleware/permissions', () => ({
      requirePermission: () => (_req, _res, next) => next(),
    }));
    jest.doMock('../../src/middleware/ownership', () => ({
      requireEventOwnership: (_req, _res, next) => next(),
    }));
    jest.doMock('sharp', () => () => ({ metadata: async () => ({ width: 100, height: 200 }) }));
    jest.doMock('../../src/services/imageProcessor', () => ({
      generateThumbnail: jest.fn(async () => 'thumbnails/mock.jpg'),
      ensureThumbnail: jest.fn(),
    }));
    jest.doMock('../../src/utils/logger', () => ({
      debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    }));

    ({ db } = await require('./helpers/crmDb').bootCrmDb());
    ({ resolvePhotoFilePath } = require('../../src/services/photoResolver'));

    app = express();
    app.use(express.json());
    app.use('/api/admin/external-media', require('../../src/routes/adminExternalMedia'));
  }, 180000);

  afterAll(async () => {
    if (db) await db.destroy?.();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  async function seedEvent() {
    await db('photos').del();
    await db('events').del();
    await fs.promises.rm(mediaRoot, { recursive: true, force: true });
    await fs.promises.mkdir(mediaRoot, { recursive: true });
    const [e] = await db('events').insert({
      slug: `ext2nd-${Math.random().toString(36).slice(2, 8)}`,
      event_type: 'wedding',
      event_name: 'ext2nd',
      event_date: '2026-01-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: `ext2nd-${Math.random()}`,
      expires_at: new Date().toISOString(),
      source_mode: 'reference',
    }).returning('id');
    return typeof e === 'object' ? e.id : e;
  }

  const runImport = (eventId, external_path) => request(app)
    .post(`/api/admin/external-media/events/${eventId}/import-external`)
    .send({ external_path, recursive: true });

  /** Where the app would go looking for this photo's original, right now. */
  async function resolved(eventId, filename) {
    const event = await db('events').where({ id: eventId }).first();
    const photo = await db('photos').where({ event_id: eventId, filename }).first();
    return resolvePhotoFilePath(event, photo);
  }

  it('stores paths relative to the media root, not to the imported folder', async () => {
    const eventId = await seedEvent();
    await touch('Trip/Leknes/old.jpg');

    await runImport(eventId, 'Trip');

    const photo = await db('photos').where({ event_id: eventId }).first();
    expect(photo.external_relpath).toBe(path.join('Trip', 'Leknes', 'old.jpg'));
  });

  it('leaves the first folder’s originals reachable after a second import', async () => {
    const eventId = await seedEvent();
    await touch('Trip/Leknes/old.jpg');
    await touch('Trip/Sub/new.jpg');

    await runImport(eventId, 'Trip');
    const before = await resolved(eventId, 'old.jpg');
    await runImport(eventId, 'Trip/Sub');
    const after = await resolved(eventId, 'old.jpg');

    // The regression: `after` used to be <root>/Trip/Sub/Leknes/old.jpg.
    expect(after).toBe(before);
    expect(fs.existsSync(after)).toBe(true);
  });

  it('every original in the event is still on disk afterwards', async () => {
    const eventId = await seedEvent();
    await touch('Trip/Leknes/a.jpg');
    await touch('Trip/Leknes/b.jpg');
    await touch('Trip/Sub/c.jpg');

    await runImport(eventId, 'Trip');
    await runImport(eventId, 'Trip/Sub');

    const event = await db('events').where({ id: eventId }).first();
    const photos = await db('photos').where({ event_id: eventId });
    expect(photos).toHaveLength(3);
    for (const photo of photos) {
      expect(fs.existsSync(resolvePhotoFilePath(event, photo))).toBe(true);
    }
  });

  it('does not re-insert a file the first import already took', async () => {
    // The dedupe check compares stored paths, so it has to be comparing the
    // same shape the insert writes.
    const eventId = await seedEvent();
    await touch('Trip/Sub/c.jpg');

    await runImport(eventId, 'Trip');
    const second = await runImport(eventId, 'Trip/Sub');

    expect(second.body.imported).toBe(0);
    expect(second.body.skipped).toBe(1);
    expect(await db('photos').where({ event_id: eventId }).count('* as c').first()).toEqual({ c: 1 });
  });

  it('resolves a subfolder that repeats its parent’s name', async () => {
    // The old resolver stripped the relpath's first segment when it matched the
    // base path's last one, which broke exactly this layout.
    const eventId = await seedEvent();
    await touch('Trip/Trip/x.jpg');

    await runImport(eventId, 'Trip');

    const event = await db('events').where({ id: eventId }).first();
    const photo = await db('photos').where({ event_id: eventId }).first();
    expect(resolvePhotoFilePath(event, photo)).toBe(path.join(mediaRoot, 'Trip', 'Trip', 'x.jpg'));
  });
});
