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
   * Issue 2113. A RAW photo's cached sizes are named through its processing
   * attempt, so the row the sweep gets must carry it; and a tier that could
   * not be deleted keeps being served, so the photo counts as failed.
   */
  describe('RAW tiers and failed tier deletes (issue 2113)', () => {
    const completion = () => logInfo.mock.calls.map((c) => String(c[0])).find((m) => /regeneration complete/.test(m));
    const raw = { source_origin: 'managed', filename: 'IMG_1.NEF', path: 'nas-wedding/IMG_1.NEF', processing_attempt_id: 'attempt-a1' };

    it.each([
      ['thumbnails', '/admin/thumbnails/regenerate', 'deleteThumbnailTiers'],
      ['previews', '/admin/thumbnails/regenerate-previews', 'deletePreviewTiers'],
    ])('hands the %s sweep the processing attempt, strictly', async (_kind, url, helper) => {
      const eventId = await seedEvent();
      await seedPhoto(eventId, raw);

      await request(app).post(url).send({});
      await drain();

      const [photoArg, options] = imageProcessor[helper].mock.calls[0];
      expect(photoArg).toMatchObject({ event_id: eventId, filename: 'IMG_1.NEF', processing_attempt_id: 'attempt-a1' });
      expect(options).toEqual({ strict: true });
      expect(completion()).toMatch(/1 success, 0 errors/);
    });

    it.each([
      ['thumbnails', '/admin/thumbnails/regenerate', 'deleteThumbnailTiers', 'ensureThumbnail'],
      ['previews', '/admin/thumbnails/regenerate-previews', 'deletePreviewTiers', 'ensurePreviewImage'],
    ])('counts a photo whose %s tiers could not be deleted as failed', async (_kind, url, helper, ensure) => {
      const eventId = await seedEvent();
      await seedPhoto(eventId, raw);
      await seedPhoto(eventId, { source_origin: 'managed', filename: 'fine.jpg' });
      imageProcessor[helper].mockRejectedValueOnce(new Error('Could not delete 1 tier(s): AccessDenied'));

      await request(app).post(url).send({});
      await drain();

      // The rebuild still runs for both; only the count changes.
      expect(imageProcessor[ensure]).toHaveBeenCalledTimes(2);
      expect(completion()).toMatch(/1 success, 1 errors/);
    });
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
        thumbnail_path: 'thumbnails/thumb_clip.jpg', processing_status: 'complete',
      });

      const res = await request(app).post('/admin/thumbnails/regenerate').send({});
      await drain();

      expect(res.body.count).toBe(1);
      expect(imageProcessor.ensureThumbnail).toHaveBeenCalledTimes(1);
      const [photoArg, options] = imageProcessor.ensureThumbnail.mock.calls[0];
      expect(photoArg.filename).toBe('clip.mp4');
      expect(photoArg.thumbnail_path).toBe('thumbnails/thumb_clip.jpg');
      // Without the status, ensureThumbnail could not keep the poster note in
      // step with the rebuilt frame (issue 1430).
      expect(photoArg.processing_status).toBe('complete');
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

  /**
   * The preview endpoint nulls preview_path the same way, so the replaced
   * preview is hidden from every cleanup once its key moves: a watch-folder
   * photo's preview gets a per-photo name (PR 2038), an S3 source renders
   * from a random temp name, an external row's name carries its version.
   */
  describe('superseded previews', () => {
    it('removes the old preview when the key moved', async () => {
      const eventId = await seedEvent();
      const id = await seedPhoto(eventId, {
        source_origin: 'managed', filename: 'IMG_1.jpg', source_filename: 'IMG_1.jpg',
        preview_path: 'previews/preview_IMG_1.jpg',
      });
      // Publishes on the row, as a real generation does.
      imageProcessor.ensurePreviewImage.mockImplementationOnce(async () => {
        await db('photos').where({ id }).update({ preview_path: `previews/preview_p${id}_IMG_1.jpg` });
        return `previews/preview_p${id}_IMG_1.jpg`;
      });

      await request(app).post('/admin/thumbnails/regenerate-previews').send({});
      await drain();

      expect(storage.delete).toHaveBeenCalledWith('previews/preview_IMG_1.jpg');
    });

    it.each([
      ['a leading ./', './previews/preview_stable.jpg'],
      ['an interior ./', 'previews/./preview_stable.jpg'],
      ['a repeated leading ./', '././previews/preview_stable.jpg'],
      ['a leading /./', '/./previews/preview_stable.jpg'],
      ['a doubled separator before ./', 'previews//./preview_stable.jpg'],
      ['a resolved ..', 'previews/x/../preview_stable.jpg'],
    ])('keeps the old preview when the key is unchanged, spelled with %s', async (_name, stored) => {
      const eventId = await seedEvent();
      await seedPhoto(eventId, { source_origin: 'managed', preview_path: stored });
      imageProcessor.ensurePreviewImage.mockResolvedValueOnce('previews/preview_stable.jpg');

      await request(app).post('/admin/thumbnails/regenerate-previews').send({});
      await drain();

      expect(storage.delete).not.toHaveBeenCalled();
    });

    it('keeps the old preview when an older render published it on the row again', async () => {
      const eventId = await seedEvent();
      const id = await seedPhoto(eventId, { source_origin: 'managed', preview_path: 'previews/preview_K.jpg' });
      // Our render publishes K.webp; another replica's older one then puts
      // K.jpg back on the row before the cleanup looks.
      imageProcessor.ensurePreviewImage.mockImplementationOnce(async () => {
        await db('photos').where({ id }).update({ preview_path: 'previews/preview_K.jpg' });
        return 'previews/preview_K.webp';
      });

      await request(app).post('/admin/thumbnails/regenerate-previews').send({});
      await drain();

      expect(storage.delete).not.toHaveBeenCalled();
    });

    it('deletes a preview two regenerated photos shared once, after both moved off it', async () => {
      const eventId = await seedEvent();
      await seedPhoto(eventId, { source_origin: 'managed', preview_path: 'previews/preview_IMG_1.jpg' });
      await seedPhoto(eventId, { source_origin: 'managed', preview_path: 'previews/preview_IMG_1.jpg' });
      // Publishes on the row, as a real generation does.
      const publish = async (photo) => {
        const key = `previews/preview_p${photo.id}_IMG_1.jpg`;
        await db('photos').where({ id: photo.id }).update({ preview_path: key });
        return key;
      };
      imageProcessor.ensurePreviewImage.mockImplementationOnce(publish).mockImplementationOnce(publish);

      await request(app).post('/admin/thumbnails/regenerate-previews').send({});
      await drain();

      // Both moved off it during the run: deleted once, after the loop.
      expect(storage.delete).toHaveBeenCalledTimes(1);
      expect(storage.delete).toHaveBeenCalledWith('previews/preview_IMG_1.jpg');
    });

    it.each([
      ['backslashes', '.\\previews\\preview_IMG_1.jpg'],
      ['a repeated leading ./', '././previews/preview_IMG_1.jpg'],
      ['a leading /./', '/./previews/preview_IMG_1.jpg'],
    ])('keeps the old preview while another gallery stores it with %s', async (_name, stored) => {
      const eventId = await seedEvent();
      const id = await seedPhoto(eventId, { source_origin: 'managed', preview_path: 'previews/preview_IMG_1.jpg' });
      const [other] = await db('events').insert({
        slug: 'other', event_type: 'wedding', event_name: 'other', event_date: '2026-01-01',
        host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
        share_link: 'other-share', expires_at: new Date().toISOString(),
      }).returning('id');
      await seedPhoto(typeof other === 'object' ? other.id : other, {
        source_origin: 'managed', preview_path: stored,
      });
      imageProcessor.ensurePreviewImage.mockImplementationOnce(async () => {
        await db('photos').where({ id }).update({ preview_path: 'previews/preview_p1_IMG_1.jpg' });
        return 'previews/preview_p1_IMG_1.jpg';
      });

      await request(app).post('/admin/thumbnails/regenerate-previews').send({ eventId });
      await drain();

      // Both backends fold the two spellings to one object.
      expect(imageProcessor.ensurePreviewImage).toHaveBeenCalledTimes(1);
      expect(storage.delete).not.toHaveBeenCalled();
    });

    it('checks the references once for the whole run, not once per moved preview', async () => {
      const eventId = await seedEvent();
      for (let i = 1; i <= 3; i++) {
        await seedPhoto(eventId, { source_origin: 'managed', preview_path: `previews/preview_OLD${i}.jpg` });
      }
      // Kept: another photo, not regenerated here, still points at OLD3.
      await seedPhoto(eventId, { source_origin: 'managed', media_type: 'video', preview_path: 'previews/preview_OLD3.jpg' });
      imageProcessor.ensurePreviewImage.mockImplementation(async (photo) => {
        const key = `previews/preview_NEW${photo.id}.jpg`;
        await db('photos').where({ id: photo.id }).update({ preview_path: key });
        return key;
      });
      const lookups = [];
      const onQuery = (q) => { if (/preview_path. is not null/i.test(q.sql)) lookups.push(q.sql); };
      db.on('query', onQuery);
      try {
        await request(app).post('/admin/thumbnails/regenerate-previews').send({});
        await drain();
      } finally {
        db.removeListener('query', onQuery);
        imageProcessor.ensurePreviewImage.mockReset();
        imageProcessor.ensurePreviewImage.mockResolvedValue('previews/p.jpg');
      }

      expect(storage.delete.mock.calls.map((c) => c[0]).sort())
        .toEqual(['previews/preview_OLD1.jpg', 'previews/preview_OLD2.jpg']);
      // One paged pass for all three moves: a page, then the empty page.
      expect(lookups).toHaveLength(2);
    });

    it('keeps the old preview when nothing was generated', async () => {
      const eventId = await seedEvent();
      await seedPhoto(eventId, { source_origin: 'managed', preview_path: 'previews/preview_old.jpg' });
      imageProcessor.ensurePreviewImage.mockResolvedValueOnce(null);

      await request(app).post('/admin/thumbnails/regenerate-previews').send({});
      await drain();

      expect(storage.delete).not.toHaveBeenCalled();
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
