const { estimate, configuration } = require('../../src/services/mediaProcessPolicy');
const { videoSignature, rawSignature } = require('../../src/services/mediaProcessService');
const ordinary = () => ({ format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '10' },
  streams: [{ codec_type: 'video', width: 3840, height: 2160, avg_frame_rate: '30/1', pix_fmt: 'yuv420p' }] });
test('ordinary 4K and HDR have finite, frame-aware deployment admission', () => {
  expect(estimate(ordinary())).toEqual({ decodedBytes: 3840 * 2160 * 8, work: 3840 * 2160 * 300 });
  const hdr = ordinary(); hdr.streams[0].pix_fmt = 'yuv420p10le';
  expect(estimate(hdr).decodedBytes).toBe(3840 * 2160 * 16);
});
test('dimensions, streams, rate, duration, frame count and equivalent numeric encodings cannot bypass policy', () => {
  for (const alter of [
    item => { item.streams[0].width = 50000; }, item => { item.streams[0].width = 'Infinity'; },
    item => { item.streams[0].width = -1; }, item => { item.streams[0].width = 1.5; },
    item => { item.streams[0].avg_frame_rate = '1000/1'; }, item => { item.streams[0].avg_frame_rate = '1/0'; },
    item => { item.streams[0].nb_frames = '1e15'; }, item => { item.format.duration = '1e10'; },
    item => { item.streams = Array(17).fill(item.streams[0]); }, item => { item.format.format_name = 'hls'; },
  ]) { const item = ordinary(); alter(item); expect(() => estimate(item)).toThrow(); }
  const numeric = ordinary(); numeric.streams[0].width = '3.84e3';
  expect(estimate(numeric)).toEqual(estimate(ordinary()));
  const unknown = ordinary(); delete unknown.format.duration; delete unknown.streams[0].avg_frame_rate;
  expect(estimate(unknown).work).toBe(configuration().maxWork);
});
test('extensions do not substitute for video and RAW container signatures', () => {
  expect(() => videoSignature(Buffer.from('#EXTM3U\n'))).toThrow();
  expect(() => rawSignature(Buffer.from([255, 216, 255, 224]), 'spoof.DNG')).toThrow();
  for (const name of ['dng', 'cr2', 'nef', 'arw', 'pef', '3fr', 'dcr', 'kdc']) expect(() => rawSignature(Buffer.from('II*\0'), `normal.${name}`)).not.toThrow();
  expect(() => rawSignature(Buffer.from('FUJIFILMCCD-RAW '), 'normal.RAF')).not.toThrow();
  expect(() => rawSignature(Buffer.from('IIU\0'), 'normal.RW2')).not.toThrow();
  expect(() => rawSignature(Buffer.from('IIRO'), 'normal.ORF')).not.toThrow();
});
