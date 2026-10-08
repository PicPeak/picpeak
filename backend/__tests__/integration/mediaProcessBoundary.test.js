const fs = require('fs').promises;
const path = require('path');
const { execFileSync } = require('child_process');
const nativeSharp = require('sharp'); // Only bounded, generated fixtures.
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');
const linux = process.platform === 'linux' ? describe : describe.skip;

linux('real mandatory video/RAW admission and execution fencing', () => {
  let db, cleanup, tmpDir, storage, processor, attempts, eventId, processes, mediaAdmission;
  const resultId = rows => rows[0]?.id ?? rows[0];
  const tool = (command, args) => execFileSync(command, args, { timeout: 30000, maxBuffer: 1024 * 1024 });
  beforeAll(async () => {
    process.env.MEDIA_PROCESS_HOST_ID = 'owned-media-fixture-host-0001';
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
    processes = require('../../src/services/mediaProcessService'); mediaAdmission = require('../../src/services/mediaWorkAdmission');
  });
  afterAll(async () => {
    attempts?.assertDrained(); await processes?.stop();
    await require('../../src/services/nativeProcessRunner').stop();
    require('../../src/services/storage').resetStorage(); delete process.env.MEDIA_PROCESS_HOST_ID;
    if (cleanup) await cleanup();
  });
  beforeEach(async () => {
    processes.start();
    await db('media_process_attempts').delete(); await db('media_video_work_reservations').delete();
    await db('image_work_reservations').delete(); await db('photos').delete();
    await db('app_settings').where({ setting_key: 'general_video_web_rendition' }).delete();
    await db('app_settings').insert({ setting_key: 'general_video_web_rendition', setting_value: 'true' });
    require('../../src/services/videoRenditionService').clearCache();
  });
  async function upload(bytes, name, mimetype) {
    const localPath = path.join(tmpDir, name); await fs.writeFile(localPath, bytes);
    return { path: localPath, originalname: name, mimetype };
  }
  async function queue(file) { return processor.queueFilesForProcessing([file], { eventId, uploadedBy: 'guest' }); }
  async function photo(name = 'ordinary.mp4') {
    const result = await queue(await upload(require('../fixtures/admissionVideo').admissionVideo(), name, 'video/mp4'));
    expect(result.errors).toEqual([]); return db('photos').where({ id: result.photos[0].id }).first();
  }
  test('ordinary video uses real probe/poster/storage and a durable shared decoded/work charge', async () => {
    const row = await photo();
    expect(Number((await db('image_work_reservations').first()).decoded_bytes)).toBe(16 * 16 * 8);
    expect(Number((await db('media_video_work_reservations').first()).work_units)).toBeGreaterThan(0);
    await processor.processPhoto(row.id);
    const complete = await db('photos').where({ id: row.id }).first();
    expect(complete).toMatchObject({ processing_status: 'complete', width: 16, height: 16, video_codec: 'h264' });
    expect(complete.processing_attempt_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(complete.thumbnail_path).toContain(complete.processing_attempt_id);
    expect((await storage.stat(complete.thumbnail_path)).size).toBeGreaterThan(0);
    const record = await db('media_process_attempts').first();
    expect(record.state).toBe('terminated');
    expect(JSON.parse(record.children_json).every(child => child.terminated)).toBe(true);
    expect(JSON.parse(record.children_json).length).toBeGreaterThan(0);
    expect(await require('../../src/services/linuxKernelLease').probe(record.lease_path,
      { device: record.lease_device, inode: record.lease_inode, filesystem: record.lease_filesystem })).toBe('free');
    expect(await require('../../src/services/videoRenditionService').renderWebCopy(row.id)).toBe('skipped');
    const original = storage.resolveLocalPath(path.posix.join('events/active', complete.path));
    await require('../../src/services/videoProcessor').generateVideoThumbnail(original, 'thumbnails/ordinary-real-poster.jpg', { timeOffset: '00:00:00' });
    expect((await nativeSharp(storage.resolveLocalPath('thumbnails/ordinary-real-poster.jpg')).metadata()).format).toBe('jpeg');
  });
  test('playlist/URL text renamed MP4 and JPEG renamed DNG cannot reach promotion or the queue', async () => {
    const spy = jest.spyOn(storage, 'putFromFile');
    try {
      for (const file of [
        await upload(Buffer.from('#EXTM3U\n#EXTINF:1\nhttp://127.0.0.1/segment\n'), 'playlist.MP4', 'video/mp4'),
        await upload(await nativeSharp({ create: { width: 16, height: 16, channels: 3, background: 'white' } }).jpeg().toBuffer(), 'fake.DNG', 'image/x-adobe-dng'),
      ]) {
        const result = await queue(file);
        expect(result.photos).toEqual([]); expect(result.errors[0].code).toBe('MEDIA_INVALID_SIGNATURE');
      }
      expect(spy).not.toHaveBeenCalled(); expect(await db('photos')).toEqual([]);
      expect(await db('image_work_reservations')).toEqual([]); expect(await db('media_video_work_reservations')).toEqual([]);
    } finally { spy.mockRestore(); }
  });
  test('ordinary MPEG4 transcodes to a real H264 web copy and lazy video publication rejects a replaced source', async () => {
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
    const oldKey = row.thumbnail_path;
    const put = storage.putFromFile.bind(storage), spy = jest.spyOn(storage, 'putFromFile').mockImplementation(async (key, ...args) => {
      const value = await put(key, ...args);
      if (key.startsWith('thumbnails/')) await db('photos').where({ id }).update({ filename: 'replacement.mov', path: 'replacement.mov' });
      return value;
    });
    try {
      await expect(require('../../src/services/imageProcessor').ensureThumbnail(row, { force: true }))
        .rejects.toMatchObject({ code: 'MEDIA_SUPERSEDED' });
      expect((await db('photos').where({ id }).first()).thumbnail_path).toBe(oldKey);
      expect(spy.mock.calls[0][0]).not.toBe(oldKey);
    } finally { spy.mockRestore(); }
  });
  test('generated ordinary TIFF/DNG retains preview and orientation through the real hard-capped exiftool/Sharp path', async () => {
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
  test('event and batch decoded/CPU work reservations are aggregate, not compressed-byte counters', async () => {
    const policy = require('../../src/services/mediaProcessPolicy').configuration();
    const value = { decodedBytes: 1024, work: policy.maxWork };
    await expect(mediaAdmission.reserve(eventId, value, { bytes: 1024, work: policy.maxWork * 2 + 1 })).rejects.toMatchObject({ code: 'MEDIA_RESOURCE_LIMIT' });
    const outcomes = await Promise.allSettled(Array.from({ length: 6 }, () => mediaAdmission.reserve(eventId, value, { bytes: 1024, work: value.work })));
    expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(4);
    expect(outcomes.filter(item => item.status === 'rejected').every(item => item.reason.code === 'MEDIA_RESOURCE_LIMIT')).toBe(true);
  });
  test('age never requeues a live owner; confirmed terminal execution gets only one retry', async () => {
    const row = await photo('retry.mp4'), claimed = await attempts.claimNext('photo', row.id);
    await db('photos').where({ id: row.id }).update({ processing_started_at: '2000-01-01T00:00:00.000Z' });
    expect(await attempts.recover('photo', new Date().toISOString())).toBe(0);
    await attempts.execute(claimed, 'photo', async () => {});
    expect(await attempts.recover('photo', new Date().toISOString())).toBe(1);
    const retry = await attempts.claimNext('photo', row.id);
    expect(retry.processing_attempt_id).not.toBe(claimed.processing_attempt_id);
    expect(retry.processing_attempts).toBe(2);
    await attempts.execute(retry, 'photo', async () => {});
    await db('photos').where({ id: row.id }).update({ processing_started_at: '2000-01-01T00:00:00.000Z' });
    expect(await attempts.recover('photo', new Date().toISOString())).toBe(1);
    expect((await db('photos').where({ id: row.id }).first()).processing_status).toBe('failed');
    expect(await attempts.claimNext('photo', row.id)).toBeNull();
    expect(await db('image_work_reservations')).toEqual([]); expect(await db('media_video_work_reservations')).toEqual([]);
  });
  test('a superseded source cannot publish DB or derivative storage, and cannot overlap its old execution', async () => {
    const row = await photo('superseded.mp4'), claimed = await attempts.claimNext('photo', row.id);
    const spy = jest.spyOn(storage, 'putFromFile');
    try {
      await attempts.execute(claimed, 'photo', async attempt => {
        await db('photos').where({ id: row.id }).update({ filename: 'replacement.mp4', path: 'replacement.mp4', processing_attempt_id: null, processing_status: 'pending' });
        expect(await attempts.claimNext('photo', row.id)).toBeNull();
        expect(await attempts.guard(attempt, db, true).update({ processing_status: 'complete' })).toBe(0);
        await expect(require('../../src/services/videoProcessor').generateVideoThumbnail(path.join(tmpDir, 'ordinary.mp4'), 'thumbnails/stale.jpg'))
          .rejects.toMatchObject({ code: 'MEDIA_SUPERSEDED' });
      });
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  test('restore resets imported runtime authority and charges inside the caller transaction only', async () => {
    const row = await photo('restore.mp4'), claimed = await attempts.claimNext('photo', row.id);
    await attempts.execute(claimed, 'photo', async () => {});
    await db('photos').where({ id: row.id }).update({ web_status: 'processing', web_attempt_id: claimed.processing_attempt_id, web_attempts: 2 });
    await db.transaction(trx => attempts.resetImportedMediaAttempts(trx));
    expect(await db('photos').where({ id: row.id }).first()).toMatchObject({ processing_status: 'pending', processing_attempt_id: null,
      processing_attempts: 0, web_status: 'pending', web_attempt_id: null, web_attempts: 0 });
    for (const table of ['media_process_attempts', 'media_video_work_reservations', 'image_work_reservations']) expect(await db(table)).toEqual([]);
  });
});
