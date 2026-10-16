/**
 * videoHlsService (issue 1733, D4), the parts that need no process and no
 * storage: which rungs a source gets, ffmpeg's arguments, the playlists and
 * the names a request may reach.
 */
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/database/db', () => ({ db: Object.assign(jest.fn(), { client: { config: { client: 'sqlite3' } } }) }));
const mockStorage = { kind: jest.fn(), list: jest.fn(), delete: jest.fn() };
jest.mock('../../src/services/storage', () => ({ getStorage: () => mockStorage }));

const hls = require('../../src/services/videoHlsService');
const { HDR_TO_SDR_FILTER } = require('../../src/services/videoRenditionService');

const ATTEMPT = '0b6f6d0e-5f0b-4c55-9f0e-2a4d3c1b7e9a';

describe('deleteLadder', () => {
  const entries = keys => keys.map(key => ({ key, size: 1 }));

  it('confines an object store listing to this photo, and deletes nothing of its neighbours', async () => {
    // Without the slash S3 lists hls/10/, hls/100/ ... for photo 1 as well:
    // every ladder whose id starts with the same digits, fetched to be dropped.
    mockStorage.kind.mockReturnValue('s3');
    mockStorage.list.mockResolvedValue(entries([`hls/1/${ATTEMPT}/master.m3u8`, `hls/1/${ATTEMPT}/480p/seg_00000.m4s`]));
    mockStorage.delete.mockResolvedValue();
    await hls.deleteLadder({ id: 1, hls_status: 'complete' });
    expect(mockStorage.list).toHaveBeenCalledWith('hls/1/');
    expect(mockStorage.delete.mock.calls.map(call => call[0]).sort())
      .toEqual([`hls/1/${ATTEMPT}/480p/seg_00000.m4s`, `hls/1/${ATTEMPT}/master.m3u8`]);
  });

  it('still drops a key of another photo that a listing hands back', async () => {
    mockStorage.kind.mockReturnValue('s3');
    mockStorage.list.mockResolvedValue(entries([`hls/1/${ATTEMPT}/master.m3u8`, `hls/10/${ATTEMPT}/master.m3u8`]));
    mockStorage.delete.mockClear();
    await hls.deleteLadder({ id: 1, hls_status: 'complete' });
    expect(mockStorage.delete.mock.calls.map(call => call[0])).toEqual([`hls/1/${ATTEMPT}/master.m3u8`]);
  });
});

