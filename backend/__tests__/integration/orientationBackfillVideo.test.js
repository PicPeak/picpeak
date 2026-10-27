/**
 * The orientation backfill repairs videos stored before issue 2263 was fixed:
 * coded instead of displayed dimensions, no capture date, and a poster
 * squashed into a square. ffprobe and the poster rebuild are stood in for;
 * what is under test is which rows the job touches and what it writes.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const request = require('supertest');
const sharp = require('sharp');

describe('orientation backfill for videos (issue 2263)', () => {
  let tmpDir; let db; let app; let storageRoot;
  let probe; let ensureThumbnail; let getStorage;

  const run = () => request(app).post('/api/admin/photos/repair-orientation');
  const settle = async () => {
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const s = await request(app).get('/api/admin/photos/repair-orientation/status');
      if (!s.body.isRunning) return s;
    }
    throw new Error('backfill did not settle');
  };

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-orientbf-video-'));
    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'data', 'db.sqlite');
    await fs.promises.mkdir(path.dirname(process.env.TEST_DATABASE_PATH), { recursive: true });
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'orientbf-video-secret';

    jest.resetModules();
    jest.doMock('../../src/middleware/auth', () => ({
      adminAuth: (req, _res, next) => { req.admin = { id: 1, username: 'tester' }; next(); },
    }));
    jest.doMock('../../src/middleware/permissions', () => ({
      requirePermission: () => (_req, _res, next) => next(),
    }));
    jest.doMock('../../src/utils/logger', () => ({
      debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    }));
    probe = jest.fn();
    jest.doMock('../../src/services/videoProcessor', () => ({
      ...jest.requireActual('../../src/services/videoProcessor'),
      extractVideoMetadata: (...args) => probe(...args),
    }));
    ensureThumbnail = jest.fn();
    jest.doMock('../../src/services/imageProcessor', () => ({
      ...jest.requireActual('../../src/services/imageProcessor'),
      ensureThumbnail: (...args) => ensureThumbnail(...args),
    }));

    ({ db } = await require('./helpers/crmDb').bootCrmDb());
    storageRoot = process.env.STORAGE_PATH;
    await fs.promises.mkdir(path.join(storageRoot, 'events/active/orientbfv'), { recursive: true });
    ({ getStorage } = require('../../src/services/storage'));

    app = express();
    app.use(express.json());
    app.use('/api/admin/photos', require('../../src/routes/adminPhotoDimensions'));
  }, 180000);

  afterAll(async () => {
    if (db) await db.destroy?.();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(() => {
    probe.mockReset();
    ensureThumbnail.mockReset();
    // What the real rebuild leaves: a new attempt-scoped key on the row.
    ensureThumbnail.mockImplementation(async (row) => {
      const key = 'thumbnails/thumb_rebuilt.jpg';
      await getStorage().put(key, await sharp({ create: { width: 169, height: 300, channels: 3, background: '#333' } }).jpeg().toBuffer());
      await db('photos').where({ id: row.id }).update({ thumbnail_path: key });
      return key;
    });
  });

  async function seed({ width, height, posterWidth = 300, posterHeight = 300, capturedAt = null }) {
    await db('photos').del();
    await db('events').del();
    const [e] = await db('events').insert({
      slug: 'orientbfv', event_type: 'wedding', event_name: 'orientbfv', event_date: '2026-01-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `orientbfv-${Math.random()}`, expires_at: new Date().toISOString(),
    }).returning('id');
    const eventId = typeof e === 'object' ? e.id : e;
    await fs.promises.writeFile(path.join(storageRoot, 'events/active/orientbfv', 'clip.mov'), 'video');
    const poster = 'thumbnails/thumb_clip_old.jpg';
    await getStorage().put(poster, await sharp({
      create: { width: posterWidth, height: posterHeight, channels: 3, background: '#777' },
    }).jpeg().toBuffer());
    const [p] = await db('photos').insert({
      event_id: eventId, filename: 'clip.mov', path: 'orientbfv/clip.mov', type: 'individual',
      media_type: 'video', mime_type: 'video/quicktime', processing_status: 'complete',
      width, height, captured_at: capturedAt, thumbnail_path: poster,
      uploaded_at: new Date().toISOString(),
    }).returning('id');
    return { photoId: typeof p === 'object' ? p.id : p, poster };
  }

  it('turns a portrait clip, dates it and rebuilds its squashed poster, once', async () => {
    const { photoId, poster } = await seed({ width: 1920, height: 1080 });
    probe.mockResolvedValue({ width: 1080, height: 1920, capturedAt: '2025-06-15T12:30:00.000Z' });

    expect((await run()).body.count).toBe(1);
    const done = await settle();

    const row = await db('photos').where({ id: photoId }).first();
    expect(row).toMatchObject({ width: 1080, height: 1920, thumbnail_path: 'thumbnails/thumb_rebuilt.jpg' });
    expect(new Date(row.captured_at).toISOString()).toBe('2025-06-15T12:30:00.000Z');
    expect(row.orientation_checked_at).toBeTruthy();
    expect(ensureThumbnail).toHaveBeenCalledWith(expect.objectContaining({ id: photoId }), { force: true, boundVideoSource: false, strictVideoFrame: true });
    // The squashed poster is not left behind in storage.
    expect(await getStorage().exists(poster)).toBe(false);
    expect(done.body.lastResult).toMatchObject({ checked: 1, corrected: 1, videoDated: 1, videoPosters: 1, failed: 0 });

    expect((await run()).body.count).toBe(0);
  });

  it('leaves a clip stored since the fix alone, and keeps a date already set', async () => {
    const { photoId } = await seed({
      width: 1080, height: 1920, posterWidth: 169, posterHeight: 300, capturedAt: '2024-01-01T00:00:00.000Z',
    });
    probe.mockResolvedValue({ width: 1080, height: 1920, capturedAt: '2025-06-15T12:30:00.000Z' });

    await run();
    const done = await settle();

    const row = await db('photos').where({ id: photoId }).first();
    expect(row.thumbnail_path).toBe('thumbnails/thumb_clip_old.jpg');
    expect(new Date(row.captured_at).toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(ensureThumbnail).not.toHaveBeenCalled();
    expect(done.body.lastResult).toMatchObject({ checked: 1, corrected: 0, videoDated: 0, videoPosters: 0 });
    expect(row.orientation_checked_at).toBeTruthy();
  });

  it('keeps the square poster of a square clip', async () => {
    await seed({ width: 1080, height: 1080 });
    probe.mockResolvedValue({ width: 1080, height: 1080, capturedAt: null });

    await run();
    await settle();

    expect(ensureThumbnail).not.toHaveBeenCalled();
  });

  it('leaves the row a candidate when the poster could not be rebuilt', async () => {
    const { photoId } = await seed({ width: 1920, height: 1080 });
    probe.mockResolvedValue({ width: 1920, height: 1080, capturedAt: null });
    ensureThumbnail.mockResolvedValue(null);

    await run();
    const done = await settle();

    expect(done.body.lastResult.failed).toBe(1);
    expect((await db('photos').where({ id: photoId }).first()).orientation_checked_at).toBeNull();
    expect((await run()).body.count).toBe(1);
    await settle();
  });

  it('counts a clip ffprobe cannot read as failed and writes nothing', async () => {
    const { photoId } = await seed({ width: 1920, height: 1080 });
    probe.mockRejectedValue(new Error('moov atom not found'));

    await run();
    const done = await settle();

    const row = await db('photos').where({ id: photoId }).first();
    expect(row).toMatchObject({ width: 1920, height: 1080, orientation_checked_at: null });
    expect(done.body.lastResult.failed).toBe(1);
  });
});
