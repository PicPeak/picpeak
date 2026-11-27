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
  const jpeg = async (name, leadingSegments, { exif = true } = {}) => {
    let image = sharp({ create: { width: 30, height: 20, channels: 3, background: { r: 5, g: 5, b: 5 } } });
    if (exif) {
      image = image.withExif({
        IFD0: { Make: 'Canon', Model: 'Canon EOS R5' },
        IFD2: { DateTimeOriginal: '2025:06:01 09:45:03', OffsetTimeOriginal: '+02:00' },
      });
    }
    const plain = await image.jpeg().toBuffer();
    // sharp writes the EXIF APP1 right after SOI; the extra blocks go in front of it.
    if (exif) expect(plain.readUInt16BE(2)).toBe(0xffe1);
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

  describe('bytes read by both readers together', () => {
    const FIRST_PASS = 64 * 1024; // exifr's own first read, per reader
    let read;
    let openSpy;
    beforeEach(() => {
      read = 0;
      const open = require('fs').promises.open;
      openSpy = jest.spyOn(require('fs').promises, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args);
        const plainRead = handle.read.bind(handle);
        handle.read = async (...readArgs) => {
          const result = await plainRead(...readArgs);
          read += result.bytesRead;
          return result;
        };
        return handle;
      });
    });
    afterEach(() => openSpy.mockRestore());
    const readBoth = async (file) => {
      await extractCapture(file);
      await extractPhotoExif(file);
      return read;
    };

    // A PNG chunk: length, type, data, CRC (not checked by the readers).
    const pngChunk = (type, data) => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(data.length);
      return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
    };
    const png = async (name, textBytes) => {
      const pixels = Buffer.alloc(300 * 300 * 3, 7);
      const plain = await sharp(pixels, { raw: { width: 300, height: 300, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
      const iend = plain.length - 12;
      const text = textBytes ? [pngChunk('tEXt', Buffer.concat([Buffer.from('Comment\0'), Buffer.alloc(textBytes, 0x41)]))] : [];
      const file = path.join(tmpDir, name);
      await fs.writeFile(file, Buffer.concat([plain.subarray(0, iend), ...text, plain.subarray(iend)]));
      return file;
    };

    it('retries nothing for a PNG without EXIF', async () => {
      expect(await readBoth(await png('plain.png', 0))).toBeLessThanOrEqual(2 * (FIRST_PASS + 2));
    });

    it('does not read a huge PNG text chunk', async () => {
      expect(await readBoth(await png('text.png', 16 * 1024 * 1024))).toBeLessThanOrEqual(2 * (FIRST_PASS + 2));
    });

    it('only walks the marker chain of a JPEG without EXIF', async () => {
      const file = await jpeg('noexif.jpg', 16, { exif: false });
      expect(await readBoth(file)).toBeLessThanOrEqual(2 * (FIRST_PASS + 2 + 4 * 32));
    });

    it('reads one EXIF segment, not the blocks in front of it', async () => {
      const file = await jpeg('bounded.jpg', 16);
      expect(await readBoth(file)).toBeLessThanOrEqual(2 * (FIRST_PASS + 2 + 4 * 32 + 64 * 1024));
    });
  });
});