describe('selectLadder', () => {
  const names = source => hls.selectLadder(source).map(rung => rung.name);

  it('gives a 1080p source all three rungs at their ceilings', () => {
    expect(hls.selectLadder({ width: 1920, height: 1080, bitrate: 20000000 })).toEqual([
      { name: '480p', height: 480, bitrate: 1200000, width: 854, outputHeight: 480 },
      { name: '720p', height: 720, bitrate: 2800000, width: 1280, outputHeight: 720 },
      { name: '1080p', height: 1080, bitrate: 5000000, width: 1920, outputHeight: 1080 },
    ]);
  });

  it('never upscales: a rung above the source is left out, a 4K source stops at 1080p', () => {
    expect(names({ width: 1280, height: 720, bitrate: 20000000 })).toEqual(['480p', '720p']);
    expect(names({ width: 1024, height: 600, bitrate: 20000000 })).toEqual(['480p']);
    expect(names({ width: 3840, height: 2160, bitrate: 45000000 })).toEqual(['480p', '720p', '1080p']);
  });

  it('gives a source at or below 480p one rendition, at its own size when smaller', () => {
    expect(hls.selectLadder({ width: 854, height: 480, bitrate: 20000000 })).toEqual([
      { name: '480p', height: 480, bitrate: 1200000, width: 854, outputHeight: 480 },
    ]);
    expect(hls.selectLadder({ width: 640, height: 359, bitrate: 20000000 })).toEqual([
      { name: '358p', height: 358, bitrate: 1200000, width: 638, outputHeight: 358 },
    ]);
  });

  it('reads the short edge, so a portrait phone video is 1080p too', () => {
    const rungs = hls.selectLadder({ width: 1080, height: 1920, bitrate: 20000000 });
    expect(rungs.map(rung => rung.name)).toEqual(['480p', '720p', '1080p']);
    expect(rungs[2]).toMatchObject({ width: 1080, outputHeight: 1920 });
    expect(rungs[0]).toMatchObject({ width: 480, outputHeight: 854 });
  });

  it('never asks for more than the source bitrate', () => {
    const rungs = hls.selectLadder({ width: 1920, height: 1080, bitrate: 3500000 });
    expect(rungs.map(rung => [rung.name, rung.bitrate])).toEqual([['480p', 1200000], ['720p', 2800000], ['1080p', 3500000]]);
    for (const rung of rungs) expect(rung.bitrate).toBeLessThanOrEqual(3500000);
  });

  it('drops a rung the cap leaves no better than the one above it', () => {
    // 2 Mbit/s source: 720p and 1080p would both be capped to 2 Mbit/s.
    expect(hls.selectLadder({ width: 1920, height: 1080, bitrate: 2000000 }).map(rung => [rung.name, rung.bitrate]))
      .toEqual([['480p', 1200000], ['1080p', 2000000]]);
    expect(hls.selectLadder({ width: 1920, height: 1080, bitrate: 800000 }).map(rung => [rung.name, rung.bitrate]))
      .toEqual([['1080p', 800000]]);
  });

  it('keeps the ceilings when the source bitrate is unknown, and has nothing for unknown dimensions', () => {
    expect(names({ width: 1920, height: 1080, bitrate: null })).toEqual(['480p', '720p', '1080p']);
    expect(hls.selectLadder({ width: null, height: null, bitrate: 1 })).toEqual([]);
    expect(hls.selectLadder()).toEqual([]);
  });
});

