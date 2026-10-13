/**
 * One real transcode (issue 1733, D4): a generated clip through the claim,
 * the process runner, ffmpeg and local storage, then played back through the
 * gallery routes. Skipped where ffmpeg or ffprobe is not installed (CI has
 * neither); the arguments are pinned in services/videoHlsService.test.js.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-hls-transcode-')), 'db.sqlite');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'hls-transcode-test-secret-at-least-thirty-two';
process.env.STORAGE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-hls-transcode-storage-'));
process.env.VIDEO_HLS_MAX_DURATION_SECONDS = '8';

jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const request = require('supertest');
const express = require('express');
const { bootCrmDb, seedMinimal } = require('./helpers/crmDb');

const installed = ['ffmpeg', 'ffprobe'].every(tool => spawnSync(tool, ['-version']).status === 0);
const SLUG = 'hls-transcode';

(installed ? describe : describe.skip)('adaptive streaming: a real transcode', () => {
  let db, cleanup, eventId, storage, service, attempts, capabilities, app;
  const id = rows => rows[0]?.id ?? rows[0];
  const clips = fs.mkdtempSync(path.join(os.tmpdir(), 'picpeak-hls-clips-'));
  // Noise keeps the bitrate of the generated clip above the ladder's
  // ceilings, as a camera's is; a clean test pattern compresses to nothing.
  const clip = (name, { size, seconds, rate = 12 }) => {
    const file = path.join(clips, name);
    const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=${rate}:duration=${seconds},noise=alls=30:allf=t`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '8M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
    if (made.status !== 0) throw new Error(`could not generate ${name}: ${made.stderr}`);
    return file;
  };
  const video = async (filename, source, over = {}) => {
    const bytes = typeof source === 'string' ? fs.readFileSync(source) : source;
    await storage.put(`events/active/${SLUG}/individual/${filename}`, bytes);
    return id(await db('photos').insert({ event_id: eventId, filename, path: `${SLUG}/individual/${filename}`, type: 'individual',
      media_type: 'video', mime_type: 'video/mp4', size_bytes: bytes.length, uploaded_at: new Date().toISOString(),
      processing_status: 'complete', hls_status: 'pending', ...over }).returning('id'));
  };
  const render = async (photoId) => {
    const claimed = await attempts.claimNext('hls', photoId);
    return attempts.execute(claimed, 'hls', () => service.renderLadder(photoId));
  };
  const keys = async photoId => (await storage.list(`hls/${photoId}`)).map(entry => entry.key).sort();
  const row = photoId => db('photos').where({ id: photoId }).first();
  const get = route => request(app).get(`/api/gallery/${SLUG}/hls/${route}`).buffer().parse((res, cb) => {
    const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

  beforeAll(async () => {
    ({ db, cleanup } = await bootCrmDb());
    await seedMinimal(db);
    eventId = id(await db('events').insert({ slug: SLUG, event_type: 'wedding', event_name: SLUG, event_date: '2026-10-12',
      host_email: 'host@fixture.invalid', admin_email: 'admin@fixture.invalid', password_hash: 'x',
      share_link: `/gallery/${SLUG}/share`, share_token: `${SLUG}-share`, expires_at: new Date(Date.now() + 3600000).toISOString(),
      is_active: 1, is_archived: 0, is_draft: 0, require_password: 0 }).returning('id'));
    await db('app_settings').insert({ setting_key: 'general_video_adaptive_streaming', setting_value: 'true', setting_type: 'general' });
    capabilities = require('../../src/services/mediaCapabilities');
    capabilities.set({ guard: false, leases: false });
    storage = require('../../src/services/storage').getStorage();
    service = require('../../src/services/videoHlsService');
    attempts = require('../../src/services/mediaAttemptService');
    app = express();
    app.use(require('cookie-parser')());
    app.use('/api/gallery', require('../../src/routes/gallery'));
  }, 120000);
  afterAll(async () => {
    capabilities?.set(null);
    if (cleanup) await cleanup();
    fs.rmSync(clips, { recursive: true, force: true });
  });

  test('writes a ladder that never exceeds the source, and the routes play it', async () => {
    // 720p, 13 s would be the honest case; 7 s keeps this under a few seconds.
    const photoId = await video('landscape.mp4', clip('landscape.mp4', { size: '1280x720', seconds: 7 }));
    expect(await render(photoId)).toBe('complete');

    const published = await row(photoId);
    expect(published).toMatchObject({ hls_status: 'complete', hls_error: null, hls_started_at: null });
    expect(published.hls_path).toBe(`hls/${photoId}/${published.hls_attempt_id}`);
    const prefix = published.hls_path;
    expect(await keys(photoId)).toEqual([
      `${prefix}/480p/index.m3u8`, `${prefix}/480p/init.mp4`, `${prefix}/480p/seg_00000.m4s`, `${prefix}/480p/seg_00001.m4s`,
      `${prefix}/720p/index.m3u8`, `${prefix}/720p/init.mp4`, `${prefix}/720p/seg_00000.m4s`, `${prefix}/720p/seg_00001.m4s`,
      `${prefix}/master.m3u8`,
    ]);

    // The version the photo list names: the end of the attempt id.
    const v = prefix.slice(-12);
    const master = await get(`${photoId}/master.m3u8?v=${v}`);
    expect(master.status).toBe(200);
    const lines = master.body.toString().split('\n');
    expect(lines.filter(line => line && !line.startsWith('#'))).toEqual([`480p/index.m3u8?v=${v}`, `720p/index.m3u8?v=${v}`]);
    const variants = lines.filter(line => line.startsWith('#EXT-X-STREAM-INF'));
    expect(variants.map(line => /RESOLUTION=(\d+x\d+)/.exec(line)[1])).toEqual(['854x480', '1280x720']);
    for (const line of variants) {
      expect(line).toMatch(/^#EXT-X-STREAM-INF:BANDWIDTH=\d+,AVERAGE-BANDWIDTH=\d+,RESOLUTION=\d+x\d+,CODECS="avc1\.64[0-9a-f]{4},mp4a\.40\.2"$/);
    }

    const media = await get(`${photoId}/720p/index.m3u8?v=${v}`);
    expect(media.status).toBe(200);
    const text = media.body.toString();
    expect(text).toContain(`#EXT-X-MAP:URI="init.mp4?v=${v}"`);
    expect(text).toContain('#EXT-X-TARGETDURATION:6');
    expect(text).toContain(`#EXTINF:6.000000,\nseg_00000.m4s?v=${v}`);
    expect(text).toContain('#EXT-X-ENDLIST');
    const segment = await get(`${photoId}/720p/seg_00000.m4s?v=${v}`);
    expect(segment.status).toBe(200);
    expect(segment.body.subarray(4, 8).toString('latin1')).toMatch(/^(styp|moof|sidx)$/);

    // What ffmpeg wrote is what the playlist promised: H.264/AAC at the rung's size.
    const local = path.join(clips, 'probe.mp4');
    fs.writeFileSync(local, Buffer.concat([(await get(`${photoId}/480p/init.mp4`)).body, (await get(`${photoId}/480p/seg_00000.m4s`)).body]));
    const probed = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', local]).stdout.toString());
    const stream = type => probed.streams.find(item => item.codec_type === type);
    expect(stream('video')).toMatchObject({ codec_name: 'h264', width: 854, height: 480, pix_fmt: 'yuv420p' });
    expect(stream('audio')).toMatchObject({ codec_name: 'aac', channels: 2 });
  }, 120000);

  test('a portrait clip below 480p gets one rendition at its own size', async () => {
    const photoId = await video('portrait.mp4', clip('portrait.mp4', { size: '240x426', seconds: 2 }));
    expect(await render(photoId)).toBe('complete');
    const prefix = (await row(photoId)).hls_path;
    expect(await keys(photoId)).toEqual([`${prefix}/240p/index.m3u8`, `${prefix}/240p/init.mp4`, `${prefix}/240p/seg_00000.m4s`, `${prefix}/master.m3u8`]);
    expect((await get(`${photoId}/master.m3u8`)).body.toString()).toContain('RESOLUTION=240x426');
  }, 120000);

  test('a second transcode replaces the first: the old attempt\'s files go', async () => {
    const photoId = await video('again.mp4', clip('again.mp4', { size: '320x240', seconds: 2 }));
    expect(await render(photoId)).toBe('complete');
    const first = (await row(photoId)).hls_path;
    await db('photos').where({ id: photoId }).update({ hls_status: 'pending' });
    expect(await render(photoId)).toBe('complete');
    const second = (await row(photoId)).hls_path;
    expect(second).not.toBe(first);
    expect((await keys(photoId)).every(key => key.startsWith(`${second}/`))).toBe(true);
    expect(await keys(photoId)).toHaveLength(4);
    // No empty directory of the first attempt stays behind on local disk.
    expect(fs.readdirSync(path.join(process.env.STORAGE_PATH, 'hls', String(photoId)))).toEqual([path.basename(second)]);
  }, 120000);

  test('the cleanup after a publish takes what earlier attempts left, never what appeared since', async () => {
    const photoId = await video('fenced.mp4', clip('fenced.mp4', { size: '320x240', seconds: 2 }));
    const older = `hls/${photoId}/11111111-1111-4111-8111-111111111111/master.m3u8`;
    const newer = `hls/${photoId}/99999999-9999-4999-8999-999999999999/master.m3u8`;
    await storage.put(older, Buffer.from('#EXTM3U'));
    const original = attempts.guard;
    const guard = jest.spyOn(attempts, 'guard').mockImplementation((attempt, conn, processing) => {
      const query = original(attempt, conn, processing);
      if (!processing) return query;
      // As the row is published, another replica's newer attempt (the row
      // replaced right after) starts writing its own prefix.
      const update = query.update.bind(query);
      query.update = async (values) => {
        const result = await update(values);
        await storage.put(newer, Buffer.from('#EXTM3U'));
        return result;
      };
      return query;
    });
    try {
      expect(await render(photoId)).toBe('complete');
    } finally {
      guard.mockRestore();
    }
    const left = await keys(photoId);
    expect(left).toContain(newer);
    expect(left).not.toContain(older);
    const published = (await row(photoId)).hls_path;
    expect(left.filter(key => key.startsWith(`${published}/`))).toHaveLength(4);
  }, 120000);

  test('an attempt that lost its claim stops uploading with the next file', async () => {
    const photoId = await video('stopped.mp4', clip('stopped.mp4', { size: '320x240', seconds: 2 }));
    const original = storage.putFromFile;
    const putFromFile = jest.spyOn(storage, 'putFromFile').mockImplementation(async function (key, ...rest) {
      const result = await original.call(this, key, ...rest);
      // The replacement lands as the first file goes up.
      await db('photos').where({ id: photoId }).update({ hls_attempt_id: null, hls_status: null });
      return result;
    });
    try {
      await expect(render(photoId)).rejects.toMatchObject({ code: 'MEDIA_SUPERSEDED' });
      expect(putFromFile).toHaveBeenCalledTimes(1);
    } finally {
      putFromFile.mockRestore();
    }
    expect(await keys(photoId)).toEqual([]);
  }, 120000);

  test('a video that is too long, or too large, is skipped and keeps range-serving', async () => {
    const long = await video('long.mp4', clip('long.mp4', { size: '160x90', seconds: 9, rate: 5 }));
    expect(await render(long)).toBe('skipped');
    expect(await row(long)).toMatchObject({ hls_status: 'skipped', hls_path: null, hls_error: 'Longer than 8 s (VIDEO_HLS_MAX_DURATION_SECONDS)' });
    expect(await keys(long)).toEqual([]);
    expect((await get(`${long}/master.m3u8`)).status).toBe(404);
    const original = await request(app).get(`/api/gallery/${SLUG}/photo/${long}`).set('Range', 'bytes=0-3');
    expect(original.status).toBe(206);

    // The size cap is read from the row, before the source is fetched at all.
    const large = await video('large.mp4', Buffer.from('never read'), { size_bytes: 5 * 1024 * 1024 * 1024 });
    expect(await render(large)).toBe('skipped');
    expect((await row(large)).hls_error).toBe('Larger than 4096 MiB (VIDEO_HLS_MAX_SOURCE_MIB)');
  }, 120000);

  test('a failed transcode throws, leaves no file behind and does not touch the rest of the row', async () => {
    const photoId = await video('broken.mp4', Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(4096, 7)]),
      { thumbnail_path: 'thumbnails/thumb_broken.jpg' });
    await expect(render(photoId)).rejects.toThrow();
    expect(await keys(photoId)).toEqual([]);
    // The queue records the failure (videoHlsQueue.test.js); the service wrote nothing.
    expect(await row(photoId)).toMatchObject({ hls_path: null, processing_status: 'complete', thumbnail_path: 'thumbnails/thumb_broken.jpg' });
  }, 120000);

  test('a video replaced during the transcode publishes nothing and drops its own files', async () => {
    const photoId = await video('raced.mp4', clip('raced.mp4', { size: '320x240', seconds: 2 }));
    const original = storage.putFromFile;
    const putFromFile = jest.spyOn(storage, 'putFromFile').mockImplementation(async function (key, ...rest) {
      const result = await original.call(this, key, ...rest);
      // The replacement lands as the last file goes up: the row starts over.
      if (key.endsWith('/master.m3u8')) await db('photos').where({ id: photoId }).update({ hls_attempt_id: null, hls_status: null });
      return result;
    });
    try {
      await expect(render(photoId)).rejects.toMatchObject({ code: 'MEDIA_SUPERSEDED' });
      expect(putFromFile.mock.calls.map(call => path.basename(call[0]))).toContain('master.m3u8');
    } finally {
      putFromFile.mockRestore();
    }
    expect(await keys(photoId)).toEqual([]);
    expect(await row(photoId)).toMatchObject({ hls_status: null, hls_path: null });
  }, 120000);
});
