/**
 * POST /admin/thumbnails/regenerate for external/reference photos (#1129).
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
  let tmpDir; let db; let cleanup; let app; let imageProcessor; let storage; let logInfo;

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
      // An unscoped regeneration also checks settings.edit in the handler.
      userHasAnyPermission: jest.fn().mockResolvedValue(true),
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
      deleteThumbnailTiers: jest.fn().mockResolvedValue(undefined),
      deletePreviewTiers: jest.fn().mockResolvedValue(undefined),
    }));

    // Same module registry as the route, so the spy sees its calls. The
    // completion line is what drain() below waits for.
    logInfo = jest.spyOn(require('../../src/utils/logger'), 'info');

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

  /**
   * The work runs in setImmediate, after the response. Wait for the loop's
   * "regeneration complete" log line rather than a fixed 150 ms: under a
   * loaded machine (fifteen suites in parallel, each booting a migrated
   * SQLite) the loop occasionally took longer than that, and the assertions
   * then ran against a half-finished mock call list.
   */
  const drain = async () => {
    const deadline = Date.now() + 10000;
    const done = () => logInfo.mock.calls.some((c) => /regeneration complete/.test(String(c[0])));
    while (!done() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

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

  it('still drops the responsive tiers first', async () => {
    const eventId = await seedEvent();
    await seedPhoto(eventId, { source_origin: 'external', external_relpath: 'shot.jpg' });

    await request(app).post('/admin/thumbnails/regenerate').send({});
    await drain();

    // They are keyed by width outside thumbnail_path and carry no settings
    // version, so leaving them serves the old fit to phones indefinitely.
    expect(imageProcessor.deleteThumbnailTiers).toHaveBeenCalledTimes(1);
  });

  /**
   * Videos used to be filtered out of this query: ensureThumbnail had no video
   * branch, so each one only produced a Sharp error. It has one now (issue
   * 1414), and this button is what an admin with a galleryful of broken video
   * tiles reaches for — so videos are back in, under different rules from
   * stills, because a poster frame is not a function of the thumbnail settings
   * (videoProcessor renders it at a fixed 300x300):
   *
   *  - REPAIR, not rebuild. thumbnail_path is passed through and `force` is
   *    off, so ensureThumbnail's own valid-thumbnail check skips a healthy
   *    poster. Forcing it would re-download every video on every press — a
   *    full object each on S3 — to write back the same bytes.
   *  - No size bound. The bound exists for the guest request path; here an
   *    admin asked, in a background job. Bounded, a large S3 video whose
   *    thumbnail is missing could only ever get the placeholder.
   *  - No tier deletion: videos never take the tier path.
   */
  describe('videos', () => {
    it('repairs a video through ensureThumbnail without forcing or bounding it', async () => {
      const eventId = await seedEvent();
      await seedPhoto(eventId, {
        source_origin: 'managed', media_type: 'video', filename: 'clip.mp4',
        thumbnail_path: 'thumbnails/thumb_clip.jpg',
      });

      const res = await request(app).post('/admin/thumbnails/regenerate').send({});
      await drain();

      expect(res.body.count).toBe(1);
      expect(imageProcessor.ensureThumbnail).toHaveBeenCalledTimes(1);
      const [photoArg, options] = imageProcessor.ensureThumbnail.mock.calls[0];
      expect(photoArg.filename).toBe('clip.mp4');
      expect(photoArg.thumbnail_path).toBe('thumbnails/thumb_clip.jpg');
      expect(options).toEqual({ boundVideoSource: false });
      expect(imageProcessor.deleteThumbnailTiers).not.toHaveBeenCalled();
    });

    it('recognises a legacy video row by mime_type alone', async () => {
      const eventId = await seedEvent();
      await seedPhoto(eventId, { source_origin: 'managed', mime_type: 'video/mp4', filename: 'old.mp4' });

      await request(app).post('/admin/thumbnails/regenerate').send({});
      await drain();

      expect(imageProcessor.ensureThumbnail.mock.calls[0][1]).toEqual({ boundVideoSource: false });
    });

    it('keeps rebuilding stills with force and a nulled thumbnail_path', async () => {
      const eventId = await seedEvent();
      await seedPhoto(eventId, { source_origin: 'managed', filename: 'still.jpg', thumbnail_path: 'thumbnails/thumb_still.jpg' });

      await request(app).post('/admin/thumbnails/regenerate').send({});
      await drain();

      const [photoArg, options] = imageProcessor.ensureThumbnail.mock.calls[0];
      expect(photoArg.thumbnail_path).toBeNull();
      expect(options).toEqual({ force: true });
      expect(imageProcessor.deleteThumbnailTiers).toHaveBeenCalledTimes(1);
    });

    it('does not let an unreadable video take the rest of the batch down', async () => {
      const eventId = await seedEvent();
      await seedPhoto(eventId, { source_origin: 'managed', media_type: 'video', filename: 'broken.mp4' });
      await seedPhoto(eventId, { source_origin: 'managed', media_type: 'video', filename: 'throws.mp4' });
      await seedPhoto(eventId, { source_origin: 'managed', filename: 'still.jpg' });
      imageProcessor.ensureThumbnail
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error('ffmpeg exited with code 1'));

      await request(app).post('/admin/thumbnails/regenerate').send({});
      await drain();

      expect(imageProcessor.ensureThumbnail).toHaveBeenCalledTimes(3);
      const done = logInfo.mock.calls.map((c) => String(c[0])).find((l) => /regeneration complete/.test(l));
      expect(done).toMatch(/1 success, 2 errors/);
    });

    it('still leaves videos out of the preview regeneration, which is image-only', async () => {
      const eventId = await seedEvent();
      await seedPhoto(eventId, { source_origin: 'managed', media_type: 'video', filename: 'clip.mp4' });
      await seedPhoto(eventId, { source_origin: 'managed', filename: 'still.jpg' });

      const res = await request(app).post('/admin/thumbnails/regenerate-previews').send({});

      expect(res.body.count).toBe(1);
    });
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
