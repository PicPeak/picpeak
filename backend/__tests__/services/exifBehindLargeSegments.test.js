/**
 * EXIF behind large metadata blocks (issue 2617).
 *
 * exifr's Node build reads the first 64 KB of a file, and when only EXIF
 * (TIFF) tags are asked for it reads no further. Some editors write XMP, ICC
 * or Photoshop blocks in front of the EXIF segment; past 64 KB of them the
 * capture date and the camera details came back empty. The fixture is a
 * sharp JPEG with ICC-labelled APP2 segments spliced in front of its EXIF.
 */
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const exifr = require('exifr');

jest.mock('../../src/database/db', () => {
  const api = () => ({ where: () => ({ whereIn: () => [], first: async () => null }), whereIn: async () => [] });
  return { db: api };
});

const { extractCapture } = require('../../src/services/imageProcessor');
const { extractPhotoExif } = require('../../src/services/photoExif');

// An APPn segment of `size` payload bytes after its identifier.
const appSegment = (marker, id, size) => {
  const body = Buffer.concat([Buffer.from(id, 'latin1'), Buffer.alloc(size, 0x20)]);
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
};

describe('EXIF behind large metadata segments (issue 2617)', () => {
  let tmpDir;
  const jpeg = async (name, leadingSegments) => {
    const plain = await sharp({ create: { width: 30, height: 20, channels: 3, background: { r: 5, g: 5, b: 5 } } })
      .withExif({
        IFD0: { Make: 'Canon', Model: 'Canon EOS R5' },
        IFD2: { DateTimeOriginal: '2025:06:01 09:45:03', OffsetTimeOriginal: '+02:00' },
      })
      .jpeg().toBuffer();
    // sharp writes the EXIF APP1 right after SOI; the extra blocks go in front of it.
    expect(plain.readUInt16BE(2)).toBe(0xffe1);
    const extra = Array.from({ length: leadingSegments }, () => appSegment(0xe2, 'ICC_PROFILE\0', 65000));
    const file = path.join(tmpDir, name);
    await fs.writeFile(file, Buffer.concat([plain.subarray(0, 2), ...extra, plain.subarray(2)]));
    return file;
  };

  beforeAll(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'picpeak-exif-segments-')); });
  afterAll(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it('reproduces the gap: exifr alone misses an EXIF segment past 64 KB', async () => {
    const near = await jpeg('near.jpg', 1);
    const far = await jpeg('far.jpg', 2);
    expect(await exifr.parse(near, { pick: ['DateTimeOriginal'] })).toBeTruthy();
    expect(await exifr.parse(far, { pick: ['DateTimeOriginal'] })).toBeUndefined();
  });

  it('reads the capture date behind ~1 MB of leading segments', async () => {
    const file = await jpeg('capture.jpg', 16);
    const capture = await extractCapture(file);
    expect(capture.wall).toBe('2025-06-01T09:45:03+02:00');
    expect(capture.capturedAt.getTime()).toBe(new Date(2025, 5, 1, 9, 45, 3).getTime());
  });

  it('reads the camera details behind ~1 MB of leading segments', async () => {
    const file = await jpeg('details.jpg', 16);
    expect(await extractPhotoExif(file)).toEqual({ make: 'Canon', model: 'Canon EOS R5' });
  });
});
