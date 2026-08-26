/**
 * Recomputing dimensions for a library that predates the orientation fix
 * (#1185).
 *
 * The repair job only ever filled rows with a NULL dimension. A photo affected
 * by the orientation bug does not have one: it has BOTH dimensions stored, in
 * the raw order. So the job could never reach exactly the rows that needed it,
 * and once their thumbnails regenerated rotated, the grid sized a portrait
 * photo with a landscape ratio.
 *
 * `recompute` widens the candidate set to every image row. It also has to deal
 * with the consequence: face detection stores bounding boxes in ORIGINAL pixel
 * space, scaled by `photo.width / previewMeta.width`
 * (faceProcessor.js:220-224), so a photo whose stored dimensions change has
 * face data recorded against a coordinate system that no longer exists.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const request = require('supertest');
const sharp = require('sharp');

describe('dimension repair — recompute (#1185)', () => {
  let tmpDir; let db; let app; let storageRoot;

  const status = () => request(app).get('/api/admin/photos/repair-dimensions/status');
  const settle = async () => {
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const s = await status();
      if (!s.body.isRunning) return s;
    }
    throw new Error('repair did not settle');
  };

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-recompute-'));

    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'data', 'db.sqlite');
    await fs.promises.mkdir(path.dirname(process.env.TEST_DATABASE_PATH), { recursive: true });
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'recompute-secret';

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

    ({ db } = await require('./helpers/crmDb').bootCrmDb());
    // bootCrmDb points STORAGE_PATH at its own temp tree; the fixture has to
    // live where the app will actually resolve it.
    storageRoot = process.env.STORAGE_PATH;
    await fs.promises.mkdir(path.join(storageRoot, 'events/active/recompute-ev'), { recursive: true });

    app = express();
    app.use(express.json());
    app.use('/api/admin/photos', require('../../src/routes/adminPhotoDimensions'));
  }, 180000);

  afterAll(async () => {
    if (db) await db.destroy?.();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  // 400x200 stored, orientation 6 → displays as 200x400.
  async function seedRotatedPhoto({ storedWidth, storedHeight, faceStatus = null }) {
    await db('photos').del();
    await db('events').del();
    const [e] = await db('events').insert({
      slug: 'recompute-ev', event_type: 'wedding', event_name: 'recompute', event_date: '2026-01-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `recompute-${Math.random()}`, expires_at: new Date().toISOString(),
    }).returning('id');
    const eventId = typeof e === 'object' ? e.id : e;

    const abs = path.join(storageRoot, 'events/active/recompute-ev', 'rotated.jpg');
    await sharp({ create: { width: 400, height: 200, channels: 3, background: { r: 9, g: 9, b: 9 } } })
      .withMetadata({ orientation: 6 }).jpeg().toFile(abs);

    const [p] = await db('photos').insert({
      event_id: eventId, filename: 'rotated.jpg', path: 'recompute-ev/rotated.jpg',
      type: 'individual', width: storedWidth, height: storedHeight,
      face_status: faceStatus, uploaded_at: new Date().toISOString(),
    }).returning('id');
    return { eventId, photoId: typeof p === 'object' ? p.id : p };
  }

  it('without recompute, a row that already has dimensions is never visited', async () => {
    // The gap: an orientation-affected row has both dimensions, just wrong.
    await seedRotatedPhoto({ storedWidth: 400, storedHeight: 200 });

    const res = await request(app).post('/api/admin/photos/repair-dimensions');
    expect(res.body.count).toBe(0);
  });

  it('with recompute, it is visited and corrected to the displayed orientation', async () => {
    const { photoId } = await seedRotatedPhoto({ storedWidth: 400, storedHeight: 200 });

    const res = await request(app)
      .post('/api/admin/photos/repair-dimensions')
      .send({ recompute: true });
    expect(res.body.count).toBe(1);
    await settle();

    const row = await db('photos').where({ id: photoId }).first();
    expect(row.width).toBe(200);
    expect(row.height).toBe(400);
  });

  it('a photo whose orientation changed is requeued for face scanning', async () => {
    // Boxes were stored against the raw coordinate system; after this the
    // preview regenerates rotated and they would crop the wrong region.
    const { photoId } = await seedRotatedPhoto({ storedWidth: 400, storedHeight: 200, faceStatus: 'done' });

    await request(app).post('/api/admin/photos/repair-dimensions').send({ recompute: true });
    const done = await settle();

    expect((await db('photos').where({ id: photoId }).first()).face_status).toBe('pending');
    expect(done.body.lastResult.requeuedFaces).toBe(1);
  });

  it('an install that never enabled faces is left alone', async () => {
    // face_status NULL means the feature was never switched on for this photo;
    // queueing it would start scanning on an install that never asked for it.
    const { photoId } = await seedRotatedPhoto({ storedWidth: 400, storedHeight: 200, faceStatus: null });

    await request(app).post('/api/admin/photos/repair-dimensions').send({ recompute: true });
    const done = await settle();

    expect((await db('photos').where({ id: photoId }).first()).face_status).toBeNull();
    expect(done.body.lastResult.requeuedFaces).toBe(0);
  });

  it('a photo whose dimensions were already correct is not requeued', async () => {
    // Recompute re-reads everything, but only a real change invalidates face
    // data — otherwise a routine repair would rescan the whole library.
    const { photoId } = await seedRotatedPhoto({ storedWidth: 200, storedHeight: 400, faceStatus: 'done' });

    await request(app).post('/api/admin/photos/repair-dimensions').send({ recompute: true });
    const done = await settle();

    expect((await db('photos').where({ id: photoId }).first()).face_status).toBe('done');
    expect(done.body.lastResult.requeuedFaces).toBe(0);
  });
});
