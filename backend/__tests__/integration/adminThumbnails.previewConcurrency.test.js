/**
 * POST /admin/thumbnails/regenerate-previews works on PREVIEW_REGEN_CONCURRENCY
 * photos at once (default 1, the old one-by-one loop).
 *
 * Each photo is mostly I/O: fetch the original from storage, write the
 * rendition back. One at a time left a 2-core host ~75% idle and took ~3 s a
 * photo, so a 19k-photo library needed a whole day. The cap stays because
 * every slot holds one full-resolution decode in memory.
 *
 * The mocked ensurePreviewImage records how many calls are in flight at once.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const request = require('supertest');

describe('preview regeneration concurrency', () => {
  let tmpDir; let db; let cleanup; let app; let imageProcessor; let logInfo;
  let inFlight = 0; let peak = 0;
  const savedConcurrency = process.env.PREVIEW_REGEN_CONCURRENCY;

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-regen-conc-'));
    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'data', 'test.db');
    process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
    await fs.promises.mkdir(path.dirname(process.env.TEST_DATABASE_PATH), { recursive: true });
    await fs.promises.mkdir(process.env.STORAGE_PATH, { recursive: true });

    jest.resetModules();
    jest.doMock('../../src/middleware/auth', () => ({
      adminAuth: (req, _res, next) => { req.admin = { id: 1, username: 'tester' }; next(); },
    }));
    jest.doMock('../../src/middleware/permissions', () => ({
      requirePermission: () => (_req, _res, next) => next(),
      userHasAnyPermission: jest.fn().mockResolvedValue(true),
    }));
    jest.doMock('../../src/services/storage', () => {
      const instance = { delete: jest.fn().mockResolvedValue(undefined) };
      return { getStorage: () => instance };
    });
    jest.doMock('../../src/services/imageProcessor', () => ({
      ensureThumbnail: jest.fn().mockResolvedValue('thumbnails/t.jpg'),
      ensurePreviewImage: jest.fn(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight--;
        return 'previews/p.jpg';
      }),
      deleteThumbnailTiers: jest.fn().mockResolvedValue(undefined),
      deletePreviewTiers: jest.fn().mockResolvedValue(undefined),
    }));
    logInfo = jest.spyOn(require('../../src/utils/logger'), 'info');

    ({ db, cleanup } = await require('./helpers/crmDb').bootCrmDb());
    imageProcessor = require('../../src/services/imageProcessor');
    app = express();
    app.use(express.json());
    app.use('/admin/thumbnails', require('../../src/routes/adminThumbnails'));
  }, 180000);

  afterAll(async () => {
    if (savedConcurrency === undefined) delete process.env.PREVIEW_REGEN_CONCURRENCY;
    else process.env.PREVIEW_REGEN_CONCURRENCY = savedConcurrency;
    if (cleanup) await cleanup();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    inFlight = 0; peak = 0;
    await db('photos').del();
    await db('events').del();
  });

  async function seedEventWithPhotos(count) {
    const [row] = await db('events').insert({
      slug: 'conc-wedding', event_type: 'wedding', event_name: 'conc',
      event_date: '2026-01-01', host_email: 'h@example.com', admin_email: 'a@example.com',
      password_hash: 'x', share_link: 'conc-share', expires_at: new Date().toISOString(),
    }).returning('id');
    const eventId = typeof row === 'object' ? row.id : row;
    for (let i = 0; i < count; i++) {
      await db('photos').insert({
        event_id: eventId, filename: `shot${i}.jpg`, path: `conc-wedding/shot${i}.jpg`, type: 'individual',
      });
    }
    return eventId;
  }

  // The loop logs its completion line once every photo is done.
  const drain = async () => {
    const deadline = Date.now() + 10000;
    const done = () => logInfo.mock.calls.some((c) => /Preview regeneration complete/.test(String(c[0])));
    while (!done() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  it('works on PREVIEW_REGEN_CONCURRENCY photos at once and still does every photo', async () => {
    process.env.PREVIEW_REGEN_CONCURRENCY = '3';
    const eventId = await seedEventWithPhotos(7);
    const res = await request(app).post('/admin/thumbnails/regenerate-previews').send({ eventId });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(7);
    await drain();

    expect(imageProcessor.ensurePreviewImage).toHaveBeenCalledTimes(7);
    expect(peak).toBe(3);
    expect(logInfo.mock.calls.some((c) => /7 success, 0 errors/.test(String(c[0])))).toBe(true);
  });

  it('keeps the one-by-one default when the variable is unset', async () => {
    delete process.env.PREVIEW_REGEN_CONCURRENCY;
    const eventId = await seedEventWithPhotos(4);
    await request(app).post('/admin/thumbnails/regenerate-previews').send({ eventId });
    await drain();

    expect(imageProcessor.ensurePreviewImage).toHaveBeenCalledTimes(4);
    expect(peak).toBe(1);
  });

  it('caps a silly value instead of decoding a whole gallery at once', async () => {
    process.env.PREVIEW_REGEN_CONCURRENCY = '500';
    const eventId = await seedEventWithPhotos(12);
    await request(app).post('/admin/thumbnails/regenerate-previews').send({ eventId });
    await drain();

    expect(imageProcessor.ensurePreviewImage).toHaveBeenCalledTimes(12);
    expect(peak).toBe(8);
  });

  it('a failing photo does not stop the others', async () => {
    process.env.PREVIEW_REGEN_CONCURRENCY = '2';
    const eventId = await seedEventWithPhotos(5);
    imageProcessor.ensurePreviewImage.mockRejectedValueOnce(new Error('decode failed'));
    await request(app).post('/admin/thumbnails/regenerate-previews').send({ eventId });
    await drain();

    expect(imageProcessor.ensurePreviewImage).toHaveBeenCalledTimes(5);
    expect(logInfo.mock.calls.some((c) => /4 success, 1 errors/.test(String(c[0])))).toBe(true);
  });
});
