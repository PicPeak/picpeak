/**
 * External imports take videos (issue 1430, item 4).
 *
 * The folder import and the picker listed jpg/jpeg/png/webp only, so a clip an
 * editor dropped into the NAS folder next to the photos was invisible to
 * PicPeak. Videos are now imported like uploaded ones: media_type and
 * mime_type set, a poster frame and ffprobe metadata from the same routine the
 * upload pipeline uses.
 *
 * Pins:
 *  - videos are taken only for the types the install allows as uploads, so an
 *    upgrade does not publish clips from a folder that always held them
 *  - an allowed video gets the row shape every serving route relies on, and
 *    the thumbnail key regenerateVideoThumbnail would derive for it
 *  - a video is not queued for face scanning
 *  - a failed poster frame keeps the row
 *
 * Driven through the real route. processUploadedVideo is mocked: CI has no
 * ffmpeg, and what it does with a file is covered by its own tests.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const request = require('supertest');

describe('external import of videos (issue 1430)', () => {
  let tmpDir; let db; let app; let mediaRoot;
  let uploadSettings;
  let processUploadedVideo;

  const write = async (rel) => {
    const full = path.join(mediaRoot, rel);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, 'not-real-media');
  };

  const allowTypes = async (value) => {
    await db('app_settings')
      .insert({
        setting_key: 'general_allowed_file_types',
        setting_value: JSON.stringify(value),
        setting_type: 'general',
        updated_at: new Date().toISOString(),
      })
      .onConflict('setting_key')
      .merge({ setting_value: JSON.stringify(value) });
    uploadSettings.clearAllowedTypesCache();
  };

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-extvideo-'));
    mediaRoot = path.join(tmpDir, 'media');
    await fs.promises.mkdir(mediaRoot, { recursive: true });

    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'data', 'db.sqlite');
    await fs.promises.mkdir(path.dirname(process.env.TEST_DATABASE_PATH), { recursive: true });
    process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
    process.env.EXTERNAL_MEDIA_ROOT = mediaRoot;
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'extvideo-secret';

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
    jest.doMock('../../src/services/imageProcessor', () => {
      const actual = jest.requireActual('../../src/services/imageProcessor');
      return { ...actual, generateThumbnail: jest.fn(async () => 'thumbnails/mock.jpg'), ensureThumbnail: jest.fn() };
    });
    jest.doMock('../../src/services/videoProcessor', () => {
      const actual = jest.requireActual('../../src/services/videoProcessor');
      return { ...actual, processUploadedVideo: jest.fn() };
    });
    jest.doMock('../../src/utils/logger', () => ({
      debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    }));

    ({ db } = await require('./helpers/crmDb').bootCrmDb());
    uploadSettings = require('../../src/services/uploadSettings');
    ({ processUploadedVideo } = require('../../src/services/videoProcessor'));

    app = express();
    app.use(express.json());
    app.use('/api/admin/external-media', require('../../src/routes/adminExternalMedia'));
  }, 180000);

  afterAll(async () => {
    if (db) await db.destroy?.();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    await db('photos').del();
    // The import logs an activity against the event; Postgres enforces that
    // foreign key where SQLite does not.
    await db('activity_logs').del();
    await db('events').del();
    await db('app_settings').where({ setting_key: 'general_allowed_file_types' }).del();
    uploadSettings.clearAllowedTypesCache();
    await fs.promises.rm(mediaRoot, { recursive: true, force: true });
    await fs.promises.mkdir(mediaRoot, { recursive: true });

    processUploadedVideo.mockReset();
    processUploadedVideo.mockImplementation(async (_videoPath, thumbnailKey) => ({
      success: true,
      thumbnailKey,
      metadata: { duration: 42, width: 1920, height: 1080, videoCodec: 'h264', audioCodec: 'aac' },
    }));
  });

  async function seedEvent({ facesEnabled = false } = {}) {
    await db('feature_flags').insert({ key: 'faces', value: facesEnabled })
      .onConflict('key').merge()
      .catch(async () => { await db('feature_flags').where({ key: 'faces' }).update({ value: facesEnabled }); });
    require('../../src/middleware/requireFeatureFlag').invalidateFeatureFlagCache();

    const [e] = await db('events').insert({
      slug: `extvideo-${Math.random().toString(36).slice(2, 8)}`,
      event_type: 'wedding', event_name: 'extvideo', event_date: '2026-01-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `extvideo-${Math.random()}`, expires_at: new Date().toISOString(),
      face_recognition_enabled: facesEnabled,
      source_mode: 'reference',
    }).returning('id');
    return typeof e === 'object' ? e.id : e;
  }

  const runImport = (eventId, external_path = 'shoot') => request(app)
    .post(`/api/admin/external-media/events/${eventId}/import-external`)
    .send({ external_path, recursive: true });

  const listNames = async (dir) => {
    const res = await request(app).get('/api/admin/external-media/list').query({ path: dir });
    expect(res.status).toBe(200);
    return res.body.entries.map((e) => e.name).sort();
  };

  it('leaves videos alone while no video type is allowed for uploads', async () => {
    const eventId = await seedEvent();
    await write('shoot/a.jpg');
    await write('shoot/clip.mp4');

    const res = await runImport(eventId);

    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    const rows = await db('photos').where({ event_id: eventId });
    expect(rows.map((r) => r.filename)).toEqual(['a.jpg']);
    expect(processUploadedVideo).not.toHaveBeenCalled();
    // The picker's listing follows the same rule.
    expect(await listNames('shoot')).toEqual(['a.jpg']);
  });

  it('imports an allowed video with the row shape of an uploaded one', async () => {
    await allowTypes('jpg,jpeg,png,webp,mp4');
    const eventId = await seedEvent();
    await write('shoot/a.jpg');
    await write('shoot/clip.mp4');

    const res = await runImport(eventId);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ imported: 2, thumbnailsGenerated: 2, thumbnailsFailed: 0 });

    const video = await db('photos').where({ event_id: eventId, filename: 'clip.mp4' }).first();
    expect(video).toMatchObject({
      media_type: 'video',
      mime_type: 'video/mp4',
      source_origin: 'external',
      external_relpath: path.join('shoot', 'clip.mp4'),
      duration: 42,
      width: 1920,
      height: 1080,
      video_codec: 'h264',
      audio_codec: 'aac',
      // The key regenerateVideoThumbnail derives for this row, so a later
      // regenerate overwrites the file rather than orphaning it.
      thumbnail_path: `thumbnails/thumb_ext${video.id}_clip.jpg`,
    });
    // Read straight off the mount, not copied anywhere first.
    expect(processUploadedVideo).toHaveBeenCalledWith(
      path.join(mediaRoot, 'shoot', 'clip.mp4'),
      `thumbnails/thumb_ext${video.id}_clip.jpg`,
    );

    // The photo next to it is untouched by any of this.
    const photo = await db('photos').where({ event_id: eventId, filename: 'a.jpg' }).first();
    expect(photo.media_type).toBe('image');
    expect(photo.thumbnail_path).toBe('thumbnails/mock.jpg');

    expect(await listNames('shoot')).toEqual(['a.jpg', 'clip.mp4']);
  });

  it('takes only the video types that are allowed, whatever the case of the extension', async () => {
    await allowTypes('jpg,mov');
    const eventId = await seedEvent();
    await write('shoot/FIRST.MOV');
    await write('shoot/second.webm');
    await write('shoot/third.mp4');

    const res = await runImport(eventId);

    expect(res.body.imported).toBe(1);
    const rows = await db('photos').where({ event_id: eventId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ filename: 'FIRST.MOV', media_type: 'video', mime_type: 'video/quicktime' });
  });

  it('does not import the same video twice', async () => {
    await allowTypes('jpg,mp4');
    const eventId = await seedEvent();
    await write('shoot/clip.mp4');

    await runImport(eventId);
    const again = await runImport(eventId);

    expect(again.body).toMatchObject({ imported: 0, skipped: 1 });
    expect(await db('photos').where({ event_id: eventId })).toHaveLength(1);
    expect(processUploadedVideo).toHaveBeenCalledTimes(1);
  });

  it('queues the photos for face scanning and leaves the videos out', async () => {
    await allowTypes('jpg,mp4');
    const eventId = await seedEvent({ facesEnabled: true });
    await write('shoot/a.jpg');
    await write('shoot/clip.mp4');

    await runImport(eventId);

    const photo = await db('photos').where({ event_id: eventId, filename: 'a.jpg' }).first();
    const video = await db('photos').where({ event_id: eventId, filename: 'clip.mp4' }).first();
    expect(photo.face_status).toBe('pending');
    expect(video.face_status).toBeNull();
  });

  it('keeps the row when the poster frame cannot be produced', async () => {
    await allowTypes('jpg,mp4');
    const eventId = await seedEvent();
    await write('shoot/broken.mp4');
    processUploadedVideo.mockRejectedValue(new Error('Unable to generate any thumbnail'));

    const res = await runImport(eventId);

    expect(res.body).toMatchObject({ imported: 1, thumbnailsGenerated: 0, thumbnailsFailed: 1 });
    const video = await db('photos').where({ event_id: eventId }).first();
    expect(video).toMatchObject({ media_type: 'video', mime_type: 'video/mp4', thumbnail_path: null, duration: null });
  });

  it('stores what ffprobe could read and nothing it could not', async () => {
    await allowTypes('jpg,mp4');
    const eventId = await seedEvent();
    await write('shoot/odd.mp4');
    // The shape #1370 produced: a poster frame, but no readable metadata.
    processUploadedVideo.mockImplementation(async (_p, thumbnailKey) => ({ success: true, thumbnailKey, metadata: null }));

    await runImport(eventId);

    const video = await db('photos').where({ event_id: eventId }).first();
    expect(video.thumbnail_path).toBe(`thumbnails/thumb_ext${video.id}_odd.jpg`);
    expect(video).toMatchObject({ duration: null, width: null, height: null, video_codec: null });
  });
});