describe('transcodeOptions', () => {
  const rungs = hls.selectLadder({ width: 1920, height: 1080, bitrate: 20000000 });
  const args = hls.transcodeOptions(rungs, '/tmp/out', { threads: 4 });
  const after = (flag, from = 0) => args[args.indexOf(flag, from) + 1];

  it('decodes once and scales every rung by its short edge, never by a fixed width', () => {
    expect(after('-filter_complex')).toBe(
      '[0:v:0]split=3[s0][s1][s2];'
      + '[s0]scale=w=\'if(gt(iw,ih),-2,480)\':h=\'if(gt(iw,ih),480,-2)\'[v0];'
      + '[s1]scale=w=\'if(gt(iw,ih),-2,720)\':h=\'if(gt(iw,ih),720,-2)\'[v1];'
      + '[s2]scale=w=\'if(gt(iw,ih),-2,1080)\':h=\'if(gt(iw,ih),1080,-2)\'[v2]',
    );
  });

  it('writes H.264/AAC fMP4 HLS in 6 s segments, cut at the same instants in every rung', () => {
    expect(args.filter(arg => arg === 'libx264')).toHaveLength(3);
    expect(args.filter(arg => arg === 'aac')).toHaveLength(3);
    expect(args.filter(arg => arg === 'expr:gte(t,n_forced*6)')).toHaveLength(3);
    expect(after('-hls_time')).toBe('6');
    expect(after('-hls_segment_type')).toBe('fmp4');
    expect(after('-hls_playlist_type')).toBe('vod');
    expect(after('-hls_fmp4_init_filename')).toBe('init.mp4');
    expect(args.filter(arg => /seg_%05d\.m4s$/.test(arg))).toEqual([
      '/tmp/out/480p/seg_%05d.m4s', '/tmp/out/720p/seg_%05d.m4s', '/tmp/out/1080p/seg_%05d.m4s',
    ]);
    expect(args[args.length - 1]).toBe('/tmp/out/1080p/index.m3u8');
  });

  it('caps each rung at its bitrate and shares the thread budget between the encoders', () => {
    const maxrates = args.map((arg, index) => (arg === '-maxrate' ? args[index + 1] : null)).filter(Boolean);
    expect(maxrates).toEqual(['1200000', '2800000', '5000000']);
    // 4 threads over 3 encoders: one each, never 12.
    expect(args.map((arg, index) => (arg === '-threads' ? args[index + 1] : null)).filter(Boolean)).toEqual(['1', '1', '1']);
    expect(after('-filter_complex_threads')).toBe('4');
  });

  it('drops the source metadata and chapters from every rung', () => {
    expect(args.filter(arg => arg === '-map_metadata')).toHaveLength(3);
    expect(args.filter(arg => arg === '-map_chapters')).toHaveLength(3);
    expect(after('-map_metadata')).toBe('-1');
    expect(after('-map_chapters')).toBe('-1');
  });

  it('a single rung needs no split', () => {
    const one = hls.transcodeOptions(hls.selectLadder({ width: 640, height: 360, bitrate: 900000 }), '/tmp/out');
    expect(one.filter(arg => arg === 'libx264')).toHaveLength(1);
    expect(one[one.indexOf('-filter_complex') + 1]).toBe('[0:v:0]scale=w=\'if(gt(iw,ih),-2,360)\':h=\'if(gt(iw,ih),360,-2)\'[v0]');
  });

  it('tone-maps an HDR source once, ahead of the split, and tags the output BT.709', () => {
    const hdr = hls.transcodeOptions(rungs, '/tmp/out', { toneMap: true, threads: 2 });
    const graph = hdr[hdr.indexOf('-filter_complex') + 1];
    expect(graph.startsWith(`[0:v:0]${HDR_TO_SDR_FILTER},split=3`)).toBe(true);
    expect(graph.split(HDR_TO_SDR_FILTER)).toHaveLength(2);
    expect(hdr.filter(arg => arg === '-color_trc')).toHaveLength(3);
    expect(args).not.toContain('-color_trc');
  });
});

describe('buildMasterPlaylist', () => {
  it('lists the rungs that exist, lowest first, by relative URL', () => {
    const rungs = hls.selectLadder({ width: 1280, height: 720, bitrate: 20000000 });
    expect(hls.buildMasterPlaylist(rungs, { averages: { '480p': 900000.4 } })).toBe([
      '#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS',
      '#EXT-X-STREAM-INF:BANDWIDTH=1460800,AVERAGE-BANDWIDTH=900001,RESOLUTION=854x480', '480p/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=3220800,RESOLUTION=1280x720', '720p/index.m3u8', '',
    ].join('\n'));
  });

  it('leaves the audio out of the bandwidth of a silent video', () => {
    const rungs = hls.selectLadder({ width: 854, height: 480, bitrate: 20000000 });
    expect(hls.buildMasterPlaylist(rungs, { audio: false })).toContain('BANDWIDTH=1320000,');
  });
});

