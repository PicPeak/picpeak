/**
 * Camera details (issue 1733, D1): an allow-list of seven EXIF fields.
 * Location, serial numbers, names and software must never be stored.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const exifr = require('exifr');

jest.mock('../../src/utils/logger', () => ({
  debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

const { extractPhotoExif, exifColumn, normalizeExif, parseStoredExif } = require('../../src/services/photoExif');

describe('photoExif', () => {
  let tmpDir;
  const jpeg = async (name, exif) => {
    const file = path.join(tmpDir, name);
    const image = sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 5, g: 5, b: 5 } } });
    await (exif ? image.withExif(exif) : image).jpeg().toFile(file);
    return file;
  };

  beforeAll(async () => { tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'picpeak-exif-')); });
  afterAll(async () => { await fs.promises.rm(tmpDir, { recursive: true, force: true }); });

  it('stores the allow-listed fields and nothing else from a file with GPS and a body serial', async () => {
    const file = await jpeg('full.jpg', {
      IFD0: { Make: 'Canon', Model: 'Canon EOS R5', Artist: 'Jane Private', Software: 'SecretTool 1.0', Copyright: 'Jane Private' },
      IFD2: {
        LensModel: 'RF24-70mm F2.8 L IS USM', FocalLength: '50/1', FNumber: '28/10',
        ExposureTime: '1/250', ISOSpeedRatings: '400',
        BodySerialNumber: 'SER123456', LensSerialNumber: 'LENS98765', CameraOwnerName: 'Jane Private',
      },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '7/1 15/1 0/1' },
    });

    // The fixture really carries what must be dropped.
    const everything = await exifr.parse(file, true);
    expect(everything.latitude).toBeCloseTo(51.5);
    expect(everything.SerialNumber).toBe('SER123456');
    expect(everything.LensSerialNumber).toBe('LENS98765');
    expect(everything.Artist).toBe('Jane Private');

    const exif = await extractPhotoExif(file);
    expect(exif).toEqual({
      make: 'Canon', model: 'Canon EOS R5', lens: 'RF24-70mm F2.8 L IS USM',
      focal_length: 50, aperture: 2.8, exposure_time: 0.004, iso: 400,
    });

    const stored = (await exifColumn(file)).exif_json;
    expect(JSON.parse(stored)).toEqual(exif);
    expect(stored).not.toMatch(/gps|latitude|longitude|51|serial|SER123456|LENS98765|Jane|Secret/i);
  });

  it('returns {} for a file without EXIF and for one exifr cannot parse', async () => {
    expect(await extractPhotoExif(await jpeg('plain.jpg'))).toEqual({});
    const junk = path.join(tmpDir, 'junk.raf');
    await fs.promises.writeFile(junk, Buffer.from('FUJIFILMCCD-RAW not a real file, long enough to be sniffed'));
    expect(await extractPhotoExif(junk)).toEqual({});
  });

  it('returns null, and no column, for a file that cannot be read', async () => {
    const missing = path.join(tmpDir, 'missing.jpg');
    expect(await extractPhotoExif(missing)).toBeNull();
    expect(await exifColumn(missing)).toEqual({});
  });

  it('normalises: trims, caps and strips control characters, drops bad numbers', () => {
    expect(normalizeExif({
      Make: '  NIKON\u0000 CORPORATION\n', Model: 'x'.repeat(300), LensModel: '\u0007',
      FocalLength: 35.04, FNumber: -1, ExposureTime: Infinity, ISO: [3200, 3200],
      GPSLatitude: [51, 30, 0], BodySerialNumber: 'SER', Artist: 'Jane',
    })).toEqual({ make: 'NIKON CORPORATION', model: 'x'.repeat(100), focal_length: 35, iso: 3200 });
    expect(normalizeExif(null)).toEqual({});
    expect(normalizeExif({ ExposureTime: 1 / 8000, FNumber: 0.95 })).toEqual({ exposure_time: 0.000125, aperture: 0.95 });
  });

  it('keeps a shutter speed precise enough for its reciprocal to read as the camera set it', () => {
    for (const speed of [3, 60, 250, 1250, 3200, 6400, 8000, 16000, 32000, 180000]) {
      const { exposure_time: stored } = normalizeExif({ ExposureTime: 1 / speed });
      expect(Math.round(1 / stored)).toBe(speed);
      // A stored value survives the read-side rebuild unchanged.
      expect(parseStoredExif(JSON.stringify({ exposure_time: stored })).exposure_time).toBe(stored);
    }
  });

  it('parses a stored value back through the allow-list', () => {
    expect(parseStoredExif(null)).toBeNull();
    expect(parseStoredExif('{}')).toBeNull();
    expect(parseStoredExif('not json')).toBeNull();
    expect(parseStoredExif(JSON.stringify({ model: 'X-T5', iso: 160, latitude: 51.5, serial: 'S' })))
      .toEqual({ model: 'X-T5', iso: 160 });
  });
});
