/**
 * The real tools, end to end, on whatever this host offers: guarded where
 * the guard is built and allowed (Linux CI, the Docker images), as plain
 * children everywhere else (macOS development). The outcome is the same.
 * Skipped only where ffmpeg itself is not installed.
 */
const fs = require('fs').promises;
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const nativeSharp = require('sharp'); // Only bounded, generated fixtures.
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');
const hasTool = name => spawnSync(name, [name === 'exiftool' ? '-ver' : '-version'], { stdio: 'ignore' }).status === 0;
const withFfmpeg = hasTool('ffmpeg') && hasTool('ffprobe') ? describe : describe.skip;

withFfmpeg('real video/RAW processing and execution fencing', () => {
  let db, cleanup, tmpDir, storage, processor, attempts, eventId, processes, runner, capabilities;
  const resultId = rows => rows[0]?.id ?? rows[0];
  const tool = (command, args) => execFileSync(command, args, { timeout: 30000, maxBuffer: 1024 * 1024 });
  beforeAll(async () => {
    ({ db, cleanup, tmpDir } = await bootCrmDb());
    const { adminId } = await seedMinimal(db);
    eventId = resultId(await db('events').insert({ slug: 'media-budget', event_type: 'wedding', event_name: 'Media budget',
      event_date: '2026-10-08', host_email: 'host@fixture.invalid', admin_email: 'admin@fixture.invalid',
      password_hash: 'x', share_link: '/gallery/media-budget/share', expires_at: new Date(Date.now() + 3600000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, allow_user_uploads: 1, created_by: adminId }).returning('id'));
    const LocalFs = require('../../src/services/storage/LocalFsStorage');
    storage = new LocalFs({ root: process.env.STORAGE_PATH }); await storage.init();
    require('../../src/services/storage').setStorageForTesting(storage);
    processor = require('../../src/services/photoProcessor'); attempts = require('../../src/services/mediaAttemptService');
    processes = require('../../src/services/mediaProcessService'); runner = require('../../src/services/nativeProcessRunner');
    capabilities = require('../../src/services/mediaCapabilities');
  }, 60000);
  afterAll(async () => {
    attempts?.assertDrained(); await processes?.stop(); await runner?.stop();
    await require('../../src/services/isolatedSharp').shutdown();
    require('../../src/services/storage').resetStorage();
    if (cleanup) await cleanup();
  });
  beforeEach(async () => {
    processes.start();
    await db('media_process_attempts').delete(); await db('photos').delete();
    await db('app_settings').where({ setting_key: 'general_video_web_rendition' }).delete();
    await db('app_settings').insert({ setting_key: 'general_video_web_rendition', setting_value: 'true' });
    require('../../src/services/videoRenditionService').clearCache();
  });
  afterEach(() => { delete process.env.MEDIA_MAX_SNAPSHOT_MIB; jest.restoreAllMocks(); });
  async function upload(bytes, name, mimetype) {
    const localPath = path.join(tmpDir, name); await fs.writeFile(localPath, bytes);
    return { path: localPath, originalname: name, mimetype };
  }
  async function queue(file) { return processor.queueFilesForProcessing([file], { eventId, uploadedBy: 'guest' }); }
  async function photo(name = 'ordinary.mp4') {
    const result = await queue(await upload(require('../fixtures/admissionVideo').admissionVideo(), name, 'video/mp4'));
    expect(result.errors).toEqual([]); return db('photos').where({ id: result.photos[0].id }).first();
  }
  test('whatever protections this host has, a video gets its real poster, and nothing of the attempt is left behind', async () => {
    const caps = await capabilities.probe();
    if (process.platform !== 'linux') expect(caps).toMatchObject({ guard: false, leases: false });
    // Accepting the upload does not probe the video: the queue does that.
    const probe = jest.spyOn(processes, 'probeVideo');
    const row = await photo();
    expect(probe).not.toHaveBeenCalled();
    expect(row).toMatchObject({ processing_status: 'pending', processing_attempt_id: null });
    await processor.processPhoto(row.id);
    const complete = await db('photos').where({ id: row.id }).first();
    expect(complete).toMatchObject({ processing_status: 'complete', width: 16, height: 16, video_codec: 'h264' });
    expect(complete.processing_attempt_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(complete.thumbnail_path).toContain(complete.processing_attempt_id);
    expect((await nativeSharp(storage.resolveLocalPath(complete.thumbnail_path)).metadata()).format).toBe('jpeg');
    expect(await db('media_process_attempts')).toEqual([]);
    if (caps.leases) expect((await fs.readdir(caps.leaseRoot)).filter(name => name.startsWith(complete.processing_attempt_id))).toEqual([]);
    expect(await require('../../src/services/videoRenditionService').renderWebCopy(row.id)).toBe('skipped');
    // The fixture is shorter than the default one-second offset; its first frame is a real poster.
    const original = storage.resolveLocalPath(path.posix.join('events/active', complete.path));
    await require('../../src/services/videoProcessor').generateVideoThumbnail(original, 'thumbnails/ordinary-real-poster.jpg', { timeOffset: '00:00:00' });
    expect((await nativeSharp(storage.resolveLocalPath('thumbnails/ordinary-real-poster.jpg')).metadata()).format).toBe('jpeg');
    // A retry writes a new attempt-named poster and removes the one it replaces.
    await db('photos').where({ id: row.id }).update({ processing_status: 'pending', processing_attempts: 0 });
    await processor.processPhoto(row.id);
    const again = await db('photos').where({ id: row.id }).first();
    expect(again.thumbnail_path).not.toBe(complete.thumbnail_path);
    expect(await storage.stat(complete.thumbnail_path).catch(() => null)).toBeFalsy();
    expect((await storage.stat(again.thumbnail_path)).size).toBeGreaterThan(0);
  });
  test('a file that is not a video never reaches a parser, and still completes with the placeholder tile', async () => {
    const run = jest.spyOn(runner, 'run');
    const result = await queue(await upload(Buffer.from('#EXTM3U\n#EXTINF:1\nhttp://127.0.0.1/segment\n'), 'playlist.MP4', 'video/mp4'));
    expect(result.errors).toEqual([]);
    await processor.processPhoto(result.photos[0].id);
    expect(run).not.toHaveBeenCalled();
    const complete = await db('photos').where({ id: result.photos[0].id }).first();
    expect(complete.processing_status).toBe('complete');
    expect(complete.thumbnail_path).toBeTruthy();
    expect(complete.processing_error).toMatch(/signature/i);
  });
  test('a video larger than the staging area is read where it is instead of being refused', async () => {
    const movie = path.join(tmpDir, 'large.mov');
    tool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x480:r=30:d=3',
      '-threads', '1', '-c:v', 'mjpeg', '-q:v', '1', '-pix_fmt', 'yuvj422p', movie]);
    expect((await fs.stat(movie)).size).toBeGreaterThan(1024 * 1024);
    process.env.MEDIA_MAX_SNAPSHOT_MIB = '1';
    const result = await queue({ path: movie, originalname: 'large.mov', mimetype: 'video/quicktime' });
    await processor.processPhoto(result.photos[0].id);
    expect(await db('photos').where({ id: result.photos[0].id }).first()).toMatchObject({ processing_status: 'complete', processing_error: null, width: 640, height: 480 });
  });
  test('MPEG-4 transcodes to a real H.264 web copy, and lazy publication rejects a replaced source', async () => {
    const movie = path.join(tmpDir, 'mpeg4.mov');
    tool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=32x48:r=10:d=2',
      '-threads', '1', '-c:v', 'mpeg4', movie]);
    const result = await queue({ path: movie, originalname: 'mpeg4.mov', mimetype: 'video/quicktime' });
    expect(result.errors).toEqual([]); const id = result.photos[0].id;
    await processor.processPhoto(id);
    expect(await require('../../src/services/videoRenditionService').renderWebCopy(id)).toBe('complete');
    const row = await db('photos').where({ id }).first();
    expect(row.web_path).toContain(row.web_attempt_id);
    const metadata = await processes.probeVideo(storage.resolveLocalPath(row.web_path));
    expect(metadata.streams.find(stream => stream.codec_type === 'video')).toMatchObject({ codec_name: 'h264', width: 32, height: 48 });
    expect(await db('media_process_attempts')).toEqual([]);
    const oldKey = row.thumbnail_path;
    const put = storage.putFromFile.bind(storage), spy = jest.spyOn(storage, 'putFromFile').mockImplementation(async (key, ...args) => {
      const value = await put(key, ...args);
      if (key.startsWith('thumbnails/')) await db('photos').where({ id }).update({ filename: 'replacement.mov', path: 'replacement.mov' });
      return value;
    });
    await expect(require('../../src/services/imageProcessor').ensureThumbnail(row, { force: true }))
      .rejects.toMatchObject({ code: 'MEDIA_SUPERSEDED' });
    expect((await db('photos').where({ id }).first()).thumbnail_path).toBe(oldKey);
    expect(spy.mock.calls[0][0]).not.toBe(oldKey);
  });
  (hasTool('exiftool') ? test : test.skip)('a generated TIFF/DNG keeps its preview and orientation through the real exiftool/sharp path', async () => {
    const preview = path.join(tmpDir, 'embedded.jpg'), raw = path.join(tmpDir, 'ordinary.dng');
    await nativeSharp({ create: { width: 1024, height: 683, channels: 3, background: 'white' } }).jpeg().toFile(preview);
    // Uncompressed TIFF avoids an abbreviated JPEG strip masquerading as a
    // self-contained embedded preview; the inserted JPEG is truly decodable.
    await nativeSharp({ create: { width: 1024, height: 683, channels: 3, background: 'white' } }).tiff({ compression: 'none' }).toFile(raw);
    tool('exiftool', ['-overwrite_original', '-DNGVersion=1 4 0 0', '-Orientation=6', '-n', raw]);
    // TIFF writers do not create IFD1 for ThumbnailImage assignment. Append
    // a standard reduced JPEG IFD to the intact, uncompressed TIFF image.
    const tiff = await fs.readFile(raw), jpeg = await fs.readFile(preview);
    expect(tiff.toString('ascii', 0, 2)).toBe('II');
    const first = tiff.readUInt32LE(4), count = tiff.readUInt16LE(first);
    const entries = [[254, 4, 1], [256, 4, 1024], [257, 4, 683], [259, 3, 6],
      [262, 3, 6], [274, 3, 6], [513, 4, tiff.length + 102], [514, 4, jpeg.length]];
    const ifd = Buffer.alloc(102); ifd.writeUInt16LE(entries.length, 0);
    entries.forEach(([tag, type, value], index) => {
      const offset = 2 + index * 12; ifd.writeUInt16LE(tag, offset); ifd.writeUInt16LE(type, offset + 2);
      ifd.writeUInt32LE(1, offset + 4); ifd.writeUInt32LE(value, offset + 8);
    });
    tiff.writeUInt32LE(tiff.length, first + 2 + count * 12);
    await fs.writeFile(raw, Buffer.concat([tiff, ifd, jpeg]));
    const extracted = await require('../../src/services/imageProcessor').extractRawPreview(raw);
    try { expect(await nativeSharp(extracted.path).metadata()).toMatchObject({ width: 1024, orientation: 6 }); }
    finally { await extracted.cleanup(); }
    const result = await queue({ path: raw, originalname: 'ordinary.DNG', mimetype: 'image/x-adobe-dng' });
    expect(result.errors).toEqual([]); expect(result.photos).toHaveLength(1);
    await processor.processPhoto(result.photos[0].id);
    const complete = await db('photos').where({ id: result.photos[0].id }).first();
    expect(complete.processing_status).toBe('complete'); expect(complete.thumbnail_path).toBeTruthy();
    expect((await nativeSharp(storage.resolveLocalPath(complete.thumbnail_path)).metadata()).format).toBe('jpeg');
  });
  test('a superseded source cannot publish to the database or to storage, and its row is not handed out while it still runs', async () => {
    const row = await photo('superseded.mp4'), claimed = await attempts.claimNext('photo', row.id);
    const spy = jest.spyOn(storage, 'putFromFile');
    await attempts.execute(claimed, 'photo', async attempt => {
      await db('photos').where({ id: row.id }).update({ filename: 'replacement.mp4', path: 'replacement.mp4', processing_attempt_id: null, processing_status: 'pending' });
      expect(await attempts.claimNext('photo', row.id)).toBeNull();
      expect(await attempts.guard(attempt, db, true).update({ processing_status: 'complete' })).toBe(0);
      await expect(require('../../src/services/videoProcessor').generateVideoThumbnail(path.join(tmpDir, 'superseded.mp4'), 'thumbnails/stale.jpg'))
        .rejects.toMatchObject({ code: 'MEDIA_SUPERSEDED' });
    });
    expect(spy).not.toHaveBeenCalled();
    // The old attempt is over: the replacement is processed as usual.
    const next = await attempts.claimNext('photo', row.id);
    expect(next).toMatchObject({ id: row.id, processing_status: 'processing' });
    await attempts.execute(next, 'photo', async () => {});
  });
});