describe('readInitSegment and the master playlist built from it', () => {
  // ftyp names 'avc1' as a brand; the sample entry after stsd is the one that counts.
  const init = ({ profile = 0x64, flags = 0x00, level = 0x1f, width = 1280, height = 720, audio = true } = {}) => {
    const entry = Buffer.alloc(8 + 78);
    entry.write('avc1', 4, 'latin1');
    entry.writeUInt16BE(width, 8 + 24);
    entry.writeUInt16BE(height, 8 + 26);
    return Buffer.concat([
      Buffer.from('\0\0\0\x18ftypiso5\0\0\0\0iso5avc1', 'latin1'), Buffer.from('\0\0\0\0stsd\0\0\0\0\0\0\0\x01', 'latin1'),
      entry, Buffer.from('\0\0\0\x10avcC', 'latin1'), Buffer.from([1, profile, flags, level, 0xff]),
      audio ? Buffer.from('\0\0\0\x10mp4a', 'latin1') : Buffer.alloc(0),
    ]);
  };

  it('reads the codec string and the coded size', () => {
    expect(hls.readInitSegment(init())).toEqual({ codecs: 'avc1.64001f,mp4a.40.2', width: 1280, height: 720 });
    expect(hls.readInitSegment(init({ profile: 0x4d, flags: 0x40, level: 0x28, width: 1080, height: 1920, audio: false })))
      .toEqual({ codecs: 'avc1.4d4028', width: 1080, height: 1920 });
  });

  it('has nothing to say about a file that is not H.264 in MP4', () => {
    expect(hls.readInitSegment(Buffer.from('not an init segment'))).toBeNull();
    expect(hls.readInitSegment(Buffer.from('\0\0\0\x18ftypiso5\0\0\0\0iso5avc1', 'latin1'))).toBeNull();
    expect(hls.readInitSegment(Buffer.alloc(0))).toBeNull();
  });

  it('puts CODECS and the real RESOLUTION on every rung it was read for', () => {
    const rungs = hls.selectLadder({ width: 1280, height: 720, bitrate: 20000000 });
    const inits = { '480p': { codecs: 'avc1.64001e,mp4a.40.2', width: 854, height: 480 }, '720p': { codecs: 'avc1.64001f,mp4a.40.2', width: 1280, height: 720 } };
    expect(hls.buildMasterPlaylist(rungs, { averages: { '480p': 900000, '720p': 2100000 }, inits })).toBe([
      '#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS',
      '#EXT-X-STREAM-INF:BANDWIDTH=1460800,AVERAGE-BANDWIDTH=900000,RESOLUTION=854x480,CODECS="avc1.64001e,mp4a.40.2"', '480p/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=3220800,AVERAGE-BANDWIDTH=2100000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"', '720p/index.m3u8', '',
    ].join('\n'));
    // The quoted attribute passes the route's rewrite untouched.
    expect(hls.rewritePlaylist(hls.buildMasterPlaylist(rungs, { inits }), 'master', 'v=a')).toContain('CODECS="avc1.64001f,mp4a.40.2"\n720p/index.m3u8?v=a');
  });
});

