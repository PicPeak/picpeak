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

jest.mock('../../src/database/db', () => {
  const state = { photo: null, event: null, setting: null, updates: [], updateResult: null };
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
        if (table === 'app_settings') return state.setting;
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
});

describe('renderWebCopy', () => {
  beforeEach(() => {
    dbModule.__state.updates.length = 0;
    dbModule.__state.updateResult = null;
    dbModule.__state.event = { id: 9, slug: 'wedding' };
    storage.putFromFile.mockClear();
    storage.delete.mockClear();
    ffmpeg.mockReset();
  });

  it('skips a video that already plays, dropping a stale copy', async () => {
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
    // The key carries the claim, so two attempts never share an object.
    expect(storage.putFromFile).toHaveBeenCalledWith('videos/web_22_muqqfmo0_phone.mp4', savedTo, { contentType: 'video/mp4' });
    const update = dbModule.__state.updates.find((u) => u.table === 'photos');
    expect(update.data).toMatchObject({ web_path: 'videos/web_22_muqqfmo0_phone.mp4', web_status: 'complete', web_error: null });
    // Published only against the worker's own claim: status and claim time.
    expect(update.where).toEqual({ id: 22, web_status: 'processing', web_started_at: '2026-10-02T09:00:00.000Z' });
    // The temp file is gone once the copy is in storage.
    expect(fs.existsSync(savedTo)).toBe(false);
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
    expect(storage.putFromFile).toHaveBeenCalledWith('videos/web_22_muqqfmo0_phone.mp4', expect.any(String), { contentType: 'video/mp4' });
    // Its own object only: the key is this claim's.
    expect(storage.delete).toHaveBeenCalledWith('videos/web_22_muqqfmo0_phone.mp4');
    const update = dbModule.__state.updates.find((u) => u.table === 'photos');
    expect(update.where).toEqual({ id: 22, web_status: 'processing', web_started_at: '2026-10-02T09:00:00.000Z' });
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
    expect(storage.putFromFile).toHaveBeenCalledWith('videos/web_23_Teaser.mp4', expect.any(String), { contentType: 'video/mp4' });
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

  it('marks a row that is not a video as skipped without touching ffmpeg', async () => {
    dbModule.__state.photo = { id: 25, event_id: 9, filename: 'still.jpg', media_type: 'image', mime_type: 'image/jpeg' };
    expect(await service.renderWebCopy(25)).toBe('skipped');
    expect(ffmpeg).not.toHaveBeenCalled();
  });
});
