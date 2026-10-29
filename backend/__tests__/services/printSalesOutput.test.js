'use strict';
const sharp = require('sharp');
const { output, encode } = require('../../src/services/printSales/output');
const { pngDensity } = require('../../src/services/printSales/pngDensity');
const { ValidationError } = require('../../src/utils/errors');
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
    await expect(isolated(source).flatten({ background: '/path/to/colour' }).png().toBuffer()).rejects.toThrow('Unsupported image operation');
    await expect(isolated(source).tiff({ compression: 'lzw', xres: 1, yres: 1, resolutionUnit: 'inch', tile: true }).toBuffer()).rejects.toThrow('Unsupported image operation');
  } finally { await isolated.shutdown(); }
});