describe('rewritePlaylist', () => {
  const media = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:6', '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:6.000000,', 'seg_00000.m4s', '#EXTINF:1.000000,', 'seg_00001.m4s', '#EXT-X-ENDLIST', ''].join('\n');

  it('passes the query on to every URL and keeps them relative', () => {
    const out = hls.rewritePlaylist(media, 'media', 'v=abc&admin_preview=1');
    expect(out).toContain('#EXT-X-MAP:URI="init.mp4?v=abc&admin_preview=1"');
    expect(out).toContain('\nseg_00000.m4s?v=abc&admin_preview=1\n');
    expect(out).toContain('\nseg_00001.m4s?v=abc&admin_preview=1\n');
    expect(out).not.toMatch(/https?:|\/api\//);
    expect(out).toContain('#EXTINF:6.000000,');
  });

  it('changes nothing but line endings without a query', () => {
    expect(hls.rewritePlaylist(media.replace(/\n/g, '\r\n'), 'media')).toBe(media);
  });

  it('rewrites the rung URLs of a master playlist', () => {
    const master = hls.buildMasterPlaylist(hls.selectLadder({ width: 1280, height: 720, bitrate: 20000000 }));
    const out = hls.rewritePlaylist(master, 'master', 'v=abc');
    expect(out).toContain('\n480p/index.m3u8?v=abc\n');
    expect(out).toContain('\n720p/index.m3u8?v=abc\n');
  });

  it.each([
    ['an absolute URL', 'https://evil.example/seg_00000.m4s'],
    ['a parent path', '../../7/x/480p/seg_00000.m4s'],
    ['a path into another rung', '720p/seg_00000.m4s'],
    ['a name with a query of its own', 'seg_00000.m4s?token=1'],
    ['an unexpected file', 'seg_0.ts'],
  ])('refuses %s in a media playlist', (_label, uri) => {
    expect(() => hls.rewritePlaylist(`#EXTM3U\n#EXTINF:6,\n${uri}\n`, 'media', 'v=a')).toThrow(/Unexpected URI/);
  });

  it('refuses a URI attribute it does not write', () => {
    expect(() => hls.rewritePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://evil.example/key"\n', 'media')).toThrow(/Unexpected URI/);
    expect(() => hls.rewritePlaylist('#EXTM3U\n#EXT-X-MAP:URI="../init.mp4"\n', 'media')).toThrow(/Unexpected URI/);
    expect(() => hls.rewritePlaylist('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="a/index.m3u8"\n', 'master')).toThrow(/Unexpected URI/);
    expect(() => hls.rewritePlaylist('#EXTM3U\nseg_00000.m4s\n', 'master')).toThrow(/Unexpected URI/);
  });
});

describe('ladderKey', () => {
  const photo = { id: 7, hls_status: 'complete', hls_path: `hls/7/${ATTEMPT}` };

  it('resolves the names the transcode writes under the photo\'s own prefix', () => {
    expect(hls.ladderKey(photo, undefined, 'master.m3u8')).toBe(`hls/7/${ATTEMPT}/master.m3u8`);
    expect(hls.ladderKey(photo, '720p', 'index.m3u8')).toBe(`hls/7/${ATTEMPT}/720p/index.m3u8`);
    expect(hls.ladderKey(photo, '720p', 'init.mp4')).toBe(`hls/7/${ATTEMPT}/720p/init.mp4`);
    expect(hls.ladderKey(photo, '1080p', 'seg_00042.m4s')).toBe(`hls/7/${ATTEMPT}/1080p/seg_00042.m4s`);
  });

  it.each([
    ['..', 'seg_00000.m4s'], ['720p', '..'], ['720p', '../master.m3u8'], ['720p', 'seg_00000.m4s/..'],
    ['720p', 'seg_0.m4s'], ['720p', 'seg_000000.m4s'], ['720p', 'seg_00000.ts'], ['720p', 'master.m3u8'],
    ['720p', 'init.mp4.bak'], ['720p', '%2e%2e'], ['720p', 'seg_00000.m4s\0'], ['720', 'init.mp4'],
    ['720p/..', 'init.mp4'], ['events', 'init.mp4'], ['', 'init.mp4'], ['720p', ''],
  ])('refuses rung %j file %j', (rung, file) => {
    expect(hls.ladderKey(photo, rung, file)).toBeNull();
  });

  it('has no key for a master file under another name', () => {
    expect(hls.ladderKey(photo, undefined, 'index.m3u8')).toBeNull();
    expect(hls.ladderKey(photo, undefined, '../master.m3u8')).toBeNull();
  });

  it('does not follow a row pointer outside the photo\'s own ladder', () => {
    expect(hls.ladderKey({ ...photo, hls_path: `hls/8/${ATTEMPT}` }, '720p', 'init.mp4')).toBeNull();
    expect(hls.ladderKey({ ...photo, hls_path: 'events/active/other' }, '720p', 'init.mp4')).toBeNull();
    expect(hls.ladderKey({ ...photo, hls_path: `hls/7/${ATTEMPT}/../../8` }, '720p', 'init.mp4')).toBeNull();
    expect(hls.ladderKey({ ...photo, hls_path: null }, '720p', 'init.mp4')).toBeNull();
  });

  it('has nothing for a ladder that is not published', () => {
    for (const status of ['pending', 'processing', 'failed', 'skipped', null]) {
      expect(hls.ladderKey({ ...photo, hls_status: status }, undefined, 'master.m3u8')).toBeNull();
    }
  });
});
