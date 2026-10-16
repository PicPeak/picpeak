/**
 * A reference-gallery video edited in place (same path, new bytes) must not
 * keep its old poster, web copy and adaptive streaming ladder (issue 2114).
 *
 * The re-scan refreshed edited photos but skipped videos, so guests kept
 * playing the previous version while the download served the new file.
 *
 * Driven through the real route against real files. processUploadedVideo and
 * extractVideoMetadata are mocked: CI has no ffmpeg, and what they do with a
 * file is covered by their own tests.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const request = require('supertest');

describe('external re-scan of a video changed in place (issue 2114)', () => {
  let tmpDir; let db; let app; let mediaRoot; let storageRoot;
  let processUploadedVideo; let extractVideoMetadata; let mediaAttempts;

  const writeVideo = async (rel, content) => {
    const full = path.join(mediaRoot, rel);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, content);
    // Out of the settle window unless a test moves it back in.
    const old = new Date(Date.now() - 60000);
    await fs.promises.utimes(full, old, old);
    return fs.promises.stat(full);
  };
  const writeStored = async (key) => {
    const full = path.join(storageRoot, key);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, 'old rendition');
  };
  const exists = (key) => fs.existsSync(path.join(storageRoot, key));

  const setSetting = async (key, value) => {
    await db('app_settings')
      .insert({ setting_key: key, setting_value: JSON.stringify(value), setting_type: 'general', updated_at: new Date().toISOString() })
      .onConflict('setting_key')
      .merge({ setting_value: JSON.stringify(value) });
  };
  const setWebCopy = async (on) => {
    await setSetting('general_video_web_rendition', on);
    require('../../src/services/videoRenditionService').clearCache();
  };

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-extchangedvideo-'));
    mediaRoot = path.join(tmpDir, 'media');
    await fs.promises.mkdir(mediaRoot, { recursive: true });

    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = path.join(tmpDir, 'data', 'db.sqlite');
    await fs.promises.mkdir(path.dirname(process.env.TEST_DATABASE_PATH), { recursive: true });
    process.env.STORAGE_PATH = path.join(tmpDir, 'storage');
    process.env.EXTERNAL_MEDIA_ROOT = mediaRoot;
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'extchangedvideo-secret';

    jest.resetModules();
    jest.doMock('../../src/middleware/auth', () => ({
      adminAuth: (req, _res, next) => { req.admin = { id: 1, username: 'tester', roleName: 'admin' }; next(); },
    }));
    jest.doMock('../../src/middleware/permissions', () => ({
      ...jest.requireActual('../../src/middleware/permissions'),
      requirePermission: () => (_req, _res, next) => next(),
    }));
    jest.doMock('../../src/middleware/ownership', () => ({
      ...jest.requireActual('../../src/middleware/ownership'),
      requireEventOwnership: (_req, _res, next) => next(),
    }));
    jest.doMock('../../src/services/imageProcessor', () => {
      const actual = jest.requireActual('../../src/services/imageProcessor');
      return { ...actual, generateThumbnail: jest.fn(async () => 'thumbnails/mock.jpg'), ensureThumbnail: jest.fn() };
    });
    jest.doMock('../../src/services/videoProcessor', () => {
      const actual = jest.requireActual('../../src/services/videoProcessor');
      return { ...actual, processUploadedVideo: jest.fn(), extractVideoMetadata: jest.fn() };
    });
    jest.doMock('../../src/utils/logger', () => ({
      debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
    }));

    ({ db } = await require('./helpers/crmDb').bootCrmDb());
    await require('./helpers/externalMediaFixture').seedExternalAdminFixture(db);
    // bootCrmDb points STORAGE_PATH at its own directory.
    storageRoot = process.env.STORAGE_PATH;
    await setSetting('general_allowed_file_types', 'jpg,mp4');
    require('../../src/services/uploadSettings').clearAllowedTypesCache();
    ({ processUploadedVideo, extractVideoMetadata } = require('../../src/services/videoProcessor'));
    mediaAttempts = require('../../src/services/mediaAttemptService');
    require('../../src/services/mediaCapabilities').set({ guard: false, leases: false });

    app = express();
    app.use(express.json());
    app.use('/api/admin/external-media', require('../../src/routes/adminExternalMedia'));
  }, 180000);

  afterAll(async () => {
    require('../../src/services/mediaCapabilities').set(null);
    if (db) await db.destroy?.();
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    await db('photos').del();
    await db('media_process_attempts').del();
    await db('activity_logs').del();
    await db('events').del();
    await fs.promises.rm(mediaRoot, { recursive: true, force: true });
    await fs.promises.mkdir(mediaRoot, { recursive: true });
    await setWebCopy(true);

    processUploadedVideo.mockReset();
    processUploadedVideo.mockImplementation(async (_videoPath, thumbnailKey) => ({
      success: true, thumbnailKey, thumbHash: 'first-hash', metadata: { duration: 10, width: 640, height: 360, videoCodec: 'hevc', audioCodec: 'aac' },
    }));
    extractVideoMetadata.mockReset();
    extractVideoMetadata.mockResolvedValue({ duration: 10, width: 640, height: 360, videoCodec: 'hevc', audioCodec: 'aac' });
  });

  async function seedEvent() {
    const [e] = await db('events').insert({
      slug: `extchangedvideo-${Math.random().toString(36).slice(2, 8)}`,
      event_type: 'wedding', event_name: 'extchangedvideo', event_date: '2026-01-01',
      host_email: 'h@example.com', admin_email: 'a@example.com', password_hash: 'x',
      share_link: `extchangedvideo-${Math.random()}`, expires_at: new Date().toISOString(),
      source_mode: 'reference',
    }).returning('id');
    return typeof e === 'object' ? e.id : e;
  }

  const runImport = (eventId) => request(app)
    .post(`/api/admin/external-media/events/${eventId}/import-external`)
    .send({ external_path: 'shoot', recursive: true });

  // Import, then give the row a published web copy and ladder, as the
  // queues would.
  async function importWithRenditions(eventId) {
    await writeVideo('shoot/clip.mp4', 'first version of the clip');
    expect((await runImport(eventId)).body.imported).toBe(1);
    const video = await db('photos').where({ event_id: eventId }).first();
    const attempt = '11111111-2222-4333-8444-555555555555';
    const keys = {
      poster: video.thumbnail_path,
      web: `videos/web_${video.id}_${attempt}_clip.mp4`,
      ladder: [`hls/${video.id}/${attempt}/master.m3u8`, `hls/${video.id}/${attempt}/360p/index.m3u8`],
    };
    for (const key of [keys.poster, keys.web, ...keys.ladder]) await writeStored(key);
    await db('photos').where({ id: video.id }).update({
      web_path: keys.web, web_status: 'complete', web_attempts: 1,
      hls_path: `hls/${video.id}/${attempt}`, hls_status: 'complete', hls_attempts: 1,
    });
    return { video: await db('photos').where({ id: video.id }).first(), keys };
  }

  const editVideo = async () => {
    extractVideoMetadata.mockResolvedValue({ duration: 25, width: 1920, height: 1080, videoCodec: 'h264', audioCodec: 'opus' });
    processUploadedVideo.mockImplementation(async (_videoPath, thumbnailKey) => ({
      success: true, thumbnailKey, thumbHash: 'new-hash', metadata: {},
    }));
    return writeVideo('shoot/clip.mp4', 'second, longer version of the same clip');
  };

  it('records the new version, makes a new poster and starts the web copy and ladder over', async () => {
    const eventId = await seedEvent();
    const { video, keys } = await importWithRenditions(eventId);
    processUploadedVideo.mockClear();

    const edited = await editVideo();
    const zips = jest.spyOn(require('../../src/services/downloadZipService'), 'invalidate');
    const res = await runImport(eventId);
    expect(res.body).toMatchObject({ imported: 0, refreshed: 1 });
    expect(zips).toHaveBeenCalledWith(eventId);
    zips.mockRestore();

    const after = await db('photos').where({ id: video.id }).first();
    expect(Number(after.size_bytes)).toBe(edited.size);
    expect(Number(after.source_mtime_ms)).toBe(Math.floor(edited.mtimeMs));
    expect(after).toMatchObject({
      duration: 25, width: 1920, height: 1080, video_codec: 'h264', audio_codec: 'opus',
      web_path: null, web_status: 'pending', web_attempt_id: null,
      hls_path: null, hls_status: null, hls_attempt_id: null,
      processing_error: null,
    });
    expect(Number(after.web_attempts)).toBe(0);
    expect(Number(after.hls_attempts)).toBe(0);
    // A new poster from the new file, under a key naming the new version.
    expect(processUploadedVideo).toHaveBeenCalledTimes(1);
    expect(processUploadedVideo.mock.calls[0][0]).toBe(path.join(mediaRoot, 'shoot/clip.mp4'));
    expect(after.thumbnail_path).toBe(`thumbnails/thumb_ext${video.id}_clip_v${edited.size}m${Math.floor(edited.mtimeMs)}.jpg`);
    expect(after.thumb_hash).toBe('new-hash');
    // Nothing of the old version is left in storage.
    expect(exists(keys.poster)).toBe(false);
    expect(exists(keys.web)).toBe(false);
    for (const key of keys.ladder) expect(exists(key)).toBe(false);
  });

  it('does not queue a web copy while the setting is off', async () => {
    const eventId = await seedEvent();
    const { video } = await importWithRenditions(eventId);
    await setWebCopy(false);
    await editVideo();
    expect((await runImport(eventId)).body.refreshed).toBe(1);
    expect(await db('photos').where({ id: video.id }).first()).toMatchObject({ web_path: null, web_status: null });
  });

  it('does not queue a web copy for a video in an archived gallery', async () => {
    const eventId = await seedEvent();
    const { video } = await importWithRenditions(eventId);
    await db('events').where({ id: eventId }).update({ is_archived: true });
    await editVideo();
    expect((await runImport(eventId)).body.refreshed).toBe(1);
    expect(await db('photos').where({ id: video.id }).first()).toMatchObject({ web_path: null, web_status: null });
  });

  it('leaves an unchanged video and its renditions alone', async () => {
    const eventId = await seedEvent();
    const { video, keys } = await importWithRenditions(eventId);
    processUploadedVideo.mockClear();

    const res = await runImport(eventId);
    expect(res.body).toMatchObject({ refreshed: 0, skipped: 1 });
    expect(processUploadedVideo).not.toHaveBeenCalled();
    const after = await db('photos').where({ id: video.id }).first();
    expect(after).toMatchObject({ web_path: keys.web, web_status: 'complete', hls_status: 'complete', thumb_hash: 'first-hash' });
    for (const key of [keys.poster, keys.web, ...keys.ladder]) expect(exists(key)).toBe(true);
  });

  it.each(['web', 'hls'])('a %s transcode of the old bytes cannot publish after the refresh', async (kind) => {
    const eventId = await seedEvent();
    const { video } = await importWithRenditions(eventId);
    await db('photos').where({ id: video.id }).update({ [`${kind}_status`]: 'pending' });
    const claimed = await mediaAttempts.claimNext(kind, video.id);
    expect(claimed?.[`${kind}_attempt_id`]).toBeTruthy();

    await mediaAttempts.execute(claimed, kind, async (attempt) => {
      await attempt.assertCurrent();
      // The file is edited and re-scanned while this attempt transcodes.
      await editVideo();
      expect((await runImport(eventId)).body.refreshed).toBe(1);
      await expect(attempt.assertCurrent()).rejects.toMatchObject({ code: 'MEDIA_SUPERSEDED' });
      // The publish renderWebCopy / renderLadder make.
      const published = await mediaAttempts.guard(attempt, db, true)
        .update({ [`${kind}_path`]: 'stale', [`${kind}_status`]: 'complete' });
      expect(published).toBe(0);
    });

    const after = await db('photos').where({ id: video.id }).first();
    expect(after[`${kind}_path`]).toBeNull();
    expect(after[`${kind}_status`]).toBe(kind === 'web' ? 'pending' : null);
  });

  it('leaves a video that is still being written for the next automatic pass', async () => {
    const eventId = await seedEvent();
    await db('events').where({ id: eventId }).update({
      created_by: 1, external_path: 'shoot', external_watch: 1, is_active: 1, is_archived: 0,
    });
    const { video, keys } = await importWithRenditions(eventId);
    const { importExternalFolder } = require('../../src/services/externalImportService');

    await editVideo();
    // Just written: mtime is now, inside the settle window.
    const now = new Date();
    await fs.promises.utimes(path.join(mediaRoot, 'shoot/clip.mp4'), now, now);
    const pass = { eventId, externalPath: 'shoot', actor: { type: 'system' }, automatic: true, settleMs: 5000 };
    expect(await importExternalFolder(pass)).toMatchObject({ refreshed: 0, deferred: 1 });
    expect(await db('photos').where({ id: video.id }).first()).toMatchObject({ web_path: keys.web, web_status: 'complete' });
    expect(exists(keys.web)).toBe(true);

    // Quiet for longer than the window: refreshed.
    const old = new Date(Date.now() - 60000);
    await fs.promises.utimes(path.join(mediaRoot, 'shoot/clip.mp4'), old, old);
    expect(await importExternalFolder(pass)).toMatchObject({ refreshed: 1, deferred: 0 });
    expect(await db('photos').where({ id: video.id }).first()).toMatchObject({ web_path: null, web_status: 'pending' });
    expect(exists(keys.web)).toBe(false);
  });

  it('removes a ladder published after the listing and before the commit, listing outside the transaction', async () => {
    const eventId = await seedEvent();
    const { video, keys } = await importWithRenditions(eventId);
    const videoHls = require('../../src/services/videoHlsService');
    const late = '99999999-8888-4777-8666-555555555555';
    const lateKey = `hls/${video.id}/${late}/master.m3u8`;
    const realCapture = videoHls.captureLadder;
    const spy = jest.spyOn(videoHls, 'captureLadder').mockImplementationOnce(async (photo) => {
      const sweep = await realCapture(photo);
      // A transcode of the old bytes publishes right behind the listing.
      // A query here would wait for SQLite's only connection if the listing
      // ran inside the refresh's transaction.
      await writeStored(lateKey);
      await db('photos').where({ id: video.id }).update({ hls_path: `hls/${video.id}/${late}`, hls_status: 'complete' });
      return sweep;
    });
    try {
      await editVideo();
      expect((await runImport(eventId)).body.refreshed).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(exists(lateKey)).toBe(false);
    for (const key of keys.ladder) expect(exists(key)).toBe(false);
    expect((await db('photos').where({ id: video.id }).first()).hls_path).toBeNull();
  }, 20000);

  it('keeps the poster key of a long file name within a file name\'s length', async () => {
    const eventId = await seedEvent();
    const stem = 'x'.repeat(205);
    await writeVideo(`shoot/${stem}.mp4`, 'first version of the clip');
    expect((await runImport(eventId)).body.imported).toBe(1);
    const video = await db('photos').where({ event_id: eventId }).first();
    const edited = await writeVideo(`shoot/${stem}.mp4`, 'second, longer version of the same clip');
    expect((await runImport(eventId)).body).toMatchObject({ imported: 0, refreshed: 1 });
    const key = (await db('photos').where({ id: video.id }).first()).thumbnail_path;
    expect(key).toMatch(new RegExp(`_v${edited.size}m${Math.floor(edited.mtimeMs)}\\.jpg$`));
    // Room for LocalFsStorage's staging suffix under the 255-byte limit.
    expect(Buffer.byteLength(path.posix.basename(key))).toBeLessThanOrEqual(200);
  });

  it('drops its own poster when a viewer\'s lazy poster was published first', async () => {
    const eventId = await seedEvent();
    const { video, keys } = await importWithRenditions(eventId);
    await editVideo();
    const lazyKey = `thumbnails/thumb_ext${video.id}_lazy.jpg`;
    let written;
    processUploadedVideo.mockImplementation(async (_videoPath, thumbnailKey) => {
      written = thumbnailKey;
      await writeStored(thumbnailKey);
      await db('photos').where({ id: video.id }).update({ thumbnail_path: lazyKey });
      return { success: true, thumbnailKey, metadata: {} };
    });
    expect((await runImport(eventId)).body.refreshed).toBe(1);
    expect((await db('photos').where({ id: video.id }).first()).thumbnail_path).toBe(lazyKey);
    expect(written).toBeTruthy();
    expect(exists(written)).toBe(false);
    expect(exists(keys.poster)).toBe(false);
  });

  describe('a type no longer allowed (issue 2120)', () => {
    const allowTypes = async (types) => {
      await setSetting('general_allowed_file_types', types);
      require('../../src/services/uploadSettings').clearAllowedTypesCache();
    };
    afterEach(() => allowTypes('jpg,mp4'));

    it('still refreshes an edited row of that type, and imports no new file of it', async () => {
      const eventId = await seedEvent();
      const { video, keys } = await importWithRenditions(eventId);
      await allowTypes('jpg');
      processUploadedVideo.mockClear();

      const edited = await editVideo();
      await writeVideo('shoot/new-clip.mp4', 'a clip added after the type was removed');
      // An allowed type still imports as before.
      await writeVideo('shoot/new-photo.jpg', 'not decodable, imported without dimensions');
      const res = await runImport(eventId);
      expect(res.body).toMatchObject({ imported: 1, refreshed: 1 });
      expect(await db('photos').where({ event_id: eventId, filename: 'new-photo.jpg' }).first()).toBeTruthy();
      expect(await db('photos').where({ event_id: eventId, filename: 'new-clip.mp4' }).first()).toBeUndefined();

      const after = await db('photos').where({ id: video.id }).first();
      expect(Number(after.size_bytes)).toBe(edited.size);
      expect(Number(after.source_mtime_ms)).toBe(Math.floor(edited.mtimeMs));
      expect(after).toMatchObject({ duration: 25, web_path: null, hls_path: null });
      expect(processUploadedVideo).toHaveBeenCalledTimes(1);
      expect(exists(keys.web)).toBe(false);
    });

    it('leaves an unchanged row of that type alone', async () => {
      const eventId = await seedEvent();
      const { video, keys } = await importWithRenditions(eventId);
      await allowTypes('jpg');
      processUploadedVideo.mockClear();

      expect((await runImport(eventId)).body).toMatchObject({ imported: 0, refreshed: 0, skipped: 1 });
      expect(processUploadedVideo).not.toHaveBeenCalled();
      expect(await db('photos').where({ id: video.id }).first()).toMatchObject({ web_path: keys.web, web_status: 'complete' });
    });

    it('does not import a file of that type on an automatic pass either', async () => {
      const eventId = await seedEvent();
      await db('events').where({ id: eventId }).update({
        created_by: 1, external_path: 'shoot', external_watch: 1, is_active: 1, is_archived: 0,
      });
      const { video } = await importWithRenditions(eventId);
      await allowTypes('jpg');
      await editVideo();
      await writeVideo('shoot/new-clip.mp4', 'a clip added after the type was removed');
      const { importExternalFolder } = require('../../src/services/externalImportService');
      const pass = { eventId, externalPath: 'shoot', actor: { type: 'system' }, automatic: true, settleMs: 5000 };
      expect(await importExternalFolder(pass)).toMatchObject({ imported: 0, refreshed: 1 });
      expect((await db('photos').where({ id: video.id }).first()).duration).toBe(25);
      expect(await db('photos').where({ event_id: eventId }).count('* as n').first()).toMatchObject({ n: 1 });
    }, 20000);
  });

  it('records the poster note when no poster frame can be made from the new file', async () => {
    const eventId = await seedEvent();
    const { video } = await importWithRenditions(eventId);
    await editVideo();
    processUploadedVideo.mockImplementation(async (_videoPath, thumbnailKey) => ({
      success: true, thumbnailKey, placeholder: true, thumbnailError: 'no frame', metadata: {},
    }));
    expect((await runImport(eventId)).body.refreshed).toBe(1);
    const after = await db('photos').where({ id: video.id }).first();
    expect(after.processing_error).toMatch(/no frame/);
    expect(after.thumbnail_path).toBeTruthy();
  });
});
