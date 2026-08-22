/**
 * POST /admin/thumbnails/regenerate for external/reference photos (#1129).
 *
 * STABLE TWIN. Diverges from the main version in one place: stable has no
 * responsive ?w= tiers (#1095/#1109), so there is no deleteThumbnailTiers call
 * to assert and the "drops the tiers first" test is absent here. Everything
 * else — the external rebuild, the thumbnail_path:null contract, video
 * skipping, per-event scoping and the superseded-key deletion — is identical.
 *
 * The route used to resolve every source as `storage/events/active/<path>` and
 * `fs.access` it. External and reference rows do not live there — their
 * originals sit under `events.external_path` — so every one of them failed the
 * check and was counted as an error.
 *
 * That alone would be inert. What made it destructive is that the tier
 * deletion runs FIRST (deliberately, so S3 and external rows are not skipped):
 * on a reference install the button dropped every ?w= tier and rebuilt
 * nothing, while the UI reported success — the response is sent before the
 * background loop starts.
 *
 * The background work is fired with setImmediate, so every assertion here has
 * to wait for it to drain rather than trusting the response.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const request = require('supertest');

describe('admin thumbnail regeneration (#1129)', () => {
  let tmpDir; let db; let cleanup; let app; let imageProcessor; let storage;

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-regen-'));
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
    }));
    // One instance, not a fresh object per call — the route and the
    // assertions have to be looking at the same mock.
    jest.doMock('../../src/services/storage', () => {
      const instance = { delete: jest.fn().mockResolvedValue(undefined) };
      return { getStorage: () => instance };
    });
    jest.doMock('../../src/services/imageProcessor', () => ({
      ensureThumbnail: jest.fn().mockResolvedValue('thumbnails/thumb_ext1_shot.jpg'),
      ensurePreviewImage: jest.fn().mockResolvedValue('previews/p.jpg'),
      deletePreviewTiers: jest.fn().mockResolvedValue(undefined),
    }));

    // bootCrmDb, not run-migrations: the latter calls process.exit(0) on
    // success, which ends the jest worker mid-suite.
    ({ db, cleanup } = await require('./helpers/crmDb').bootCrmDb());

    imageProcessor = require('../../src/services/imageProcessor');
    storage = require('../../src/services/storage').getStorage();
    app = express();
    app.use(express.json());
    app.use('/admin/thumbnails', require('../../src/routes/adminThumbnails'));
  }, 180000);

  afterAll(async () => {
    if (cleanup) await cleanup();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await db('photos').del();
    await db('events').del();
  });

  async function seedEvent() {
    const [row] = await db('events').insert({
      slug: 'nas-wedding', event_type: 'wedding', event_name: 'nas',
      event_date: '2026-01-01', host_email: 'h@example.com', admin_email: 'a@example.com',
      password_hash: 'x', share_link: 'nas-share', expires_at: new Date().toISOString(),
      source_mode: 'reference', external_path: 'weddings/2026-08',
    }).returning('id');
    return typeof row === 'object' ? row.id : row;
  }

  async function seedPhoto(eventId, overrides = {}) {
    const [row] = await db('photos').insert({
      event_id: eventId, filename: 'shot.jpg', path: 'nas-wedding/shot.jpg',
      type: 'individual', ...overrides,
    }).returning('id');
    return typeof row === 'object' ? row.id : row;
  }

  /** The work runs in setImmediate; give it room to finish. */
  const drain = () => new Promise((resolve) => setTimeout(resolve, 150));

  it('rebuilds the canonical thumbnail for an external photo instead of erroring', async () => {
    const eventId = await seedEvent();
    await seedPhoto(eventId, {
      source_origin: 'external',
      external_relpath: 'shot.jpg',
      thumbnail_path: 'thumbnails/stale.jpg',
    });

    const res = await request(app).post('/admin/thumbnails/regenerate').send({});
    expect(res.status).toBe(200);
    await drain();

    // The whole bug: this used to be zero calls and one logged
    // "Original file not found" per photo.
    expect(imageProcessor.ensureThumbnail).toHaveBeenCalledTimes(1);
  });

  it('nulls thumbnail_path so the valid-thumbnail short-circuit cannot skip the rebuild', async () => {
    const eventId = await seedEvent();
    await seedPhoto(eventId, {
      source_origin: 'external',
      external_relpath: 'shot.jpg',
      thumbnail_path: 'thumbnails/still-on-disk.jpg',
    });

    await request(app).post('/admin/thumbnails/regenerate').send({});
    await drain();

    // Without this the endpoint is a no-op whenever the OLD thumbnail is still
    // readable — which is the normal case after a settings change, and exactly
    // when the admin pressed the button.
    const [photoArg] = imageProcessor.ensureThumbnail.mock.calls[0];
    expect(photoArg.thumbnail_path).toBeNull();
    expect(photoArg.source_origin).toBe('external');
    // Carried through so ensureThumbnail can resolve off the mount rather than
    // under events/active.
    expect(photoArg.external_relpath).toBe('shot.jpg');
  });

  it('leaves videos alone rather than handing a container file to Sharp', async () => {
    const eventId = await seedEvent();
    await seedPhoto(eventId, { source_origin: 'managed', media_type: 'video', filename: 'clip.mp4' });
    await seedPhoto(eventId, { source_origin: 'managed', filename: 'still.jpg' });

    const res = await request(app).post('/admin/thumbnails/regenerate').send({});
    await drain();

    expect(res.body.count).toBe(1);
    expect(imageProcessor.ensureThumbnail).toHaveBeenCalledTimes(1);
    expect(imageProcessor.ensureThumbnail.mock.calls[0][0].filename).toBe('still.jpg');
  });

  /**
   * On S3, ensureThumbnail downloads the source to a randomly-named temp file,
   * and for non-RAW input withProcessableImage passes no outputBasename — so
   * generateThumbnail derives the key from that random name and it differs on
   * every run. Nulling thumbnail_path hides the old key from everything that
   * would otherwise clean it up, so each regeneration would strand a full
   * thumbnail in the bucket, once per photo per run.
   */
  describe('superseded canonical renditions', () => {
    it('removes the old thumbnail when the key moved', async () => {
      const eventId = await seedEvent();
      await seedPhoto(eventId, {
        source_origin: 'managed',
        thumbnail_path: 'thumbnails/thumb_OLDRANDOM_shot.jpg',
      });
      imageProcessor.ensureThumbnail.mockResolvedValueOnce('thumbnails/thumb_NEWRANDOM_shot.jpg');

      await request(app).post('/admin/thumbnails/regenerate').send({});
      await drain();

      expect(storage.delete).toHaveBeenCalledWith('thumbnails/thumb_OLDRANDOM_shot.jpg');
    });

    it('does NOT delete when the key is unchanged — that is the new file', async () => {
      const eventId = await seedEvent();
      await seedPhoto(eventId, {
        source_origin: 'managed',
        thumbnail_path: 'thumbnails/thumb_stable.jpg',
      });
      // Local storage resolves to a stable path, so the key is identical.
      imageProcessor.ensureThumbnail.mockResolvedValueOnce('thumbnails/thumb_stable.jpg');

      await request(app).post('/admin/thumbnails/regenerate').send({});
      await drain();

      expect(storage.delete).not.toHaveBeenCalled();
    });

    it.each([
      ['a Windows-style legacy path', 'thumbnails\\thumb_ext1_shot.jpg'],
      ['a leading ./', './thumbnails/thumb_ext1_shot.jpg'],
      ['a doubled separator', 'thumbnails//thumb_ext1_shot.jpg'],
    ])('does not delete the file it just wrote when the old path is %s', async (_name, stored) => {
      const eventId = await seedEvent();
      await seedPhoto(eventId, { source_origin: 'managed', thumbnail_path: stored });
      // Both storage backends fold these to the same key, so this is the SAME
      // object — deleting it would remove the freshly generated thumbnail and
      // leave the row pointing at nothing.
      imageProcessor.ensureThumbnail.mockResolvedValueOnce('thumbnails/thumb_ext1_shot.jpg');

      await request(app).post('/admin/thumbnails/regenerate').send({});
      await drain();

      expect(storage.delete).not.toHaveBeenCalled();
    });

    it('counts the photo as regenerated even if the old object cannot be removed', async () => {
      const eventId = await seedEvent();
      await seedPhoto(eventId, {
        source_origin: 'managed',
        thumbnail_path: 'thumbnails/thumb_OLD.jpg',
      });
      imageProcessor.ensureThumbnail.mockResolvedValueOnce('thumbnails/thumb_NEW.jpg');
      storage.delete.mockRejectedValueOnce(new Error('bucket said no'));

      await request(app).post('/admin/thumbnails/regenerate').send({});
      await drain();

      // Losing the old object is untidy; the regeneration itself succeeded.
      expect(imageProcessor.ensureThumbnail).toHaveBeenCalledTimes(1);
    });
  });

  it('scopes to one event when asked', async () => {
    const a = await seedEvent();
    await seedPhoto(a, { source_origin: 'external', external_relpath: 'a.jpg' });
    const [b] = await db('events').insert({
      slug: 'other', event_type: 'wedding', event_name: 'other', event_date: '2026-01-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: 'other-share', expires_at: new Date().toISOString(),
    }).returning('id');
    await seedPhoto(typeof b === 'object' ? b.id : b, { source_origin: 'managed' });

    const res = await request(app).post('/admin/thumbnails/regenerate').send({ eventId: a });
    await drain();

    expect(res.body.count).toBe(1);
    expect(imageProcessor.ensureThumbnail).toHaveBeenCalledTimes(1);
  });
});
