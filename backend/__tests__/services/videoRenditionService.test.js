/**
 * videoRenditionService (issue 1430, item 8): the decision, the atom walk,
 * ffmpeg's arguments, and renderWebCopy's two outcomes. ffmpeg and ffprobe
 * are mocked — CI has neither.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('fluent-ffmpeg');
jest.mock('../../src/services/mediaProcessService', () => ({
  probeVideo: path => new Promise((resolve, reject) => require('fluent-ffmpeg').ffprobe(path, (error, value) => error ? reject(error) : resolve(value))),
  // The snapshot is the file itself here, probed like it.
  probeSnapshot: path => new Promise((resolve, reject) => require('fluent-ffmpeg').ffprobe(path, (error, value) => error ? reject(error) : resolve(value))),
  inputOptions: () => [],
  withSnapshot: (path, _kind, callback) => callback(path, { format: 'mov,mp4', policy: { nativeBytes: 2048 * 1024 * 1024, transcodeBytes: 0, threads: 2, renditionMs: 3600000, renditionMaxMs: 86400000, outputBytes: null } }),
  run: (_command, args) => new Promise((resolve, reject) => {
    const ffmpeg = require('fluent-ffmpeg');
    if (args.includes('-filters')) return ffmpeg.getAvailableFilters((error, filters) => error ? reject(error) : resolve({ stdout: Buffer.from(Object.keys(filters).join(' ')) }));
    const command = ffmpeg(args[args.indexOf('-i') + 1]);
    command.outputOptions(args.slice(args.indexOf('-i') + 2, args.lastIndexOf('-threads')))
      .on('end', () => resolve({ stdout: Buffer.alloc(0) })).on('error', reject).save(args[args.length - 1]);
  }),
}));
jest.mock('../../src/services/mediaAttemptService', () => ({
  current: () => ({ id: '11111111-1111-4111-8111-111111111111', assertCurrent: async () => {} }),
  guard: (_attempt, db) => db('photos').where({ id: require('../../src/database/db').__state.photo.id,
    web_status: 'processing', web_attempt_id: '11111111-1111-4111-8111-111111111111' }),
}));

jest.mock('../../src/database/db', () => {
  const state = { photo: null, event: null, setting: null, stripSetting: null, updates: [], updateResult: null };
  let pendingWhere = null;
  function query(table) {
    return {
      where(args) { pendingWhere = args; return this; },
      whereRaw() { return this; },
      whereNull() { return this; },
      orWhere() { return this; },
      orWhereNull() { return this; },
      async first() {
        if (table === 'photos') return state.photo;
        if (table === 'events') return state.event;
        if (table === 'app_settings') {
          return pendingWhere?.setting_key === 'general_video_strip_metadata' ? state.stripSetting : state.setting;
        }
        return null;
      },
      async update(data) { state.updates.push({ table, where: pendingWhere, data }); return table === 'photos' && state.updateResult != null ? state.updateResult : 1; },
    };
  }
  query.client = { config: { client: 'sqlite3' } };
  return { db: query, __state: state };
});

const mockStorage = { putFromFile: jest.fn(async () => {}), delete: jest.fn(async () => {}), kind: () => 'local' };
jest.mock('../../src/services/storage', () => ({ getStorage: () => mockStorage }));
const storage = mockStorage;
jest.mock('../../src/services/photoResolver', () => ({
  resolvePhotoStorageKey: jest.fn((event, photo) => (photo.source_origin === 'external' ? null : `events/active/${event.slug}/${photo.filename}`)),
  resolvePhotoFilePath: jest.fn((event, photo) => `/mnt/media/${photo.external_relpath}`),
}));
jest.mock('../../src/services/imageProcessor', () => ({
  withLocalCopy: jest.fn(async (key, fn) => fn(`/tmp/local-${require('path').basename(key)}`)),
}));

const ffmpeg = require('fluent-ffmpeg');
const dbModule = require('../../src/database/db');
const service = require('../../src/services/videoRenditionService');

// A top-level MP4 box: 4-byte big-endian size (header included), 4-byte type.
function box(type, payloadLength = 0) {
  const b = Buffer.alloc(8 + payloadLength);
  b.writeUInt32BE(8 + payloadLength, 0);
  b.write(type, 4, 'latin1');
  return b;
}

async function writeAtoms(...boxes) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-atoms-'));
  const file = path.join(dir, 'clip.mp4');
  await fs.promises.writeFile(file, Buffer.concat(boxes));
  return file;
}

function probeResult(over = {}) {
  return {
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2', majorBrand: 'isom', videoCodec: 'h264', audioCodec: 'aac', pixFmt: 'yuv420p', width: 1920, height: 1080,
    ...over,
  };
}

function mockProbe(streams, format) {
  ffmpeg.ffprobe = jest.fn((_p, cb) => cb(null, { streams, format }));
}

describe('hasFaststart', () => {
  it('is true when moov precedes mdat, false the other way round', async () => {
    expect(await service.hasFaststart(await writeAtoms(box('ftyp', 16), box('moov', 40), box('mdat', 100)))).toBe(true);
    expect(await service.hasFaststart(await writeAtoms(box('ftyp', 16), box('mdat', 100), box('moov', 40)))).toBe(false);
  });

  it('reads a 64-bit box size and a size-0 "to the end" box', async () => {
    const large = Buffer.alloc(16 + 50);
    large.writeUInt32BE(1, 0); large.write('mdat', 4, 'latin1'); large.writeBigUInt64BE(BigInt(16 + 50), 8);
    expect(await service.hasFaststart(await writeAtoms(box('ftyp', 16), large, box('moov', 40)))).toBe(false);

    const toEnd = Buffer.alloc(8 + 30);
    toEnd.writeUInt32BE(0, 0); toEnd.write('mdat', 4, 'latin1');
    expect(await service.hasFaststart(await writeAtoms(box('ftyp', 16), box('moov', 40), toEnd))).toBe(true);
  });

  it('is false for a file with no moov at all, or that is not boxed', async () => {
    expect(await service.hasFaststart(await writeAtoms(box('ftyp', 16), box('mdat', 100)))).toBe(false);
    expect(await service.hasFaststart(await writeAtoms(Buffer.from('this is not an mp4 file at all, just text')))).toBe(false);
  });
});

describe('playsInBrowser', () => {
  it('accepts H.264/AAC in an ISO MP4 with the moov in front', () => {
    expect(service.playsInBrowser(probeResult(), true)).toBe(true);
    // No audio track is fine.
    expect(service.playsInBrowser(probeResult({ audioCodec: null }), true)).toBe(true);
    expect(service.playsInBrowser(probeResult({ majorBrand: 'mp42' }), true)).toBe(true);
  });

  it('wants a copy for HEVC, non-AAC audio, 10-bit, QuickTime, WebM and a trailing moov', () => {
    expect(service.playsInBrowser(probeResult({ videoCodec: 'hevc' }), true)).toBe(false);
    expect(service.playsInBrowser(probeResult({ audioCodec: 'pcm_s16le' }), true)).toBe(false);
    expect(service.playsInBrowser(probeResult({ pixFmt: 'yuv420p10le' }), true)).toBe(false);
    expect(service.playsInBrowser(probeResult({ majorBrand: 'qt' }), true)).toBe(false);
    expect(service.playsInBrowser(probeResult({ formatName: 'matroska,webm', majorBrand: '' }), true)).toBe(false);
    expect(service.playsInBrowser(probeResult(), false)).toBe(false);
    expect(service.playsInBrowser(null, true)).toBe(false);
  });
});

describe('transcodeOptions', () => {
  it('writes a faststart H.264/AAC 4:2:0 MP4 capped on the long edge, first video and optional audio stream only', () => {
    const opts = service.transcodeOptions().join(' ');
    expect(opts).toContain('-c:v libx264');
    expect(opts).toContain('-c:a aac');
    expect(opts).toContain('-pix_fmt yuv420p');
    expect(opts).toContain('-movflags +faststart');
    expect(opts).toContain('-map 0:v:0 -map 0:a:0?');
    expect(opts).toContain('scale=w=\'min(1920,iw)\':h=\'min(1920,ih)\':force_original_aspect_ratio=decrease:force_divisible_by=2');
    expect(opts).toContain('-f mp4');
  });

  it('drops the source metadata (location, artist, device tags) and chapters', () => {
    const opts = service.transcodeOptions().join(' ');
    expect(opts).toContain('-map_metadata -1 -map_chapters -1');
    expect(service.transcodeOptions({ toneMap: true }).join(' ')).toContain('-map_metadata -1 -map_chapters -1');
  });
});

describe('remuxOptions', () => {
  it('copies the first video and optional audio stream into a faststart MP4 without metadata or chapters', () => {
    expect(service.remuxOptions()).toEqual([
      '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy',
      '-map_metadata', '-1', '-map_chapters', '-1',
      '-movflags', '+faststart', '-f', 'mp4',
    ]);
  });

  it('maps the probed tracks by absolute index when it has them, as the transcode does', () => {
    const opts = service.remuxOptions({ videoIndex: 1, audioIndex: 3 });
    expect(opts.slice(0, 4)).toEqual(['-map', '0:1', '-map', '0:3']);
    expect(service.transcodeOptions({ toneMap: true, videoIndex: 1, audioIndex: 3 }).slice(0, 4)).toEqual(['-map', '0:1', '-map', '0:3']);
    expect(service.remuxOptions({ videoIndex: 0, audioIndex: null }).slice(0, 4)).toEqual(['-map', '0:0', '-map', '0:a:0?']);
  });
});

describe('probe and playedStreamIndexes', () => {
  it('pick the default video and audio track, never a cover image', async () => {
    mockProbe([
      { index: 0, codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1, default: 1 } },
      { index: 1, codec_type: 'video', codec_name: 'h264', disposition: { default: 0 }, width: 160 },
      { index: 2, codec_type: 'video', codec_name: 'h264', disposition: { default: 1 }, width: 320 },
      { index: 3, codec_type: 'audio', codec_name: 'aac', disposition: { default: 0 } },
      { index: 4, codec_type: 'audio', codec_name: 'aac', disposition: { default: 1 } },
    ], { format_name: 'mov,mp4', tags: {} });
    const probed = await service.probe('/tmp/x.mp4');
    expect(probed).toMatchObject({ videoCodec: 'h264', width: 320 });
    const metadata = await new Promise((resolve) => ffmpeg.ffprobe('/tmp/x.mp4', (_e, v) => resolve(v)));
    expect(service.playedStreamIndexes(metadata)).toEqual({ videoIndex: 2, audioIndex: 4 });

    // Nothing flagged default: the first real one.
    mockProbe([
      { index: 0, codec_type: 'video', codec_name: 'h264', width: 160 },
      { index: 1, codec_type: 'video', codec_name: 'h264', width: 320 },
    ], { format_name: 'mov,mp4', tags: {} });
    expect(await service.probe('/tmp/x.mp4')).toMatchObject({ width: 160 });
    const single = await new Promise((resolve) => ffmpeg.ffprobe('/tmp/x.mp4', (_e, v) => resolve(v)));
    expect(service.playedStreamIndexes(single)).toEqual({ videoIndex: 0, audioIndex: null });
    expect(service.playedStreamIndexes({})).toEqual({ videoIndex: null, audioIndex: null });
  });
});

describe('isStripEnabled', () => {
  beforeEach(() => service.clearCache());
  afterAll(() => { dbModule.__state.stripSetting = null; service.clearCache(); });

  it('is on when no row exists, and off only for a stored false', async () => {
    dbModule.__state.stripSetting = null;
    expect(await service.isStripEnabled()).toBe(true);
    for (const [stored, expected] of [['false', false], [false, false], ['"false"', false], [0, false], ['true', true], [true, true]]) {
      service.clearCache();
      dbModule.__state.stripSetting = { setting_value: stored };
      expect(await service.isStripEnabled()).toBe(expected);
    }
  });
});

describe('queuesVideos', () => {
  beforeEach(() => service.clearCache());
  afterAll(() => { dbModule.__state.setting = null; dbModule.__state.stripSetting = null; service.clearCache(); });

  it('is on while either the transcodes or metadata stripping is on', async () => {
    for (const [copies, strip, expected] of [[null, null, true], [false, false, false], [true, false, true], [false, true, true]]) {
      service.clearCache();
      dbModule.__state.setting = copies == null ? null : { setting_value: String(copies) };
      dbModule.__state.stripSetting = strip == null ? null : { setting_value: String(strip) };
      expect(await service.queuesVideos()).toBe(expected);
    }
  });
});

describe('isEnabled', () => {
  beforeEach(() => service.clearCache());

  it('reads the setting in the shapes the two engines store it', async () => {
    dbModule.__state.setting = { setting_value: 'true' };
    expect(await service.isEnabled()).toBe(true);
    service.clearCache();
    dbModule.__state.setting = { setting_value: false };
    expect(await service.isEnabled()).toBe(false);
    service.clearCache();
    dbModule.__state.setting = null;
    expect(await service.isEnabled()).toBe(false);
  });
});

describe('webKeyFor', () => {
  it('caps a long basename so the key stays a legal filename everywhere', () => {
    const long = `${'a'.repeat(300)}.MOV`;
    const key = service.webKeyFor({ id: 7, external_relpath: `shoot/${long}` }, '2026-10-02T09:00:00.000Z');
    expect(key.startsWith('videos/web_7_')).toBe(true);
    expect(key.endsWith('.mp4')).toBe(true);
    expect(key.split('/').pop().length).toBeLessThan(140);
    // A short name is kept whole.
    expect(service.webKeyFor({ id: 7, external_relpath: 'shoot/Teaser.MOV' })).toBe('videos/web_7_Teaser.mp4');
    // Bytes, not characters: 80 three-byte characters are 240 bytes.
    const wide = service.webKeyFor({ id: 7, filename: `${'結婚式の動画ファイル'.repeat(8)}.mov` });
    expect(Buffer.byteLength(wide.split('/').pop(), 'utf8')).toBeLessThan(140);
    expect(wide.endsWith('.mp4')).toBe(true);
    // Never a half character.
    expect(wide).toBe(Buffer.from(wide, 'utf8').toString('utf8'));
  });

  it('marks a remux, and the gallery tells it from a transcode by that marker', () => {
    const { isRemuxWebKey } = require('../../src/services/galleryAssetPolicy');
    const remux = service.webKeyFor({ id: 7, filename: 'clip.mp4' }, '11111111-1111-4111-8111-111111111111', { remux: true });
    expect(remux).toBe('videos/web_7_remux_11111111-1111-4111-8111-111111111111_clip.mp4');
    expect(isRemuxWebKey(remux)).toBe(true);
    expect(isRemuxWebKey(service.webKeyFor({ id: 7, filename: 'remux_clip.mp4' }, '11111111-1111-4111-8111-111111111111'))).toBe(false);
    expect(isRemuxWebKey(null)).toBe(false);
  });
});

describe('HDR', () => {
  it('tells PQ and HLG from SDR by the transfer function', () => {
    expect(service.isHdr(probeResult({ colorTransfer: 'smpte2084' }))).toBe(true);
    expect(service.isHdr(probeResult({ colorTransfer: 'arib-std-b67' }))).toBe(true);
    expect(service.isHdr(probeResult({ colorTransfer: 'bt709' }))).toBe(false);
    // Wide primaries alone are not HDR.
    expect(service.isHdr(probeResult({ colorTransfer: null, colorPrimaries: 'bt2020' }))).toBe(false);
  });

  it('runs the tone-map chain ahead of the scale and tags the copy BT.709', () => {
    const plain = service.transcodeOptions();
    const mapped = service.transcodeOptions({ toneMap: true });
    const vf = (opts) => opts[opts.indexOf('-vf') + 1];
    expect(vf(plain).startsWith('scale=')).toBe(true);
    expect(vf(mapped)).toBe(`${service.HDR_TO_SDR_FILTER},${vf(plain)}`);
    expect(mapped).toEqual(expect.arrayContaining(['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709']));
    expect(plain).not.toContain('-color_trc');
  });

  it('asks ffmpeg for its filters once', async () => {
    service._resetToneMapSupportForTests();
    ffmpeg.getAvailableFilters = jest.fn((cb) => cb(null, { zscale: {}, tonemap: {}, scale: {} }));
    expect(await service.canToneMap()).toBe(true);
    expect(await service.canToneMap()).toBe(true);
    expect(ffmpeg.getAvailableFilters).toHaveBeenCalledTimes(1);

    service._resetToneMapSupportForTests();
    ffmpeg.getAvailableFilters = jest.fn((cb) => cb(null, { scale: {} }));
    expect(await service.canToneMap()).toBe(false);
  });
});

describe('renderWebCopy', () => {
  beforeEach(() => {
    dbModule.__state.updates.length = 0;
    dbModule.__state.updateResult = null;
    dbModule.__state.event = { id: 9, slug: 'wedding' };
    // The transcodes are on unless a test says otherwise.
    dbModule.__state.setting = { setting_value: 'true' };
    service.clearCache();
    storage.putFromFile.mockClear();
    storage.delete.mockClear();
    ffmpeg.mockReset();
  });

  afterEach(() => { dbModule.__state.stripSetting = null; dbModule.__state.setting = null; service.clearCache(); });

  it('defers a video that needs a transcode while the transcodes are off: nothing written, no ffmpeg', async () => {
    dbModule.__state.setting = { setting_value: 'false' };
    service.clearCache();
    dbModule.__state.photo = { id: 31, event_id: 9, filename: 'phone.mov', media_type: 'video', mime_type: 'video/quicktime' };
    mockProbe(
      [{ index: 0, codec_type: 'video', codec_name: 'hevc', pix_fmt: 'yuv420p' }],
      { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', tags: { major_brand: 'qt  ' } },
    );
    const atoms = await writeAtoms(box('ftyp', 16), box('mdat', 100), box('moov', 40));
    require('../../src/services/imageProcessor').withLocalCopy.mockImplementationOnce(async (_k, fn) => fn(atoms));

    expect(await service.renderWebCopy(31)).toBe('deferred');
    expect(ffmpeg).not.toHaveBeenCalled();
    expect(storage.putFromFile).not.toHaveBeenCalled();
    expect(dbModule.__state.updates.find((u) => u.table === 'photos').data).toMatchObject({ web_path: null, web_status: 'deferred' });
  });

  it('remuxes a compatible video with the transcodes off, and never falls back to a transcode then', async () => {
    dbModule.__state.setting = { setting_value: 'false' };
    service.clearCache();
    dbModule.__state.photo = { id: 32, event_id: 9, filename: 'clip.mp4', media_type: 'video' };
    const format = { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', tags: { major_brand: 'isom' } };
    const h264 = { streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p' }], format };
    const hevc = { streams: [{ index: 0, codec_type: 'video', codec_name: 'hevc', pix_fmt: 'yuv420p' }], format };
    const command = {
      outputOptions: jest.fn(function () { return this; }),
      on: jest.fn(function (event, handler) { if (event === 'end') this._end = handler; return this; }),
      save: jest.fn(function (out) { fs.writeFileSync(out, 'remuxed-bytes'); setImmediate(() => this._end()); }),
      kill: jest.fn(),
    };
    ffmpeg.mockImplementation(() => command);
    const atoms = await writeAtoms(box('ftyp', 16), box('moov', 40), box('mdat', 100));

    ffmpeg.ffprobe = jest.fn((_p, cb) => cb(null, h264));
    require('../../src/services/imageProcessor').withLocalCopy.mockImplementationOnce(async (_k, fn) => fn(atoms));
    expect(await service.renderWebCopy(32)).toBe('complete');
    expect(command.outputOptions).toHaveBeenCalledWith(service.remuxOptions({ videoIndex: 0, audioIndex: null }));

    // Replaced by HEVC before the snapshot: no transcode with the copies off.
    let calls = 0;
    ffmpeg.ffprobe = jest.fn((_p, cb) => cb(null, calls++ === 0 ? h264 : hevc));
    command.outputOptions.mockClear();
    require('../../src/services/imageProcessor').withLocalCopy.mockImplementationOnce(async (_k, fn) => fn(atoms));
    await expect(service.renderWebCopy(32)).rejects.toThrow('browser-playable copies are off');
    expect(command.outputOptions).not.toHaveBeenCalled();
  });

  it('skips a video that already plays when metadata stripping is off, dropping a stale copy', async () => {
    dbModule.__state.stripSetting = { setting_value: 'false' };
    service.clearCache();
    dbModule.__state.photo = { id: 21, event_id: 9, filename: 'clip.mp4', media_type: 'video', web_path: 'videos/web_21_old.mp4' };
    mockProbe(
      [{ codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 1920, height: 1080 }, { codec_type: 'audio', codec_name: 'aac' }],
      { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', tags: { major_brand: 'isom' } },
    );
    const atoms = await writeAtoms(box('ftyp', 16), box('moov', 40), box('mdat', 100));
    require('../../src/services/imageProcessor').withLocalCopy.mockImplementationOnce(async (_k, fn) => fn(atoms));

    expect(await service.renderWebCopy(21)).toBe('skipped');
    const update = dbModule.__state.updates.find((u) => u.table === 'photos');
    expect(update.data).toMatchObject({ web_path: null, web_status: 'skipped', web_error: null });
    expect(storage.delete).toHaveBeenCalledWith('videos/web_21_old.mp4');
    expect(ffmpeg).not.toHaveBeenCalled();
  });

  it('remuxes a video that already plays (stripping is on by default) and publishes it like a copy', async () => {
    dbModule.__state.photo = { id: 26, event_id: 9, filename: 'phone.mp4', media_type: 'video', web_path: 'videos/web_26_old.mp4' };
    service.clearCache();
    mockProbe(
      [{ index: 0, codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 1920, height: 1080 }, { index: 1, codec_type: 'audio', codec_name: 'aac' }],
      { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', tags: { major_brand: 'isom' } },
    );
    const atoms = await writeAtoms(box('ftyp', 16), box('moov', 40), box('mdat', 100));
    require('../../src/services/imageProcessor').withLocalCopy.mockImplementationOnce(async (_k, fn) => fn(atoms));
    let savedTo = null;
    const command = {
      outputOptions: jest.fn(function () { return this; }),
      on: jest.fn(function (event, handler) { if (event === 'end') this._end = handler; return this; }),
      save: jest.fn(function (out) { savedTo = out; fs.writeFileSync(out, 'remuxed-bytes'); setImmediate(() => this._end()); }),
      kill: jest.fn(),
    };
    ffmpeg.mockImplementation(() => command);

    expect(await service.renderWebCopy(26)).toBe('complete');
    expect(command.outputOptions).toHaveBeenCalledWith(service.remuxOptions({ videoIndex: 0, audioIndex: 1 }));
    const key = 'videos/web_26_remux_11111111-1111-4111-8111-111111111111_phone.mp4';
    expect(storage.putFromFile).toHaveBeenCalledWith(key, savedTo, { contentType: 'video/mp4' });
    const update = dbModule.__state.updates.find((u) => u.table === 'photos');
    expect(update.data).toMatchObject({ web_path: key, web_status: 'complete', web_error: null });
    expect(update.where).toEqual({ id: 26, web_status: 'processing', web_attempt_id: '11111111-1111-4111-8111-111111111111' });
    // The copy an earlier attempt left behind is dropped once the remux is published.
    expect(storage.delete).toHaveBeenCalledWith('videos/web_26_old.mp4');
  });

  it('reads the strip setting past its cache before skipping: another replica may just have switched it on', async () => {
    dbModule.__state.stripSetting = { setting_value: 'false' };
    service.clearCache();
    expect(await service.isStripEnabled()).toBe(false);
    // Switched on elsewhere; this process still caches "off".
    dbModule.__state.stripSetting = { setting_value: 'true' };
    expect(await service.isStripEnabled()).toBe(false);
    dbModule.__state.photo = { id: 27, event_id: 9, filename: 'late.mp4', media_type: 'video' };
    mockProbe(
      [{ index: 0, codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p' }],
      { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', tags: { major_brand: 'isom' } },
    );
    const atoms = await writeAtoms(box('ftyp', 16), box('moov', 40), box('mdat', 100));
    require('../../src/services/imageProcessor').withLocalCopy.mockImplementationOnce(async (_k, fn) => fn(atoms));
    const command = {
      outputOptions: jest.fn(function () { return this; }),
      on: jest.fn(function (event, handler) { if (event === 'end') this._end = handler; return this; }),
      save: jest.fn(function (out) { fs.writeFileSync(out, 'remuxed-bytes'); setImmediate(() => this._end()); }),
      kill: jest.fn(),
    };
    ffmpeg.mockImplementation(() => command);

    expect(await service.renderWebCopy(27)).toBe('complete');
    expect(command.outputOptions).toHaveBeenCalledWith(service.remuxOptions({ videoIndex: 0, audioIndex: null }));
  });

  it('transcodes an HEVC clip, stores the copy under videos/ and records it', async () => {
    dbModule.__state.photo = { id: 22, event_id: 9, filename: 'phone.mov', media_type: 'video', mime_type: 'video/quicktime' };
    mockProbe(
      [{ codec_type: 'video', codec_name: 'hevc', pix_fmt: 'yuv420p', width: 3840, height: 2160 }, { codec_type: 'audio', codec_name: 'aac' }],
      { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', tags: { major_brand: 'qt  ' } },
    );
    const atoms = await writeAtoms(box('ftyp', 16), box('mdat', 100), box('moov', 40));
    require('../../src/services/imageProcessor').withLocalCopy.mockImplementationOnce(async (_k, fn) => fn(atoms));

    let savedTo = null;
    const command = {
      outputOptions: jest.fn(function () { return this; }),
      on: jest.fn(function (event, handler) { if (event === 'end') this._end = handler; return this; }),
      save: jest.fn(function (out) { savedTo = out; fs.writeFileSync(out, 'h264-bytes'); setImmediate(() => this._end()); }),
      kill: jest.fn(),
    };
    ffmpeg.mockImplementation(() => command);

    expect(await service.renderWebCopy(22, { claimedAt: '2026-10-02T09:00:00.000Z' })).toBe('complete');
    expect(ffmpeg).toHaveBeenCalledWith(atoms);
    expect(command.outputOptions).toHaveBeenCalledWith(service.transcodeOptions());
    expect(service.transcodeOptions().slice(0, 4)).toEqual(['-map', '0:v:0', '-map', '0:a:0?']);
    // The key carries the claim, so two attempts never share an object.
    expect(storage.putFromFile).toHaveBeenCalledWith('videos/web_22_11111111-1111-4111-8111-111111111111_phone.mp4', savedTo, { contentType: 'video/mp4' });
    const update = dbModule.__state.updates.find((u) => u.table === 'photos');
    expect(update.data).toMatchObject({ web_path: 'videos/web_22_11111111-1111-4111-8111-111111111111_phone.mp4', web_status: 'complete', web_error: null });
    // Published only against the worker's own claim: status and claim time.
    expect(update.where).toEqual({ id: 22, web_status: 'processing', web_attempt_id: '11111111-1111-4111-8111-111111111111' });
    // The temp file is gone once the copy is in storage.
    expect(fs.existsSync(savedTo)).toBe(false);
  });

  it.each([
    ['tone-maps an HLG clip when ffmpeg has the filters', { zscale: {}, tonemap: {} }, true],
    ['still writes the copy, untone-mapped, when ffmpeg lacks them', { scale: {} }, false],
  ])('%s', async (_name, filters, mapped) => {
    service._resetToneMapSupportForTests();
    ffmpeg.getAvailableFilters = jest.fn((cb) => cb(null, filters));
    const logger = require('../../src/utils/logger');
    logger.warn.mockClear();
    dbModule.__state.photo = { id: 24, event_id: 9, filename: 'hlg.mov', media_type: 'video', mime_type: 'video/quicktime' };
    mockProbe(
      [{ codec_type: 'video', codec_name: 'hevc', pix_fmt: 'yuv420p10le', width: 3840, height: 2160, color_transfer: 'arib-std-b67', color_primaries: 'bt2020' }, { codec_type: 'audio', codec_name: 'aac' }],
      { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', tags: { major_brand: 'qt  ' } },
    );
    const atoms = await writeAtoms(box('ftyp', 16), box('mdat', 100), box('moov', 40));
    require('../../src/services/imageProcessor').withLocalCopy.mockImplementationOnce(async (_k, fn) => fn(atoms));
    const command = {
      outputOptions: jest.fn(function () { return this; }),
      on: jest.fn(function (event, handler) { if (event === 'end') this._end = handler; return this; }),
      save: jest.fn(function (out) { fs.writeFileSync(out, 'h264-bytes'); setImmediate(() => this._end()); }),
      kill: jest.fn(),
    };
    ffmpeg.mockImplementation(() => command);

    expect(await service.renderWebCopy(24, { claimedAt: '2026-10-02T09:00:00.000Z' })).toBe('complete');
    expect(command.outputOptions).toHaveBeenCalledWith(service.transcodeOptions({ toneMap: mapped }));
    if (mapped) expect(logger.warn).not.toHaveBeenCalled();
    else expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('lacks zscale/tonemap'));
  });

  it('transcodes the default track it probed, so the HDR decision and the encode see the same picture', async () => {
    service._resetToneMapSupportForTests();
    ffmpeg.getAvailableFilters = jest.fn((cb) => cb(null, { zscale: {}, tonemap: {} }));
    dbModule.__state.photo = { id: 28, event_id: 9, filename: 'two.mov', media_type: 'video', mime_type: 'video/quicktime' };
    mockProbe([
      { index: 0, codec_type: 'video', codec_name: 'hevc', pix_fmt: 'yuv420p10le', color_transfer: 'smpte2084', disposition: { default: 0 } },
      { index: 1, codec_type: 'video', codec_name: 'hevc', pix_fmt: 'yuv420p', color_transfer: 'bt709', disposition: { default: 1 } },
      { index: 2, codec_type: 'audio', codec_name: 'aac', disposition: { default: 1 } },
    ], { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', tags: { major_brand: 'qt  ' } });
    const atoms = await writeAtoms(box('ftyp', 16), box('mdat', 100), box('moov', 40));
    require('../../src/services/imageProcessor').withLocalCopy.mockImplementationOnce(async (_k, fn) => fn(atoms));
    const command = {
      outputOptions: jest.fn(function () { return this; }),
      on: jest.fn(function (event, handler) { if (event === 'end') this._end = handler; return this; }),
      save: jest.fn(function (out) { fs.writeFileSync(out, 'h264-bytes'); setImmediate(() => this._end()); }),
      kill: jest.fn(),
    };
    ffmpeg.mockImplementation(() => command);

    expect(await service.renderWebCopy(28)).toBe('complete');
    expect(command.outputOptions).toHaveBeenCalledWith(service.transcodeOptions({ toneMap: false, videoIndex: 1, audioIndex: 2 }));
  });

  it('maps the streams of the snapshot ffmpeg reads, not of an earlier probe of a since-replaced file', async () => {
    dbModule.__state.photo = { id: 29, event_id: 9, filename: 'swap.mp4', media_type: 'video' };
    // First probe: [video, audio]. By the time the snapshot is taken the NAS
    // file was replaced by one laid out [video, video, audio].
    const before = { streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p' }, { index: 1, codec_type: 'audio', codec_name: 'aac' }],
      format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', tags: { major_brand: 'isom' } } };
    const after = { streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p' }, { index: 1, codec_type: 'video', codec_name: 'h264' },
      { index: 2, codec_type: 'audio', codec_name: 'aac' }], format: before.format };
    let calls = 0;
    ffmpeg.ffprobe = jest.fn((_p, cb) => cb(null, calls++ === 0 ? before : after));
    const atoms = await writeAtoms(box('ftyp', 16), box('moov', 40), box('mdat', 100));
    require('../../src/services/imageProcessor').withLocalCopy.mockImplementationOnce(async (_k, fn) => fn(atoms));
    const command = {
      outputOptions: jest.fn(function () { return this; }),
      on: jest.fn(function (event, handler) { if (event === 'end') this._end = handler; return this; }),
      save: jest.fn(function (out) { fs.writeFileSync(out, 'remuxed-bytes'); setImmediate(() => this._end()); }),
      kill: jest.fn(),
    };
    ffmpeg.mockImplementation(() => command);

    expect(await service.renderWebCopy(29)).toBe('complete');
    expect(command.outputOptions).toHaveBeenCalledWith(service.remuxOptions({ videoIndex: 0, audioIndex: 2 }));
  });

  it('transcodes instead of stream-copying when the file was replaced by one a browser cannot play', async () => {
    dbModule.__state.photo = { id: 30, event_id: 9, filename: 'swap.mp4', media_type: 'video' };
    const format = { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', tags: { major_brand: 'isom' } };
    const before = { streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p' }], format };
    const after = { streams: [{ index: 0, codec_type: 'video', codec_name: 'hevc', pix_fmt: 'yuv420p' }, { index: 1, codec_type: 'audio', codec_name: 'aac' }], format };
    let calls = 0;
    ffmpeg.ffprobe = jest.fn((_p, cb) => cb(null, calls++ === 0 ? before : after));
    const atoms = await writeAtoms(box('ftyp', 16), box('moov', 40), box('mdat', 100));
    require('../../src/services/imageProcessor').withLocalCopy.mockImplementationOnce(async (_k, fn) => fn(atoms));
    const command = {
      outputOptions: jest.fn(function () { return this; }),
      on: jest.fn(function (event, handler) { if (event === 'end') this._end = handler; return this; }),
      save: jest.fn(function (out) { fs.writeFileSync(out, 'h264-bytes'); setImmediate(() => this._end()); }),
      kill: jest.fn(),
    };
    ffmpeg.mockImplementation(() => command);

    expect(await service.renderWebCopy(30)).toBe('complete');
    expect(command.outputOptions).toHaveBeenCalledWith(service.transcodeOptions({ toneMap: false, videoIndex: 0, audioIndex: 1 }));
    // A transcoded copy, keyed as one: it plays free like any other.
    const key = 'videos/web_30_11111111-1111-4111-8111-111111111111_swap.mp4';
    expect(storage.putFromFile).toHaveBeenCalledWith(key, expect.any(String), { contentType: 'video/mp4' });
    expect(dbModule.__state.updates.find((u) => u.table === 'photos').data).toMatchObject({ web_path: key, web_status: 'complete' });
  });

  it('drops the copy and leaves the row alone when the claim was lost during the transcode', async () => {
    // A replacement re-queued the new file (or the row is gone) while ffmpeg
    // ran: the fenced UPDATE matches nothing, the old source's copy must not
    // be published over it.
    dbModule.__state.photo = { id: 22, event_id: 9, filename: 'phone.mov', media_type: 'video', mime_type: 'video/quicktime' };
    dbModule.__state.updateResult = 0;
    mockProbe(
      [{ codec_type: 'video', codec_name: 'hevc', pix_fmt: 'yuv420p', width: 3840, height: 2160 }, { codec_type: 'audio', codec_name: 'aac' }],
      { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', tags: { major_brand: 'qt  ' } },
    );
    const atoms = await writeAtoms(box('ftyp', 16), box('mdat', 100), box('moov', 40));
    require('../../src/services/imageProcessor').withLocalCopy.mockImplementationOnce(async (_k, fn) => fn(atoms));
    const command = {
      outputOptions: jest.fn(function () { return this; }),
      on: jest.fn(function (event, handler) { if (event === 'end') this._end = handler; return this; }),
      save: jest.fn(function (out) { fs.writeFileSync(out, 'h264-bytes'); setImmediate(() => this._end()); }),
      kill: jest.fn(),
    };
    ffmpeg.mockImplementation(() => command);

    expect(await service.renderWebCopy(22, { claimedAt: '2026-10-02T09:00:00.000Z' })).toBe('superseded');
    expect(storage.putFromFile).toHaveBeenCalledWith('videos/web_22_11111111-1111-4111-8111-111111111111_phone.mp4', expect.any(String), { contentType: 'video/mp4' });
    // Its own object only: the key is this claim's.
    expect(storage.delete).toHaveBeenCalledWith('videos/web_22_11111111-1111-4111-8111-111111111111_phone.mp4');
    const update = dbModule.__state.updates.find((u) => u.table === 'photos');
    expect(update.where).toEqual({ id: 22, web_status: 'processing', web_attempt_id: '11111111-1111-4111-8111-111111111111' });
  });

  it('reads an external video off the mount and keys the copy by id and NAS basename', async () => {
    dbModule.__state.photo = { id: 23, event_id: 9, filename: 'Teaser.MOV', external_relpath: 'shoot/Teaser.MOV', source_origin: 'external', media_type: 'video' };
    mockProbe(
      [{ codec_type: 'video', codec_name: 'hevc', pix_fmt: 'yuv420p' }],
      { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', tags: { major_brand: 'qt  ' } },
    );
    const command = {
      outputOptions: jest.fn(function () { return this; }),
      on: jest.fn(function (event, handler) { if (event === 'end') this._end = handler; return this; }),
      save: jest.fn(function (out) { fs.writeFileSync(out, 'h264-bytes'); setImmediate(() => this._end()); }),
      kill: jest.fn(),
    };
    ffmpeg.mockImplementation(() => command);
    // The "mount": a real file, read straight off it, never through withLocalCopy.
    const nasFile = await writeAtoms(box('ftyp', 16), box('mdat', 100), box('moov', 40));
    require('../../src/services/photoResolver').resolvePhotoFilePath.mockReturnValueOnce(nasFile);
    const { withLocalCopy } = require('../../src/services/imageProcessor');
    withLocalCopy.mockClear();

    expect(await service.renderWebCopy(23)).toBe('complete');
    expect(withLocalCopy).not.toHaveBeenCalled();
    expect(ffmpeg).toHaveBeenCalledWith(nasFile);
    expect(storage.putFromFile).toHaveBeenCalledWith('videos/web_23_11111111-1111-4111-8111-111111111111_Teaser.mp4', expect.any(String), { contentType: 'video/mp4' });
  });

  it('throws when ffmpeg fails, leaving the row for the queue to mark', async () => {
    dbModule.__state.photo = { id: 24, event_id: 9, filename: 'bad.mp4', media_type: 'video' };
    mockProbe([{ codec_type: 'video', codec_name: 'hevc' }], { format_name: 'mov,mp4', tags: {} });
    const command = {
      outputOptions: jest.fn(function () { return this; }),
      on: jest.fn(function (event, handler) { if (event === 'error') this._error = handler; return this; }),
      save: jest.fn(function () { setImmediate(() => this._error(new Error('ffmpeg exited with code 1'))); }),
      kill: jest.fn(),
    };
    ffmpeg.mockImplementation(() => command);
    const atoms = await writeAtoms(box('ftyp', 16), box('mdat', 100), box('moov', 40));
    require('../../src/services/imageProcessor').withLocalCopy.mockImplementationOnce(async (_k, fn) => fn(atoms));

    await expect(service.renderWebCopy(24)).rejects.toThrow('ffmpeg exited with code 1');
    expect(storage.putFromFile).not.toHaveBeenCalled();
    expect(dbModule.__state.updates.filter((u) => u.table === 'photos')).toHaveLength(0);
  });

  it('takes an upper-case video MIME type as a video, as the SQLite sweeps do', async () => {
    dbModule.__state.setting = { setting_value: 'false' };
    service.clearCache();
    dbModule.__state.photo = { id: 33, event_id: 9, filename: 'shout.mov', media_type: 'image', mime_type: 'VIDEO/QUICKTIME' };
    mockProbe([{ index: 0, codec_type: 'video', codec_name: 'hevc', pix_fmt: 'yuv420p' }], { format_name: 'mov,mp4', tags: { major_brand: 'qt  ' } });
    const atoms = await writeAtoms(box('ftyp', 16), box('mdat', 100), box('moov', 40));
    require('../../src/services/imageProcessor').withLocalCopy.mockImplementationOnce(async (_k, fn) => fn(atoms));
    // Not 'skipped' (the janitor would queue that again every minute): probed and deferred.
    expect(await service.renderWebCopy(33)).toBe('deferred');
  });

  it('marks a row that is not a video as skipped without touching ffmpeg', async () => {
    dbModule.__state.photo = { id: 25, event_id: 9, filename: 'still.jpg', media_type: 'image', mime_type: 'image/jpeg' };
    expect(await service.renderWebCopy(25)).toBe('skipped');
    expect(ffmpeg).not.toHaveBeenCalled();
  });
});
