/**
 * The external import honours the event's photo cap and bounds its walk.
 *
 * Every upload path enforces events.photo_cap; the external import inserted
 * straight into `photos` and never looked, so an event owner with
 * photos.upload could grow a capped event without limit by pointing it at a
 * folder. The recursive walk also had no depth or entry bound, so the
 * admin's choice of subtree decided how much filesystem work one request
 * could cause.
 *
 * Pins:
 *  - a cap of two lets two of three files in, reports capReached, and counts
 *    the rest as skipped
 *  - an uncapped event imports everything, as before
 *  - a tree deeper than the walk's depth bound imports what is within reach
 *    and reports truncated
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

describe('external import: photo cap and walk bounds', () => {
  let tmpDir; let db; let mediaRoot; let importExternalFolder;

  const touch = async (rel) => {
    const full = path.join(mediaRoot, rel);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, 'not-a-real-jpeg');
  };

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-extcap-'));
    mediaRoot = path.join(tmpDir, 'media');
    await fs.promises.mkdir(mediaRoot, { recursive: true });

    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'data', 'db.sqlite');
    await fs.promises.mkdir(path.dirname(process.env.TEST_DATABASE_PATH), { recursive: true });
    process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
    process.env.EXTERNAL_MEDIA_ROOT = mediaRoot;

    jest.resetModules();
    jest.doMock('sharp', () => () => ({ metadata: async () => ({ width: 100, height: 200 }) }));
    jest.doMock('../../src/services/imageProcessor', () => ({
      generateThumbnail: jest.fn(async () => 'thumbnails/mock.jpg'),
      ensureThumbnail: jest.fn(),
      extractCaptureDate: jest.fn(async () => null),
      orientedDimensions: (m) => ({ width: m.width, height: m.height }),
    }));
    jest.doMock('../../src/utils/logger', () => ({
      debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    }));

    ({ db } = await require('./helpers/crmDb').bootCrmDb());
    ({ importExternalFolder } = require('../../src/services/externalImportService'));
  }, 180000);

  afterAll(async () => {
    if (db) await db.destroy?.();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  async function seedEvent(extra = {}) {
    const [e] = await db('events').insert({
      slug: `extcap-${Math.random().toString(36).slice(2, 8)}`,
      event_type: 'wedding',
      event_name: 'extcap',
      event_date: '2026-01-01',
      host_email: 'h@example.com',
      admin_email: 'a@example.com',
      password_hash: 'x',
      share_link: `extcap-${Math.random()}`,
      expires_at: new Date().toISOString(),
      source_mode: 'reference',
      ...extra,
    }).returning('id');
    return typeof e === 'object' ? e.id : e;
  }

  it('stops at the photo cap and reports it', async () => {
    await touch('capped/a.jpg');
    await touch('capped/b.jpg');
    await touch('capped/c.jpg');
    const eventId = await seedEvent({ photo_cap: 2 });

    const result = await importExternalFolder({ eventId, externalPath: 'capped', recursive: true });

    expect(result.imported).toBe(2);
    expect(result.capReached).toBe(true);
    expect(result.skipped).toBe(1);
    expect(await db('photos').where({ event_id: eventId }).count('id as c').first()).toMatchObject({ c: 2 });
  });

  it('counts photos already in the event against the cap', async () => {
    await touch('capped2/a.jpg');
    const eventId = await seedEvent({ photo_cap: 1 });
    await db('photos').insert({
      event_id: eventId, filename: 'existing.jpg', path: 'x/existing.jpg', type: 'individual',
      uploaded_at: new Date().toISOString(),
    });

    const result = await importExternalFolder({ eventId, externalPath: 'capped2', recursive: true });

    expect(result.imported).toBe(0);
    expect(result.capReached).toBe(true);
    expect(await db('photos').where({ event_id: eventId }).count('id as c').first()).toMatchObject({ c: 1 });
  });

  it('imports everything into an uncapped event', async () => {
    await touch('open/a.jpg');
    await touch('open/b.jpg');
    await touch('open/c.jpg');
    const eventId = await seedEvent();

    const result = await importExternalFolder({ eventId, externalPath: 'open', recursive: true });

    expect(result.imported).toBe(3);
    expect(result.capReached).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it('stops the walk at its depth bound and reports it', async () => {
    const deep = Array.from({ length: 20 }, (_, i) => `d${i}`).join('/');
    await touch('deep/top.jpg');
    await touch(`deep/${deep}/bottom.jpg`);
    const eventId = await seedEvent();

    const result = await importExternalFolder({ eventId, externalPath: 'deep', recursive: true });

    expect(result.truncated).toBe(true);
    expect(result.imported).toBe(1);
    const rows = await db('photos').where({ event_id: eventId });
    expect(rows.map((r) => r.filename)).toEqual(['top.jpg']);
  });
});
