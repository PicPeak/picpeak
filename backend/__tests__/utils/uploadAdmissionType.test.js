const { Readable, Writable } = require('stream');
const { pipeline } = require('stream/promises');
const { videoPrefix, createUploadFileGuard, PREFIX_BYTES } = require('../../src/utils/uploadAdmissionType');
const { admissionVideo } = require('../fixtures/admissionVideo');

function bmff(major, compatible = []) {
  const b = Buffer.alloc(16 + compatible.length * 4);
  b.writeUInt32BE(b.length); b.write('ftyp', 4); b.write(major, 8, 'latin1');
  compatible.forEach((brand, n) => b.write(brand, 16 + n * 4, 'latin1'));
  return b;
}
async function receive(bytes, mime, photoCap = 1024, videoCap = 4096) {
  const chunks = [];
  await pipeline(Readable.from(bytes), createUploadFileGuard({ mimetype: mime }, photoCap, videoCap),
    new Writable({ write(chunk, _encoding, cb) { chunks.push(chunk); cb(); } }));
  return Buffer.concat(chunks);
}
test('ordinary real MP4 passes both admission classification and split-prefix streaming unchanged', async () => {
  const b = admissionVideo();
  expect(videoPrefix(b, 'video/mp4')).toBe(true);
  expect(await receive([b.subarray(0, 3), b.subarray(3, 17), b.subarray(17)], 'video/mp4')).toEqual(b);
});
test.each(['heic', 'avif', 'mif1', 'msf1', 'jpeg', 'j2ki'])('still-image brand %s cannot borrow a video allowance', async brand => {
  const b = bmff('isom', ['mp42', brand]);
  expect(videoPrefix(b, 'video/mp4')).toBe(false);
  await expect(receive([b], 'video/mp4')).rejects.toMatchObject({ code: 'UPLOAD_TYPE_REJECTED' });
});
test('absent, oversized, truncated and non-ASCII lookalike brands do not identify a video', () => {
  for (const b of [bmff('mp42').subarray(0, 12), Buffer.alloc(PREFIX_BYTES), Buffer.from('\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01', 'latin1')]) {
    expect(videoPrefix(b, 'video/mp4', true)).toBe(false);
    expect(videoPrefix(b, 'video/quicktime', true)).toBe(false);
  }
  const b = bmff('mp42'); b.writeUInt32BE(PREFIX_BYTES + 4);
  expect(videoPrefix(b, 'video/mp4')).toBe(false);
  const lookalike = bmff('mp42'); lookalike[8] |= 0x80;
  expect(videoPrefix(lookalike, 'video/mp4')).toBe(false);
});
// Header bytes as real encoders write them: ffmpeg (isom), a phone (3gp4), an
// HEVC camera (hvc1), iTunes (M4V ), a Sony camcorder (MSNV) and Apple (qt  ).
test.each([
  ['video/mp4', '000000206674797069736f6d0000020069736f6d69736f32617663316d703431'],
  ['video/mp4', '0000001c6674797069736f36000000016d70343169736f3669736f6d'],
  ['video/mp4', '000000186674797033677034000003003367703433677035'],
  ['video/mp4', '000000186674797068766331000000006876633169736f6d'],
  ['video/mp4', '00000020667479704d345620000000014d3456204d34412069736f6d6d703432'],
  ['video/mp4', '0000001c667479704d534e56012900464d534e566d70343269736f6d'],
  ['video/quicktime', '0000001466747970717420200000020071742020'],
  ['video/quicktime', '0000002066747970717420202005030071742020000000000000000000000000'],
  ['video/quicktime', '000000186674797069736f6d0000020069736f6d6d703432'],
])('%s header %s is admitted as a video container', (mime, hex) => {
  expect(videoPrefix(Buffer.from(hex, 'hex'), mime, true)).toBe(true);
});
// Classic QuickTime movies carry no ftyp box at all.
test.each([
  ['moov', '000003146d6f6f760000006c6d766864'],
  ['mdat', '0000a1b86d646174000000000000'],
  ['wide', '00000008776964650000a1b86d646174'],
  ['free', '0000000866726565000003146d6f6f76'],
  ['64-bit mdat', '000000016d6461740000000100000000'],
])('a legacy QuickTime file opening with %s is admitted only as video/quicktime', (_name, hex) => {
  const b = Buffer.from(hex, 'hex');
  expect(videoPrefix(b, 'video/quicktime', true)).toBe(true);
  expect(videoPrefix(b, 'video/mp4', true)).toBe(false);
});
test('QuickTime, AVI and WebM require their own container, not a shared image signature', () => {
  expect(videoPrefix(bmff('qt  '), 'video/quicktime')).toBe(true);
  expect(videoPrefix(Buffer.from('RIFFxxxxAVI '), 'video/x-msvideo')).toBe(true);
  expect(videoPrefix(Buffer.from('RIFFxxxxWEBP'), 'video/x-msvideo')).toBe(false);
  const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]);
  expect(videoPrefix(webm, 'video/webm')).toBe(true);
  expect(videoPrefix(webm.subarray(0, 8), 'video/webm', true)).toBe(false);
});
test('images and normalized RAW use only the photo cap while valid videos retain their larger cap', async () => {
  await expect(receive([Buffer.alloc(2048)], 'image/jpeg')).rejects.toMatchObject({ code: 'UPLOAD_FILE_TOO_LARGE' });
  await expect(receive([Buffer.alloc(2048)], 'image/x-nikon-nef')).rejects.toMatchObject({ code: 'UPLOAD_FILE_TOO_LARGE' });
  expect(await receive([admissionVideo(2048)], 'video/mp4')).toEqual(admissionVideo(2048));
  await expect(receive([admissionVideo(8192)], 'video/mp4')).rejects.toMatchObject({ code: 'UPLOAD_FILE_TOO_LARGE' });
});
