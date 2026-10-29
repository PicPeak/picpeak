'use strict';
const sharp = require('sharp');
const { output, encode } = require('../../src/services/printSales/output');
const { pngDensity } = require('../../src/services/printSales/pngDensity');
const { ValidationError } = require('../../src/utils/errors');
const colours = require('../../src/services/printSales/colourProfiles');
const rgbProfiles = ['adobe-rgb-1998', 'display-p3', 'prophoto-rgb'];
const make = () => sharp({ create: { width: 100, height: 150, channels: 3, background: '#102030' } });
test.each(['jpeg', 'png', 'tiff'])('%s output has frozen dimensions, density and embedded sRGB without camera metadata', async format => {
  const source = await make().withExif({ IFD0: { Make: 'Private camera' } }).png().toBuffer();
  const result = await encode(sharp(source), { format, colourSpace: 'srgb' }, 300), meta = await sharp(result.bytes).metadata();
  expect(meta).toMatchObject({ format, width: 100, height: 150, density: 300 });
  expect(meta.icc).toBeTruthy(); expect(meta.exif).toBeUndefined(); expect(meta.xmp).toBeUndefined();
  if (format === 'tiff') expect(meta.bitsPerSample).toBe(8);
});
test('minimal historical JPEG requirements keep the original encoding defaults', () => {
  expect(output({ format: 'jpeg', colourSpace: 'srgb' })).toEqual({ format: 'jpeg', colourSpace: 'srgb', quality: 95, chromaSubsampling: '4:4:4' });
});
test.each(rgbProfiles.flatMap(colourSpace => ['jpeg', 'png', 'tiff'].map(format => [colourSpace, format])))('%s %s converts pixels, embeds the pinned ICC and round-trips an sRGB colour', async (colourSpace, format) => {
  const spec = output({ format, colourSpace });
  expect(spec.profileSha256).toBe(colours.profile(colourSpace).sha256);
  const { bytes } = await encode(make(), spec, 300), meta = await sharp(bytes).metadata();
  expect(meta).toMatchObject({ format, width: 100, height: 150, density: 300, depth: 'uchar' });
  if (format !== 'jpeg') expect(meta.bitsPerSample).toBe(8);
  expect(meta.exif).toBeUndefined(); expect(meta.xmp).toBeUndefined();
  expect(() => colours.verify(meta, spec)).not.toThrow();
  const encoded = await sharp(bytes, { ignoreIcc: true }).raw().toBuffer();
  expect([...encoded.subarray(0, 3)]).not.toEqual([16, 32, 48]);
  const roundTrip = await sharp(bytes).raw().toBuffer();
  // 8-bit ProPhoto's wider gamut quantises this dark sample more coarsely.
  const maximumError = colourSpace === 'prophoto-rgb' ? 5 : 3;
  [16, 32, 48].forEach((value, n) => expect(Math.abs(roundTrip[n] - value)).toBeLessThanOrEqual(maximumError));
});
test('profile identities reject substitution and missing or differently tagged output', () => {
  expect(() => output({ format: 'png', colourSpace: 'adobe-rgb-1998', profileSha256: '0'.repeat(64) })).toThrow('identity changed');
  expect(() => output({ format: 'png', colourSpace: '../arbitrary.icc' })).toThrow(ValidationError);
  expect(() => colours.verify({}, output({ format: 'png', colourSpace: 'adobe-rgb-1998' }))).toThrow('frozen output ICC');
  const wrong = require('fs').readFileSync(colours.profile('display-p3').icc);
  expect(() => colours.verify({ icc: wrong }, output({ format: 'png', colourSpace: 'adobe-rgb-1998' }))).toThrow('frozen output ICC');
});
test('JPEG quality and chroma selection are applied to real encoded pixels', async () => {
  const raw = Buffer.alloc(100 * 150 * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 71 + Math.floor(i / 13)) % 256;
  const raster = () => sharp(raw, { raw: { width: 100, height: 150, channels: 3 } });
  const low = await encode(raster(), { format: 'jpeg', colourSpace: 'srgb', quality: 50, chromaSubsampling: '4:2:0' }, 300),
    high = await encode(raster(), { format: 'jpeg', colourSpace: 'srgb', quality: 99, chromaSubsampling: '4:4:4' }, 300);
  expect(high.bytes.length).toBeGreaterThan(low.bytes.length);
});
test.each(['lzw', 'deflate', 'none'])('TIFF %s compression remains 8-bit and readable', async compression => {
  const result = await encode(make(), { format: 'tiff', colourSpace: 'srgb', compression }, 150);
  const meta = await sharp(result.bytes).metadata();
  expect(meta).toMatchObject({ format: 'tiff', density: 150, bitsPerSample: 8 });
  const raw = await sharp(result.bytes).raw().toBuffer(); expect([...raw.subarray(0, 3)]).toEqual([16, 32, 48]);
});
test.each([0, 9])('PNG compression %s preserves pixels and creates exactly one density chunk', async compressionLevel => {
  const result = await encode(make(), { format: 'png', colourSpace: 'srgb', compressionLevel }, 300);
  const updated = pngDensity(result.bytes, 150), meta = await sharp(updated).metadata();
  expect(meta.density).toBe(150); expect(meta.icc).toBeTruthy();
  expect([...await sharp(updated).raw().toBuffer()].slice(0, 3)).toEqual([16, 32, 48]);
  let offset = 8, count = 0;
  while (offset < updated.length) { if (updated.toString('ascii', offset + 4, offset + 8) === 'pHYs') count++; offset += 12 + updated.readUInt32BE(offset); }
  expect(count).toBe(1);
});
test.each([
  { format: 'pdf', colourSpace: 'srgb' }, { format: 'jpeg', colourSpace: 'cmyk' },
  { format: 'jpeg', colourSpace: 'srgb', quality: 0 }, { format: 'jpeg', colourSpace: 'srgb', quality: 101 },
  { format: 'jpeg', colourSpace: 'srgb', quality: null }, { format: 'png', colourSpace: 'srgb', compressionLevel: null },
  { format: 'tiff', colourSpace: 'srgb', compression: null },
  { format: 'jpeg', colourSpace: 'srgb', chromaSubsampling: 'unknown' },
  { format: 'png', colourSpace: 'srgb', quality: 95 }, { format: 'png', colourSpace: 'srgb', compressionLevel: 10 },
  { format: 'tiff', colourSpace: 'srgb', compression: 'jpeg' }, { format: 'tiff', colourSpace: 'srgb', bitdepth: 16 },
  { format: 'jpeg', colourSpace: 'srgb', iccProfile: '/untrusted/profile' },
])('rejects unsupported output requirements %j', requirements => expect(() => output(requirements)).toThrow(ValidationError));
test('the isolated renderer accepts the supported operations and refuses extra TIFF/flatten arguments', async () => {
  const isolated = require('../../src/services/isolatedSharp'), source = await make().png().toBuffer();
  try {
    expect(await isolated.prepare()).not.toBe('inprocess');
    for (const format of ['jpeg', 'png', 'tiff']) {
      const result = await encode(isolated(source).flatten({ background: '#102030' }), { format, colourSpace: 'srgb' }, 300);
      expect((await sharp(result.bytes).metadata()).format).toBe(format);
    }
    for (const colourSpace of rgbProfiles) {
      const spec = output({ format: 'png', colourSpace }), result = await encode(isolated(source), spec, 300);
      colours.verify(await sharp(result.bytes).metadata(), spec);
    }
    await expect(isolated(source).withIccProfile('/tmp/arbitrary.icc', { attach: true }).png().toBuffer()).rejects.toThrow('Unsupported image operation');
    await expect(isolated(source).flatten({ background: '/path/to/colour' }).png().toBuffer()).rejects.toThrow('Unsupported image operation');
    await expect(isolated(source).tiff({ compression: 'lzw', xres: 1, yres: 1, resolutionUnit: 'inch', tile: true }).toBuffer()).rejects.toThrow('Unsupported image operation');
  } finally { await isolated.shutdown(); }
});
