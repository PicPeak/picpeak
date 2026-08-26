/**
 * Backfilling orientation for a library that predates #1185 (#1198).
 *
 * The orientation fix corrected the generators and every ingest path, but left
 * existing rows describing the raw sensor order. Those rows end up worse than
 * untouched ones: before the fix a rotated photo was consistently wrong — a
 * sideways image in a matching tile — and afterwards the thumbnail is right
 * while the stored aspect ratio is not.
 *
 * A first attempt at this was reverted from #1194 after review. These tests
 * pin the five things that went wrong with it:
 *
 *   1. requeueing faces without clearing the cached preview, so the rescan
 *      re-read unrotated pixels;
 *   2. reading originals in a way that cannot see S3 or RAW;
 *   3. deciding "did this change" from a dimension delta, which never fires
 *      for orientations 2, 3 and 4;
 *   4. walking archived events whose originals no longer exist;
 *   5. writing dimensions and invalidation non-atomically.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const request = require('supertest');
const sharp = require('sharp');

describe('orientation backfill (#1198)', () => {
  let tmpDir; let db; let app; let storageRoot;

  const status = () => request(app).get('/api/admin/photos/repair-orientation/status');
  const run = () => request(app).post('/api/admin/photos/repair-orientation');
  const settle = async () => {
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const s = await status();
      if (!s.body.isRunning) return s;
    }
    throw new Error('backfill did not settle');
  };

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-orientbf-'));
    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'data', 'db.sqlite');
    await fs.promises.mkdir(path.dirname(process.env.TEST_DATABASE_PATH), { recursive: true });
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'orientbf-secret';

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
    // bootCrmDb owns STORAGE_PATH; fixtures must live where the app resolves.
    storageRoot = process.env.STORAGE_PATH;
    await fs.promises.mkdir(path.join(storageRoot, 'events/active/orientbf'), { recursive: true });

    app = express();
    app.use(express.json());
    app.use('/api/admin/photos', require('../../src/routes/adminPhotoDimensions'));
  }, 180000);

  afterAll(async () => {
    if (db) await db.destroy?.();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  async function seed({
    orientation, storedWidth, storedHeight, faceStatus = null,
    previewPath = 'previews/prev_orientbf.jpg', archived = false, filename = 'p.jpg',
    thumbnailPath = 'thumbnails/thumb_orientbf.jpg', heroPath = 'heroes/hero_orientbf.jpg',
    watermarkPath = 'watermarks/wm_orientbf.jpg', checkedAt = null,
  }) {
    await db('photos').del();
    await db('events').del();
    const [e] = await db('events').insert({
      slug: 'orientbf', event_type: 'wedding', event_name: 'orientbf', event_date: '2026-01-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `orientbf-${Math.random()}`, expires_at: new Date().toISOString(),
      is_archived: archived,
    }).returning('id');
    const eventId = typeof e === 'object' ? e.id : e;

    const img = sharp({ create: { width: 400, height: 200, channels: 3, background: { r: 7, g: 7, b: 7 } } });
    await (orientation ? img.withMetadata({ orientation }) : img)
      .jpeg().toFile(path.join(storageRoot, 'events/active/orientbf', filename));

    const [p] = await db('photos').insert({
      event_id: eventId, filename, path: `orientbf/${filename}`, type: 'individual',
      width: storedWidth, height: storedHeight, face_status: faceStatus,
      preview_path: previewPath, thumbnail_path: thumbnailPath, hero_path: heroPath,
      watermark_path: watermarkPath, orientation_checked_at: checkedAt,
      uploaded_at: new Date().toISOString(),
    }).returning('id');
    return { eventId, photoId: typeof p === 'object' ? p.id : p };
  }

  it('corrects a row whose dimensions are transposed', async () => {
    // The case the dimension repair can never reach: both values present,
    // just in the raw sensor order.
    const { photoId } = await seed({ orientation: 6, storedWidth: 400, storedHeight: 200 });

    expect((await run()).body.count).toBe(1);
    const done = await settle();

    const row = await db('photos').where({ id: photoId }).first();
    expect(row.width).toBe(200);
    expect(row.height).toBe(400);
    expect(done.body.lastResult.corrected).toBe(1);
  });

  it('clears the cached preview before requeueing, not after', async () => {
    // The reverted attempt's own-goal: ensurePreviewImage hands back a cached
    // preview whenever it is still a valid image, so a rescan against the
    // pre-fix preview produced boxes in the old coordinate system and scaled
    // them by the corrected dimensions.
    const { photoId } = await seed({
      orientation: 6, storedWidth: 400, storedHeight: 200, faceStatus: 'done',
    });

    await run();
    const done = await settle();

    const row = await db('photos').where({ id: photoId }).first();
    expect(row.preview_path).toBeNull();
    expect(row.face_status).toBe('pending');
    expect(done.body.lastResult.requeuedFaces).toBe(1);
  });

  it('clears the thumbnail and hero too, not just the preview', async () => {
    // The miss that mattered most: ensureThumbnail and ensureHeroImage return
    // their cached file whenever it is merely VALID, and a pre-fix sideways
    // thumbnail is perfectly valid. Clearing only the preview fixed the face
    // data and left the gallery rendering the old sideways image inside a
    // newly-corrected portrait tile.
    const { photoId } = await seed({ orientation: 6, storedWidth: 400, storedHeight: 200 });

    await run();
    await settle();

    const row = await db('photos').where({ id: photoId }).first();
    expect(row.preview_path).toBeNull();
    expect(row.thumbnail_path).toBeNull();
    expect(row.hero_path).toBeNull();
  });

  it('leaves the renditions of an untransformed photo alone', async () => {
    // Nothing moved, so nothing cached is stale — clearing them would make a
    // routine run regenerate the whole library for no reason.
    const { photoId } = await seed({ orientation: null, storedWidth: 400, storedHeight: 200 });

    await run();
    await settle();

    const row = await db('photos').where({ id: photoId }).first();
    expect(row.thumbnail_path).toBe('thumbnails/thumb_orientbf.jpg');
    expect(row.hero_path).toBe('heroes/hero_orientbf.jpg');
    expect(row.preview_path).toBe('previews/prev_orientbf.jpg');
  });

  it('does not touch a row whose file was replaced while it was reading', async () => {
    // replacePhoto swaps a new file under an existing row and rewrites
    // path/filename (reachable from replace_by_name). The writes are fenced on
    // the identity that was measured, so a replacement that lands mid-run is
    // left entirely alone rather than being given the previous file's
    // dimensions and having its fresh renditions cleared.
    const { photoId } = await seed({
      orientation: 6, storedWidth: 400, storedHeight: 200, faceStatus: 'done',
    });

    const res = await run();
    expect(res.body.count).toBe(1);
    // Simulate the replacement landing before the loop writes.
    await db('photos').where({ id: photoId })
      .update({ path: 'orientbf/replaced.jpg', filename: 'replaced.jpg' });
    await settle();

    const row = await db('photos').where({ id: photoId }).first();
    expect(row.width).toBe(400);            // untouched
    expect(row.face_status).toBe('done');   // not requeued
    expect(row.thumbnail_path).toBe('thumbnails/thumb_orientbf.jpg');
  });

  it('is idempotent — a second run finds nothing left to do', async () => {
    // The trigger is the EXIF tag on the ORIGINAL, which correcting a photo
    // never changes. Without a marker every re-run would throw away the
    // renditions it had just regenerated and requeue every completed face
    // scan — on a face-enabled install, re-detecting the whole library.
    await seed({ orientation: 6, storedWidth: 400, storedHeight: 200, faceStatus: 'done' });

    expect((await run()).body.count).toBe(1);
    const first = await settle();
    expect(first.body.lastResult.corrected).toBe(1);

    expect((await run()).body.count).toBe(0);
  });

  it('force revisits rows it has already checked', async () => {
    await seed({
      orientation: 6, storedWidth: 200, storedHeight: 400,
      checkedAt: new Date().toISOString(),
    });

    expect((await run()).body.count).toBe(0);
    const forced = await request(app).post('/api/admin/photos/repair-orientation').send({ force: true });
    expect(forced.body.count).toBe(1);
    await settle();
  });

  it('clears the watermarked rendition, which is what a guest actually sees', async () => {
    // gallery.js serves watermark_path ahead of the original when branding
    // watermarking is on.
    const { photoId } = await seed({ orientation: 6, storedWidth: 400, storedHeight: 200 });

    await run();
    await settle();

    expect((await db('photos').where({ id: photoId }).first()).watermark_path).toBeNull();
  });

  it('does not report stale tiers after a clean run', async () => {
    // storage.stat() RESOLVES with null for a missing key rather than
    // rejecting, so counting "the promise settled" marked every deleted and
    // never-created tier as a survivor and told the operator to re-run.
    await seed({ orientation: 6, storedWidth: 400, storedHeight: 200 });

    await run();
    const done = await settle();

    expect(done.body.lastResult.staleTiers).toBe(0);
  });

  it('requeues faces when only the dimensions were wrong', async () => {
    // No rotation involved: boxes are scaled by photo.width at read time, so
    // any change to the stored dimensions invalidates them.
    const { photoId } = await seed({
      orientation: null, storedWidth: 999, storedHeight: 111, faceStatus: 'done',
    });

    await run();
    const done = await settle();

    const row = await db('photos').where({ id: photoId }).first();
    expect(row.width).toBe(400);
    expect(row.face_status).toBe('pending');
    expect(done.body.lastResult.requeuedFaces).toBe(1);
  });

  it('requeues an orientation that moves pixels without moving dimensions', async () => {
    // Orientation 3 is a 180° turn: every pixel moves, width and height do
    // not. A dimension-delta check sees nothing and skips exactly this row.
    const { photoId } = await seed({
      orientation: 3, storedWidth: 400, storedHeight: 200, faceStatus: 'done',
    });

    await run();
    const done = await settle();

    const row = await db('photos').where({ id: photoId }).first();
    expect(row.width).toBe(400);          // unchanged, correctly
    expect(row.face_status).toBe('pending');
    expect(row.preview_path).toBeNull();
    expect(done.body.lastResult.requeuedFaces).toBe(1);
    expect(done.body.lastResult.corrected).toBe(0);
  });

  it('leaves a post-fix import alone, renditions and all', async () => {
    // A 5-8 rotation changes the dimensions, so a tagged photo whose stored
    // dimensions are already oriented must have been ingested after #1185.
    // Re-clearing its renditions would delete valid files and rescan a
    // completed face detection for nothing.
    const { photoId } = await seed({
      orientation: 6, storedWidth: 200, storedHeight: 400, faceStatus: 'done',
    });

    await run();
    const done = await settle();

    const row = await db('photos').where({ id: photoId }).first();
    expect(row.thumbnail_path).toBe('thumbnails/thumb_orientbf.jpg');
    expect(row.face_status).toBe('done');
    expect(done.body.lastResult).toMatchObject({ corrected: 0, requeuedFaces: 0 });
    // ...and it is marked, so it is not re-read next time either.
    expect(row.orientation_checked_at).toBeTruthy();
  });

  it('still invalidates a 180-degree rotation, which carries no such evidence', async () => {
    // Orientation 3 leaves the dimensions identical whether or not it has been
    // processed, so there is nothing to infer from and it must be done once.
    const { photoId } = await seed({
      orientation: 3, storedWidth: 400, storedHeight: 200, faceStatus: 'done',
    });

    await run();
    await settle();

    const row = await db('photos').where({ id: photoId }).first();
    expect(row.thumbnail_path).toBeNull();
    expect(row.face_status).toBe('pending');
  });

  it('leaves an untagged photo completely alone', async () => {
    const { photoId } = await seed({
      orientation: null, storedWidth: 400, storedHeight: 200, faceStatus: 'done',
    });

    await run();
    const done = await settle();

    const row = await db('photos').where({ id: photoId }).first();
    expect(row.width).toBe(400);
    expect(row.face_status).toBe('done');
    expect(row.preview_path).toBe('previews/prev_orientbf.jpg');
    expect(done.body.lastResult).toMatchObject({ corrected: 0, requeuedFaces: 0, failed: 0 });
  });

  it('does not start face scanning on an install that never enabled it', async () => {
    const { photoId } = await seed({
      orientation: 6, storedWidth: 400, storedHeight: 200, faceStatus: null,
    });

    await run();
    const done = await settle();

    expect((await db('photos').where({ id: photoId }).first()).face_status).toBeNull();
    expect(done.body.lastResult.requeuedFaces).toBe(0);
    // ...but the dimensions are still corrected.
    expect(done.body.lastResult.corrected).toBe(1);
  });

  it('skips archived events, whose originals were deleted on archive', async () => {
    await seed({ orientation: 6, storedWidth: 400, storedHeight: 200, archived: true });

    const res = await run();
    expect(res.body.count).toBe(0);
  });

  it('refuses a second run while one is in flight', async () => {
    // Shares the maintenance-lease plumbing, on its own job row so it neither
    // blocks nor is blocked by the dimension repair.
    const jobs = require('../../src/services/maintenanceJobState');
    await seed({ orientation: 6, storedWidth: 400, storedHeight: 200 });

    const claim = await jobs.claim(jobs.JOB_ORIENTATION_BACKFILL);
    expect(claim).toEqual(expect.any(String));

    expect((await run()).status).toBe(409);

    // The dimension repair is a different job and is unaffected.
    expect((await request(app).post('/api/admin/photos/repair-dimensions')).status).toBe(200);
    await jobs.release(jobs.JOB_ORIENTATION_BACKFILL, claim);
  });
});
